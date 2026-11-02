// prints raw UDP heartbeats. Do NOT run together with the balancer or dgram-demo.js (all bind the same UDP port)
const dgram = require('dgram');

const UDP_PORT = Number(process.env.UDP_PORT) || 4000;
const sock = dgram.createSocket('udp4');
sock.on('message', (msg, rinfo) => console.log(new Date().toLocaleTimeString(), `from :${rinfo.port}`, msg.toString()));
sock.on('error', (e) => { console.log('udp error:', e.message); sock.close(); });
sock.bind(UDP_PORT, '127.0.0.1', () => console.log(`listening for heartbeats on udp 127.0.0.1:${UDP_PORT}`));
