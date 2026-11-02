# Sprint 29 (26 Oct – 12 Nov 2026): user stories

Practice project `D:\EnSys\WebSockets`. 5 user stories, each with its tasks. Estimates are the developer's first estimates, in hours; the story estimate is the sum of its tasks.
The portal tasks, planned day by day at 8 h per day, are in "Daily task plan" at the end.
Order follows the supervisor's priority: Dgram in the login flow first, then message deletion, then the rest.
Owners: **Developer** = me (implementation, tests); **Supervisor** = decisions.

Capacity: 14 working days × 8 h = **112 h**. Story work is estimated at **82.5 h**, leaving about **29.5 h** for planning, meetings, supervisor reviews and unexpected problems (see the summary at the end).

Decisions from the supervisor (26 Oct):
- Dgram in the login flow: signed event datagrams after register / login / logout (no password or token over UDP).
- One device at a time: a new login logs the previous device out; no device list or manual revoke.
- "Encryption" means the user's password: already stored as a bcrypt hash; only a review is needed.
- Privacy: the first message to a non-friend creates a request; until the recipient accepts, the sender can send only 3 messages, and they are delivered normally. The recipient can reply only after accepting; after that both can message freely. If the recipient declines, the sender cannot try again: their input field stays disabled for that user.
- Profile picture: visible to every logged-in user (simplest; no friendship check needed).
- Media: stored in MySQL if suitable, otherwise Firebase or an AWS bucket. "Collections" = one for media sent in messages, one for user media (profile picture).
- Location from the IP at registration is acceptable for privacy; only the result (country, city) is stored, not the IP address.
- Public cache-demo messages may be kept.

---

## Story 1: Single-device login with Dgram events

- **Title:** Single-device login: a new login logs the previous device out, announced with Dgram events
- **Type:** Feature
- **Priority:** High
- **Requirement:** As a user I am logged in on one device at a time. When I log in on another device (or another browser), the previous one is logged out at once and shows "You were logged out because you logged in on another device". Each register, login and logout sends a small signed UDP (`dgram`) event `{ type, xid, sid, instance, at }` to the socket gateway; on a login event the gateway disconnects the user's previous device immediately. Login itself stays on HTTP over TCP; no password, hash or token is ever sent over UDP. At registration the user's approximate location (country, city) is detected from their IP address; only that result is stored. Passwords stay bcrypt-hashed (review only).
- **Tasks:**

  | # | Task | Dev | Test |
  |---|---|---|---|
  | 1.1 | Dgram auth events: signed register / login / logout datagrams to the gateway (UDP 4001, behind an env flag) | 4 | 1 |
  | 1.2 | Sessions: `sessions` table, one active session per user, session id (`sid`) in the JWT; a new login replaces the old session | 4 | 1 |
  | 1.3 | Log out the previous device: on the login event the gateway disconnects the user's sockets with an older `sid`; the old page shows the reason and returns to login | 3 | 1.5 |
  | 1.4 | Server-side enforcement: API and gateway reject a token whose `sid` is no longer the current session (also if a UDP packet is lost) | 3 | 1 |
  | 1.5 | Location at registration from the IP (offline GeoIP database), stored as country + city only | 4 | 2 |
  | 1.6 | Password hashing review (bcrypt cost, salt, no plain text anywhere) | 1 | 0.5 |

- **Acceptance criteria:**
  - Register, login and logout each send one datagram; the gateway logs it within 1 second; no datagram contains a password, hash or token.
  - A forged or replayed datagram (bad signature, older than 30 s) is rejected and changes nothing.
  - Logging in on a second browser logs the first one out within a few seconds, with the message "logged in on another device".
  - The first browser's old token is refused by the API (401) and by the gateway, even before it expires.
  - Tabs of the same browser share one login and stay logged in together.
  - A new user registered from a public IP gets country and city stored; from localhost / a private IP "unknown", without an error; a failing lookup never blocks the registration.
  - Passwords exist only as bcrypt hashes in MySQL.
