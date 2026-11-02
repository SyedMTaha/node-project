const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');

const PORT = Number(process.env.LB_PORT) || 3000;
const ALGO = (process.env.ALGO || 'round-robin').toLowerCase(); // 'round-robin', 'least-connections', 'ip-hash' or 'fill-first'
const HARD_LIMIT = process.env.HARD_LIMIT !== 'false'; // fill-first: do not exceed capacity
const QUEUE_MAX = process.env.QUEUE_MAX !== undefined ? Number(process.env.QUEUE_MAX) : 100; // 0 = reject instead of queue
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS) || 15000;
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS) || 5000;
const CHECK_TIMEOUT_MS = 2000;
const FAILS_TO_DOWN = 2;
const STICKY = ['ip-hash', 'fill-first'].includes(ALGO);
const UDP_HEARTBEAT = process.env.UDP_HEARTBEAT === 'true';
const UDP_PORT = Number(process.env.UDP_PORT) || 4000;
const UDP_TIMEOUT_MS = Number(process.env.UDP_TIMEOUT_MS) || 3000;
const DEMO_GATEWAY_URL = process.env.DEMO_GATEWAY_URL || 'http://localhost:6100'; // socket gateway used by the demo pages
const TRUST_UPSTREAM_PROXY = process.env.TRUST_UPSTREAM_PROXY === 'true';

function forwardedClientIp(req) {
  if (TRUST_UPSTREAM_PROXY && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

function cookiePort(req) {
  const m = /(?:^|;\s*)lb_instance=(\d+)/.exec(req.headers.cookie || '');
  return m ? Number(m[1]) : null;
}

// the instance named by the cookie, if it is healthy and not already tried
function pinnedTarget(req, tried) {
  if (!STICKY) return null;
  const port = cookiePort(req);
  if (!port) return null;
  const t = targets.find((x) => x.port === port);
  return t && isUp(t) && !tried.includes(t) ? t : null;
}

//childrens list 
const targets = (process.env.TARGETS || '3001,3002,3003').split(',').map((p) => ({
  host: '127.0.0.1',
  port: Number(p.trim()),
  healthy: true,
  fails: 0,
  active: 0,      // requests in flight (WebSockets count for their whole life)
  served: 0,      // requests the backend actually answered
  connections: 0, // Socket.IO connections reported by the instance
  capacity: 0,    // MAX_CONN reported by the instance
  pending: 0,     // connections assigned since the last health check
  udpAlive: true,        // UDP heartbeat signal (only used when UDP_HEARTBEAT=true)
  lastSeen: Date.now(),  // time of the last heartbeat; starting at now gives a grace period
}));

const queue = [];
const sseClients = new Set();
function emitEvent(ev) {
  if (!sseClients.size) return;
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  sseClients.forEach((res) => res.write(line));
}
const stats = { admittedFromQueue: 0, refused: 0, timedOut: 0 };
let last = -1;

const load = (t) => t.connections + t.pending;
// usable only if the HTTP check AND (when enabled) the UDP heartbeat both say alive
const isUp = (t) => t.healthy && (!UDP_HEARTBEAT || t.udpAlive);
const hasFree = () => targets.some((t) => isUp(t) && load(t) < t.capacity);
const anyHealthy = () => targets.some(isUp);

function hashIp(ip) {
  let h = 0;
  for (const ch of String(ip)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}


//check algo and return child which should get the request
function pickTarget(exclude = [], clientIp = '', isSocket = false) {
  const usable = (t) => isUp(t) && !exclude.includes(t);
  const candidates = targets.filter(usable);
  if (candidates.length === 0) return null;

  if (ALGO === 'fill-first') {
    const free = candidates.find((t) => load(t) < t.capacity);
    if (!free && isSocket && HARD_LIMIT) return null; // everything is full
    const chosen = free || candidates.reduce((a, b) => (load(a) <= load(b) ? a : b));
    if (isSocket) chosen.pending++;
    return chosen;
  }

  if (ALGO === 'ip-hash') {
    return candidates[hashIp(clientIp) % candidates.length];
  }

  if (ALGO === 'least-connections') {
    return candidates.reduce((best, t) =>
      t.active < best.active || (t.active === best.active && t.served < best.served) ? t : best);
  }

  // round-robin
  for (let i = 1; i <= targets.length; i++) {
    const idx = (last + i) % targets.length;
    if (usable(targets[idx])) {
      last = idx;
      return targets[idx];
    }
  }
  return null;
}


//ask for api health and update 
function markUp(t) {
  if (!t.healthy) console.log(`[lb] instance ${t.port} is back UP`);
  t.healthy = true;
  t.fails = 0;
}

function markFailure(t) {
  t.fails++;
  if (t.healthy && t.fails >= FAILS_TO_DOWN) {
    t.healthy = false;
    console.log(`[lb] instance ${t.port} marked DOWN after ${t.fails} failures`);
  }
}

function checkHealth(t) {
  const req = http.get(
    { host: t.host, port: t.port, path: '/api/health', timeout: CHECK_TIMEOUT_MS },
    (res) => {
      if (res.statusCode !== 200) { res.resume(); return markFailure(t); }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          t.connections = j.connections || 0;
          t.capacity = j.capacity || 0;
          t.pending = 0;
        } catch { /* keep the old numbers */ }
        markUp(t);
        drainQueue(); // new capacity may have appeared
      });
    }
  );
  req.on('timeout', () => req.destroy(new Error('health check timeout')));
  req.on('error', () => markFailure(t));
}

