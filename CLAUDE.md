# CLAUDE.md: context for D:\EnSys\WebSockets

Read this file first. Then READ THE ACTUAL CODE before answering. This summary was written from a chat history and may be out of date; the files are the truth. Start by confirming in a few lines what you understood and what you could not verify.

## 1. Who I am and how to work with me

- I am a junior Node.js intern (about 3 weeks in) at Enabling Systems. I am learning, so **explain the concept first, then give code and commands, say how to test, and say what output to expect**.
- I am on Windows, PowerShell, VS Code, Node.js v20.13.1, 4 cores, 16 GB RAM. Docker Desktop is installed and works. MySQL 8.0 runs as the Windows service `MySQL80`. No Redis server runs yet.
- PowerShell rules: use `Invoke-RestMethod` or `curl.exe` (never plain `curl`), mind JSON quoting, never use the variable `$pid` (use `$backendPid`). Environment variables are per terminal (`$env:NAME='x'`, clear with `Remove-Item Env:NAME`).
- **Be honest about uncertainty. Never claim a result I have not shown you.** Separate "verified (I saw the output)" from "written but untested". Label predictions as predictions.
- **Before changing an existing file, show me the exact change (or ask me to confirm).** Prefer small edits. When you give an edit, say which function it belongs to (past mistake: a block meant for `forwardUpgrade` was pasted into `forward` and crashed the balancer; another time an edit replaced only one line of a callback and left the response body unpiped, which made every request hang).
- Never print or ask for secrets. Do not read or echo `.env` values (JWT_SECRET, DB_PASSWORD, REDIS_URL, SERVICE_KEY). Keep `.env` out of git.
- Keep answers focused. Do not invent features, file contents or test results.

### Output formats I need
- **Portal text** (company time-tracking portal): give a title, a description and an hour estimate. Portal entries are logged **per day for the task being worked on**. When a task is ongoing, write the log as work in progress (what was done that day, what is pending). Do not claim completion unless I say so. Only the hours I actually worked.
- **Reports:** make a Word (.docx) file.
- **Commands reference:** `commands.md` in this folder lists reusable commands with a verified / not-run-yet mark. Update it when something gets verified.

## 2. The company context

- The company backend ("xpalserver") is a main server connected to several small services (cache, upload and similar). Each service is a separate codebase (separate JavaScript files in its own directory) running locally on its own port. The main server receives requests and forwards them to the right service. Services talk to the main server over Socket.IO and are chosen by name.
- Load balancing is not implemented in the company project. My job: analyze the available algorithms (which suit, what the drawbacks are) and implement one there later. This practice project is where I learn and test every concept.
- Supervisor reference: the company backend handles about 600 users at 60-70 ms.
- This repo is a practice project. It is not the company project.

## 3. This repo

Real-time chat backend: Node.js, Express, Socket.IO at /socket.io, JWT auth (HS256, bcrypt, 1 h tokens, secret in .env), deny-by-default API (public: /api/auth/register, /api/auth/login, /api/health), UUID user IDs assigned at registration, in-memory users and messages (reset on restart), message pagination, ETag off, express-rate-limit (register 5/hour/IP, login 20/15 min/IP; `RATE_LIMIT_DISABLED=true` switches it off), JSON Lines request log at `logs/requests.log`, `app.set('trust proxy', 1)` enabled and verified.

The raw `ws` WebSocket endpoint (/ws) is commented out of `server.js` only; `websocket/hub.js` is still used by Socket.IO. Only Socket.IO is used. `public/socketio.html` is the chat page (UUID, socket ID, online users, typing, messages).

### Two systems live side by side

