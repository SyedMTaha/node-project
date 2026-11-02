//

const jwt = require('jsonwebtoken');
const store = require('../services/messageStore');
const hub = require('../websocket/hub');
const sessions = require('../services/sessionStore');

const MAX_LENGTH = 500;

module.exports = (io) => {
  hub.init(io);

  // Handshake authentication: valid token AND current session (task 1.4)
  io.use(async (socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return next(new Error('Unauthorized'));
    }
    const current = await sessions.isCurrent(socket.user.xid, socket.user.sid).catch(() => false);
    if (!current) return next(new Error('Session ended'));
    socket.data.userId = socket.user.id; // the stable, unique user ID
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    socket.join('user:' + userId); // private room: reaches ALL tabs/devices of this user

    console.log(`[socket.io] user ${userId} (${socket.user.username}) connected on socket ${socket.id}`);
    socket.emit('server_info', { instance: process.env.INSTANCE_ID || 'unknown' });
    hub.broadcast('presence', { users: hub.onlineUsers() });

    socket.on('send', async (payload) => {
      if (socket.user.exp * 1000 < Date.now()) {
        socket.emit('auth_expired');
        return socket.disconnect(true);
      }
      if (!(await sessions.isCurrent(socket.user.xid, socket.user.sid).catch(() => false))) { // task 1.4
        socket.emit('session:ended', { reason: 'ended' });
        return socket.disconnect(true);
      }
      const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text || text.length > MAX_LENGTH) return;

      const msg = store.add(text, socket.user.username);
      hub.broadcast('message', msg);
    });

    socket.on('typing', () => {
      socket.broadcast.emit('typing', socket.user.username);
    });

    socket.on('disconnect', () => {
      console.log(`[socket.io] user ${userId} (${socket.user.username}) disconnected, socket ${socket.id}`);
      hub.broadcast('presence', { users: hub.onlineUsers() });
    });
  });
};