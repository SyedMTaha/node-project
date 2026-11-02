//

const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://localhost:3000';
const COUNT = Number(process.env.COUNT) || 6;
const TRANSPORT = process.env.TRANSPORT || 'websocket'; // 'websocket' or 'polling'
const token = process.env.TOKEN;

if (!token) {
  console.log('TOKEN is not set. Register first and set $env:TOKEN.');
  process.exit(1);
}

let connected = 0;
let errors = 0;
const sockets = [];                                                                                

for (let i = 0; i < COUNT; i++) {
  const s = io(URL, { auth: { token }, transports: [TRANSPORT], reconnection: false });
  sockets.push(s);
  s.on('connect', () => { connected++; });
  s.on('connect_error', (e) => { errors++; console.log('connect_error:', e.message); });
}

setTimeout(async () => {
  console.log(`connected=${connected} errors=${errors} (transport=${TRANSPORT})`);
  try {
    const status = await (await fetch(URL + '/__lb/status')).json();
    console.table(status.instances);
  } catch (e) {
    console.log('could not read /__lb/status:', e.message);
  }
  sockets.forEach((s) => s.close());
  setTimeout(() => process.exit(0), 200); }, Number(process.env.HOLD_MS) || 2000);