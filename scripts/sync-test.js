const { io } = require('socket.io-client');

const URL = process.env.SG_URL || 'http://localhost:6000';
const s = io(URL, { auth: { token: process.env.TOKEN }, transports: ['websocket'], reconnection: false });
const call = (event, data = {}) => new Promise((resolve) => s.emit(event, data, resolve));
const fail = (msg) => { console.log(msg); s.close(); process.exit(1); };

s.on('connect_error', (e) => fail('connect_error: ' + e.message));
s.on('connect', async () => {
  const sent = await call('message:send', { text: 'first version' });
  if (!sent.ok) return fail('send failed: ' + sent.error);
  const id = sent.data.id;
  console.log('send  ->', sent.ok, 'id', id);
  const g1 = await call('message:get', { id });
  if (!g1.ok) return fail('get 1 failed: ' + g1.error);
  console.log('get 1 ->', g1.data.text);
  const ed = await call('message:edit', { id, text: 'second version' });
  if (!ed.ok) return fail('edit failed: ' + ed.error);
  console.log('edit  ->', ed.ok);
  const g2 = await call('message:get', { id });
  if (!g2.ok) return fail('get 2 failed: ' + g2.error);
  console.log('get 2 ->', g2.data.text);
  s.close();
  setTimeout(() => process.exit(0), 200);
});