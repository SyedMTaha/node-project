const WebSocket = require('ws');
const base = 'localhost:3000';

async function getToken(username, password = 'secret123') {
  for (const path of ['login', 'register']) {
    const res = await fetch(`http://${base}/api/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) return (await res.json()).token;
  }
  throw new Error('Could not log in or register ' + username);
}

function connect(name, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${base}?token=${token}`); // /ws?
    ws.on('open', () => resolve(ws));
    ws.on('message', (raw) => {
      const { type, data } = JSON.parse(raw.toString());
      if (type === 'message') console.log(`[${name}] got:`, data.username + ':', data.text);
    });
  });
}

(async () => {
  // 1. No token: must be rejected
  const bad = new WebSocket(`ws://${base}`); //new WebSocket(`ws://${base}/ws`)
  bad.on('close', (code) => console.log('No-token connection closed with code', code, '(expected 4401)'));

  // 2. Two users: alice sends, both should receive
  const a = await connect('alice', await getToken('alice'));
  const b = await connect('bob', await getToken('bob'));
  a.send(JSON.stringify({ type: 'message', text: 'hello everyone' }));

  setTimeout(() => { a.close(); b.close(); }, 1000);
})();

