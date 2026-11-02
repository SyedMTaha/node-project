// End-to-end check of the practice system. Prints PASS / FAIL / SKIP per step, exit code 0 (no FAIL) or 1.
// Needs: cluster + balancer, socket gateway + message service. Steps 5-7 test direct messages. See commands.md section 10f.
require('dotenv').config();
const { exec } = require('child_process');
const { promisify } = require('util');
const { io } = require('socket.io-client');
const Redis = require('ioredis');
const db = require('../services/db');

const BASE = process.env.BASE_URL || 'http://localhost:3000'; // balancer
const SG = process.env.SG_URL || 'http://localhost:6000';     // socket gateway
const TEST_FAILOVER = process.env.TEST_FAILOVER === 'true';
const TEST_UDP = process.env.TEST_UDP === 'true';
const TEST_DB_PATH = process.env.TEST_DB_PATH === 'true';            // step 7: needs T4 with short PENDING_MAX_S
const DB_PATH_WAIT_S = Number(process.env.DB_PATH_WAIT_S) || 40;     // PENDING_MAX_S (30) + MOVER_INTERVAL_S (5) + margin

const results = [];
const pass = (detail, value) => ({ status: 'PASS', detail, value });
const fail = (detail) => ({ status: 'FAIL', detail });
const skip = (detail) => ({ status: 'SKIP', detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lbStatus = async () => (await fetch(BASE + '/__lb/status')).json();

// runs one step, prints one line, never throws
async function step(n, name, fn) {
  let r;
  try { r = await fn(); } catch (e) { r = fail((e.cause && e.cause.code) || e.message); }
  results.push(r.status);
  console.log(`[${n}] ${name.padEnd(40, '.')} ${r.status}${r.detail ? '  ' + r.detail : ''}`);
  return r.value;
}

function connect(url, token) {
  return new Promise((resolve, reject) => {
    const s = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5000 });
    s.on('server_info', (i) => { s.instance = i.instance; });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => { s.close(); reject(e); });
  });
}

function call(s, event, data) {
  return new Promise((resolve) =>
    s.timeout(8000).emit(event, data, (err, reply) => resolve(err ? { ok: false, error: 'no reply in 8 s' } : reply)));
}

// resolves with the event's arguments when `event` arrives (and `test` accepts it), or null after ms
function waitFor(s, event, ms, test = () => true) {
  return new Promise((resolve) => {
    const h = (...args) => { if (test(...args)) { clearTimeout(t); s.off(event, h); resolve(args); } };
    const t = setTimeout(() => { s.off(event, h); resolve(null); }, ms);
    s.on(event, h);
  });
}

// connects user B and catches the first dm:pending batch, acknowledging it like the Messaging page does
function connectAndCollect(url, token, ms) {
  return new Promise((resolve, reject) => {
    const s = io(url, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5000 });
    const t = setTimeout(() => resolve({ s, list: null }), ms);
    s.once('dm:pending', (list, ack) => { if (typeof ack === 'function') ack('received'); clearTimeout(t); resolve({ s, list }); });
    s.once('connect_error', (e) => { clearTimeout(t); s.close(); reject(e); });
  });
}

async function registerUser(username) {
  const res = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'Integration1!' }),
  });
  if (res.status !== 201) throw new Error(`register ${username} returned ${res.status}`);
  const { token, user } = await res.json();
  return { token, xid: user.xid };
}

async function loginUser(username) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'Integration1!' }),
  });
  if (res.status !== 200) throw new Error(`login ${username} returned ${res.status}`);
  return (await res.json()).token;
}

// task 1.4: a second login ends the first session in the API and the gateway. Other processes may still
// answer from their 5 s session cache, so the old token is retried for up to 8 s before the step fails.
async function singleDevice() {
  const username = 'it' + Date.now() + 'c';
  const first = await registerUser(username);
  const old = await connect(SG, first.token);                  // device 1, connected to the gateway
  const told = waitFor(old, 'session:ended', 3000);           // arrives only with AUTH_EVENTS=true
  const second = await loginUser(username);                    // device 2
  const me = (t) => fetch(BASE + '/api/auth/me', { headers: { Authorization: 'Bearer ' + t } }).then((r) => r.status);

  let api = 0;
  for (const end = Date.now() + 8000; Date.now() < end; await sleep(500)) { api = await me(first.token); if (api === 401) break; }
  let gw = 'accepted';
  for (const end = Date.now() + 8000; Date.now() < end; await sleep(500)) {
    gw = await connect(SG, first.token).then((s) => { s.close(); return 'accepted'; }, (e) => e.message);
    if (gw !== 'accepted') break;
  }
  const newApi = await me(second);
  const kicked = !!(await told);
  old.close();
  const detail = `old token: API ${api}, gateway "${gw}"; new token: API ${newApi}; old socket told: ${kicked ? 'yes' : 'no (AUTH_EVENTS off)'}`;
  return api === 401 && gw === 'Session ended' && newApi === 200 ? pass(detail) : fail(detail);
}

