// One active session per user (table `sessions`, one row per user). A new login overwrites the row,
// so the previous sid is no longer current. Task 1.4 will reject tokens whose sid is not current.
const { randomUUID } = require('crypto');
const db = require('./db');

// starts a new session and replaces the previous one in one atomic statement. `place` = { country, city } of this login.
// Returns the new sid and the replaced session's place and start time (null if there was none), for the new device's notice.
exports.start = async (xid, place = {}) => {
  const sid = randomUUID();
  const country = place.country || null;
  const city = place.city || null;
  const [old] = await db.execute('SELECT country, city, created_at AS since FROM sessions WHERE user_xid = ?', [xid]);
  await db.execute(
    'INSERT INTO sessions (user_xid, sid, country, city) VALUES (?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE sid = ?, country = ?, city = ?, created_at = CURRENT_TIMESTAMP(3)',
    [xid, sid, country, city, sid, country, city]);
  exports.remember(xid, sid);
  return { sid, previous: old[0] || null };
};

// ends the session only if it is still the current one (an old device's logout must not end the new session)
exports.end = async (xid, sid) => {
  const [r] = await db.execute('DELETE FROM sessions WHERE user_xid = ? AND sid = ?', [xid, sid]);
  if (r.affectedRows) exports.forget(xid);
  return r.affectedRows === 1;
};

// task 1.4: is this sid still the user's current session? Answered from a short in-memory cache
// (SESSION_CACHE_MS, default 5 s), so a busy user does not cost one MySQL query per request.
const CACHE_MS = Number(process.env.SESSION_CACHE_MS) || 5000;
const cache = new Map(); // xid -> { sid (null = no session), at }

exports.isCurrent = async (xid, sid) => {
  if (!xid || !sid) return false; // tokens from before task 1.2 have no sid
  const hit = cache.get(xid);
  if (hit && hit.sid === sid && Date.now() - hit.at < CACHE_MS) return true; // trust only a match: a mismatch may be a stale cache
  const [rows] = await db.execute('SELECT sid FROM sessions WHERE user_xid = ?', [xid]);
  const current = rows.length ? rows[0].sid : null;
  cache.set(xid, { sid: current, at: Date.now() });
  return current === sid;
};

// a process that learns about a new session (a login here, or a login event in the gateway) updates its cache at once
exports.remember = (xid, sid) => cache.set(xid, { sid, at: Date.now() });
exports.forget = (xid) => cache.delete(xid); // next check reads MySQL