// ---------- UDP heartbeats (only when UDP_HEARTBEAT=true) ----------
function onHeartbeat(msg) {
  let beat;
  try { beat = JSON.parse(msg); } catch { return; } // ignore bad packets
  const t = targets.find((x) => x.port === Number(beat && beat.port));
  if (!t) return; // not one of our instances
  t.connections = Number(beat.connections) || 0;
  t.capacity = Number(beat.capacity) || 0;
  t.pending = 0; // fresh numbers from the instance, like the HTTP check
  t.lastSeen = Date.now();
  if (!t.udpAlive) {
    t.udpAlive = true;
    console.log(`[lb] udp: ${t.port} UP`);
  }
  drainQueue(); // new capacity may have appeared
}

function checkHeartbeats() {
  const now = Date.now();
  targets.forEach((t) => {
    if (t.udpAlive && now - t.lastSeen > UDP_TIMEOUT_MS) {
      t.udpAlive = false;
      console.log(`[lb] udp: ${t.port} DOWN (no heartbeat ${((now - t.lastSeen) / 1000).toFixed(1)}s)`);
    }
  });
}

// ---------- queue for socket connections ----------
function removeFromQueue(entry) {
  const i = queue.indexOf(entry);
  if (i !== -1) queue.splice(i, 1);
}

function enqueue(req, socket, head, front = false) {
  if (queue.length >= QUEUE_MAX) {
    stats.refused++;
    console.log('[lb] queue full: refusing socket connection');
    return socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
  }
  const entry = { req, socket, head, since: Date.now() };
  entry.timer = setTimeout(() => {
    removeFromQueue(entry);
    stats.timedOut++;
    console.log('[lb] queued socket timed out');
    socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n');
  }, QUEUE_TIMEOUT_MS);
  entry.onClose = () => { clearTimeout(entry.timer); removeFromQueue(entry); };
  socket.once('close', entry.onClose);
  socket.on('error', () => socket.destroy());
  if (front) queue.unshift(entry); else queue.push(entry);
  console.log(`[lb] all instances full: socket queued (${queue.length} waiting)`);
}

function drainQueue() {
  while (queue.length && hasFree()) {
    const entry = queue.shift();
    clearTimeout(entry.timer);
    entry.socket.removeListener('close', entry.onClose);
    if (entry.socket.destroyed) continue;
    stats.admittedFromQueue++;
    console.log(`[lb] slot free: admitting queued socket (${queue.length} still waiting)`);
    forwardUpgrade(entry.req, entry.socket, entry.head, [], true);
  }
}