// ---------- steps ----------
async function registerAndLogin() {
  const username = 'it' + Date.now(); // new user every run
  const body = JSON.stringify({ username, password: 'Integration1!' });
  const json = { 'Content-Type': 'application/json' };

  const reg = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: json, body });
  if (reg.status === 429) return fail('register rate-limited (429): start the cluster with RATE_LIMIT_DISABLED=true');
  if (reg.status !== 201) return fail(`register returned ${reg.status}`);
  const regBy = reg.headers.get('x-served-by');
  const cookie = reg.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('lb_instance='));

  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { ...json, ...(cookie && { Cookie: cookie }) }, body });
  const loginBy = login.headers.get('x-served-by');
  if (login.status !== 200) {
    return fail(`login returned ${login.status} (register on ${regBy}, login on ${loginBy}; users are per instance, run the balancer with ALGO=ip-hash)`);
  }
  const { token } = await login.json();
  return pass(`user ${username}, register on ${regBy}, login on ${loginBy}`, { token, port: Number(String(regBy).replace('instance-', '')) });
}

async function socketViaBalancer(token) {
  const s = await connect(BASE, token);
  await sleep(300); // give server_info time to arrive
  const detail = `socket ${s.id} on ${s.instance || 'unknown instance'}`;
  s.close();
  return pass(detail);
}

async function sendAndList(gw) {
  const text = 'integration test ' + new Date().toISOString();
  const sent = await call(gw, 'message:send', { text });
  if (!sent.ok) return fail('send: ' + sent.error);
  const id = sent.data.id;
  const list = await call(gw, 'message:list', {});
  if (!list.ok) return fail('list: ' + list.error);
  const found = list.data.some((m) => m.id === id && m.text === text);
  return found ? pass(`message #${id} stored in MySQL and listed`, id) : fail(`list did not contain #${id}`);
}

async function cacheFlow(gw, id) {
  const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });
  try { await redis.del(`message:${id}`); } finally { redis.quit(); } // force the next get to be a MISS

  const src = (r) => (r.ok && r.meta ? r.meta.source : 'error');
  const g1 = await call(gw, 'message:get', { id });                    // expect db (MISS)
  const g2 = await call(gw, 'message:get', { id });                    // expect cache (HIT)
  const newText = 'edited by integration test';
  const ed = await call(gw, 'message:edit', { id, text: newText });    // expect ok
  const g3 = await call(gw, 'message:get', { id });                    // expect cache with new text

  const detail = `get=${src(g1)} get=${src(g2)} edit=${ed.ok ? 'ok' : ed.error} get=${src(g3)} "${g3.ok ? g3.data.text : g3.error}"`;
  const ok = src(g1) === 'db' && src(g2) === 'cache' && ed.ok && src(g3) === 'cache' && g3.data.text === newText;
  return ok ? pass(detail) : fail(detail);
}

async function directOnline(a, b, bXid) {
  const arrived = waitFor(b, 'dm', 3000);
  const r = await call(a, 'message:direct', { to: bXid, text: 'it direct ' + Date.now() });
  if (!r.ok) return fail('send: ' + r.error);
  const got = await arrived;
  const src = r.meta && r.meta.source;
  if (src === 'direct' && got && got[0].uid === r.data.uid) return pass(`source=direct, B received it (chatid_${String(r.data.chatId).padStart(2, '0')})`);
  return fail(`source=${src}, B received ${got ? 'a different message' : 'nothing in 3 s'}`);
}

// Story 2: after delivery no copy may remain (Redis pending:<xid> and the MySQL row). '' = nothing left
async function nothingLeft(xid, uid, waitMs = 5000) {
  const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });
  try {
    const end = Date.now() + waitMs;
    for (;;) {
      const inRedis = (await redis.zrange(`pending:${xid}`, 0, -1)).some((x) => x.includes(uid));
      const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM direct_messages WHERE msg_uid = ?', [uid]);
      if (!inRedis && n === 0) return '';
      if (Date.now() > end) return 'still in ' + [inRedis && 'Redis', n && 'MySQL'].filter(Boolean).join(' + ');
      await sleep(250);
    }
  } finally { redis.quit(); }
}

// B goes offline, A sends, (optionally wait for the mover), B comes back: checks where it came from + the receipt.
// The result's value is B's new socket.
async function heldThenDelivered(a, bSocket, bToken, bXid, waitS, expectVia) {
  bSocket.close();
  await sleep(500); // let the "offline" presence event reach the message service
  const r = await call(a, 'message:direct', { to: bXid, text: `it ${expectVia} ` + Date.now() });
  if (!r.ok) return fail('send: ' + r.error);
  if (!r.meta || r.meta.source !== 'pending') return fail(`expected source=pending, got ${r.meta && r.meta.source}`);
  if (waitS) { console.log(`    waiting ${waitS} s for the mover (T4 must run with a short PENDING_MAX_S)...`); await sleep(waitS * 1000); }
  const receipt = waitFor(a, 'dm:delivered', 10000, (d) => !!(d && d.uids && d.uids.includes(r.data.uid)));
  const { s, list } = await connectAndCollect(SG, bToken, 10000);
  const m = list && list.find((x) => x.uid === r.data.uid);
  const gotReceipt = !!(await receipt);
  const left = m ? await nothingLeft(bXid, r.data.uid) : 'not delivered';
  const detail = `held, B got it via=${m ? m.via : 'nothing'}, receipt to A: ${gotReceipt ? 'yes' : 'no'}, left: ${left || 'nothing'}`;
  return m && m.via === expectVia && gotReceipt && !left ? pass(detail, s) : { ...fail(detail), value: s };
}