- **Technical impact analysis:**
  - APIs / integrations affected: `POST /api/auth/register`, `POST /api/auth/login`, new `POST /api/auth/logout`, `authenticate` middleware, socket gateway auth, chat page logout.
  - Database / shared services affected: new `sessions` table; `users` gets country / city columns; new UDP listener in the gateway (port 4001).
  - Existing functionality that must remain unchanged: register/login responses (apart from the new `sid`), presence and tab counting, direct messages, UDP heartbeats on port 4000.
  - Regression testing required:   (commands.md 10d/10e); presence (10i).
- **Dependencies & risks:**
  - Dependencies: GeoIP database file (see "Location from IP" below).
  - Unknowns / questions: none (single device decided on 26 Oct; location stores country and city only).
  - Key risks: UDP is unauthenticated and can lose packets, so datagrams are signed and the logout of the old device is also enforced by the server check (task 1.4). The session check on every request needs an in-memory cache, not a Redis Cloud round trip (~213 ms) per request. The integration test logs its test users in more than once, so it must be adjusted.
  - Owners: Developer.
- **Estimation & planning:** Dev 19 h · Testing 7 h · Unit: Hours · Confidence: Medium · Investigation required: No
- **Definition of done:** All tasks merged; acceptance criteria verified and recorded in commands.md; integration test extended (second login logs out the first); regression passes; no secrets in logs or datagrams.
- **Planning decision:** Ready to commit to the sprint
- **Notes / decisions:** Supervisor (26 Oct): only one device at a time; a "My devices" list and manual revoke are not needed. Each browser (or InPrivate window) counts as its own device; tabs of one browser are one device. UDP stays out of Socket.IO traffic; port 4000 stays for heartbeats.

---

## Story 2: No message text kept after delivery

- **Title:** Delete message text from Redis and MySQL after delivery
- **Type:** Feature
- **Priority:** High
- **Requirement:** As a user I know that once my message is delivered, no copy of its text remains on the server: not in Redis, not in MySQL, not in logs. Most of the mechanism exists (sprint 28: removal on acknowledgement, `is_delivered` flag, batching delete queue). This story audits every place a message can live, closes any gaps and proves it with automated tests. Public cache-demo messages are out of scope and may be kept.
- **Tasks:**

  | # | Task | Dev | Test |
  |---|---|---|---|
  | 2.1 | Audit: list every place a direct message can exist (Redis, MySQL, logs, memory) | 1 | 0 |
  | 2.2 | Close gaps found (e.g. empty `pending:users` entries, log lines) | 2 | 1 |
  | 2.3 | Integration test: after delivery, Redis entry and MySQL row are gone | 1 | 2 |

- **Acceptance criteria:**
  - After delivery, the Redis entry for the message is gone (checked by the integration test).
  - After the delete queue has run, the MySQL row is gone (checked by the integration test).
  - No log line of the gateway or message service contains message text.
  - A delivered message is never delivered twice, also after a restart.
- **Technical impact analysis:**
  - APIs / integrations affected: `message:direct`, delivery (`dm:pending`), delete queue.
  - Database / shared services affected: Redis `pending:*`, MySQL `direct_messages`.
  - Existing functionality that must remain unchanged: online / held / stored delivery, receipts, cache demo.
  - Regression testing required: integration test steps 5–7; commands.md 10k–10o.
- **Dependencies & risks:**
  - Dependencies: none.
  - Unknowns / questions: none.
  - Key risks: a message held in Redis is lost if Redis loses its data (known trade-off of the agreed design).
  - Owners: Developer.
- **Estimation & planning:** Dev 4 h · Testing 3 h · Unit: Hours · Confidence: High · Investigation required: No
- **Definition of done:** Audit written; gaps fixed; integration test proves Redis and MySQL are empty after delivery; regression passes.
- **Planning decision:** Ready to commit to the sprint
- **Notes / decisions:** Delivered direct messages are not stored anywhere (decided 22 Oct).

---