// ---------- normal HTTP request  ----------
function forward(clientReq, clientRes, body, tried = []) {
  const target = pinnedTarget(clientReq, tried) || pickTarget(tried, clientReq.socket.remoteAddress);
  if (!target) {
    clientRes.writeHead(503, { 'Content-Type': 'application/json' });
    return clientRes.end(JSON.stringify({ error: 'No healthy backend instance available' }));
  }

  target.active++;
  let finished = false;
  const done = () => { if (!finished) { finished = true; target.active--; } };
  clientRes.on('close', done);

  const proxyReq = http.request(
    {
      host: target.host,
      port: target.port,
      method: clientReq.method,
      path: clientReq.url,
      headers: {
        ...clientReq.headers,
        'x-forwarded-for': forwardedClientIp(clientReq),
        'x-forwarded-host': clientReq.headers.host,
      },
    },
    (proxyRes) => {
      target.served++;
      emitEvent({ type: 'http', port: target.port });
      const headers = { ...proxyRes.headers };
      if (STICKY && cookiePort(clientReq) !== target.port) {
        const c = `lb_instance=${target.port}; Path=/; HttpOnly; SameSite=Lax`;
        headers['set-cookie'] = headers['set-cookie'] ? [].concat(headers['set-cookie'], c) : [c];
      }
      clientRes.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(clientRes);
      proxyRes.on('end', done);
      proxyRes.on('error', done);
    }
  );

  proxyReq.on('error', (err) => {
    done();
    markFailure(target);
    // ECONNREFUSED: nothing is listening. ECONNRESET: a reused (keep-alive) connection to an instance that just stopped.
    // Retry on another instance only if nothing reached the client yet; on ECONNRESET only GET/HEAD
    // (the instance may already have handled a POST, so retrying could register or send twice).
    const safe = clientReq.method === 'GET' || clientReq.method === 'HEAD';
    const canRetry = !clientRes.headersSent && tried.length < targets.length - 1 &&
      (err.code === 'ECONNREFUSED' || (err.code === 'ECONNRESET' && safe));
    if (canRetry) {
      console.log(`[lb] instance ${target.port}: ${err.code}, retrying ${clientReq.method} ${clientReq.url} on another instance`);
      return forward(clientReq, clientRes, body, [...tried, target]);
    }
    console.log(`[lb] instance ${target.port}: ${err.code || err.message} on ${clientReq.method} ${clientReq.url}, not retried`);
    if (clientRes.headersSent) return clientRes.destroy();
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'Bad gateway: backend unavailable', instance: target.port }));
  });

  proxyReq.end(body);
}

// ---------- WebSocket / Socket.IO upgrade ----------
function forwardUpgrade(req, clientSocket, head, tried = [], fromQueue = false) {
  const pin = pinnedTarget(req, tried);
  const target = pin || pickTarget(tried, req.socket.remoteAddress, true);
  if (pin) pin.pending++; // pickTarget wasn't used, so count this socket here
  if (!target) {
    const allFull = ALGO === 'fill-first' && HARD_LIMIT && tried.length === 0 && anyHealthy();
    if (allFull && QUEUE_MAX > 0) return enqueue(req, clientSocket, head, fromQueue);
    stats.refused++;
    console.log('[lb] no instance available for this socket: refusing');
    clientSocket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }

  const upstream = net.connect(target.port, target.host);
  let connected = false;
  let retrying = false;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    if (connected) {
      target.active--;
      // free the slot right away; the next health check corrects the number
      if (target.pending > 0) target.pending--;
      else if (target.connections > 0) target.connections--;
      drainQueue();
    }
  };

  clientSocket.on('error', () => upstream.destroy());
  clientSocket.on('close', () => upstream.destroy());

  upstream.on('connect', () => {
    connected = true;
    target.active++;
    target.served++;
    emitEvent({ type: 'socket', port: target.port });

    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === 'x-forwarded-for') continue;
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    raw += `X-Forwarded-For: ${forwardedClientIp(req)}\r\n\r\n`;
    upstream.write(raw);
    if (head && head.length) upstream.write(head);

    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (err) => {
    if (!connected) {
      markFailure(target);
      if (err.code === 'ECONNREFUSED' && tried.length < targets.length - 1) {
        console.log(`[lb] instance ${target.port} refused the upgrade, retrying on another instance`);
        retrying = true;
        return forwardUpgrade(req, clientSocket, head, [...tried, target]);
      }
    }
    clientSocket.destroy();
  });

  upstream.on('close', () => {
    if (retrying) return;
    done();
    clientSocket.destroy();
  });
}
 

