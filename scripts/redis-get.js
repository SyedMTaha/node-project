require('dotenv').config();
const Redis = require('ioredis');

const r = new Redis(process.env.REDIS_URL);
const key = process.argv[2];

(async () => {
  console.log('value:', await r.get(key));
  console.log('ttl  :', await r.ttl(key));
  if (process.argv[3] === 'del') console.log('deleted:', await r.del(key));
  r.quit();
})().catch((e) => { console.log('error:', e.message); r.quit(); });