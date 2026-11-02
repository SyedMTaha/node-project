-- Direct messaging schema (supervisor design, 22 Oct 2026).
-- Run once in MySQL Workbench as an admin user (root): the app user `chatapp` may not have CREATE rights.
-- Safe to run again: every table uses CREATE TABLE IF NOT EXISTS. The existing `messages` table
-- (used by the cache demo) is NOT touched.
USE chat_practice;

-- 1. users: register/login move here from instance memory.
--    user_xid = id as 9 digits, zero-padded (id 1 -> '000000001'). The app sets it right after the INSERT:
--    UPDATE users SET user_xid = LPAD(id, 9, '0') WHERE id = <insertId>
--    (MySQL does not allow a generated column based on an AUTO_INCREMENT column, so it cannot be automatic.)
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_xid      CHAR(9)      NULL,                          -- NULL only for the moment between INSERT and UPDATE
  username      VARCHAR(100) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,                      -- bcrypt hash, never the password itself
  role          VARCHAR(20)  NOT NULL DEFAULT 'user',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_xid (user_xid),
  UNIQUE KEY uq_users_username (username)
);

-- 2. connections: one row per 1-to-1 chat.
--    chat_id is shown as chatid_01, chatid_02 ... by the app.
--    chatroom_id = 'chatroom' + smaller xid + '_' + larger xid, e.g. chatroom000000001_000000002,
--    so user 1 -> user 2 and user 2 -> user 1 always find the same row.
CREATE TABLE IF NOT EXISTS connections (
  chat_id     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  chatroom_id VARCHAR(30)  NOT NULL,                        -- 8 + 9 + 1 + 9 = 27 characters
  user_a_xid  CHAR(9)      NOT NULL,                        -- the smaller xid
  user_b_xid  CHAR(9)      NOT NULL,                        -- the larger xid
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id),
  UNIQUE KEY uq_chatroom (chatroom_id),
  CONSTRAINT fk_conn_a FOREIGN KEY (user_a_xid) REFERENCES users (user_xid),
  CONSTRAINT fk_conn_b FOREIGN KEY (user_b_xid) REFERENCES users (user_xid)
);

-- 3. friendships: one row per pair for message requests and private aliases.
--    user_a_xid is always the smaller xid, so both directions find the same row.
CREATE TABLE IF NOT EXISTS friendships (
  friendship_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_a_xid        CHAR(9)          NOT NULL,
  user_b_xid        CHAR(9)          NOT NULL,
  requester_xid     CHAR(9)          NOT NULL,
  status            ENUM('pending', 'accepted', 'declined') NOT NULL DEFAULT 'pending',
  messages_sent     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  alias_a           VARCHAR(100)     NULL,
  alias_b           VARCHAR(100)     NULL,
  created_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (friendship_id),
  UNIQUE KEY uq_friendship_pair (user_a_xid, user_b_xid),
  KEY idx_friendship_a (user_a_xid, status),
  KEY idx_friendship_b (user_b_xid, status),
  CONSTRAINT fk_friendship_a FOREIGN KEY (user_a_xid) REFERENCES users (user_xid),
  CONSTRAINT fk_friendship_b FOREIGN KEY (user_b_xid) REFERENCES users (user_xid),
  CONSTRAINT fk_friendship_requester FOREIGN KEY (requester_xid) REFERENCES users (user_xid)
);

-- 3. direct_messages: ONLY messages whose recipient stayed offline longer than 5 minutes.
--    They arrive here from the Redis pending list (moved by a timer in the message service)
--    When the recipient confirms them they are flagged is_delivered = 1, and a delete queue
--    removes flagged rows in batches (no chat history). Columns/indexes added on 23 Oct: see 2026-10-23-delivered.sql.
CREATE TABLE IF NOT EXISTS direct_messages (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  msg_uid        CHAR(36)        NOT NULL,                  -- id given when the message was sent (same id as in Redis)
  chat_id        INT UNSIGNED    NOT NULL,
  sender_xid     CHAR(9)         NOT NULL,                  -- "sender" in the supervisor's table
  is_message_for CHAR(9)         NOT NULL,                  -- recipient xid ("isMessageFor")
  text           VARCHAR(500)    NOT NULL,
  sent_at        DATETIME(3)     NOT NULL,                  -- when user 1 sent it, kept from Redis
  stored_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP, -- when the timer moved it here
  is_delivered   TINYINT(1)      NOT NULL DEFAULT 0,        -- 1 = the recipient's page confirmed it (delete queue removes it)
  delivered_at   DATETIME(3)     NULL,                      -- when it was confirmed
  PRIMARY KEY (id),
  UNIQUE KEY uq_dm_uid (msg_uid),                           -- moving the same message twice is ignored (INSERT IGNORE)
  KEY idx_dm_open (is_message_for, is_delivered, sent_at),  -- "undelivered messages for user X, oldest first", not a full scan
  KEY idx_dm_delivered (is_delivered),                      -- the delete queue finds delivered rows
  CONSTRAINT fk_dm_chat   FOREIGN KEY (chat_id)        REFERENCES connections (chat_id),
  CONSTRAINT fk_dm_sender FOREIGN KEY (sender_xid)     REFERENCES users (user_xid),
  CONSTRAINT fk_dm_for    FOREIGN KEY (is_message_for) REFERENCES users (user_xid)
);

-- 4. Rights for the app user. Check first which host it uses:  SELECT user, host FROM mysql.user WHERE user = 'chatapp';
--    then run these with that host (shown here as 'localhost'):
-- GRANT SELECT, INSERT, UPDATE, DELETE ON chat_practice.users           TO 'chatapp'@'localhost';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON chat_practice.connections     TO 'chatapp'@'localhost';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON chat_practice.direct_messages TO 'chatapp'@'localhost';


-- 5. sessions: one row per user = the user's ONLY active session (sprint 29, task 1.2).
--    A new login overwrites sid; a token whose sid is not this one belongs to an old session.
CREATE TABLE IF NOT EXISTS sessions (
  user_xid   CHAR(9)     NOT NULL,                              -- one row per user (primary key)
  sid        CHAR(36)    NOT NULL,                              -- random UUID, also inside the JWT
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), -- when this session started
  PRIMARY KEY (user_xid),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_xid) REFERENCES users (user_xid)
);
-- GRANT SELECT, INSERT, UPDATE, DELETE ON chat_practice.sessions TO 'chatapp'@'localhost';

-- 6. Location (sprint 29, task 1.5): country / city from an offline GeoIP lookup, never the IP itself.
--    users: where the account was registered. sessions: where the current login came from
--    (shown to the new device when a login replaces this session). Run once as root.
ALTER TABLE users    ADD COLUMN country CHAR(2) NULL, ADD COLUMN city VARCHAR(100) NULL;
ALTER TABLE sessions ADD COLUMN country CHAR(2) NULL, ADD COLUMN city VARCHAR(100) NULL;
