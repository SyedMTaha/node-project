    const http = require('http');

const PORT = Number(process.env.PORT) || 4001;
const store = new Map();

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') return send(res, 200, { status: 'ok', service: 'cache', port: PORT });
  if (u.pathname === '/cache/set') {
    store.set(u.searchParams.get('key'), u.searchParams.get('value'));
    return send(res, 200, { service: 'cache', port: PORT, ok: true });
  }
  if (u.pathname === '/cache/get') {
    const key = u.searchParams.get('key');
    return send(res, 200, { service: 'cache', port: PORT, key, value: store.has(key) ? store.get(key) : null });
  }
  send(res, 404, { service: 'cache', port: PORT, error: 'unknown path' });
}).listen(PORT, () => console.log(`[cache] listening on ${PORT}`));