**A. Cluster + load balancer (original practice setup)**
- `server.js` is started several times on ports 3001-3003 by `scripts/start-instances.js` (`npm run cluster`). Each is a separate process with its own memory (users and messages are per instance). Env: `PORT`, `INSTANCE_ID`, `MAX_CONN`. `X-Served-By` header and `/api/health` (instance, pid, uptime, connections, capacity).
- `loadbalancer/lb.js` (`npm run lb`, port 3000) is the main parent. Features: HTTP reverse proxy, WebSocket/Socket.IO upgrade proxy (raw TCP pipe), active health checks every `CHECK_INTERVAL_MS` (down after 2 failures, up after 1 success), retry on ECONNREFUSED, algorithms via `ALGO` = round-robin (default), least-connections, ip-hash, fill-first (spillover by capacity, with a hard limit), cookie affinity `lb_instance` layered on ip-hash and fill-first with re-pinning, `/__lb/status`, `/__lb/events` (server-sent events), animated dashboard at `/dashboard.html` served from `loadbalancer/dashboard.html`. A socket queue exists in the code but the supervisor dropped queueing and limits (use `HARD_LIMIT=false QUEUE_MAX=0`); the queue was never verified.
- Test tools: `scripts/sio-test.js` (opens N Socket.IO clients; env TRANSPORT, COUNT, HOLD_MS, URL, TOKEN), `loadtest/run.js <users> <reqsPerUser> [delayMs]` with `BASE_URL`, `loadtest/analyze.js`, `loadtest/history.js`.

**B. Socket gateway + separate microservices (new, matches the company design)**
- `gateway/socket-gateway.js` (port 6000): a Socket.IO server. Services connect with `auth: { role:'service', name, key }` (shared `SERVICE_KEY`) and register in a pool by name. Clients connect with a JWT. A client event named `service:action` (e.g. `message:send`) is forwarded to a server in that service's pool (least active calls), and the reply returns through the Socket.IO acknowledgement. A reply may contain `broadcast: { event, data }`, which the gateway emits to all clients. 5 s call timeout. `/__sg/status` lists the registry.
- `microservices/message-service/index.js`: the message service, its own codebase. Actions: send, list, get, edit. Uses MySQL (`mysql2`, database `chat_practice`, table `messages`, app user `chatapp`) as the source of truth and Redis (`ioredis`) as a cache (cache-aside reads; writes go to MySQL first, then refresh Redis and invalidate the list key; 60 s TTL; Redis failures fall back to MySQL).
- Older demo: `gateway/gateway.js` (port 5000, HTTP, routes by first path segment to pools) with `microservices/cache-service.js`, `upload-service.js`, `start-all.js` (ports 4001-4003).
- `scripts/gateway-test.js` and `scripts/sync-test.js` test the socket gateway.

## 4. Verified so far (I saw the output)

- Health checks and failover: with one instance stopped, requests kept being answered; instance marked DOWN and later UP.
- Socket.IO polling through round-robin: 0 of 6 connected (requests split across instances). With ip-hash: 6 of 6 on one instance. WebSocket transport: 6 of 6 spread 2/2/2.
- fill-first with capacity 10: 25 clients gave 10/10/5; with the hard limit, 35 clients gave 30 connected and 5 refused.
- Trust proxy: a request with `X-Forwarded-For: 1.2.3.4` sent to an instance was logged with `"ip":"1.2.3.4"`.
- Cookie affinity: a new client got `lb_instance=3001`; a request with `lb_instance=3002` was served by 3002; with 3002 stopped it was re-pinned and a new cookie set.
- Dashboard: animated dots travel parent to child; cards show health, connections/capacity bar, in flight and served.
- HTTP gateway demo: routing by type works, unknown path gives 404, round-robin alternates, failover to the remaining upload server works.
- Socket gateway with the in-memory message service: send, list, unknown service error and broadcast to two clients all worked.
- MySQL: `chat_practice` database, `chatapp` user and `messages` table exist; the message service connects to MySQL.
- Earlier load results (client figures partly recalled from memory): 5,000 requests with 50 users went from about 30 s / 300 ms / 167-200 req/s to 10.5 s / 104 ms / 476 req/s after the pagination and ETag fix; three instances with three clients about 1,425-1,535 req/s. Load balancer v1 with one client was slower than direct (368 req/s), cause not established (single-threaded proxy, single load-generator process, or CPU contention). The two bottleneck experiments were never run.

