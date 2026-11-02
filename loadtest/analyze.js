//test for endpoint performance using the server-side timings logged in requests.log 

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'logs', 'requests.log');
const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

// Use the run ID from the command line, or default to the most recent run
const runs = [...new Set(entries.map((e) => e.runId).filter(Boolean))];
const runId = process.argv[2] || runs[runs.length - 1];
const rows = entries.filter((e) => e.runId === runId);
console.log(`Run ${runId}: ${rows.length} requests (server-side timings)`);

const groups = {};
rows.forEach((e) => {
  const key = `${e.method} ${e.path.split('?')[0]}`;
  (groups[key] = groups[key] || []).push(e.ms);
});

const pct = (s, p) => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
console.table(Object.entries(groups).map(([key, list]) => {
  const s = [...list].sort((a, b) => a - b);
  return {
    endpoint: key,
    count: s.length,
    avgMs: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
    p95Ms: +pct(s, 95).toFixed(2),
    maxMs: +s[s.length - 1].toFixed(2),
  };
}));