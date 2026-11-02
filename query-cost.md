# Query cost: MySQL and Redis

What makes each kind of query cheap or expensive, applied to the queries this project uses.
This is general MySQL (InnoDB) and Redis behaviour, not a measurement. The only measured numbers are the two marked "measured".

The cost of a query mostly comes from three things:
1. **How many rows it has to look at** (an index lets MySQL jump to the right rows; without one it reads the whole table).
2. **How much it has to write** (the row, every index on the changed columns, and the log).
3. **How many trips to the server it needs** (each statement or command has a fixed network and parsing overhead).

## MySQL

| Query type | Cost | Why | Used in this project |
|---|---|---|---|
| SELECT by primary or unique key | Lowest | One lookup in a B-tree index, a few pages read, whatever the table size | Login: `users WHERE username = ?` (unique) |
| SELECT by an index, ORDER BY on the same index | Low, grows only with the rows **returned** | The index already holds the rows in the right order: no sort step | Delivery: `direct_messages WHERE is_message_for = ? AND is_delivered = 0 ORDER BY sent_at` (index `idx_dm_open`) |
| SELECT without a usable index (full table scan) | Highest, grows with the **table size** | MySQL reads every row to find the matching ones: fine at 10 rows, slow at 10 million | Avoided: every query has an index |
| ORDER BY not covered by an index | Medium to high | Extra sort step ("filesort") in memory or on disk | Avoided: the index order matches |
| JOIN on a unique or indexed column | Low | One index lookup per row in the other table | Delivery joins `users` on `user_xid` (unique) for the sender's name |
| COUNT(*) | Grows with the rows **counted** | InnoDB keeps no stored row count, so it walks an index | Once at startup: flagged rows (`idx_dm_delivered`) |
| INSERT, one row | Low per row, but each commit is a disk flush | Writes the row, updates **every index**, writes the redo log; with autocommit each statement is its own commit | New chat row in `connections` |
| INSERT, many rows in one statement (bulk) | Much cheaper per row | One round trip, one parse, one commit for all rows | Mover: all old messages of a user in one `INSERT IGNORE ... VALUES ?` |
| UPDATE | Low if the rows are found by index | Finds the rows, changes them, updates the indexes **containing the changed column**, locks those rows | Flag: `UPDATE ... SET is_delivered = 1 WHERE id IN (...)` (`is_delivered` is in 2 indexes, both updated) |
| DELETE | Medium; many rows at once is expensive | Removes the row **and its entry in every index**, writes undo/redo logs, holds locks until the commit; a huge DELETE is one long, heavy transaction | The **delete queue**: at most 100 rows per DELETE, one batch at a time |
| Transaction (BEGIN ... COMMIT) | Adds one disk flush at the commit | Groups statements so they succeed or fail together | Register: INSERT user + UPDATE Xid |
| ALTER TABLE (schema change) | High, but rare | May rebuild the table and its indexes | The two migrations, run once |

Two rules of thumb:
- **Indexes make reads cheap and writes a bit more expensive.** Every INSERT, UPDATE or DELETE also updates each index on the changed columns, so add an index only where a frequent query needs it.
- **Fewer, bigger statements beat many small ones.** One bulk INSERT instead of 50, one `WHERE id IN (...)` instead of 50 UPDATEs: each statement has a fixed overhead (network trip, parsing, commit).

## Redis

| Command | Cost inside Redis | Used in this project |
|---|---|---|
| `GET` / `SET` / `DEL` / `SADD` / `SREM` | O(1): constant, very fast | Cache keys, `pending:users` |
| `ZADD` / `ZREM` (sorted set) | O(log N) per entry | Holding and removing offline messages |
| `ZRANGE` / `ZRANGEBYSCORE` | O(log N + M), M = entries returned | Reading pending messages; "older than 5 min" |
| `SMEMBERS` | O(N), all members | The mover's list of users with waiting messages |
| `MULTI ... EXEC` / Lua `EVAL` | Sum of its commands, but **one round trip** and atomic | Holding a message (ZADD + SADD); "remove user if empty" |

**For Redis, the network costs far more than the command.** The work inside Redis takes microseconds; one round trip to Redis Cloud took about **213 ms** (measured), while a local indexed MySQL query took about **0.5 to 1 ms** (measured). That is why commands are grouped with `MULTI` and Lua (one trip instead of two or three). "Fewer database queries" and "faster" are not the same thing while Redis runs on the cloud.

## Cost of each message path (counted from the code)

| Path | MySQL queries | Redis Cloud round trips |
|---|---|---|
| Online: delivered directly | 0 (the first message of a new chat does 2 to 3 to create the chat row) | 0 |
| Offline: held in Redis | 0 | 1 (MULTI: ZADD + SADD) |
| Delivered within 5 min (on login) | 1 indexed SELECT (finds nothing in MySQL) | 2 (ZRANGE, ZREM) |
| Moved after 5 min (per user, per mover run) | 1 bulk INSERT | 3 to 4 (ZRANGEBYSCORE, ZREM, EVAL; SMEMBERS once for all users) |
| Delivered from MySQL (on login) | 1 SELECT + 1 UPDATE (flag) + its share of 1 batched DELETE | 1 to 2 |

## Summary

- MySQL is used only for messages that waited more than 5 minutes, and then with bulk statements.
- Every MySQL query in the messaging flow uses an index; none scans the whole table.
- Deletes go through a queue: at most 100 rows per statement, one statement at a time.
- With Redis on the cloud, the main time cost is the Redis network round trip, not the database. Running Redis locally (or in a nearby region) would remove most of it.
