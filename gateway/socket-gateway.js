const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.JWT_SECRET) console.log('[gw] WARNING: JWT_SECRET is not set, every client will be rejected');
const http = require('http');
const jwt = require('jsonwebtoken');
const sessions = require('../services/sessionStore');
const { Server } = require('socket.io');

const PORT = Number(process.env.SG_PORT) || 6000;
const SERVICE_KEY = process.env.SERVICE_KEY || 'dev-service-key';
const CALL_TIMEOUT_MS = 5000;
const DEMO_ORIGIN = process.env.DEMO_ORIGIN || 'http://localhost:3000'; // the only browser origin allowed to connect

const pools = new Map(); // service name -> list of connected service sockets
const online = new Map(); // user xid -> number of open client sockets (tabs)
const names = new Map();  // user xid -> username (for the online list shown on the pages)

// presence events go to every connected service (room 'services')
const toServices = (event, data) => io.to('services').emit(event, data);

// every page gets the online list (xid + username) whenever it changes
const onlineList = () => [...online.keys()].map((xid) => ({ xid, username: names.get(xid) }));
const sendOnlineList = () => io.to('clients').emit('presence:list', onlineList());

function status() {
  return [...pools].map(([name, list]) => ({
    service: name,
    servers: list.map((s) => ({ id: s.id, active: s.data.active, served: s.data.served })),
  }));
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/__sg/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(status(), null, 2));
  }
  if (req.url === '/demo') {
    res.writeHead(302, { Location: DEMO_ORIGIN + '/demo.html' }); // the page lives on the login origin now
    return res.end();
  }
  res.writeHead(404);
  res.end();
});
const io = new Server(httpServer, { cors: { origin: DEMO_ORIGIN } }); // browsers on other origins are refused

io.use(async (socket, next) => {
  const a = socket.handshake.auth || {};
  if (a.role === 'service') {
    if (a.key !== SERVICE_KEY || !a.name) return next(new Error('Unauthorized service'));
    Object.assign(socket.data, { role: 'service', name: a.name, active: 0, served: 0 });
    return next();
  }
  try {
    socket.data.role = 'client';
    socket.data.user = jwt.verify(a.token, process.env.JWT_SECRET);
    socket.data.watch = a.watch === true; // task 1.3: a page that only waits for "session:ended"
    if (!socket.data.user.xid) throw new Error('token has no xid (issued before users moved to MySQL): log in again');
    if (!(await sessions.isCurrent(socket.data.user.xid, socket.data.user.sid))) throw new Error('Session ended'); // task 1.4
    next();
  }    catch (e) {
    console.log('[gw] client auth failed:', e.message);
    next(new Error(e.message === 'Session ended' ? 'Session ended' : 'Unauthorized'));
  }
});

