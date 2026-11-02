const http = require('http');

const PORT = Number(process.env.GW_PORT) || 5000;
const ALGO = (process.env.GW_ALGO || 'least-connections').toLowerCase(); // or 'round-robin'
const CHECK_MS = 3000;
const FAILS_TO_DOWN = 2;

// Route table from the environment, e.g. "cache=4001;upload=4002,4003"
const pools = {};
(process.env.SERVICES || 'cache=4001;upload=4002,4003').split(';').forEach((part) => {
  const [name, ports] = part.split('=');
  pools[name.trim()] = {
    name: name.trim(),
    rr: -1,
    servers: ports.split(',').map((p) => ({
      host: '127.0.0.1', port: Number(p.trim()), healthy: true, fails: 0, active: 0, served: 0,
    })),
  };
});

// Step 2: choose a server inside one pool
function pick(pool, exclude = []) {
  const ok = pool.servers.filter((s) => s.healthy && !exclude.includes(s));
  if (ok.length === 0) return null;
  if (ALGO === 'round-robin') {
    pool.rr = (pool.rr + 1) % ok.length;
    return ok[pool.rr];
  }
  return ok.reduce((a, b) => (b.active < a.active ? b : a)); // least connections
}

function check(s) {
  const req = http.get({ host: s.host, port: s.port, path: '/health', timeout: 2000 }, (res) => {
    res.resume();
    if (res.statusCode === 200) {
      if (!s.healthy) console.log(`[gw] ${s.port} is back UP`);
      s.healthy = true; s.fails = 0;
    } else fail(s);
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => fail(s));
}
function fail(s) {
  s.fails++;
  if (s.healthy && s.fails >= FAILS_TO_DOWN) {
    s.healthy = false;
    console.log(`[gw] ${s.port} marked DOWN`);
  }
}
Object.values(pools).forEach((p) => p.servers.forEach(check));
setInterval(() => Object.values(pools).forEach((p) => p.servers.forEach(check)), CHECK_MS);

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
}

function forward(req, res, body, pool, tried = []) {
  const s = pick(pool, tried);
  if (!s) return json(res, 503, { error: `no healthy server in pool "${pool.name}"` });

  s.active++;
  let released = false;
  const release = () => { if (!released) { released = true; s.active--; } };
  res.on('close', release);

  const proxyReq = http.request(
    { host: s.host, port: s.port, method: req.method, path: req.url, headers: req.headers },
    (proxyRes) => {
      s.served++;
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on('end', release);
      proxyRes.on('error', release);
    }
  );
  proxyReq.on('error', (err) => {
    release();
    fail(s);
    if (err.code === 'ECONNREFUSED' && tried.length < pool.servers.length - 1) {
      return forward(req, res, body, pool, [...tried, s]);
    }
    if (res.headersSent) return res.destroy();
    json(res, 502, { error: 'bad gateway', port: s.port });
  });
  proxyReq.end(body);
}

http.createServer((req, res) => {
  if (req.url === '/__gw/status') {
    return json(res, 200, {
      algorithm: ALGO,
      pools: Object.values(pools).map((p) => ({
        pool: p.name,
        servers: p.servers.map(({ port, healthy, active, served }) => ({ port, healthy, active, served })),
      })),
    });
  }

  // Step 1: the first path segment names the pool
  const name = req.url.split('?')[0].split('/')[1];
  const pool = pools[name];
  if (!pool) return json(res, 404, { error: 'no service for this path', known: Object.keys(pools) });

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => forward(req, res, Buffer.concat(chunks), pool));
}).listen(PORT, () => {
  console.log(`[gw] listening on ${PORT} (${ALGO})`);
  Object.values(pools).forEach((p) => console.log(`[gw] pool ${p.name}: ${p.servers.map((s) => s.port).join(', ')}`));
});
