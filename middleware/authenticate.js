//verify JWT token from the Authorization header, and (task 1.4) that its session is still the current one

const jwt = require('jsonwebtoken');
const sessions = require('../services/sessionStore');

module.exports = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET); // { id, xid, username, role, sid, iat, exp }
  } catch (err) {
    return res.status(401).json({ error: err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' });
  }

  try {
    if (!(await sessions.isCurrent(req.user.xid, req.user.sid))) {
      return res.status(401).json({ error: 'Session ended' }); // logged in on another device, or logged out
    }
    next();
  } catch (err) {
    next(err);
  }
};