## 5. Open problems and unknowns (start here)

1. `scripts/sync-test.js` returns `connect_error: Unauthorized` even though the token was set in the same terminal. Not yet diagnosed. The gateway's auth `catch` hides the real `jwt.verify` error, so first change it to log `e.message` (never the token or the secret), restart the gateway, and rerun. Likely causes: expired token (1 h), empty `TOKEN` in that terminal, or a different `JWT_SECRET` than the one the token was signed with.
2. Redis server is not running: the service logs `ECONNREFUSED 127.0.0.1:6379` and falls back to MySQL. Options: Docker (`docker run -d --name chat-redis -p 6379:6379 redis:7`), or a free cloud Redis (`REDIS_URL` with `rediss://`, kept in `.env`). The supervisor said "use the Redis library"; the library is only a client and still needs a server. A cloud account for practice was judged acceptable by me; confirm with the supervisor.
3. The MySQL and Redis flow has not been verified end to end (send, get, edit, cache HIT and MISS, MySQL and Redis holding the same value after an edit).
4. Stopping the message service while the gateway runs (expect `service "message" is not available`, no crash) and restarting it (should re-register) are untested.
5. The supervisor said UDP has issues with Socket.IO, so "only Dgram" (Node `dgram`). My interpretation, unconfirmed: UDP only for small heartbeat/load packets from instances to the balancer, never for Socket.IO traffic.
6. Some portal task descriptions do not match the work and I cannot edit them.

## 6. Supervisor decisions (as I understood them)

- Broadcasting stays isolated per instance (users of one instance see each other's messages). No relay between instances.
- Main server receives all requests and forwards by availability and request type. No queue and no fixed limit (`MAX_CONN=10` was only a test value).
- One copy per service for now; each service its own codebase in its own directory; services connect via Socket.IO and are chosen by name.
- Database: MySQL (Workbench is only the client). Redis flow: the database is the source of truth. Data read from the database is also stored in Redis. When data is updated in the database it must also be updated in Redis so both stay in sync.

## 7. Sprint 28 (5-22 Oct 2026) and what remains

Done or in progress: Load balancer (v2, health checks), Trust Proxy, Sticky sessions (ip-hash, cookie), Multiple Sockets design, dashboard UI, Broadcasting, Interconnection Testing (partly).

Portal tasks:
- Mon 19 Oct: Interconnection Testing (2 h), MySQL integration for the message service (3 h), Redis caching layer (3 h): all in progress, none marked complete.
- Tue 20 Oct: Dgram (UDP) implementation (8 h). **I am on leave this day.**
- Wed 21 Oct: Load Balancer Implementation with Dgram (8 h).
- Thu 22 Oct: Integration Testing (8 h).
The 20-22 Oct plan is 24 h in two working days. Raise this with my supervisor instead of hiding it.

Pending technical ideas: request-type routing and a users/auth service as a second microservice; the two load-generator bottleneck experiments; an algorithm analysis (round-robin, weighted variants, least connections, ip-hash, consistent hashing, least response time, power of two choices, fill-first, cookie affinity) with drawbacks, using my measured results; a Word report if I ask for it.

## 8. Known pitfalls

- Users and messages are in memory per instance, so register on one instance does not exist on another. JWTs are valid on every instance (shared secret).
- Tokens expire after 1 hour; register is limited to 5 per hour per IP; use a new username each time. A token can be made by running `npm run dev` once, registering, then stopping it; the socket gateway only needs the signature check.
- `served` in the balancer is a cumulative counter, `connections` counts only Socket.IO sockets, and WebSocket connections stay "in flight" for their whole life.
- Do not run `npm run dev` (port 3000) together with the balancer.
- Instance ports 3001-3003 accept spoofed `X-Forwarded-For` if reached directly; the balancer overwrites it.
- Pasting several terminals' output into one chat message has caused confusion; check which program printed which line (prefixes like `[gw]` and `[message-service]` help).