// ask the socket gateway for its status (server side, so the browser needs no CORS); never throws
function gatewayStatus() {
  return new Promise((resolve) => {
    const down = { up: false, url: DEMO_GATEWAY_URL, services: [] };
    const req = http.get(DEMO_GATEWAY_URL + '/__sg/status', { timeout: 1000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const list = JSON.parse(data);
          resolve({ up: true, url: DEMO_GATEWAY_URL, services: list.map((s) => ({ name: s.service, servers: s.servers.length })) });
        } catch { resolve(down); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(down));
  });
}

//main entry point and send everything to forward function
const server = http.createServer((clientReq, clientRes) => {
  if (clientReq.url === '/') {
    return fs.readFile(path.join(__dirname, 'home.html'), (err, html) => {
      if (err) { clientRes.writeHead(404); return clientRes.end('home.html not found'); }
      clientRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      clientRes.end(html);
    });
  }
  if (clientReq.url === '/demo' || clientReq.url === '/demo.html') {
    return fs.readFile(path.join(__dirname, '..', 'gateway', 'demo.html'), (err, html) => {
      if (err) { clientRes.writeHead(404); return clientRes.end('demo.html not found'); }
      clientRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      clientRes.end(html);
    });
  }
  if (clientReq.url === '/__lb/demo-status') {
    return gatewayStatus().then((gateway) => {
      clientRes.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      clientRes.end(JSON.stringify({
        balancer: { up: true, algorithm: ALGO, instancesUp: targets.filter(isUp).length, instancesTotal: targets.length },
        gateway,
      }));
    });
  }
  if (clientReq.url === '/dashboard' || clientReq.url === '/dashboard.html') {
    return fs.readFile(path.join(__dirname, 'dashboard.html'), (err, html) => {
      if (err) { clientRes.writeHead(404); return clientRes.end('dashboard.html not found'); }
      clientRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      clientRes.end(html);
    });
  }
    if (clientReq.url === '/__lb/events') {
    clientRes.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    clientRes.write(': connected\n\n');
    sseClients.add(clientRes);
    clientReq.on('close', () => sseClients.delete(clientRes));
    return;
  }
  if (clientReq.url === '/__lb/status') {
    clientRes.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return clientRes.end(JSON.stringify({
      algorithm: ALGO,
      instances: targets.map((t) => ({
        port: t.port, healthy: isUp(t), active: t.active, served: t.served, connections: t.connections, capacity: t.capacity,
        ...(UDP_HEARTBEAT && { http: t.healthy, udp: t.udpAlive, heartbeatAgoMs: Date.now() - t.lastSeen }),
      })),
      queue: {
        waiting: queue.length,
        max: QUEUE_MAX,
        timeoutMs: QUEUE_TIMEOUT_MS,
        oldestWaitMs: queue.length ? Date.now() - queue[0].since : 0,
        ...stats,
      },
    }, null, 2));
  }

  const chunks = [];
  clientReq.on('data', (c) => chunks.push(c));
  clientReq.on('end', () => forward(clientReq, clientRes, Buffer.concat(chunks)));
});

server.on('upgrade', (req, socket, head) => forwardUpgrade(req, socket, head));

targets.forEach(checkHealth);
setInterval(() => targets.forEach(checkHealth), CHECK_INTERVAL_MS);

if (UDP_HEARTBEAT) {
  const udp = dgram.createSocket('udp4');
  udp.on('message', onHeartbeat);
  udp.on('error', (e) => { console.log(`[lb] udp error: ${e.message} (is udp-listen.js still running?)`); process.exit(1); });
  udp.bind(UDP_PORT, '127.0.0.1', () => console.log(`[lb] UDP heartbeats on 127.0.0.1:${UDP_PORT} (timeout ${UDP_TIMEOUT_MS} ms)`));
  setInterval(checkHeartbeats, 1000);
}


//starts the server 
server.listen(PORT, () => {
  console.log(`[lb] listening on http://localhost:${PORT} (${ALGO}, queue max ${QUEUE_MAX})`);
  console.log(`[lb] instances: ${targets.map((t) => t.port).join(', ')}`);
});