## Story 3: Message requests with a 3-message limit, and aliases for friends

- **Title:** Request-based privacy: message requests, 3-message limit, friend aliases
- **Type:** Feature
- **Priority:** High
- **Requirement:** As a user, strangers cannot message me freely. When someone who is not my friend messages me by my Xid, their first message creates a message request that I see in a "Requests" tab. Until I accept, they can send at most 3 messages (delivered normally); after the third their input and Send button are disabled and the server refuses further messages. I can reply only after accepting; then we are friends and both can message without limit. If I decline, the sender can never message me again: their input and Send button stay disabled and the server refuses their messages. I can give each friend a personal alias that only I see.
- **Tasks:**

  | # | Task | Dev | Test |
  |---|---|---|---|
  | 3.1 | `friendships` table (requester, addressee, status, messages sent before acceptance) | 2 | 0.5 |
  | 3.2 | First message to a non-friend creates the request; server enforces the 3-message limit | 4 | 1.5 |
  | 3.3 | Requests tab: list incoming / outgoing, accept, decline (API + UI, live update); decline blocks the sender permanently | 5 | 1.5 |
  | 3.4 | Disable the sender's input and Send button after 3 messages until accepted | 1 | 0.5 |
  | 3.5 | Alias for a friend: set / clear, shown instead of the username (only to the owner) | 3 | 1 |

- **Acceptance criteria:**
  - A message to a non-friend creates a request that the recipient sees in the Requests tab.
  - Messages 1–3 are delivered; message 4 is refused by the server with a clear error.
  - After the third message, the sender's input and Send button are disabled for that chat.
  - After acceptance there is no limit and the input and Send button are enabled again.
  - The recipient cannot reply before accepting; after accepting, both can send without limit.
  - After a decline, the sender's input and Send button stay disabled for that user and the server refuses every further message, also through the API.
  - A friend's alias replaces their username in my views; they do not see it; clearing it shows the username again.
- **Technical impact analysis:**
  - APIs / integrations affected: `message:direct` (request + limit check), new actions for requests and aliases.
  - Database / shared services affected: new `friendships` table (alias stored per side); `connections` stays.
  - Existing functionality that must remain unchanged: delivery paths, receipts, presence, deletion after delivery.
  - Regression testing required: integration test 5–7 (the test users must accept the request first, or the test covers the limit).
- **Dependencies & risks:**
  - Dependencies: none.
  - Unknowns / questions: none (rules confirmed on 26 Oct).
  - Key risks: the limit must be enforced on the server; disabling the UI alone can be bypassed.
  - Owners: Developer.
- **Estimation & planning:** Dev 15 h · Testing 5 h · Unit: Hours · Confidence: Medium · Investigation required: No
- **Definition of done:** Requests, limit, decline rule and aliases work; integration test covers the limit and the decline; regression passes.
- **Planning decision:** Ready to commit to the sprint
- **Notes / decisions:** 1-to-1 messaging itself was built in sprint 28; this story adds privacy on top.

---

## Story 4: Images and PDFs in messages, and a profile picture

- **Title:** Media messages (image / PDF) and profile picture, deleted after delivery
- **Type:** Technical investigation, then Feature
- **Priority:** Medium
- **Requirement:** As a user I can send an image or a PDF in a direct message and set a profile picture. Media has two collections: message media (deleted with the message after delivery) and user media (profile picture, kept). Storage: MySQL if suitable, otherwise Firebase or an AWS bucket; the investigation decides (see "Media storage" below).
- **Tasks:**

  | # | Task | Dev | Test |
  |---|---|---|---|
  | 4.1 | Investigation: MySQL BLOB vs Firebase Storage vs AWS S3 (limits, cost, setup); recommendation to the supervisor | 4 | 0 |
  | 4.2 | Media collections: message media and user media (table structure / storage paths) | 2 | 0.5 |
  | 4.3 | Upload over HTTP (not Socket.IO: its default message limit is 1 MB), type and size checks (PNG/JPEG/PDF, e.g. max 5 MB) | 4 | 1.5 |
  | 4.4 | Show images / open PDFs in the Messaging page; profile picture on the user | 3 | 1 |
  | 4.5 | Delete message media together with the message after delivery (through the delete queue) | 3 | 1.5 |

