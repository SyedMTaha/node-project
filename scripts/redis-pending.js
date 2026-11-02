// shows the messages waiting in Redis for offline users (read-only)
// usage: node scripts/redis-pending.js
require('dotenv').config();
const Redis = require('ioredis');

const r = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });
(async () => {
  const users = await r.smembers('pending:users');
  if (!users.length) console.log('no users with pending messages');
  for (const xid of users) {
    const items = await r.zrange(`pending:${xid}`, 0, -1);
    console.log(`pending:${xid}  ${items.length} message(s)`);
    items.forEach((s) => { const m = JSON.parse(s); console.log(`   from ${m.from} at ${m.sentAt}: ${m.text}`); });
  }
  r.quit();
})().catch((e) => { console.log('error:', e.message); r.quit(); });
