// store messages add and retrieve 

let messages = [];
let nextId = 1;

exports.getAll = () => messages;

exports.getById = (id) => messages.find((m) => m.id === id);

exports.add = (text, username) => {
  const msg = { id: nextId++, text, username, createdAt: new Date().toISOString() };
  messages.push(msg);
  return msg;
};

exports.remove = (id) => {
  const index = messages.findIndex((m) => m.id === id);
  if (index === -1) return false;
  messages.splice(index, 1);
  return true;
};

exports.getRecent = (limit = 50, beforeId = Infinity) => {
  const result = [];
  for (let i = messages.length - 1; i >= 0 && result.length < limit; i--) {
    if (messages[i].id < beforeId) result.push(messages[i]);
  }
  return result.reverse();
};