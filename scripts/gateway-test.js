const { io } = require('socket.io-client');

const URL = process.env.SG_URL || 'http://localhost:6000';
const token = process.env.TOKEN;

function make(name) {
  const s = io(URL, { auth: { token }, transports: ['websocket'], reconnection: false });
  s.got = [];
  s.on('message', (m) => s.got.push(m.text));
  s.on('connect_error', (e) => console.log(name, 'connect_error:', e.message));
  return s;
}
const call = (s, event, data = {}) => new Promise((resolve) => s.emit(event, data, resolve));

const A = make('A');
const B = make('B');  

setTimeout(async () => {
  console.log('send            ->', await call(A, 'message:send', { text: 'hello via gateway' }));
  console.log('list            ->', await call(B, 'message:list'));
  console.log('unknown service ->', await call(A, 'billing:pay'));
  console.log('A got:', A.got, ' B got:', B.got);
  [A, B].forEach((s) => s.close());
  setTimeout(() => process.exit(0), 200);
}, 1000);