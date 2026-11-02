//le the multiple request and logs it

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const stream = fs.createWriteStream(path.join(LOG_DIR, 'requests.log'), { flags: 'a' });

module.exports = (req, res, next) => {
  if (!req.originalUrl.startsWith('/api') || req.originalUrl === '/api/health') return next(); // skip static files

  const start = process.hrtime.bigint();
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id); // lets the client match its record to ours

  // Log when the response is done, because req.user exists only after authentication
  res.on('finish', () => {
    const entry = {
      requestId: req.id,
      time: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100,
      userId: req.user ? req.user.id : null,
      username: req.user ? req.user.username : null,
      ip: req.ip,
      runId: req.headers['x-load-run'] || null, // tags requests belonging to a test run
      instance: process.env.INSTANCE_ID || null,
    };
    stream.write(JSON.stringify(entry) + '\n'); // JSON Lines: one object per line

    if (process.env.LOG_CONSOLE !== 'false') {
      console.log(`${entry.method} ${entry.path} ${entry.status} ${entry.ms}ms user=${entry.userId || 'anonymous'}`);
    }
  });

  next();
};