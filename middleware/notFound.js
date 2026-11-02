//Returns a JSON 404 for unknown routes

module.exports = (req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` });
};