io.on('connection', (socket) => {
  if (socket.data.role === 'service') {
    const name = socket.data.name;
    if (!pools.has(name)) pools.set(name, []);
    pools.get(name).push(socket);
    console.log(`[gw] service "${name}" registered (${pools.get(name).length} in pool)`);
    socket.join('services');
    socket.emit('presence:sync', { online: [...online.keys()] }); // a (re)started service learns who is online
    // a service pushes data to one user without a client request (e.g. messages held while they were offline);
    // the answer says whether at least one of the user's tabs acknowledged it
    socket.on('push', ({ to, event, data }, cb) => {
      if (typeof cb !== 'function') cb = () => {};
      io.to('user:' + to).timeout(5000).emit(event, data, (err, acks) => cb({ delivered: Array.isArray(acks) && acks.length > 0 }));
    });
    socket.on('disconnect', () => {
      const rest = (pools.get(name) || []).filter((s) => s !== socket);
      if (rest.length) pools.set(name, rest); else pools.delete(name);
      console.log(`[gw] service "${name}" disconnected`);
    });
    return;
  }

  if (socket.data.watch) { // watch-only: no presence, no service calls; only receives session:ended
    socket.join('watch:' + socket.data.user.xid);
    return;
  }
  socket.join('clients');
  const xid = socket.data.user.xid;
  socket.join('user:' + xid); // one room per user: reaches all their tabs
  const tabs = (online.get(xid) || 0) + 1;
  online.set(xid, tabs);
  console.log(`[gw] client ${socket.data.user.username} (${xid}) connected, ${tabs} tab(s)`);
  names.set(xid, socket.data.user.username);
  if (tabs === 1) {
    toServices('presence', { xid, online: true });
    sendOnlineList(); // everyone sees the new user
  } else {
    socket.emit('presence:list', onlineList()); // the new tab gets the current list
  }

  socket.on('disconnect', () => {
    const left = (online.get(xid) || 1) - 1;
    if (left > 0) return online.set(xid, left);
    online.delete(xid);
    names.delete(xid);
    console.log(`[gw] user ${xid} offline`);
    toServices('presence', { xid, online: false });
    sendOnlineList();
  });

  // every client event is "service:action"
  socket.onAny(async (event, payload, ack) => {
    if (typeof payload === 'function') { ack = payload; payload = {}; }
    if (typeof ack !== 'function') ack = () => {};
    if (!(await sessions.isCurrent(xid, socket.data.user.sid).catch(() => false))) { // task 1.4: missed the kick (e.g. lost UDP packet)
      ack({ ok: false, error: 'Session ended' });
      socket.emit('session:ended', { reason: 'ended' });
      return socket.disconnect(true);
    }

    const [service, action] = String(event).split(':');
    const pool = pools.get(service);
    if (!action || !pool || pool.length === 0) {
      return ack({ ok: false, error: `service "${service}" is not available` });
    }

    // choose a server inside the pool: least active calls
    const svc = pool.reduce((a, b) => (b.data.active < a.data.active ? b : a));
    svc.data.active++;
    let done = false;
    const finish = (reply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      svc.data.active--;
      svc.data.served++;
      if (reply && reply.broadcast) io.to('clients').emit(reply.broadcast.event, reply.broadcast.data);
      if (reply && reply.deliver) io.to('user:' + reply.deliver.to).emit(reply.deliver.event, reply.deliver.data); // one user, all their tabs
      if (reply && reply.friendshipEvent) {
        io.to('user:' + reply.friendshipEvent.to).emit(reply.friendshipEvent.event, reply.friendshipEvent.data);
      }
      ack({ ok: !!(reply && reply.ok), data: reply && reply.data, error: reply && reply.error, meta: reply && reply.meta });
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'service timeout' }), CALL_TIMEOUT_MS);

    svc.emit('call', { action, data: payload, user: socket.data.user }, finish);
  });
});

httpServer.listen(PORT, () => console.log(`[gw] socket gateway on port ${PORT}`));

// Dgram auth events from the instances (register / login / logout), only when AUTH_EVENTS=true.
// Packets must carry a valid HMAC signature (shared SERVICE_KEY) and be at most 30 s old; others are dropped.
if (process.env.AUTH_EVENTS === 'true') {
  const dgram = require('dgram');
  const crypto = require('crypto');
  const AUTH_UDP_PORT = Number(process.env.AUTH_UDP_PORT) || 4001;
  const authSock = dgram.createSocket('udp4');

  authSock.on('message', (msg) => {
    let packet, event;
    try { packet = JSON.parse(msg); event = JSON.parse(packet.body); } catch { return; } // not ours: ignore
    const expected = crypto.createHmac('sha256', SERVICE_KEY).update(packet.body).digest('hex');
    const ok = typeof packet.sig === 'string' && packet.sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(packet.sig), Buffer.from(expected));
    if (!ok) return console.log('[gw] auth event rejected: bad signature');
    if (!(Math.abs(Date.now() - event.at) <= 30000)) return console.log('[gw] auth event rejected: too old');
    console.log(`[gw] auth event: ${event.type} ${event.xid} from ${event.instance || 'unknown'}`);
    // task 1.3: one device per user. On "login": end this user's sockets from an OLDER session (different sid).
    // On "logout": end the other tabs of that same session. The page shows why and returns to the login page.
    if (event.type === 'login' && event.sid) sessions.remember(event.xid, event.sid); // task 1.4: instant, no 5 s wait
    if (event.type === 'logout') sessions.forget(event.xid);
    if ((event.type === 'login' || event.type === 'logout') && event.xid && event.sid) {
      io.in(['user:' + event.xid, 'watch:' + event.xid]).fetchSockets().then((sockets) => {
        const stale = sockets.filter((s) => event.type === 'login' ? s.data.user.sid !== event.sid : s.data.user.sid === event.sid);
        stale.forEach((s) => { s.emit('session:ended', { reason: event.type === 'login' ? 'new_login' : 'logout' }); s.disconnect(true); });
        if (stale.length) console.log(`[gw] ${event.xid}: ${stale.length} socket(s) of an ended session disconnected (${event.type})`);
      });
    }
  });
  authSock.on('error', (e) => console.log('[gw] auth events error:', e.message));
  authSock.bind(AUTH_UDP_PORT, '127.0.0.1', () => console.log(`[gw] auth events on udp 127.0.0.1:${AUTH_UDP_PORT}`));
}