// Stores users in MySQL (table `users`); every instance sees the same users
const db = require('./db');

const COLS = 'user_xid AS xid, username, password_hash AS passwordHash, role';

exports.findByUsername = async (username) => {
  const [rows] = await db.execute(`SELECT ${COLS} FROM users WHERE username = ?`, [username]);
  return rows[0] || null;
};

// INSERT, then set the 9-digit xid from the new id (000000001, 000000002, ...), in one transaction
// place = { country, city } at registration (task 1.5; nulls when unknown)
exports.create = async (username, passwordHash, place = {}, role = 'user') => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.execute('INSERT INTO users (username, password_hash, role, country, city) VALUES (?, ?, ?, ?, ?)',
      [username, passwordHash, role, place.country || null, place.city || null]);
    await conn.execute("UPDATE users SET user_xid = LPAD(id, 9, '0') WHERE id = ?", [r.insertId]);
    await conn.commit();
    return { xid: String(r.insertId).padStart(9, '0'), username, passwordHash, role };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release(); // give the connection back to the pool
  }
};
