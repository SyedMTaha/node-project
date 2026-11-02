//list, and creates new messages  

const store = require('../services/messageStore');
const hub = require('../websocket/hub');

exports.getMessages = (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const before = parseInt(req.query.before, 10) || Infinity;
  res.json(store.getRecent(limit, before));
};

exports.getMessage = (req, res) => {
  const msg = store.getById(Number(req.params.id));
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  res.json(msg);
};

exports.createMessage = (req, res) => {
  const msg = store.add(req.body.text.trim(), req.user.username);
  hub.broadcast('message', msg); // REST-created messages reach everyone live too
  res.status(201).json(msg);
};

exports.deleteMessage = (req, res) => {
  const id = Number(req.params.id);
  const msg = store.getById(id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  // Authorization: only the author (or an admin) may delete
  if (msg.username !== req.user.username && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only delete your own messages' });
  }

  store.remove(id);
  hub.broadcast('deleted', { id }); // every client removes it from the screen
  res.status(204).send();
};