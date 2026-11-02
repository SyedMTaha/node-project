
const http = require('http');

const PORT = Number(process.env.PORT) || 4002;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', service: 'upload', port: PORT }));
  res.end(JSON.stringify({ service: 'upload', port: PORT, pid: process.pid, method: req.method, path: req.url }));
}).listen(PORT, () => console.log(`[upload] listening on ${PORT}`)); 