- **Acceptance criteria:**
  - Investigation note compares the options and the supervisor approves one.
  - A user can attach a PNG, JPEG or PDF up to the size limit; other types and larger files are refused.
  - The recipient sees the image or can open the PDF.
  - After delivery and the queue run, the message's media is gone from storage; the profile picture stays.
  - Any storage credentials are only in `.env`, never in code or logs.
- **Technical impact analysis:**
  - APIs / integrations affected: new upload and download endpoints; `message:direct` carries an attachment reference; possibly an external storage API.
  - Database / shared services affected: media table(s) in MySQL, or an external bucket.
  - Existing functionality that must remain unchanged: text messages, all delivery paths, deletion after delivery.
  - Regression testing required: integration test 5–7; new attachment test.
- **Dependencies & risks:**
  - Dependencies: storage decision (task 4.1); a Firebase / AWS account if MySQL is not chosen.
  - Unknowns / questions: Maximum file size (proposal: 5 MB). Profile picture: visible to every logged-in user (decided).
  - Key risks: large files in MySQL make the database and backups heavy (less so here, because message media is deleted after delivery); cloud free tiers and prices change and must be checked during the investigation.
  - Owners: Developer; Supervisor (storage choice, account).
- **Estimation & planning:** Dev 16 h · Testing 4.5 h · Unit: Hours · Confidence: Low · Investigation required: Yes
- **Definition of done:** Storage approved; upload, display and deletion work end to end; limits enforced; tests added; regression passes.
- **Planning decision:** Needs technical investigation
- **Notes / decisions:** If the sprint runs short, the profile picture (part of 4.2–4.4) moves to sprint 30.

---

## Story 5: Run, recover and demo the system

- **Title:** PM2 process management, failover fix and demo run sheet
- **Type:** Feature + Bug fix
- **Priority:** Medium
- **Requirement:** As the developer I can start, stop and monitor all six programs with PM2 from one config file with matching settings, crashed programs restart automatically, and a short run sheet (DEMO.md) explains the demo. The balancer bug found in sprint 28 (a request cut with ECONNRESET right after an instance stops) is fixed.
- **Tasks:**

  | # | Task | Dev | Test |
  |---|---|---|---|
  | 5.1 | `ecosystem.config.js` for 3 instances, balancer, gateway, message service (fork mode, matching env) | 3 | 1 |
  | 5.2 | Failover fix: balancer retries GET/HEAD on ECONNRESET when no response started; test waits after stopping an instance | 2 | 1 |
  | 5.3 | DEMO.md run sheet (PM2 start, click path, expected results, troubleshooting) | 2 | 0 |

- **Acceptance criteria:**
  - `pm2 start ecosystem.config.js` starts all 6 programs; `pm2 ls` shows them online.
  - Killing an instance: PM2 restarts it and the balancer marks it UP again.
  - `pm2 logs <name>` shows that program's output; `pm2 delete all` frees all ports.
  - Integration test step 8 (failover) passes.
  - DEMO.md lets someone else run the demo without help.
- **Technical impact analysis:**
  - APIs / integrations affected: balancer `forward()` (retry rule).
  - Database / shared services affected: none.
  - Existing functionality that must remain unchanged: all services behave as when started by hand; POST/DELETE requests are never retried automatically.
  - Regression testing required: full integration test (steps 1–9) with PM2-started programs.
- **Dependencies & risks:**
  - Dependencies: installing PM2.
  - Unknowns / questions: none (PM2 runs each program once, "fork mode"; our own balancer keeps balancing).
  - Key risks: PM2's cluster mode would bypass our balancer, so it is not used; auto-start on Windows boot is out of scope.
  - Owners: Developer.
