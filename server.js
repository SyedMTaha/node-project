//main entry point load env create http server connect Websocket to same port

require('dotenv').config();
const http = require('http');
// const { WebSocketServer } = require('ws'); removed old method of creating websocket server, now using socket.io  
const { Server } = require('socket.io');
const app = require('./app');

const PORT = process.env.PORT || 3000;
const INSTANCE_ID = process.env.INSTANCE_ID || `port-${PORT}`;

// const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Raw WebSocket server (ws) lives at /ws
// const wss = new WebSocketServer({ noServer: true });
// server.on('upgrade', (req, socket, head) => {
//   const { pathname } = new URL(req.url, 'http://localhost');
//   if (pathname === '/ws') {
//     wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
//   }
//   // anything else (/socket.io/...) is handled by Socket.IO itself
// });

// Socket.IO lives at /socket.io
const io = new Server(server);

app.set('io', io); // lets routes read io.engine.clientsCount

// require('./websocket')(wss); //comment out
require('./socketio')(io);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy.`);
  else console.error(err);
});

server.listen(PORT, () => {
  console.log(`HTTP:      http://localhost:${PORT}`);
  // console.log(`WebSocket: ws://localhost:${PORT}/ws`); //old method
  console.log(`Socket.IO: http://localhost:${PORT}/socket.io/`);
  console.log(`[${INSTANCE_ID}] started, pid ${process.pid}`);
  require('./services/heartbeat')({ port: PORT, instance: INSTANCE_ID, io });
});