//Rejects empty or invalid message bodies with 400

module.exports = (req, res, next) => {
  const { text } = req.body;
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  next();
};