- **Estimation & planning:** Dev 7 h · Testing 2 h · Unit: Hours · Confidence: High · Investigation required: No
- **Definition of done:** Config committed; start / restart / logs verified; step 8 passes; DEMO.md written; regression passes.
- **Planning decision:** Ready to commit to the sprint
- **Notes / decisions:** Replaces the planned `npm run demo` script.

---

## Media storage: can MySQL store images and PDFs?

Yes. MySQL stores files in BLOB columns (`MEDIUMBLOB` up to 16 MB, `LONGBLOB` up to 4 GB); one request may not exceed `max_allowed_packet` (64 MB by default in MySQL 8).

| | MySQL (BLOB) | Firebase Storage / AWS S3 (object storage) |
|---|---|---|
| Setup | Nothing new: same database, no account | Account, project / bucket, credentials, SDK |
| Cost | None (local) | Free tiers exist but their terms change; must be checked |
| Database size and backups | Grow with every file | Database keeps only metadata |
| Serving files | Every download goes through our server and MySQL | Served by the provider (CDN), direct signed links |
| Fit for this project | Good for small files that are deleted after delivery; profile pictures are small | The normal choice at scale and for large files |

**Recommendation for this sprint:** MySQL (`MEDIUMBLOB`, max 5 MB per file) behind a small storage module, so it can be switched to Firebase or S3 later without touching the rest. Message media is deleted after delivery, so the database does not keep growing. To be confirmed in task 4.1.

## Location from IP: offline database or online API?

| | Offline database file | Online API |
|---|---|---|
| Examples | MaxMind GeoLite2 City (free, needs a free account and licence key), DB-IP Lite City (free, CC BY licence, attribution) | ip-api.com, ipinfo.io, ipapi.co (free tiers with limits) |
| How it works | Download a `.mmdb` file; a Node package (e.g. `maxmind`) looks the IP up locally | Our server sends the IP to the provider and gets JSON back |
| Speed | Microseconds, no network | One internet round trip per registration |
| Limits | None | Requests per minute / per month; some free tiers are non-commercial only |
| Privacy | The user's IP never leaves our server | The user's IP is sent to a third party |
| Upkeep | Replace the file now and then (monthly) | None |

**Recommendation:** an offline database (GeoLite2 or DB-IP Lite) with the `maxmind` Node package. It's fast, has no rate limits and keeps the user's IP on our server. Accuracy: country is reliable, city is approximate. Testing: localhost has no public IP, so tests send a public IP in `X-Forwarded-For` directly to an instance (trust proxy is set to 1).

---

## Planning summary

| Story | Priority | Dev + Test (h) | Decision |
|---|---|---|---|
| 1 Single-device login, Dgram events, location | High | 26 | Ready |
| 2 No message text kept after delivery | High | 7 | Ready |
| 3 Message requests, 3-message limit, aliases | High | 20 | Ready |
| 4 Media messages and profile picture | Medium | 20.5 | Needs investigation |
| 5 PM2, failover fix, DEMO.md | Medium | 9 | Ready |
| **Total** | | **82.5** | |

82.5 h of estimated story work out of 112 h leaves about 29.5 h for planning, meetings, reviews and the unexpected. Several estimates have Low or Medium confidence, so this margin is needed. If something still runs late, the profile picture (story 4) moves to sprint 30 first.

Suggested order:
- **Week 1 (26–30 Oct):** Story 1 tasks 1.1–1.4 (Dgram events, single session); Story 2; Story 5 task 5.2 (failover fix).
- **Week 2 (2–6 Nov):** Story 1 tasks 1.5–1.6; Story 3.
- **Week 3 (9–12 Nov):** Story 4; Story 5 tasks 5.1 and 5.3 (PM2, DEMO.md); full regression.

---

## Daily task plan (portal tasks, 8 h per day)

