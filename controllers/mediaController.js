const { randomUUID } = require('crypto');
const db = require('../services/db');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

function imageBody(req, res) {
  if (!IMAGE_TYPES.has(req.headers['content-type']) || !Buffer.isBuffer(req.body)) {
    res.status(415).json({ error: 'only PNG and JPEG images are supported' });
    return null;
  }
  if (req.body.length === 0 || req.body.length > MAX_IMAGE_BYTES) {
    res.status(413).json({ error: 'image must be between 1 byte and 5 MiB' });
    return null;
  }
  return req.body;
}

function fileName(req) {
  const value = String(req.headers['x-file-name'] || 'image');
  return value.replace(/[^\w.\- ()]/g, '_').slice(0, 255) || 'image';
}

exports.uploadMessage = async (req, res, next) => {
  try {
    const content = imageBody(req, res);
    if (!content) return;
    const recipient = String(req.query.to || '');
    if (!/^\d{9}$/.test(recipient) || recipient === req.user.xid) {
      return res.status(400).json({ error: 'a different recipient xid is required' });
    }
    const [[user]] = await db.execute('SELECT user_xid FROM users WHERE user_xid = ?', [recipient]);
    if (!user) return res.status(404).json({ error: 'recipient not found' });
    const mediaId = randomUUID();
    await db.execute(
      `INSERT INTO message_media
       (media_id, message_uid, sender_xid, recipient_xid, original_name, mime_type, size_bytes, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [mediaId, mediaId, req.user.xid, recipient, fileName(req), req.headers['content-type'], content.length, content]
    );
    res.status(201).json({ mediaId, name: fileName(req), mimeType: req.headers['content-type'], sizeBytes: content.length });
  } catch (err) {
    next(err);
  }
};

exports.downloadMessage = async (req, res, next) => {
  try {
    const [[media]] = await db.execute(
      `SELECT original_name, mime_type, size_bytes, content
         FROM message_media
        WHERE media_id = ? AND recipient_xid = ? AND downloaded_at IS NULL`,
      [req.params.mediaId, req.user.xid]
    );
    if (!media) return res.status(404).json({ error: 'media not found or already downloaded' });
    res.setHeader('Content-Type', media.mime_type);
    res.setHeader('Content-Length', media.size_bytes);
    res.setHeader('Content-Disposition', `inline; filename="${media.original_name.replace(/["\\\r\n]/g, '_')}"`);
    res.send(media.content);
  } catch (err) {
    next(err);
  }
};

exports.acknowledgeMessageDownload = async (req, res, next) => {
  try {
    const [result] = await db.execute(
      'UPDATE message_media SET downloaded_at = CURRENT_TIMESTAMP(3) WHERE media_id = ? AND recipient_xid = ? AND downloaded_at IS NULL',
      [req.params.mediaId, req.user.xid]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'media not found or already acknowledged' });
    await db.execute('DELETE FROM message_media WHERE media_id = ? AND recipient_xid = ?', [req.params.mediaId, req.user.xid]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

exports.uploadProfile = async (req, res, next) => {
  try {
    const content = imageBody(req, res);
    if (!content) return;
    await db.execute(
      `INSERT INTO user_media
       (user_xid, media_kind, original_name, mime_type, size_bytes, content)
       VALUES (?, 'profile_picture', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE original_name = VALUES(original_name),
         mime_type = VALUES(mime_type), size_bytes = VALUES(size_bytes), content = VALUES(content)`,
      [req.user.xid, fileName(req), req.headers['content-type'], content.length, content]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
};

exports.downloadProfile = async (req, res, next) => {
  try {
    const [[media]] = await db.execute(
      `SELECT original_name, mime_type, size_bytes, content
         FROM user_media
        WHERE user_xid = ? AND media_kind = 'profile_picture'`,
      [req.params.xid]
    );
    if (!media) return res.status(404).json({ error: 'profile picture not found' });
    res.setHeader('Content-Type', media.mime_type);
    res.setHeader('Content-Length', media.size_bytes);
    res.setHeader('Content-Disposition', `inline; filename="${media.original_name.replace(/["\\\r\n]/g, '_')}"`);
    res.send(media.content);
  } catch (err) {
    next(err);
  }
};
