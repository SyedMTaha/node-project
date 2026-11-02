// side-by-side check for one message: MySQL row vs Redis key
// usage: node scripts/compare.js <messageId>
require('dotenv').config();
const mysql = require('mysql2/promise');
const Redis = require('ioredis');

const id = Number(process.argv[2]);
if (!id) { console.log('usage: node scripts/compare.js <messageId>'); process.exit(1); }

(async () => {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });
  try {
    const [rows] = await db.execute('SELECT id, text, username, created_at AS createdAt FROM messages WHERE id = ?', [id]);
    const row = rows[0];
    const key = `message:${id}`;
    const raw = await redis.get(key);
    const ttl = await redis.ttl(key);
    const cached = raw ? JSON.parse(raw) : null;

    console.log(`MySQL  row ${id}    : ${row ? JSON.stringify(row.text) : '(not found)'}`);
    console.log(`Redis  ${key} : ${cached ? JSON.stringify(cached.text) + `  (ttl ${ttl}s)` : '(no key)'}`);

    if (!row) console.log('RESULT: NOT IN MYSQL');
    else if (!cached) console.log('RESULT: NOT CACHED (expired or never read; click Get on /demo first)');
    else {
      const same = cached.text === row.text && cached.username === row.username &&
        new Date(cached.createdAt).getTime() === new Date(row.createdAt).getTime();
      console.log('RESULT:', same ? 'SAME' : 'DIFFERENT');
    }
  } finally {
    await db.end();
    redis.quit();
  }
})().catch((e) => { console.log('error:', e.message); process.exit(1); });