Portal task fields: **Task type** (Planned / Unplanned / Additional change), **Est. hours**, **Effort** (Low / Medium / High), **Log comment**.
All tasks below are **Planned** (part of the sprint plan). Use **Unplanned** for bugs or work that appears during the sprint, and **Additional change** when the supervisor adds or changes scope. The log comments are drafts: adjust them to what was really done that day, and write ongoing work as "in progress".
Story tasks keep their numbers (1.1 … 5.3). Extra daily tasks (planning, regression, reviews) fill each day to 8 h; together they are the ~29.5 h margin.

### Day 1: Mon 26 Oct

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| Sprint 29 planning: user stories and daily tasks | — | Planned | 3 | Medium |
| 1.1 Dgram auth events | 1 | Planned | 5 | Medium |

- **Sprint 29 planning:** Turned the supervisor's sprint notes into 5 user stories with all portal fields and a daily task plan; clarified the open rules (single-device login, message requests, media storage, location) with the supervisor.
- **1.1 Dgram auth events:** Added signed UDP (dgram) events for register, login and logout from the instances to the socket gateway (port 4001, HMAC signature, 30 s age limit, behind a flag) and a logout endpoint. Verified: all three events arrive, a forged packet is rejected, nothing is sent with the flag off; integration test passes.

### Day 2: Tue 27 Oct

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| 2.1 Audit: where message text can live | 2 | Planned | 1 | Low |
| 2.2 Close the gaps found | 2 | Planned | 3 | Medium |
| 2.3 Integration test: nothing left after delivery | 2 | Planned | 3 | Medium |
| Regression run and commands.md update | 2 | Planned | 1 | Low |

- **2.1:** Audited 13 places where direct message text can exist (Redis pending sets, MySQL direct_messages, service and gateway memory, log files, MySQL server logs, Redis Cloud, test tools, browser). Our code leaves no copy after delivery. Found one gap outside the code: the MySQL binary log (ON, ROW format, 30-day expiry) keeps full rows, including text, after they are deleted.
- **2.2:** Prepared options for the binary log gap (turn it off, shorten its expiry, or encrypt the text) and discussed them with the supervisor. Decision (28 Oct): keep the binary log as it is for now; the gap is accepted. Our own code needed no change.
- **2.3:** Added a check to the integration test: after each offline delivery path (Redis and MySQL), the message must be gone from Redis pending:<xid> and its direct_messages row deleted within 5 s. Verified: both paths report "left: nothing". Negative run with a slow delete queue failed with "still in MySQL" as expected, which shows the check works.
- **Regression:** Full integration test run: 7 passed, 0 failed, 2 skipped (failover and UDP steps optional), exit code 0. Recorded the results in commands.md. One earlier run failed on the MySQL step, most likely because the message service was still running with the slow delete queue from the negative test; it passed after a restart with default settings.

### Day 3: Wed 28 Oct

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| 1.2 Sessions: one active session per user | 1 | Planned | 5 | Medium |
| 1.6 Password hashing review | 1 | Planned | 1.5 | Low |
| Regression run | 1 | Planned | 1.5 | Low |

- **1.2 (in progress):** Designing and adding a sessions table in MySQL (one active session per user) and a session id (sid) in the JWT, so a new login replaces the previous session and logout ends the current one. Pending: apply, test login / re-login / logout.
- **1.6:** Reviewed password storage (13 checks): all stored hashes are bcrypt 2b with cost 10 and a random salt; no plain text in the database; passwords and hashes never appear in API replies, the request log, the JWT or the UDP auth events; login and register are rate-limited. No change required. Noted optional improvements for the supervisor: minimum length 8, equal login timing for unknown usernames, 72-byte bcrypt limit, generic 500 error messages.
- **Regression:** Ran the integration test after the session change: 6 passed, 0 failed, 3 skipped (optional MySQL-path, failover and UDP steps), exit code 0. Register, login, Socket.IO, gateway messaging, cache and direct delivery still work with the new session tokens.

### Day 4: Thu 29 Oct

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| 1.3 Log out the previous device | 1 | Planned | 4.5 | High |
| 5.2 Failover fix (ECONNRESET) | 5 | Planned | 3 | Medium |
| Regression run | 1 | Planned | 0.5 | Low |

