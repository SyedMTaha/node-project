const dgram = require('dgram');
const rx = dgram.createSocket('udp4');
rx.on('message', (msg, rinfo) => console.log('got', msg.toString(), 'from', rinfo.port));
rx.bind(4000, () => {
  const tx = dgram.createSocket('udp4');
  tx.send('hello', 4000, '127.0.0.1', () => tx.close());
});