require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { io } = require('socket.io-client');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const { randomUUID } = require('crypto');

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:6000';
const LIST_KEY = 'messages:recent';
const msgKey = (id) => `message:${id}`;
const TTL_S = 60; // safety net: a stale entry always expires
const PENDING_MAX_S = Number(process.env.PENDING_MAX_S) || 300;  // offline messages older than this move from Redis to MySQL
const MOVER_INTERVAL_S = Number(process.env.MOVER_INTERVAL_S) || 30; // how often the mover checks

const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
});

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { enableOfflineQueue: false });
redis.on('error', (e) => console.log('[message-service] redis error:', e.message));
redis.on('ready', () => onlineUsers.forEach((x) => deliverPending(x))); // presence may arrive before Redis is connected

// a Redis failure never breaks a request: we fall back to MySQL
async function cacheGet(key) {
  try { const v = await redis.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
async function cacheSet(key, val) {
  try { await redis.set(key, JSON.stringify(val), 'EX', TTL_S); } catch { /* cache is optional */ }
}
async function cacheDel(...keys) {
  try { await redis.del(...keys); } catch { /* cache is optional */ }
}
async function cacheSetAndDel(key, val, ...delKeys) {
  try { await redis.multi().set(key, JSON.stringify(val), 'EX', TTL_S).del(...delKeys).exec(); } catch { /* cache is optional */ }
}

const COLS = 'id, text, username, created_at AS createdAt';
async function dbGet(id) {
  const [rows] = await db.execute(`SELECT ${COLS} FROM messages WHERE id = ?`, [id]);
  return rows[0] || null;
}
function cleanText(d) {
  const t = d && typeof d.text === 'string' ? d.text.trim() : '';
  return t && t.length <= 500 ? t : null;
}

// find or create the 1-to-1 chat row; chat ids are remembered, so each chat costs MySQL only once
const chatIds = new Map(); // chatroom id -> chat_id
async function getChat(a, b) {
  const [x, y] = a < b ? [a, b] : [b, a]; // same length, zero-padded: string order = number order
  const chatroomId = `chatroom${x}_${y}`;
  if (!chatIds.has(chatroomId)) {
    let [rows] = await db.execute('SELECT chat_id FROM connections WHERE chatroom_id = ?', [chatroomId]);
    if (!rows[0]) {
      try {
        await db.execute('INSERT INTO connections (chatroom_id, user_a_xid, user_b_xid) VALUES (?, ?, ?)', [chatroomId, x, y]);
      } catch (e) {
        if (e.code === 'ER_NO_REFERENCED_ROW_2') return null; // one of the xids is not a user
        if (e.code !== 'ER_DUP_ENTRY') throw e;                 // the other user created it at the same moment: fine
      }
      [rows] = await db.execute('SELECT chat_id FROM connections WHERE chatroom_id = ?', [chatroomId]);
    }
    chatIds.set(chatroomId, rows[0].chat_id);
  }
  return { chatId: chatIds.get(chatroomId), chatroomId };
}

function pair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function getFriendship(a, b) {
  const [x, y] = pair(a, b);
  const [rows] = await db.execute(
    `SELECT f.friendship_id AS id, f.user_a_xid AS userA, f.user_b_xid AS userB,
            f.requester_xid AS requester, f.status, f.messages_sent AS messagesSent,
            f.alias_a AS aliasA, f.alias_b AS aliasB,
            ua.username AS userAName, ub.username AS userBName
       FROM friendships f
       JOIN users ua ON ua.user_xid = f.user_a_xid
       JOIN users ub ON ub.user_xid = f.user_b_xid
      WHERE f.user_a_xid = ? AND f.user_b_xid = ?`,
    [x, y]
  );
  return rows[0] || null;
}

function friendshipView(row, xid) {
  if (!row) return null;
  const isA = row.userA === xid;
  const otherXid = isA ? row.userB : row.userA;
  const otherName = isA ? row.userBName : row.userAName;
  const alias = isA ? row.aliasA : row.aliasB;
  return {
    xid: otherXid,
    username: otherName,
    alias,
    status: row.status,
    requester: row.requester,
    messagesSent: row.messagesSent,
    remaining: row.status === 'pending' && row.requester === xid ? Math.max(0, 3 - row.messagesSent) : null,
  };
}

async function listFriendships(xid) {
  const [rows] = await db.execute(
    `SELECT f.friendship_id AS id, f.user_a_xid AS userA, f.user_b_xid AS userB,
            f.requester_xid AS requester, f.status, f.messages_sent AS messagesSent,
            f.alias_a AS aliasA, f.alias_b AS aliasB,
            ua.username AS userAName, ub.username AS userBName
       FROM friendships f
       JOIN users ua ON ua.user_xid = f.user_a_xid
       JOIN users ub ON ub.user_xid = f.user_b_xid
      WHERE f.user_a_xid = ? OR f.user_b_xid = ?
      ORDER BY f.updated_at DESC`,
    [xid, xid]
  );
  return rows.map((row) => friendshipView(row, xid));
}

async function createFriendship(a, b) {
  const [x, y] = pair(a, b);
  await db.execute(
    'INSERT INTO friendships (user_a_xid, user_b_xid, requester_xid, messages_sent) VALUES (?, ?, ?, 1)',
    [x, y, a]
  );
  return getFriendship(a, b);
}

async function changeAlias(xid, other, alias) {
  const row = await getFriendship(xid, other);
  if (!row) return { error: 'no message request or friendship exists' };
  if (row.status !== 'accepted') return { error: 'aliases are only available for friends' };
  const column = row.userA === xid ? 'alias_a' : 'alias_b';
  await db.execute(`UPDATE friendships SET ${column} = ? WHERE friendship_id = ?`, [alias, row.id]);
  return { data: friendshipView(await getFriendship(xid, other), xid) };
}

// messages for offline users wait in Redis (option A): one sorted set per recipient, score = send time, no TTL
const PENDING_USERS = 'pending:users';          // set of xids that have waiting messages (used by the 5-min mover)
const pendingKey = (xid) => `pending:${xid}`;

async function holdPending(msg) {
  const res = await redis.multi().zadd(pendingKey(msg.to), Date.parse(msg.sentAt), JSON.stringify(msg)).sadd(PENDING_USERS, msg.to).exec();
  const failed = res && res.find(([err]) => err);
  if (failed) throw failed[0];
}

// write offline messages to MySQL with ONE query; INSERT IGNORE + unique msg_uid makes a repeated move harmless
async function saveToDb(msgs) {
  const rows = msgs.map((m) => [m.uid, m.chatId, m.from, m.to, m.text, new Date(m.sentAt)]);
  await db.query('INSERT IGNORE INTO direct_messages (msg_uid, chat_id, sender_xid, is_message_for, text, sent_at) VALUES ?', [rows]);
}

// messages for one user that waited > PENDING_MAX_S (stored in MySQL), oldest first; uses index idx_dm_for
const DB_PENDING_SQL =
  'SELECT d.id, d.msg_uid AS uid, d.chat_id AS chatId, d.sender_xid AS `from`, u.username AS fromName, ' +
  'd.is_message_for AS `to`, d.text, d.sent_at AS sentAt ' +
  'FROM direct_messages d JOIN users u ON u.user_xid = d.sender_xid ' +
  'WHERE d.is_message_for = ? AND d.is_delivered = 0 ORDER BY d.sent_at LIMIT 500'; // index idx_dm_open

// delete queue: rows flagged is_delivered = 1 are deleted in batches (one DELETE for up to DELETE_BATCH rows
// every DELETE_EVERY_MS), so many deliveries never hit MySQL with many deletes at once. The flagged rows ARE
// the queue, so it survives a restart. While nothing is waiting, no query runs at all.
const DELETE_BATCH = Number(process.env.DELETE_BATCH) || 100;
const DELETE_EVERY_MS = Number(process.env.DELETE_EVERY_MS) || 1000;
let toDelete = 0; // delivered rows still in MySQL
let deleting = false;
async function runDeleteQueue() {
  if (deleting || toDelete <= 0) return;
  deleting = true;
  try {
    const [r] = await db.query('DELETE FROM direct_messages WHERE is_delivered = 1 ORDER BY id LIMIT ?', [DELETE_BATCH]);
    toDelete = r.affectedRows < DELETE_BATCH ? 0 : toDelete - r.affectedRows; // fewer than a full batch: all gone
    console.log(`[delete-queue] ${r.affectedRows} delivered message(s) deleted in one query (${toDelete} left)`);
  } catch (e) {
    console.log('[delete-queue] failed, will retry:', e.message); // rows stay flagged: nothing is lost
  } finally {
    deleting = false;
  }
}
setInterval(runDeleteQueue, DELETE_EVERY_MS);
db.query('SELECT COUNT(*) AS n FROM direct_messages WHERE is_delivered = 1') // left over from before a restart
  .then(([[row]]) => { toDelete = row.n; if (row.n) console.log(`[delete-queue] ${row.n} delivered message(s) waiting from before the restart`); })
  .catch(() => {});

// remove an xid from pending:users only if it has no messages left, atomically (Lua runs as one step in Redis)
const FORGET_IF_EMPTY = "if redis.call('ZCARD', KEYS[1]) == 0 then return redis.call('SREM', KEYS[2], ARGV[1]) end return 0";

// ask the gateway to push to one user; resolves true if at least one of their tabs acknowledged
function push(to, event, data) {
  return new Promise((resolve) =>
    socket.timeout(10000).emit('push', { to, event, data }, (err, res) => resolve(!err && !!(res && res.delivered))));
}

const busy = new Set(); // xids whose pending messages are being delivered or moved right now (only one at a time)
async function deliverPending(xid) {
  if (busy.has(xid)) return setTimeout(() => onlineUsers.has(xid) && deliverPending(xid), 1000); // mover is busy: try again
  busy.add(xid);
  try {
    const [rows] = await db.execute(DB_PENDING_SQL, [xid]);   // waited > 5 min: in MySQL (oldest)
    const items = await redis.zrange(pendingKey(xid), 0, -1).catch(() => []); // newer: still in Redis (Redis down: MySQL now, Redis on "ready")
    if (!rows.length && !items.length) return;
    const msgs = [
      ...rows.map((r) => ({ ...r, sentAt: new Date(r.sentAt).toISOString(), via: 'db' })),
      ...items.map((s) => ({ ...JSON.parse(s), via: 'redis' })),
    ];
    if (!(await push(xid, 'dm:pending', msgs))) {
      return console.log(`[message-service] ${xid}: ${msgs.length} waiting message(s) not acknowledged, kept`);
    }
    if (items.length) await redis.zrem(pendingKey(xid), ...items); // received: remove from Redis
    if (rows.length) { // received: flag in ONE query; the delete queue removes them later
      const [u] = await db.query('UPDATE direct_messages SET is_delivered = 1, delivered_at = NOW(3) WHERE id IN (?)', [rows.map((r) => r.id)]);
      toDelete += u.affectedRows;
    }
    console.log(`[message-service] ${xid}: delivered ${rows.length} from MySQL (flagged is_delivered) + ${items.length} from Redis (removed)`);
    // receipts: tell each online sender which of their held messages arrived (best effort, nothing stored)
    const bySender = new Map();
    msgs.forEach((m) => bySender.set(m.from, [...(bySender.get(m.from) || []), m.uid]));
    bySender.forEach((uids, from) => { if (onlineUsers.has(from)) push(from, 'dm:delivered', { to: xid, uids }); });
  } catch (e) {
    console.log('[message-service] pending delivery failed:', e.message);
  } finally {
    busy.delete(xid);
  }
}

// every MOVER_INTERVAL_S: messages that waited longer than PENDING_MAX_S go Redis -> MySQL (one INSERT per user)
let moving = false;
async function moveOldPending() {
  if (moving) return; // previous run still busy
  moving = true;
  try {
    const cutoff = Date.now() - PENDING_MAX_S * 1000;
    for (const xid of await redis.smembers(PENDING_USERS)) {
      if (busy.has(xid)) continue; // being delivered right now
      busy.add(xid);
      try {
        const items = await redis.zrangebyscore(pendingKey(xid), '-inf', cutoff); // only the old ones
        if (items.length) {
          await saveToDb(items.map((s) => JSON.parse(s))); // 1. MySQL first
          await redis.zrem(pendingKey(xid), ...items);      // 2. then remove from Redis
          console.log(`[mover] ${xid}: ${items.length} message(s) older than ${PENDING_MAX_S} s moved Redis -> MySQL`);
        }
        await redis.eval(FORGET_IF_EMPTY, 2, pendingKey(xid), PENDING_USERS, xid);
      } finally {
        busy.delete(xid);
      }
    }
  } catch (e) {
    console.log('[mover] failed, will retry:', e.message);
  } finally {
    moving = false;
  }
}
setInterval(moveOldPending, MOVER_INTERVAL_S * 1000);
console.log(`[mover] offline messages move to MySQL after ${PENDING_MAX_S} s (checked every ${MOVER_INTERVAL_S} s)`);

db.query('SELECT 1')
  .then(() => console.log('[message-service] MySQL connected'))
  .catch((e) => console.log('[message-service] MySQL error:', e.message));

const socket = io(GATEWAY, {
  auth: { role: 'service', name: 'message', key: process.env.SERVICE_KEY || 'dev-service-key' },
});
socket.on('connect', () => console.log('[message-service] connected to gateway'));
socket.on('disconnect', () => console.log('[message-service] disconnected, retrying...'));
socket.on('connect_error', (e) => console.log('[message-service] connect_error:', e.message));

// who is online, kept up to date by the gateway (used by direct messages in the next tasks)
const onlineUsers = new Set();
socket.on('presence:sync', ({ online }) => {
  onlineUsers.clear();
  online.forEach((x) => onlineUsers.add(x));
  console.log(`[message-service] presence sync: ${onlineUsers.size} online`);
  onlineUsers.forEach((x) => deliverPending(x)); // users who came online while this service was down
});
socket.on('presence', ({ xid, online }) => {
  if (online) onlineUsers.add(xid); else onlineUsers.delete(xid);
  console.log(`[message-service] ${xid} ${online ? 'online' : 'offline'} (${onlineUsers.size} online)`);
  if (online) deliverPending(xid);
});

socket.on('call', async ({ action, data, user }, reply) => {
  const started = performance.now();
  const meta = (source) => ({ source, ms: Math.round((performance.now() - started) * 10) / 10 });
  try {
    if (action === 'send') {
      const text = cleanText(data);
      if (!text) return reply({ ok: false, error: 'invalid text' });
      const [r] = await db.execute('INSERT INTO messages (text, username) VALUES (?, ?)', [text, user.username]);
      const msg = await dbGet(r.insertId); // MySQL's own created_at, so Redis and MySQL match
      await cacheSetAndDel(msgKey(msg.id), msg, LIST_KEY); // cache the row, drop the stale list: one round trip
      return reply({ ok: true, data: msg, meta: meta('db'), broadcast: { event: 'message', data: msg } });
    }

    if (action === 'list') {
      const hit = await cacheGet(LIST_KEY);
      if (hit) { console.log('[message-service] list: cache HIT'); return reply({ ok: true, data: hit, meta: meta('cache') }); }
      const [rows] = await db.query(`SELECT ${COLS} FROM messages ORDER BY id DESC LIMIT 50`);
      const list = rows.reverse();
      cacheSet(LIST_KEY, list); // fill the cache in the background, don't make the user wait
      console.log('[message-service] list: cache MISS (read from MySQL)');
      return reply({ ok: true, data: list, meta: meta('db') });
    }

    if (action === 'get') {
      const id = Number(data && data.id);
      if (!id) return reply({ ok: false, error: 'invalid id' });
      const hit = await cacheGet(msgKey(id));
      if (hit) { console.log(`[message-service] get ${id}: cache HIT`); return reply({ ok: true, data: hit, meta: meta('cache') }); }
      const row = await dbGet(id);
      if (!row) return reply({ ok: false, error: 'not found' });
      cacheSet(msgKey(id), row); // fill the cache in the background
      console.log(`[message-service] get ${id}: cache MISS (read from MySQL)`);
      return reply({ ok: true, data: row, meta: meta('db') });
    }

    if (action === 'edit') {
      const id = Number(data && data.id);
      const text = cleanText(data);
      if (!id || !text) return reply({ ok: false, error: 'invalid id or text' });
      const row = await dbGet(id); // ownership check reads the database, not the cache
      if (!row) return reply({ ok: false, error: 'not found' });
      if (row.username !== user.username) return reply({ ok: false, error: 'you can only edit your own messages' });
      await db.execute('UPDATE messages SET text = ? WHERE id = ?', [text, id]); // 1. database first
      const updated = { ...row, text };
      await cacheSetAndDel(msgKey(id), updated, LIST_KEY);                         // 2. then Redis, one round trip
      console.log(`[message-service] edit ${id}: MySQL updated, Redis refreshed`);
      return reply({ ok: true, data: updated, meta: meta('db'), broadcast: { event: 'message_edited', data: updated } });
    }

    if (action === 'direct') {
      const text = cleanText(data);
      const to = String((data && data.to) || '');
      if (!text || !/^\d{9}$/.test(to)) return reply({ ok: false, error: 'need "to" (9-digit xid) and text' });
      if (to === user.xid) return reply({ ok: false, error: 'you cannot send a message to yourself' });
      const chat = await getChat(user.xid, to);
      if (!chat) return reply({ ok: false, error: `no user with xid ${to}` });
      let friendship = await getFriendship(user.xid, to);
      if (!friendship) {
        friendship = await createFriendship(user.xid, to);
      } else if (friendship.status === 'declined') {
        return reply({ ok: false, error: 'messaging this user was declined' });
      } else if (friendship.status === 'pending' && friendship.requester !== user.xid) {
        return reply({ ok: false, error: 'accept the message request before replying' });
      } else if (friendship.status === 'pending' && friendship.messagesSent >= 3) {
        return reply({ ok: false, error: 'message request limit reached; wait for acceptance' });
      } else if (friendship.status === 'pending') {
        await db.execute('UPDATE friendships SET messages_sent = messages_sent + 1 WHERE friendship_id = ?', [friendship.id]);
      }
      const msg = { uid: randomUUID(), ...chat, from: user.xid, fromName: user.username, to, text, sentAt: new Date().toISOString() };
      const request = friendship.status === 'pending';
      const friendshipMeta = friendshipView(await getFriendship(user.xid, to), user.xid);
      if (onlineUsers.has(to)) {
        console.log(`[message-service] direct ${user.xid} -> ${to}: delivered (online)`);
        return reply({
          ok: true, data: msg, meta: { ...meta('direct'), friendship: friendshipMeta },
          deliver: { to, event: 'dm', data: msg },
          ...(request && { friendshipEvent: { to, event: 'friendship:request', data: friendshipMeta } }),
        });
      }
      try {
        await holdPending(msg);
      } catch (e) {
        console.log('[message-service] Redis unavailable, storing in MySQL instead:', e.message);
        await saveToDb([msg]); // if this fails too, the catch around the handler answers "internal error"
        return reply({ ok: true, data: msg, meta: { ...meta('db'), friendship: friendshipMeta } });
      }
      console.log(`[message-service] direct ${user.xid} -> ${to}: held in Redis (offline)`);
      return reply({ ok: true, data: msg, meta: { ...meta('pending'), friendship: friendshipMeta } });
    }

    if (action === 'friendships') {
      return reply({ ok: true, data: await listFriendships(user.xid), meta: meta('db') });
    }

    if (action === 'accept' || action === 'decline') {
      const other = String((data && data.xid) || '');
      const row = await getFriendship(user.xid, other);
      if (!row) return reply({ ok: false, error: 'message request not found' });
      if (row.status !== 'pending' || row.requester === user.xid) {
        return reply({ ok: false, error: 'only an incoming pending request can be changed' });
      }
      const status = action === 'accept' ? 'accepted' : 'declined';
      await db.execute('UPDATE friendships SET status = ? WHERE friendship_id = ?', [status, row.id]);
      const view = friendshipView(await getFriendship(user.xid, other), user.xid);
      return reply({
        ok: true, data: view, meta: meta('db'),
        deliver: { to: other, event: 'friendship:update', data: { ...view, status, by: user.xid } },
      });
    }

    if (action === 'alias') {
      const other = String((data && data.xid) || '');
      const value = typeof data.alias === 'string' ? data.alias.trim() : '';
      if (value.length > 100) return reply({ ok: false, error: 'alias must be 100 characters or fewer' });
      const result = await changeAlias(user.xid, other, value || null);
      return reply({ ok: !result.error, data: result.data, error: result.error, meta: meta('db') });
    }

    reply({ ok: false, error: `unknown action "${action}"` });
  } catch (e) {
    console.log('[message-service] error:', e.message);
    reply({ ok: false, error: 'internal error' });
  }
});