- **1.3:** When the gateway receives a signed login event, it disconnects the user's sockets from an older session (different sid); a logout closes the other open pages of that session. Added a shared session watcher (public/session-watch.js) so Chat, Dashboard and Home are logged out too, not only Messaging (watch-only sockets do not count as online and cannot call services). The old page shows a toast "You were logged out because you logged in on another device" and the login page repeats the reason. Tested with a normal and an incognito browser on all four pages.
- **5.2:** Investigated the failover test failure (ECONNRESET). Added a safety net in the balancer: retry GET/HEAD on another instance when a backend connection is reset before any response (POST is never retried), and log every backend error with its code. The logs showed the balancer was not the cause: the test froze for ~2 s while stopping the instance (execSync) and then reused a connection the balancer had already closed. Reproduced it without stopping any instance and fixed the test to stop the instance asynchronously. The failover step now passes: with 3002 stopped, all 6 requests were served by 3001 and 3003.
- **Regression:** Full integration test with failover: 7 passed, 0 failed, 2 skipped, exit code 0 (login with sessions, gateway messaging, cache, direct delivery, failover).

### Day 5: Fri 30 Oct

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| 1.4 Server-side enforcement of the single session | 1 | Planned | 4 | Medium |
| Integration test update for single-device login | 1 | Planned | 4 | Medium |

- **1.4:** Every use of a login token now checks that its session id is still the user's current session: the API (401 "Session ended"), the chat sockets on the instances (connect and each send) and the gateway sockets (connect and each service call). A 5 s in-memory cache avoids one MySQL query per request; the cache only confirms a match, a mismatch is checked in MySQL (fixed a bug where a stale cache refused the new device). Pages show the logout toast when refused. Verified: old token 401 "Session ended", new token works, the old browser is logged out and the new one stays logged in; regression 6 passed, 0 failed.
- **Integration test update:** Added step 10 "single-device login": registers a user, connects to the gateway, logs in again, and checks that the old token is refused by the API (401) and the gateway ("Session ended") while the new token works. Result: PASS (old token API 401, gateway "Session ended", new token 200, old socket notified); full run 7 passed, 0 failed, 3 skipped. Also replaced the login page's error pop-up with a toast notification ("Username already taken", "Invalid username or password").
- **1.5 started early (in progress, Day 6 task):** Added an offline IP location lookup (DB-IP Lite database + maxmind package, no internet call): registration stores country and city, never the IP. Supervisor's request (additional change): each login stores its location; when a new login replaces a session, the new device gets a notice with the old session's location and login time, and the old device deletes the app's data from its browser. Verified: registering from a Pakistani IP stored PK / Islamabad on the user, a later login from a US IP stored US / Mountain View on the session and returned the previous session's location (PK / Islamabad) to the new device. Pending: browser check of the notice and Story 1 wrap-up (Monday).

### Day 6: Mon 2 Nov

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| 1.5 Location at registration (country, city) | 1 | Planned | 6 | Medium |
| Story 1 wrap-up: regression and documentation | 1 | Planned | 2 | Low |

- **1.5:** Verified with a public forwarded IP: registration stored the location used for the previous-device notice as PK / Islamabad; local registration succeeded without a GeoIP error. The notice included the previous session timestamp.
- **Story 1 wrap-up:** Regression against the running gateway on port 6100 passed **7 passed, 0 failed, 3 skipped**. The first attempt used the test default port 6000 and was discarded as a configuration mismatch.

### Day 7: Tue 3 Nov

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| 3.1 Friendships table | 3 | Planned | 2.5 | Low |
| 3.2 Message request and 3-message limit | 3 | Planned | 5.5 | High |

- **3.1 (complete early):** Added the `friendships` table with canonical user pairs, request status, requester, message count, and private aliases. Added service actions for listing, accepting, declining, and changing aliases.
- **3.2 (complete early):** Added server-side enforcement: the first three messages to a non-friend are allowed, the fourth is refused, recipients cannot reply before acceptance, accepted users can message freely, and declined senders remain blocked. Focused runtime verification passed.

