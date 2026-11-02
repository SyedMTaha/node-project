//register, login, and get current user info, issue JWT tokens for authentication

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const users = require('../services/userStore');
const authEvents = require('../services/authEvents');
const sessions = require('../services/sessionStore');
const geo = require('../services/geo');

const signToken = (user, sid) =>
  jwt.sign(
    { id: user.xid, xid: user.xid, username: user.username, role: user.role, sid }, // id = xid; sid = this login's session
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
  );

const publicUser = (u) => ({ id: u.xid, xid: u.xid, username: u.username, role: u.role });

exports.register = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' ||
        !username.trim() || password.length < 6) {
      return res.status(400).json({ error: 'username and a password of at least 6 characters are required' });
    }
    if (await users.findByUsername(username.trim())) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    const hash = await bcrypt.hash(password, 10);
    await geo.ready;
    const place = geo.lookup(req.ip); // task 1.5: country / city only, the IP is not stored
    const user = await users.create(username.trim(), hash, place);
    const { sid } = await sessions.start(user.xid, place);
    authEvents.send('register', { xid: user.xid, sid });
    res.status(201).json({ token: signToken(user, sid), user: publicUser(user) });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already taken' }); // two registers at the same moment
    next(err); // Express 4 doesn't catch async errors by itself
  }
};

exports.login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password are required' });
    }
    const user = await users.findByUsername(username);
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) {
      // Same message for both cases, so attackers can't tell which usernames exist
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    // replaces any previous session of this user; previous = where and when that session started (for the notice)
    await geo.ready;
    const { sid, previous } = await sessions.start(user.xid, geo.lookup(req.ip));
    authEvents.send('login', { xid: user.xid, sid });
    res.json({ token: signToken(user, sid), user: publicUser(user), previousDevice: previous });
  } catch (err) {
    next(err);
  }
};

exports.me = (req, res) => res.json({ user: req.user });

// ends this token's session (only if it is still the current one) and tells the rest of the system
exports.logout = async (req, res, next) => {
  try {
    if (req.user.sid) await sessions.end(req.user.xid, req.user.sid);
    authEvents.send('logout', { xid: req.user.xid, sid: req.user.sid || null });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};