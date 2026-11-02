//load tester for concurrent users with multiple requests

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const USERS = Number(process.argv[2]) || 5;      // number of virtual users
const PER_USER = Number(process.argv[3]) || 20;  // requests each user sends
const DELAY_MS = Number(process.argv[4]) || 0;   // pause between one user's requests
const PASSWORD = 'loadtest-pass-123';
const runId = new Date().toISOString().replace(/[:.]/g, '-');

// Each user cycles through these, in order
const SCENARIO = [
  { method: 'GET', path: '/api/auth/me' },
  { method: 'GET', path: '/api/messages' },
  { method: 'POST', path: '/api/messages' },
];

const json = { 'Content-Type': 'application/json' };
const round = (x) => Math.round(x * 100) / 100;
const pct = (sorted, p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

// Log in (or register on first run) and return the user's ID and token
async function getUser(name) {
  for (const route of ['login', 'register']) {
    const res = await fetch(`${BASE}/api/auth/${route}`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ username: name, password: PASSWORD }),
    });
    if (res.ok) {
      const data = await res.json();
      return { username: name, token: data.token, id: data.user.id };
    }
  }
  throw new Error('Could not log in or register ' + name);
}

// One user's loop: sends PER_USER requests one after another
async function runUser(user) {
  const results = [];
  for (let n = 1; n <= PER_USER; n++) {
    const step = SCENARIO[(n - 1) % SCENARIO.length];
    const options = {
      method: step.method,
      headers: { Authorization: 'Bearer ' + user.token, 'X-Load-Run': runId },
    };
    if (step.method === 'POST') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify({ text: `load test ${user.username} #${n}` });
    }

    const t0 = performance.now();
    let status = 0;
    let requestId = '';
    try {
      const res = await fetch(BASE + step.path, options);
      status = res.status;
      requestId = res.headers.get('x-request-id') || '';
      await res.arrayBuffer(); // read the whole body so the timing is complete
    } catch (err) {
      status = 0; // no response at all (connection error)
    }
    results.push({
      userId: user.id, username: user.username, n,
      method: step.method, path: step.path,
      status, ms: performance.now() - t0, requestId,
    });
    if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  return results;
}

async function main() {
  console.log(`Run ${runId}: ${USERS} users x ${PER_USER} requests = ${USERS * PER_USER} total`);

  // Setup (not counted in the results)
  const users = await Promise.all(
    Array.from({ length: USERS }, (_, i) => getUser(`loadtest-user-${i + 1}`))
  );
  console.log(`${users.length} virtual users ready. Sending requests...`);

  // The test: all users run their loops at the same time
  const t0 = performance.now();
  const all = (await Promise.all(users.map(runUser))).flat();
  const seconds = (performance.now() - t0) / 1000;

  // ---- Summary ----
  const byStatus = {};
  all.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  const times = all.map((r) => r.ms).sort((a, b) => a - b);
  const avg = times.reduce((s, x) => s + x, 0) / times.length;

  console.log('\n=== Results ===');
  console.log('Total requests :', all.length);
  console.log('Duration       :', round(seconds), 's (', round(all.length / seconds), 'req/s )');
  console.log('Status counts  :', byStatus);
  console.log('Latency (ms)   : avg', round(avg), '| p50', round(pct(times, 50)),
    '| p95', round(pct(times, 95)), '| p99', round(pct(times, 99)), '| max', round(times[times.length - 1]));

  console.table(users.map((u) => {
    const mine = all.filter((r) => r.userId === u.id);
    return {
      username: u.username,
      userId: u.id.slice(0, 8) + '...',
      sent: mine.length,
      ok: mine.filter((r) => r.status >= 200 && r.status < 300).length,
      avgMs: round(mine.reduce((s, r) => s + r.ms, 0) / mine.length),
    };
  }));

  // ---- Save the client's request list to CSV ----
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const csvFile = path.join(dir, `run-${runId}.csv`);
  const rows = all.map((r) =>
    [runId, r.userId, r.username, r.n, r.method, r.path, r.status, round(r.ms), r.requestId].join(','));
  fs.writeFileSync(csvFile, ['runId,userId,username,n,method,path,status,ms,requestId', ...rows].join('\n'));
  console.log('Client request list saved to', csvFile);
  

  // Append one line per run to a permanent summary file
const summaryFile = path.join(dir, 'summary.csv');
if (!fs.existsSync(summaryFile)) {
  fs.writeFileSync(summaryFile, 'runId,users,perUser,total,errors,seconds,reqPerSec,avgMs,p95Ms,p99Ms\n');
}
const errors = all.filter((r) => r.status === 0 || r.status >= 400).length;
fs.appendFileSync(summaryFile,
  [runId, USERS, PER_USER, all.length, errors, round(seconds), round(all.length / seconds),
   round(avg), round(pct(times, 95)), round(pct(times, 99))].join(',') + '\n');

  // ---- Cross-check against the server's log file ----
  await new Promise((r) => setTimeout(r, 500)); // give the server time to finish writing
  const logFile = path.join(__dirname, '..', 'logs', 'requests.log');
  if (!fs.existsSync(logFile)) return console.log('Server log not found, skipping cross-check.');

  const serverEntries = fs.readFileSync(logFile, 'utf8')
    .split('\n').filter(Boolean).map(parse)
    .filter((e) => e && e.runId === runId);
  const serverById = new Map(serverEntries.map((e) => [e.requestId, e]));

  const missing = all.filter((r) => r.requestId && !serverById.has(r.requestId)).length;
  const wrongUser = all.filter((r) => {
    const e = serverById.get(r.requestId);
    return r.status < 400 && e && e.userId !== r.userId;
  }).length;

  console.log('\n=== Cross-check with server log ===');
  console.log('Client sent        :', all.length);
  console.log('Server logged      :', serverEntries.length);
  console.log('Missing on server  :', missing);
  console.log('User ID mismatches :', wrongUser);
  console.log(all.length === serverEntries.length && !missing && !wrongUser
    ? 'PASS: client and server agree'
    : 'CHECK: counts or user IDs differ');
}

main().catch(console.error);