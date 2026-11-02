# Project context for a new Claude chat (updated 27 Oct 2026)

How to use this file in a Claude project:
1. Paste **Part A** into the project's custom instructions.
2. Upload this whole file as project knowledge, together with: `sprint-29-user-stories.md`, `commands.md`, `query-cost.md`, and the code files you will work on (see section B3). Never upload `.env`.
3. Re-upload this file and the sprint file when they change.

---

## Part A: project instructions (paste into the project settings)

```
I am a junior Node.js intern (Enabling Systems) working on a practice project, "WebSockets" (D:\EnSys\WebSockets). The uploaded file PROJECT-CONTEXT.md describes the system, what is done and what is planned; sprint-29-user-stories.md is the sprint plan; commands.md lists commands with [verified] / [not run yet] marks. The uploaded files are the truth; if something is not in them, say you cannot verify it.

How to work with me:
- Explain the concept first, then the code and commands, how to test, and the expected output.
- I use Windows 11, PowerShell, VS Code, Node.js v20.13.1. Use PowerShell syntax: Invoke-RestMethod or curl.exe (never plain curl), $env:NAME='x' (per terminal, clear with Remove-Item Env:NAME), never the variable $pid (use $backendPid).
- Be honest: separate "verified (I pasted the output)" from "written but untested" and "prediction". Never claim a result I have not shown you.
- Before changing an existing file, show the exact change and say which function it belongs to. Small edits, no rewrites.
- Never ask for or print secrets (.env: JWT_SECRET, DB_PASSWORD, REDIS_URL, SERVICE_KEY).
- Keep answers focused; do not invent features, file contents or results.
- Portal tasks: Task type (Planned / Unplanned / Additional change), Est. hours, Effort (Low / Medium / High), Log comment. Logged per day, each day 8 h. Ongoing work is written "in progress"; only claim completion when I say so.
- Sprint planning goes into sprint-29-user-stories.md (I keep it in the repo). Reports are Word (.docx).
```

---

## Part B: project context

### B1. Company background
- The company backend ("xpalserver") is a main server connected to several small services (cache, upload, ...). Each service is its own codebase on its own port; services connect to the main server over Socket.IO and are chosen by name. The company project has no load balancing yet; this practice project is where concepts are learned and tested first.
- Supervisor reference: the company backend handles about 600 users at 60-70 ms.
- Sprint 28: 5-22 Oct 2026 (plus an extra day 23 Oct). **Sprint 29: 26 Oct - 12 Nov 2026**, 14 working days x 8 h = 112 h.

### B2. Architecture (ports)

| Program | Start command (PowerShell, see commands.md) | Port | Role |
|---|---|---|---|
| 3 instances (`server.js`) | `npm run cluster` (`scripts/start-instances.js`) | 3001-3003 | Express 5 API + Socket.IO public chat; register/login (users in MySQL), JWT HS256 1 h, bcrypt, rate limits, JSON request log |
| Load balancer (`loadbalancer/lb.js`) | `npm run lb` | 3000 | HTTP + WebSocket proxy; algorithms `ALGO` = round-robin (default), least-connections, ip-hash, fill-first; cookie affinity; health checks; UDP heartbeats; `/__lb/status`, landing page `/`, dashboard, `/demo` |
| Socket gateway (`gateway/socket-gateway.js`) | `$env:SG_PORT='6100'; node gateway/socket-gateway.js` | 6100 (default 6000; browsers block 6000) | Clients connect with a JWT (must contain an Xid); services connect with `role:'service'` + `SERVICE_KEY`; event `service:action` is forwarded to that service; presence; `push` to users; CORS only for `http://localhost:3000`; UDP auth-event listener |
| Message service (`microservices/message-service/index.js`) | `$env:GATEWAY_URL='http://localhost:6100'; node microservices/message-service/index.js` | (client of the gateway) | Public messages (MySQL + Redis cache-aside) and direct messages (see B4) |
| UDP heartbeats | `UDP_HEARTBEAT=true` on cluster **and** balancer | 4000 | Instance -> balancer; instance is UP only if the HTTP check and the heartbeat are fine |
| UDP auth events (`services/authEvents.js`) | `AUTH_EVENTS=true` on cluster | 4001 | Instance -> gateway: register / login / logout events, HMAC-SHA256 signed with `SERVICE_KEY`, 30 s age limit |
| Old HTTP gateway demo (`gateway/gateway.js`, `microservices/*.js`) | | 5000, 4001-4003 | Sprint 28 demo only (note: 4001 clashes with the auth-event port; do not run both) |