// Windows: stop the process listening on the port (same as commands.md section 1).
// Async on purpose: execSync froze the test for ~2 s, and fetch then reused a connection the balancer had closed (ECONNRESET).
async function stopInstance(port) {
  await promisify(exec)(`powershell -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess"`);
}

async function failover(port) {
  const served = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(BASE + '/api/health');
    served.push(r.status === 200 ? r.headers.get('x-served-by') : 'HTTP ' + r.status);
  }
  const ok = served.every((s) => s && s.startsWith('instance-') && s !== `instance-${port}`);
  return ok ? pass('served by ' + served.join(', ')) : fail(served.join(', '));
}

async function udpDown(port, stoppedAt) {
  const first = await lbStatus();
  if (!('udp' in first.instances[0])) return fail('balancer is not running with UDP_HEARTBEAT=true');
  while (Date.now() - stoppedAt < 8000) {
    const t = (await lbStatus()).instances.find((i) => i.port === port);
    if (t && t.udp === false) return pass(`udp DOWN ${((Date.now() - stoppedAt) / 1000).toFixed(1)} s after stop`);
    await sleep(250);
  }
  return fail('no udp DOWN within 8 s');
}

// ---------- main ----------
(async () => {
  let algo = 'unknown';
  try { algo = (await lbStatus()).algorithm; } catch { /* step 1 will report it */ }
  console.log(`Integration test  balancer ${BASE} (${algo})  gateway ${SG}\n`);

  const user = await step(1, 'register + login via balancer', registerAndLogin);
  const token = user && user.token;
  await step(2, 'Socket.IO connect via balancer', () => (token ? socketViaBalancer(token) : skip('no token (step 1 failed)')));

  let gw = null;
  const id = await step(3, 'gateway: send -> MySQL -> list', async () => {
    if (!token) return skip('no token (step 1 failed)');
    gw = await connect(SG, token);
    return sendAndList(gw);
  });
  await step(4, 'cache: MISS, HIT, edit, new text', () => (id ? cacheFlow(gw, id) : skip('no message id (step 3 failed)')));

  // direct messages: A = the user from step 1 (socket gw), B = a new user
  let b = null, bUser = null;
  await step(5, 'direct: online -> delivered at once', async () => {
    if (!gw) return skip('no gateway connection (step 3 failed)');
    bUser = await registerUser('it' + Date.now() + 'b');
    b = await connect(SG, bUser.token);
    await sleep(300); // presence "online" reaches the message service
    return directOnline(gw, b, bUser.xid);
  });
  await step(6, 'direct: offline -> Redis -> delivered', async () => {
    if (!b) return skip('no user B (step 5 failed)');
    const r = await heldThenDelivered(gw, b, bUser.token, bUser.xid, 0, 'redis');
    b = r.value || null; // B's new socket
    return r;
  });
  await step(7, 'direct: > 5 min -> MySQL -> delivered', async () => {
    if (!TEST_DB_PATH) return skip('set TEST_DB_PATH=true, T4 with PENDING_MAX_S=30 MOVER_INTERVAL_S=5');
    if (!b) return skip('no user B (step 6 failed)');
    const r = await heldThenDelivered(gw, b, bUser.token, bUser.xid, DB_PATH_WAIT_S, 'db');
    b = r.value || null;
    return r;
  });
  if (b) b.close();
  if (gw) gw.close();

  const port = Number(process.env.STOP_PORT) || (user && user.port) || 3002;
  let stoppedAt = 0;
  let stopError = '';
  if (TEST_FAILOVER || TEST_UDP) {
    try { await stopInstance(port); stoppedAt = Date.now(); } catch (e) { stopError = `could not stop ${port}: ${e.message.split('\n')[0]}`; }
  }
  await step(8, `failover with ${port} stopped`, () =>
    !TEST_FAILOVER ? skip('set TEST_FAILOVER=true') : stopError ? fail(stopError) : failover(port));
  await step(9, `UDP heartbeat marks ${port} DOWN`, () =>
    !TEST_UDP ? skip('set TEST_UDP=true') : stopError ? fail(stopError) : udpDown(port, stoppedAt));
  await step(10, 'single-device login (old token refused)', singleDevice);

  const count = (s) => results.filter((r) => r === s).length;
  console.log(`\nSummary: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
  if (stoppedAt) console.log(`Instance ${port} was stopped. Restart it (same env as the cluster): node scripts/start-instances.js ${port}`);
  process.exit(count('FAIL') ? 1 : 0);
})();
