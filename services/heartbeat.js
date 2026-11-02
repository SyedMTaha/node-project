// UDP heartbeat: tells the load balancer "I'm alive" every HEARTBEAT_MS (only when UDP_HEARTBEAT=true)
const dgram = require('dgram');

module.exports = function startHeartbeat({ port, instance, io }) {
  if (process.env.UDP_HEARTBEAT !== 'true') return; // off: behaviour identical to before

  const UDP_PORT = Number(process.env.UDP_PORT) || 4000;
  const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 1000;
  const sock = dgram.createSocket('udp4');
  sock.on('error', () => {}); // a heartbeat problem must never crash the app
  sock.unref();

  const timer = setInterval(() => {
    const beat = {
      port: Number(port),
      instance,
      connections: io.engine.clientsCount,          // same value /api/health reports
      capacity: Number(process.env.MAX_CONN) || 50, // same value /api/health reports
      uptime: Math.round(process.uptime()),
    };
    sock.send(JSON.stringify(beat), UDP_PORT, '127.0.0.1', () => {}); // send errors ignored
  }, HEARTBEAT_MS);
  timer.unref();

  console.log(`[${instance}] UDP heartbeat every ${HEARTBEAT_MS} ms to 127.0.0.1:${UDP_PORT}`);
};
