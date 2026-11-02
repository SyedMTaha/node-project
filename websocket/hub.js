   let io = null;

   exports.init = (server) => { io = server; };

   exports.broadcast = (type, data) => { if (io) io.emit(type, data); };

   exports.socketCount = () => (io ? io.sockets.sockets.size : 0);
   
   exports.onlineUsers = () => {
     const names = new Set();
     if (io) io.sockets.sockets.forEach((s) => { if (s.user) names.add(s.user.username); });
     return [...names];
   };