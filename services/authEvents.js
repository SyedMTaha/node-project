// Dgram auth events: after register / login / logout, tell the socket gateway with one signed UDP datagram.
// Only when AUTH_EVENTS=true. Never contains a password, hash or token. Send errors are ignored.
const dgram = require('dgram');
const crypto = require('crypto');

const ENABLED = process.env.AUTH_EVENTS === 'true';
const PORT = Number(process.env.AUTH_UDP_PORT) || 4001;
const KEY = process.env.SERVICE_KEY || 'dev-service-key'; // same shared key the gateway uses

let sock = null;
if (ENABLED) {
  sock = dgram.createSocket('udp4');
  sock.on('error', () => {}); // an auth event must never break a login
  sock.unref();
}

exports.send = (type, data) => {
  if (!sock) return;
  const body = JSON.stringify({ type, ...data, instance: process.env.INSTANCE_ID || null, at: Date.now() });
  const sig = crypto.createHmac('sha256', KEY).update(body).digest('hex'); // proves it came from one of our programs
  sock.send(JSON.stringify({ body, sig }), PORT, '127.0.0.1', () => {});
};