### Day 8: Wed 4 Nov

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| 3.3 Requests tab: accept / decline | 3 | Planned | 6.5 | High |
| 3.4 Disable the input field | 3 | Planned | 1.5 | Low |

- **3.3 (complete early):** Added the Requests and Friends section with incoming and outgoing requests, accept and decline controls, and live updates for both users; decline blocks the sender permanently.
- **3.4 (complete early):** The sender's input and Send button are disabled after 3 pending messages or after a decline. Hiding the input is not required under the accepted behavior.

### Day 9: Thu 5 Nov

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---| 
| 3.5 Alias for a friend | 3 | Planned | 4 | Medium |
| Story 3 integration tests and regression | 3 | Planned | 4 | Medium |

- **3.5 (complete early):** Users can set or clear a personal alias for a friend, shown only to themselves. The inline alias editor spacing and focus behavior were fixed; broader private-alias display polish is deferred.
- **Story 3 tests (complete early):** Focused verification covered the 3-message limit, accept, decline, alias save, and alias clearing. Full regression passed **7 passed, 0 failed, 3 skipped** against the gateway on port 6100.

### Day 10: Fri 6 Nov

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| 4.1 Media storage investigation | 4 | Planned | 4 | Medium |
| 4.2 Media collections | 4 | Planned | 2.5 | Low |
| Supervisor review of the storage choice | 4 | Planned | 1.5 | Low |

- **4.1:** Compared MySQL BLOB, Firebase Storage and AWS S3 (limits, cost, setup, deletion) and recommended one.
- **4.2:** Created the message-media and user-media collections.
- **Review:** Agreed the storage choice with the supervisor.

### Day 11: Mon 9 Nov

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| 4.3 Upload with type and size checks | 4 | Planned | 5.5 | High |
| 4.4 Show media and profile picture (part 1) | 4 | Planned | 2.5 | Medium |

- **4.3:** Image and PDF upload over HTTP with type and size checks (PNG, JPEG, PDF, max 5 MB).
- **4.4 (in progress):** Started showing images and PDFs in the Messaging page.

### Day 12: Tue 10 Nov

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| 4.4 Show media and profile picture (part 2) | 4 | Planned | 1.5 | Medium |
| 4.5 Delete message media after delivery | 4 | Planned | 4.5 | High |
| Story 4 tests and regression | 4 | Planned | 2 | Medium |

- **4.4:** Finished media display and the profile picture visible to all logged-in users.
- **4.5:** Message media is deleted with the message after delivery through the delete queue; profile pictures are kept.
- **Story 4 tests:** Added an attachment test; full regression.

### Day 13: Wed 11 Nov

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| 5.1 PM2 config for all services | 5 | Planned | 4 | Medium |
| 5.3 DEMO.md run sheet | 5 | Planned | 2 | Low |
| Full regression with PM2 | 5 | Planned | 2 | Medium |

- **5.1:** One ecosystem config starts all six programs with matching settings; crashed programs restart automatically; per-program logs.
- **5.3:** Wrote the one-page demo run sheet.
- **Regression:** Ran the full integration test with PM2-started programs.

### Day 14: Thu 12 Nov

| Task | Story | Type | Est. h | Effort |
|---|---|---|---|---|
| Bug fixes from the final regression | — | Planned | 3 | Medium |
| Sprint review and demo to the supervisor | — | Planned | 2 | Low |
| Sprint retrospective and sprint 30 notes | — | Planned | 2 | Low |
| Buffer: open items | — | Planned | 1 | Low |

- **Bug fixes:** Fixed the issues found in the final regression.
- **Sprint review:** Demonstrated the sprint 29 features to the supervisor.
- **Retrospective:** Noted what went well, what to improve, and open items for sprint 30.
- **Buffer:** Closed remaining small items.
