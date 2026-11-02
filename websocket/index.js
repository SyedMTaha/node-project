//Handles WebSocket connections: verifies the JWT, stores incoming messages, and broadcasts them to all client

//old method to create websocket server using ws package, now using socket.io

// const jwt = require('jsonwebtoken');
// const store = require('../services/messageStore');
// const hub = require('./hub');

// const MAX_LENGTH = 500;

// module.exports = (wss) => {
//   hub.initWs(wss);

//   wss.on('connection', (socket, req) => {
//     // 1. Authenticate during the handshake
//     const url = new URL(req.url, 'http://localhost');
//     const token = url.searchParams.get('token');

//     try {
//       socket.user = jwt.verify(token, process.env.JWT_SECRET);
//     } catch {
//       socket.close(4401, 'Unauthorized');
//       return;
//     }

//     console.log('Client connected:', socket.user.username);
//     hub.broadcast('presence', { users: hub.onlineUsers() });

//     // 2. Handle incoming messages
//     socket.on('message', (raw) => {
//       // The token may have expired while the connection stayed open
//       if (socket.user.exp * 1000 < Date.now()) {
//         return socket.close(4401, 'Token expired');
//       }

//       let incoming;
//       try {
//         incoming = JSON.parse(raw.toString());
//       } catch {
//         return; // ignore anything that isn't valid JSON
//       }

//       if (incoming.type === 'message') {
//         const text = typeof incoming.text === 'string' ? incoming.text.trim() : '';
//         if (!text || text.length > MAX_LENGTH) return;

//         const msg = store.add(text, socket.user.username);
//         hub.broadcast('message', msg); // goes to ALL users, sender included
//       }
//     });

//     // 3. Tell everyone when someone leaves
//     socket.on('close', () => {
//       console.log('Client disconnected:', socket.user.username);
//       hub.broadcast('presence', { users: hub.onlineUsers() });
//     });
//   });
// };