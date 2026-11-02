const { io } = require('socket.io-client');
const token = process.env.TOKEN;

function make(port, name) {
  const s = io(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
  s.got = [];
  s.on('message', (m) => s.got.push(m.text));
  s.on('connect_error', (e) => console.log(name, 'connect_error:', e.message));
  return s;
}

const A = make(3001, 'A');
const B = make(3001, 'B');
const C = make(3002, 'C');

setTimeout(() => A.emit('send', { text: 'hello from A on 3001' }), 1000);

setTimeout(() => {
  console.log('A (3001) received:', A.got);
  console.log('B (3001) received:', B.got);
  console.log('C (3002) received:', C.got);
  [A, B, C].forEach((s) => s.close());
  setTimeout(() => process.exit(0), 200);
}, 2500);