Data: MySQL 8.0 (Windows service `MySQL80`, database `chat_practice`, app user `chatapp`); Redis Cloud (`REDIS_URL` in `.env`, ~213 ms per round trip from this PC; local MySQL ~0.5-1 ms).

Pages: `public/index.html` (login), `public/socketio.html` (public room chat, broadcast per instance, logout), `gateway/demo.html` (Messaging page: direct messages, online users, badges Direct / Held in Redis / Stored in MySQL / Delivered, cache demo), `loadbalancer/home.html`, `loadbalancer/dashboard.html` (shared nav, light/dark theme).

### B3. Main files
- `server.js`, `app.js`, `routes/`, `controllers/authController.js` (register / login / logout, Xid in the JWT, auth events), `middleware/`, `services/db.js` (MySQL pool), `services/userStore.js` (users in MySQL, Xid assigned in a transaction), `services/heartbeat.js`, `services/authEvents.js`.
- `loadbalancer/lb.js`, `gateway/socket-gateway.js`, `microservices/message-service/index.js`.
- `db/chat-schema.sql` (tables `users`, `connections`, `direct_messages`), `db/2026-10-23-delivered.sql` (migration: `is_delivered`, `delivered_at`).
- `scripts/integration-test.js` (main test), `scripts/compare.js`, `scripts/redis-pending.js`, `scripts/udp-listen.js`, `scripts/sio-test.js`, `loadtest/`.
- Docs: `commands.md`, `sprint-29-user-stories.md`, `query-cost.md`. (Review results are kept in the sprint file's log comments, not in separate .md files.)

### B4. Direct messaging design (supervisor's design, built 22-23 Oct)
- Users have a 9-digit zero-padded sequential Xid (e.g. `000000012`). 1-to-1 chats; chat name `chatroom<xidA>_<xidB>`; no message history (by design).
- Recipient online: delivered at once through the gateway (`source=direct`).
- Recipient offline: held in Redis sorted set `pending:<xid>` (set `pending:users` lists who has waiting messages; no TTL).
- Waited longer than `PENDING_MAX_S` (300 s): the mover (every `MOVER_INTERVAL_S` 30 s) moves it to MySQL `direct_messages` (bulk INSERT IGNORE).
- On login: waiting messages from MySQL + Redis are pushed in one batch; after the page acknowledges, Redis entries are removed (ZREM) and MySQL rows flagged `is_delivered = 1`; a delete queue removes flagged rows in batches (`DELETE_BATCH` 100 every `DELETE_EVERY_MS` 1000; no queries while idle; survives restarts). Senders get a `dm:delivered` receipt.
- Redis down: falls back to MySQL. Lua script removes empty users from `pending:users` atomically; a `busy` set prevents the mover and delivery working on one user at the same time.

### B5. Verified results (output was seen)
- Sprint 28: health checks and failover; Socket.IO polling needs sticky routing (ip-hash 6/6); fill-first capacity and hard limit; trust proxy; cookie affinity and re-pinning; dashboard; HTTP gateway demo; socket gateway send/list/broadcast; MySQL + Redis cache flow (MISS, HIT, edit).
- Load: 5,000 requests / 50 users went from ~30 s to 10.5 s (476 req/s) after pagination + ETag fix; 3 instances ~1,425-1,535 req/s; balancer v1 with one client slower than direct (cause not established).
- 22-23 Oct: users in MySQL; presence; direct / Redis / MySQL delivery paths; mover; delete queue (incl. restart and batching); CORS; UDP heartbeats (step 9: UDP DOWN 3.1 s after stop).
- 26 Oct (task 1.1): signed Dgram auth events: register / login / logout arrive at the gateway, a forged packet is rejected, nothing sent with the flag off.
- 27 Oct (story 2): integration test with `TEST_DB_PATH=true`: **7 passed, 0 failed, 2 skipped**; steps 6 and 7 report `left: nothing` (no copy in Redis or MySQL after delivery); negative run with a slow delete queue fails with `still in MySQL`.

### B6. Sprint 29 stories (details in sprint-29-user-stories.md)
1. **Single-device login with Dgram events** (26 h): 1.1 Dgram auth events (done), 1.2 sessions table + `sid` in JWT, 1.3 log out the previous device, 1.4 server-side enforcement, 1.5 location at registration (country/city, offline GeoIP), 1.6 password hashing review.
2. **No message text kept after delivery** (7 h): 2.1 audit (done), 2.2 close gaps (in progress), 2.3 test (done, verified).
3. **Message requests, 3-message limit, aliases** (20 h): first 3 messages to a non-friend are delivered and create a request; recipient replies only after accepting; decline blocks the sender permanently; personal aliases.
4. **Images / PDFs and profile picture** (20.5 h): storage investigation (MySQL MEDIUMBLOB recommended, max 5 MB), upload over HTTP, display, message media deleted after delivery, profile picture visible to all logged-in users.
5. **PM2 (fork mode), failover ECONNRESET fix, DEMO.md** (9 h).

Total 82.5 h of 112 h. Daily plan: Day 1 (26 Oct) planning + 1.1; Day 2 (27 Oct) story 2; Day 3 (28 Oct) 1.2 + 1.6 + regression; Day 4 1.3 + 5.2; Day 5 1.4 + test update; Day 6 1.5; Days 7-9 story 3; Days 10-12 story 4; Day 13 PM2 + DEMO.md; Day 14 fixes, review, retrospective.

### B7. Current status (end of 27 Oct) and next step
- Day 2 (Story 2 complete): 2.1, 2.2, 2.3 and regression done. The audit found that the MySQL binary log (`log_bin` ON, ROW format, 30-day expiry, files in `C:\ProgramData\MySQL\MySQL Server 8.0\Data\DELL-bin.*`) keeps deleted message text for 30 days. Options: turn it off (`disable_log_bin` in my.ini + `RESET MASTER` + restart MySQL80), shorten the expiry, or encrypt the text. **Supervisor decision (28 Oct): keep the binlog as it is for now; gap accepted.** Redis Cloud backups: not checked, left as is (user's decision).
- **Day 3 (28 Oct) progress:** 1.2 code applied: `services/sessionStore.js` (`start`, `end`), `sid` in the JWT and in the auth events, `logout` ends the session only if it is still current; `sessions` table (one row per user) created. Verified: two logins give different sids and the table keeps only the second; logout with the old token keeps the row, with the current token removes it (reported). Old tokens are still accepted until task 1.4; open sockets are not kicked until 1.3. 1.6 password review done (bcrypt 2b, cost 10, random salt, no leaks; optional improvements: min length 8, equal login timing, 72-byte limit, generic 500 errors). Regression after 1.2: 6 passed, 0 failed, 3 skipped (verified).
- **Original Day 3 plan: task 1.2 sessions** (`sessions` table, one active session per user, `sid` in the JWT, new login replaces the old session, logout ends it), **1.6 password review** (bcrypt cost/salt, never logged or returned; not yet checked in code), regression run. Show the table design and code changes before applying.

### B8. Open bugs and decisions
- Fixed 29 Oct (task 5.2): integration step 8 ECONNRESET was caused by the test (execSync froze it, then fetch reused a closed keep-alive connection); `stopInstance` is now async. The balancer also retries GET/HEAD on ECONNRESET before any response and logs backend errors. Step 8 passes.
- Day 5 (30 Oct): 1.4 done and verified (`sessionStore.isCurrent` with a 5 s cache that only confirms matches; checks in `middleware/authenticate.js`, `socketio/index.js`, gateway handshake + service calls; 401 / "Session ended"). Integration step 10 "single-device login" added (not run yet). Login page errors are a toast (`window.toast` in `public/session-watch.js`). 1.5 started (not tested): `services/geo.js` (maxmind + `geo/dbip-city-lite-2026-10.mmdb`, git-ignored), country/city in `users` and `sessions`, login returns `previousDevice` shown as a blue toast on the new device; the old device clears localStorage/sessionStorage (theme kept). Start T1 and T3 with `AUTH_EVENTS=true` (T3 must print "auth events on udp 127.0.0.1:4001").
- Day 4 (29 Oct) done: 1.3 (gateway kicks older-sid sockets on login; `public/session-watch.js` watch-only sockets on Chat/Dashboard/Home, room `watch:<xid>`; toast + login page reason), 5.2, regression 7/0/2.
- Supervisor decisions: broadcasting stays per instance; no queue and no fixed connection limit; one copy per service; MySQL is the source of truth, Redis kept in sync; public (cache-demo) messages may be kept; encryption scope = password hashing only; single-device login instead of device revoke.

### B9. Pitfalls
- Environment variables are per terminal and are read when a program starts: change them, then restart the program.
- Balancer and cluster need the same `UDP_HEARTBEAT` setting, or all instances show DOWN.
- `SG_URL` / `GATEWAY_URL` / `SG_PORT` must match (6100), or clients get `xhr poll error`.
- Start the message service only after the gateway; check it prints `connected to gateway` before testing.
- Tokens expire after 1 h; register is limited to 5 per hour per IP (`RATE_LIMIT_DISABLED=true` for tests).
- Do not run `npm run dev` (port 3000) together with the balancer.
- When pasting output from several terminals, label which terminal printed it (T1 cluster, T2 balancer, T3 gateway, T4 message service, T5 tests).
