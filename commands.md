# Command reference: D:\EnSys\WebSockets

Run everything from `D:\EnSys\WebSockets` in PowerShell.
Each long-running command needs its **own terminal**.

Status key: **[verified]** = you ran it and saw the expected output.
**[not run yet]** = written but not tested. Update this file as you test.

## 0. PowerShell basics

| Thing | Meaning |
|---|---|
| `$r = ...` | stores a value in a variable named `r` |
| `$env:NAME = 'x'` | environment variable, lasts for that terminal only; programs started there can read it |
| `Remove-Item Env:NAME` | deletes an environment variable |
| `$backendPid` | use this name, never `$pid` (reserved) |
| `curl.exe` | always with `.exe`, never plain `curl` |

Old variables linger in a terminal. If behaviour looks odd, open a fresh terminal.

## 1. Start and stop the cluster and balancer

| Command | What it does |
|---|---|
| `npm run dev` | one instance on port 3000 with nodemon. Do NOT run together with the balancer **[verified]** |
| `$env:MAX_CONN='10'; npm run cluster` | starts 3 instances on 3001-3003, capacity 10 each **[verified]** |
| `npm run cluster` | same, capacity defaults to 50 **[verified]** |
| `node scripts/start-instances.js 3001 3002 3003 3004` | start a custom list of ports **[verified: ports accepted]** |
| `node scripts/start-instances.js 3002` | restart only one instance **[verified]** |
| `$env:ALGO='fill-first'; $env:CHECK_INTERVAL_MS='1000'; npm run lb` | balancer on port 3000 **[verified]** |
| `$env:HARD_LIMIT='false'; $env:QUEUE_MAX='0'; npm run lb` | no hard limit, no queue **[verified: starts]** |
| `$env:RATE_LIMIT_DISABLED='true'; npm run cluster` | turns off register/login rate limits for tests **[verified]** |

->
|`$env:UDP_HEARTBEAT='true';$env:RATE_LIMIT_DISABLED='true'; $env:AUTH_EVENTS='true' ; npm run cluster ` | starts 3 instances on 3001-3003 with UDP |
| `$env:UDP_HEARTBEAT='true'; $env:HARD_LIMIT='false';$env:QUEUE_MAX='0'; npm run lb`| starts load balancer |
| ` $env:SG_PORT='6100'; $env:AUTH_EVENTS= 'true' ; node gateway/socket-gateway.js` | starts socket gateway |
| `$env:GATEWAY_URL='http://localhost:6100'; $env:PENDING_MAX_S='30'; $env:MOVER_INTERVAL_S='5'; node microservices/message-service/index.js`| starts msg service |



Order: terminal 1 cluster, terminal 2 balancer, terminal 3 tests.

### Stop one instance (change the port)

```powershell
$backendPid = (Get-NetTCPConnection -LocalPort 3002 -State Listen).OwningProcess
Stop-Process -Id $backendPid
```
**[verified]**. `Ctrl+C` in the cluster terminal stops all instances.

## 2. Balancer algorithms (`$env:ALGO`)

| Value | Idea |
|---|---|
| `round-robin` (default) | take turns |
| `least-connections` | fewest requests in flight |
| `ip-hash` | client IP picks the instance |
| `fill-first` | fill instance 1 up to capacity, then 2, then 3 |

Cookie stickiness (`lb_instance`) is layered on `ip-hash` and `fill-first`.

## 3. Get a test token

```powershell
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/register -ContentType 'application/json' -Body '{"username":"siotest9","email":"siotest9@example.com","password":"YourPassword1!"}'
$env:TOKEN = $r.token
$env:TOKEN.Length
```
**[verified]**. Length should be about 235. Use a NEW username each time. Tokens last 1 hour, and an expired or empty token gives `connect_error: Unauthorized`. Register is limited to 5 per hour per IP.

## 4. Check status and health

| Command | What it shows |
|---|---|
| `Invoke-RestMethod http://localhost:3001/api/health \| ConvertTo-Json` | one instance: pid, connections, capacity **[verified]** |
| `Invoke-RestMethod http://localhost:3000/__lb/status \| ConvertTo-Json -Depth 4` | balancer view of all instances **[verified]** |
| `curl.exe -m 5 -i http://localhost:3000/api/health; "exit code: $LASTEXITCODE"` | full response and exit code **[verified]** |
| `1..6 \| ForEach-Object { curl.exe -s -D - -o NUL http://localhost:3000/api/health \| Select-String 'X-Served-By' }` | which instance answered each request **[verified]** |

Dashboard (served by the balancer): `http://localhost:3000/dashboard.html` **[verified]**.

### Reading curl exit codes

`0` ok, `7` connection refused, `28` timeout (accepted but never answered), `52` connection closed with no reply.

### Is something listening on a port?

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen
```

## 5. Socket.IO test script (`scripts/sio-test.js`)

```powershell
$env:TRANSPORT='websocket'; $env:COUNT='25'; $env:HOLD_MS='15000'; node scripts/sio-test.js
```
**[verified]**

| Variable | Meaning |
|---|---|
| `TRANSPORT` | `websocket` or `polling` |
| `COUNT` | number of clients (default 6) |
| `HOLD_MS` | how long the clients stay connected (default 2000) |
| `URL` | target, default `http://localhost:3000`. Use `Remove-Item Env:URL` to reset |
| `TOKEN` | the JWT from section 3 |

Results you have seen: round-robin + polling gave 0 of 6; ip-hash + polling gave 6 of 6; websocket gave 6 of 6 spread 2/2/2; fill-first with 25 clients gave 10/10/5; with a hard limit 35 clients gave 30 connected and 5 refused.

## 6. Trust proxy check

```powershell
curl.exe -s -X POST -H "X-Forwarded-For: 1.2.3.4" -H "Content-Type: application/json" -d "{}" http://localhost:3001/api/auth/login
Select-String '1.2.3.4' logs\requests.log | Select-Object -Last 1
```
**[verified]**. Expected: a log line with `"ip":"1.2.3.4"`.

## 7. Cookie stickiness tests (balancer running with `fill-first`)

```powershell
curl.exe -m 5 -i http://localhost:3000/api/health | Select-String 'x-served-by|set-cookie'
curl.exe -m 5 -i -b lb_instance=3002 http://localhost:3000/api/health | Select-String 'x-served-by|set-cookie'
```
**[verified]**. First: a new client gets `set-cookie: lb_instance=3001`. Second: served by 3002 with no `set-cookie`. Stop 3002 and repeat the second: served by another instance and a new cookie is set.

## 8. Load test tool

```powershell
node loadtest/run.js <users> <requestsPerUser> [delayMs]
$env:BASE_URL='http://localhost:3000'; node loadtest/run.js 50 100
node loadtest/analyze.js
node loadtest/history.js
```
Use `RATE_LIMIT_DISABLED=true` on the cluster for load tests.

## 9. Microservice demo with HTTP gateway (separate programs, route by path)

```powershell
node microservices/start-all.js          # terminal 1: cache 4001, upload 4002 and 4003
node gateway/gateway.js                  # terminal 2: gateway on 5000
$env:GW_ALGO='round-robin'; node gateway/gateway.js   # alternate algorithm
Invoke-RestMethod http://localhost:5000/__gw/status | ConvertTo-Json -Depth 5
curl.exe -s http://localhost:5000/upload/x
```
**[verified]**: routing by type, 404 for unknown paths, round-robin alternation, failover to the remaining upload server.

## 10. Socket gateway demo (services connect over Socket.IO)

**[verified]**: `message:send` and `message:list` routed to the message service, an unknown service returned a clear error, and both clients received the broadcast. With the message service stopped, replies were `service "message" is not available` and the gateway stayed up. After restarting only the service, it registered again and calls worked (no gateway restart needed).

```powershell
node gateway/socket-gateway.js                      # terminal 1: main server on 6000
node microservices/message-service/index.js         # terminal 2: message service
node scripts/gateway-test.js                        # terminal 3: needs $env:TOKEN
Invoke-RestMethod http://localhost:6000/__sg/status | ConvertTo-Json -Depth 5
```

## 10b. MySQL and Redis cache (message service)

Setup facts (never paste real values in chat or git). `.env` keys used: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `REDIS_URL`, `SERVICE_KEY`, `JWT_SECRET`.
- MySQL: Windows service `MySQL80` (check: `Get-Service *mysql*`). Database `chat_practice`, table `messages`, app user `chatapp` (limited rights, not root). Workbench is only a viewer: `SELECT * FROM messages ORDER BY id DESC LIMIT 5;` **[verified]**
- Redis: Redis Cloud free plan (30 MB). `REDIS_URL` must be exactly `redis://default:PASSWORD@HOST:PORT` (or `rediss://` if the provider needs TLS), and nothing else. A whole `redis-cli -u ...` command in it gives `Invalid URL`. Docker is NOT used.
- If a password appears in an error or chat, regenerate it in the Redis Cloud console and update `.env`.

Redis connection test (prints PONG) **[verified]**:
```powershell
node -e "require('dotenv').config();const R=require('ioredis');const r=new R(process.env.REDIS_URL);r.ping().then(x=>{console.log(x);r.quit()}).catch(e=>{console.log('error:',e.message);r.quit()})"
```

Sync test (send, list twice, get, edit, list again; needs a fresh `$env:TOKEN`) **[verified]**:
```powershell
node scripts/sync-test.js
```
Watch the message-service terminal for `cache HIT` / `cache MISS` lines. After an edit the next `get` returns the new text from the cache.

Look at one Redis key (replace KEY with the key name the service logs):
```powershell
node scripts/redis-get.js KEY          # prints value and ttl
node scripts/redis-get.js KEY del      # also deletes it (forces a MISS next time)
```
The TTL is 60 s. `value: null, ttl: -2` means the key expired. Do the side-by-side comparison within 60 s of the edit.

Side-by-side in one command (MySQL row vs Redis key, prints SAME / DIFFERENT / NOT CACHED) **[verified]**: after editing #9, `RESULT: SAME` with ttl 33s.
```powershell
node scripts/compare.js 8
```

Note: the cache stays in sync only for changes made through the message service. Editing a row directly in Workbench does not touch Redis; the old value stays until the key is refreshed or the 60 s TTL expires.

## 10c. DB/cache demo page (socket gateway)

Port 6000 is blocked by browsers, so run the gateway on 6100:
```powershell
$env:SG_PORT='6100'; node gateway/socket-gateway.js                                    # terminal 1
$env:GATEWAY_URL='http://localhost:6100'; node microservices/message-service/index.js  # terminal 2
```
Since 22 Oct: log in at `http://localhost:3000/index.html`, then open `http://localhost:3000/demo.html` (nav: Cache Demo). The balancer serves the page, so it reads the login token itself (no pasting); the page connects to the gateway on 6100, which allows only the origin `http://localhost:3000` (CORS). `http://localhost:6100/demo` redirects there. **[verified]**

CORS check **[verified]**: both commands print `Access-Control-Allow-Origin: http://localhost:3000` (never the other origin), so a browser page on another origin is refused.
```powershell
curl.exe -s -i -H "Origin: http://localhost:3000" "http://localhost:6100/socket.io/?EIO=4&transport=polling" | Select-String "Access-Control-Allow-Origin"
curl.exe -s -i -H "Origin: http://evil.example" "http://localhost:6100/socket.io/?EIO=4&transport=polling" | Select-String "Access-Control-Allow-Origin"
```

**[verified]** page loads and connects; send, list, get, edit work; get after edit returns the new text from Redis; editing another user's message gives an error badge; with the service stopped, calls return `service "message" is not available`.
**[verified]** TTL: get (MISS, caches the row), wait 70 s, get again: MISS again (`get 7: cache MISS` twice in the service log).

Badges: red = answered from Redis (HIT), blue = MySQL involved (MISS, send, edit). `ms` is the whole action inside the service, including every Redis round trip.
Measured with Redis Cloud, before the round-trip fix: HIT ~243 ms, MISS/send/edit ~460-530 ms (two Redis round trips each).
**[verified]** after the fix (send/edit use one `multi()` for SET+DEL; MISS replies before filling the cache): send ~255 ms, edit ~244 ms, get MISS ~241 ms, HITs ~226-329 ms. About one Redis round trip per action now; this is the minimum while Redis is on the cloud.

Timing check (prints timings only, no secrets) **[verified]**: Redis Cloud ping ~213 ms, local MySQL `SELECT 1` ~0.5-1.3 ms (first query ~3.7 ms, connection warm-up).
```powershell
node -e "require('dotenv').config();const R=require('ioredis');const r=new R(process.env.REDIS_URL);(async()=>{await r.ping();for(let i=0;i<5;i++){const t=performance.now();await r.ping();console.log('redis ping',(performance.now()-t).toFixed(1),'ms')}r.quit()})().catch(e=>{console.log('error:',e.message);r.quit()})"
node -e "require('dotenv').config();const m=require('mysql2/promise');(async()=>{const c=await m.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT)||3306,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});for(let i=0;i<5;i++){const t=performance.now();await c.query('SELECT 1');console.log('mysql query',(performance.now()-t).toFixed(1),'ms')}await c.end()})().catch(e=>console.log('error:',e.message))"
```
**[verified]** side-by-side with `scripts/compare.js` (section 10b): SAME after an edit.
**[verified]** background cache fill: with the key expired, Get gave a blue MySQL badge (`cache MISS`), the next Get a red Redis badge (`cache HIT`).

## 10d. UDP heartbeats (dgram)

Each instance sends `{port, instance, connections, capacity, uptime}` every `HEARTBEAT_MS` (default 1000) to `127.0.0.1:UDP_PORT` (default 4000), only when `UDP_HEARTBEAT=true`. `scripts/udp-listen.js`, `scripts/dgram-demo.js` and the balancer all bind the same UDP port: run only one of them.

```powershell
node scripts/udp-listen.js                          # terminal 1: prints raw heartbeats
$env:UDP_HEARTBEAT='true'; npm run cluster          # terminal 2: instances send heartbeats
Invoke-RestMethod http://localhost:3001/api/health | ConvertTo-Json   # compare connections/capacity
Remove-Item Env:UDP_HEARTBEAT; npm run cluster      # flag off: no heartbeats
```
**[verified]** 3 lines per second in terminal 1 (`{"port":3001,"instance":"instance-3001","connections":0,"capacity":50,"uptime":70}`), same `connections`/`capacity` as `/api/health`; after stopping 3002 its lines stopped and the others continued (exit code `4294967295` is normal for `Stop-Process`); with the flag off, no "UDP heartbeat" startup lines.

## 10e. Balancer with UDP heartbeats

Rule: an instance is used only if the HTTP check AND the UDP heartbeat both say alive. UDP DOWN after `UDP_TIMEOUT_MS` (default 3000) of silence, checked every 1 s. Stop `udp-listen.js` first (same UDP port).

```powershell
$env:UDP_HEARTBEAT='true'; $env:RATE_LIMIT_DISABLED='true'; npm run cluster              # terminal 1
$env:UDP_HEARTBEAT='true'; $env:HARD_LIMIT='false'; $env:QUEUE_MAX='0'; npm run lb       # terminal 2
Invoke-RestMethod http://localhost:3000/__lb/status | ConvertTo-Json -Depth 4            # terminal 3
$env:UDP_HEARTBEAT='true'; node scripts/start-instances.js 3002                          # restart one instance
```
**[verified]** balancer prints `[lb] UDP heartbeats on 127.0.0.1:4000 (timeout 3000 ms)`; status shows `"http": true, "udp": true, "heartbeatAgoMs": ~240` per instance; stopping 3002 gave `[lb] udp: 3002 DOWN (no heartbeat 3.3s)` then `[lb] instance 3002 marked DOWN after 2 failures`, and requests went only to 3001/3003; after restarting 3002 it came back UP; dashboard cards show `heartbeat N.Ns ago`.
**[verified]** flag off (variable removed in both terminals): no UDP lines in cluster or balancer, no heartbeat text on the dashboard. Note: `$env:UDP_HEARTBEAT` stays set in a terminal until `Remove-Item Env:UDP_HEARTBEAT` is run in that same terminal.

## 10f. Integration test (`scripts/integration-test.js`)

Prints PASS / FAIL / SKIP for: 1 register + login via balancer, 2 Socket.IO via balancer, 3 gateway send -> MySQL -> list, 4 cache MISS -> HIT -> edit -> new text, 5 direct message to an online user, 6 offline -> held in Redis -> delivered + receipt, 7 > 5 min -> MySQL -> delivered + receipt (optional, `TEST_DB_PATH=true`, T4 with short times), 8 failover (optional), 9 UDP heartbeat DOWN (optional). Steps 5-7 register a second test user. Exit code 0 = no FAIL, 1 = at least one FAIL.

Setup (4 terminals; ip-hash so register and login reach the same instance):
```powershell
$env:UDP_HEARTBEAT='true'; $env:RATE_LIMIT_DISABLED='true'; npm run cluster                                  # T1
$env:UDP_HEARTBEAT='true'; $env:ALGO='ip-hash'; $env:HARD_LIMIT='false'; $env:QUEUE_MAX='0'; npm run lb       # T2
node gateway/socket-gateway.js                                                                               # T3 (port 6000)
node microservices/message-service/index.js                                                                  # T4
```
Run:
```powershell
node scripts/integration-test.js; "exit code: $LASTEXITCODE"                                                 # safe default, steps 5-6 SKIP
$env:TEST_FAILOVER='true'; $env:TEST_UDP='true'; node scripts/integration-test.js; "exit code: $LASTEXITCODE" # stops one instance
Remove-Item Env:TEST_FAILOVER; Remove-Item Env:TEST_UDP                                                      # clear the flags afterwards
$env:SG_URL='http://localhost:6100'; $env:TEST_DB_PATH='true'; node scripts/integration-test.js; "exit code: $LASTEXITCODE"   # step 7: T4 must run with PENDING_MAX_S=30, MOVER_INTERVAL_S=5
```
Options: `BASE_URL` (balancer), `SG_URL` (gateway, e.g. `http://localhost:6100`), `STOP_PORT` (instance to stop; default = the one that served step 1).
**[verified]** default run, 22 Oct (after users moved to MySQL), balancer on round-robin, `SG_URL=http://localhost:6100`: 4 passed, 0 failed, 2 skipped, exit code 0 (register on instance-3002, login on instance-3003). **[verified]** 23 Oct with steps 5-6 (run by Claude against the running system, round-robin): 6 passed, 0 failed, 3 skipped, exit code 0; step 5 `source=direct, B received it (chatid_05)`, step 6 `held, B got it via=redis, receipt to A: yes`. **[verified]** step 7, 23 Oct (T4 with PENDING_MAX_S=30, MOVER_INTERVAL_S=5, `TEST_DB_PATH=true`): `held, B got it via=db, receipt to A: yes`; 7 passed, 0 failed, 2 skipped, exit code 0. Full run with TEST_FAILOVER / TEST_UDP, 23 Oct: step 9 **[verified]** `udp DOWN 3.1 s after stop`. Step 8 **[open]** `FAIL ECONNRESET` (a request through the balancer was cut right after the instance was stopped; the balancer only retries on ECONNREFUSED). Steps 3, 5, 6 failed only because the message service was not connected to the gateway at that moment (check T4 shows `connected to gateway` before running).

**Story 2 check (added 27 Oct):** steps 6 and 7 now also check that nothing is left after delivery: the message uid is not in Redis `pending:<xid>` and its `direct_messages` row is deleted within 5 s. The detail line ends with `left: nothing` (PASS) or `left: still in Redis / MySQL` (FAIL).
- Normal run (T4 with `PENDING_MAX_S=30`, `MOVER_INTERVAL_S=5`, the `TEST_DB_PATH` command above): expect steps 6 and 7 `left: nothing`. Step 6 **[verified]** 27 Oct: `held, B got it via=redis, receipt to A: yes, left: nothing` (steps 1-5 PASS). Step 7 **[verified]** 27 Oct third run (T4 restarted with only `PENDING_MAX_S=30`, `MOVER_INTERVAL_S=5`; `$env:DELETE_EVERY_MS` empty): `held, B got it via=db, receipt to A: yes, left: nothing`; 7 passed, 0 failed, 2 skipped, exit code 0. The second run before it had failed (`left: still in MySQL`; the row was gone a minute later). Cause not confirmed; most likely that T4 process had still been started with a slow `DELETE_EVERY_MS` (an env change does not affect a process that is already running).
- Negative run (T4 additionally with `$env:DELETE_EVERY_MS='120000'`): expect step 7 FAIL `left: still in MySQL`, proving the check works. Restart T4 without it afterwards. 27 Oct: reported by the user as FAIL `still in MySQL` (output not pasted); afterwards `direct_messages` held 2 flagged rows, as expected while the delete queue was slow.

## 10g. Direct messaging schema (`db/chat-schema.sql`)

Tables `users` (9-digit zero-padded `user_xid`), `connections` (`chatroom<xidA>_<xidB>`), `direct_messages` (only messages that waited > 5 min; deleted after delivery). The old `messages` table is not touched.
Run once in Workbench as root: File > Open SQL Script > `db/chat-schema.sql` > Execute (lightning icon). Then:
```sql
USE chat_practice; SHOW TABLES; DESCRIBE users; DESCRIBE connections; DESCRIBE direct_messages;
SELECT user, host FROM mysql.user WHERE user = 'chatapp';   -- host for the GRANT lines at the end of the script
```
**[verified]** 22 Oct: 4 tables (`connections`, `direct_messages`, `messages`, `users`); `chatapp` host is `localhost`; the three GRANTs ran (`0 row(s) affected`). Note: `SHOW GRANTS` shows `chatapp` already has `ALL PRIVILEGES ON chat_practice.*`, so the extra GRANTs were not strictly needed.

## 10h. Users in MySQL with the 9-digit Xid

Register/login now read and write the MySQL `users` table (`services/userStore.js`, `services/db.js`), so every instance knows every user. The JWT holds `{ id: xid, xid, username, role }`. Old in-memory accounts are gone: register again.
```powershell
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/register -ContentType 'application/json' -Body '{"username":"xiduser1","password":"YourPassword1!"}'
$r.user
1..3 | ForEach-Object { (Invoke-WebRequest -Method Post -Uri http://localhost:3000/api/auth/login -ContentType 'application/json' -Body '{"username":"xiduser1","password":"YourPassword1!"}' -UseBasicParsing).Headers['X-Served-By'] }
```
```sql
SELECT id, user_xid, username, role, created_at FROM chat_practice.users;
```
**[verified]** 22 Oct: `$r.user` showed xid `000000001`; three logins answered by three different instances with no 401 (round-robin); Workbench row `1 | 000000001 | xiduser1`; same name again gave 409; a browser-registered user got `000000002` and the Cache Demo auto-connected.

## 10i. Presence (who is online)

The gateway puts each client in room `user:<xid>`, counts open tabs per xid, and sends `presence {xid, online}` (first tab in / last tab out) and `presence:sync {online: [...]}` (when a service connects) to the message service. Tokens without `xid` (from before 10h) are refused: log in again.
Test: restart gateway (T3) and message service (T4); open Cache Demo as user A (2 tabs) and as user B in an InPrivate window; close tabs one by one; restart T4 while B is connected.
**[verified]** 22 Oct, all steps as expected (reported), and the integration test still passed 4/4. Expected T4 lines: `presence sync: 0 online`, `000000002 online (1 online)`, nothing for A's second tab, `000000001 online (2 online)`, `000000002 offline (1 online)` only after A's last tab closes, and `presence sync: 1 online` after the restart.

## 10j. Direct message to an online user

`message:direct { to: <xid>, text }` → message service finds/creates the chat in `connections` (`chatroom<smaller>_<larger>`, chat id cached in memory) → if the recipient is online, the gateway emits `dm` only to room `user:<to>`. Offline recipients get an error until 10k (Redis hold).
Test: user A (normal browser) and user B (InPrivate) on Cache Demo; A sends to B's Xid (shown as "your Xid" on B's page).
```sql
SELECT * FROM chat_practice.connections;
```
**[verified]** 22 Oct (reported as expected). Expected: B sees "from A (xid): text · chatid_01" at once; A gets a green "Direct, N ms" badge; T4 logs `direct <A> -> <B>: delivered (online)`; B's reply uses the same chatid_01; one row in `connections`; unknown xid / own xid / bad input give clear errors; B offline gives "is offline".

## 10k. Offline recipient: hold in Redis, deliver on login

Recipient offline → the message goes into Redis sorted set `pending:<xid>` (score = send time, no TTL) and its xid into set `pending:users` (one `multi()`, one round trip). When the recipient connects to the gateway, the service pushes `dm:pending` to their tabs; only after a tab acknowledges are the messages removed from Redis. Delivered DMs are not stored anywhere (no history). "Online" = connected to the gateway (Cache Demo page open), not the Chat page.
```powershell
node scripts/redis-pending.js      # read-only: lists waiting messages per user
```
**[verified]** 22 Oct: two messages to an offline user gave orange "Held in Redis, 255.4 ms / 288.6 ms" badges; the recipient received them on opening Cache Demo (reported); integration test still 4/4. The sender's "held" label is a snapshot at send time (no delivery receipts yet). 23 Oct: redis-pending output verified (2 held messages listed); after a T4 restart B was not sent anything twice. **[not run yet]** a page reload by B right after delivery.
Expected: sender gets an orange "Held in Redis, ~200-250 ms" badge and T4 logs `held in Redis (offline)`; redis-pending shows the messages; when the recipient opens Cache Demo they appear with "(held in Redis, waited N s)" and T4 logs `N pending message(s) delivered from Redis and removed`; a reload does not deliver them again; after a T4 restart `presence sync` delivers to users already online.

## 10l. Mover: Redis -> MySQL after 5 minutes

Every `MOVER_INTERVAL_S` (default 30) the message service moves pending messages older than `PENDING_MAX_S` (default 300) from Redis to `direct_messages` (one bulk `INSERT IGNORE` per user, then `ZREM`), and removes users with nothing left from `pending:users` (atomic Lua). If Redis is down when a message must be held, it goes straight to MySQL (blue badge).
Short times for testing:
```powershell
$env:GATEWAY_URL='http://localhost:6100'; $env:PENDING_MAX_S='30'; $env:MOVER_INTERVAL_S='5'; node microservices/message-service/index.js
Remove-Item Env:PENDING_MAX_S, Env:MOVER_INTERVAL_S -ErrorAction SilentlyContinue   # in T4 itself; back to 300 s / 30 s
```
```sql
SELECT id, msg_uid, chat_id, sender_xid, is_message_for, text, sent_at, stored_at FROM chat_practice.direct_messages;
```
**[verified]** 22 Oct: startup line with 30 s / 5 s; held badges for the offline user; the two rows appeared in `direct_messages` with the original `sent_at`. **[open]** redis-pending showed `no users with pending messages` (probably run after the 30 s window; recheck with `PENDING_MAX_S=120`). Expected: startup line `[mover] offline messages move to MySQL after 30 s (checked every 5 s)`; ~35 s after sending to an offline user `[mover] <xid>: N message(s) older than 30 s moved Redis -> MySQL`; redis-pending then shows `no users with pending messages`; the rows appear in `direct_messages` with the original `sent_at`. A user who comes online within the time gets the message from Redis and no row is written.

## 10m. Deliver from MySQL on login (8a, simple delete)

When a user comes online, the service reads their rows from `direct_messages` (one indexed SELECT, oldest first) plus their Redis pending list, pushes all in one `dm:pending`, and after the page acknowledges removes the Redis entries and deletes the MySQL rows with ONE `DELETE ... WHERE id IN (...)`. The batching delete queue (8b) is planned for the next sprint.
Test (T4 with `PENDING_MAX_S=30`, `MOVER_INTERVAL_S=5`): B offline; A sends 2, wait ~35 s (moved to MySQL), A sends 1 more; B opens Cache Demo.
**[verified]** 22 Oct: T4 logged `000000001: delivered 3 from MySQL + 0 from Redis, all removed` and B saw the old messages; redis-pending showed the pending message with `PENDING_MAX_S=120` (closes the 10l open point). Found and fixed: right after a T4 restart `pending delivery failed: Stream isn't writeable ...` because presence arrived before Redis was connected (now: MySQL part still delivered, retry on Redis "ready"). Mixed MySQL + Redis case verified on 23 Oct in the 10o test (2 "Stored in MySQL" + 1 "Held in Redis", in send order). Expected: B sees all 3 in order, two "(stored in MySQL, waited ~40 s)" and one "(held in Redis, waited N s)"; T4 logs `delivered 2 from MySQL + 1 from Redis, all removed`; `direct_messages` has 0 rows; redis-pending shows nothing; a reload delivers nothing again.

## 10n. Messaging page UI (task 9)

`/demo.html` (nav: Messaging) has two panels: Direct messages (top) and the Cache demo (unchanged). The gateway sends `presence:list` (xid + username) to every page; clicking a name fills To. Each DM line has a badge: Direct (green), Held in Redis (orange), Stored in MySQL (blue), ✓ Delivered (teal, from a `dm:delivered` receipt when a held message arrives). The Chat page is labelled "Public room chat (broadcast, per instance)".
**[verified]** 23 Oct: "Online now" list and the "✓ Delivered" receipt seen on the pages. **[not run yet]** the startup-race check (stop T4, B opens Messaging, start T4). Expected: both users see each other under "Online now"; A's held message to B turns to "✓ Delivered" when B opens Messaging; after a T4 restart no "Stream isn't writeable" failure blocks delivery.

## 10o. Delivery confirmation (is_delivered) + delete queue (8b)

On acknowledgement: Redis entries are removed at once; MySQL rows are flagged `is_delivered = 1, delivered_at = NOW(3)` with one UPDATE. Every `DELETE_EVERY_MS` (default 1000) the queue deletes up to `DELETE_BATCH` (default 100) flagged rows with one `DELETE ... LIMIT`; no query while nothing is waiting. Delivery reads only `is_delivered = 0` (index `idx_dm_open`), so nothing is delivered twice, even after a restart.
Migration (once, Workbench as root): `db/2026-10-23-delivered.sql`, then `DESCRIBE chat_practice.direct_messages; SHOW INDEX FROM chat_practice.direct_messages;` **[verified]** 23 Oct: all 4 ALTERs ran; one harmless warning 1681 ("Integer display width is deprecated") for `TINYINT(1)`.
Test times (the 30 s / 5 s / 20 s values are only for testing; normal: 300 s / 30 s / 1 s):
```powershell
$env:GATEWAY_URL='http://localhost:6100'; $env:PENDING_MAX_S='30'; $env:MOVER_INTERVAL_S='5'; $env:DELETE_EVERY_MS='20000'; node microservices/message-service/index.js
Remove-Item Env:PENDING_MAX_S, Env:MOVER_INTERVAL_S, Env:DELETE_EVERY_MS, Env:DELETE_BATCH -ErrorAction SilentlyContinue
```
```sql
SELECT id, text, is_delivered, delivered_at FROM chat_practice.direct_messages;
```
**[verified]** 23 Oct: redis-pending showed 2 held messages; the mover moved them (two lines of 1, because they were sent 5 s apart and crossed the 30 s limit in different checks); B received "Stored in MySQL, waited 123 s / 118 s" and "Held in Redis, waited 21 s" in send order; T4 `delivered 2 from MySQL (flagged is_delivered) + 1 from Redis (removed)` then `[delete-queue] 2 delivered message(s) deleted in one query (0 left)`; A saw "Delivered"; `DELETE_BATCH=1` deleted one row per run; integration test 4/4 with normal times. **[verified]** restart with flagged rows (Test 2, with `DELETE_EVERY_MS=120000` so the rows really wait): Workbench showed 2 rows with `is_delivered = 1`; after restarting T4: `[delete-queue] 2 delivered message(s) waiting from before the restart`. Note: the queue runs on a fixed clock from T4's start, so with a short interval the rows can be deleted before you restart. See `query-cost.md` for the cost of each query type.
Expected: B gets older messages "Stored in MySQL" and newer "Held in Redis" in send order; T4 `delivered N from MySQL (flagged is_delivered) + M from Redis (removed)`; rows show `is_delivered = 1` until `[delete-queue] N delivered message(s) deleted in one query (0 left)`; after a restart with flagged rows: `waiting from before the restart`, then deleted, and B does not get them again; `DELETE_BATCH=1` deletes one row per interval.

## 10p. Dgram auth events (sprint 29, task 1.1)

After register, login and logout (`POST /api/auth/logout`, called by the Chat page's Logout) the instance sends one signed UDP datagram `{ type, xid, instance, at }` to the socket gateway on 127.0.0.1:4001 (`AUTH_UDP_PORT`). Signature: HMAC-SHA256 with the shared `SERVICE_KEY`; the gateway drops bad signatures and packets older than 30 s. Never contains a password, hash or token. Both sides need `AUTH_EVENTS=true`.
```powershell
$env:AUTH_EVENTS='true'; $env:UDP_HEARTBEAT='true'; $env:RATE_LIMIT_DISABLED='true'; npm run cluster      # T1
$env:AUTH_EVENTS='true'; $env:SG_PORT='6100'; node gateway/socket-gateway.js                               # T3
node -e "const s=require('dgram').createSocket('udp4');s.send(JSON.stringify({body:JSON.stringify({type:'login',xid:'000000001',at:Date.now()}),sig:'fake'}),4001,'127.0.0.1',()=>s.close())"   # forged packet
```
**[verified]** 26 Oct, isolated check by Claude (temporary gateway on HTTP 6199 / UDP 4091): a signed packet was logged (`auth event: login 000000001 from check-instance`), a forged one gave `rejected: bad signature`, a 60 s old one gave `rejected: too old`.
**[verified]** real flow, 26 Oct: T3 logged `auth event: register 000000017 from instance-3001`, `logout ... from instance-3003`, `login ... from instance-3002`; the forged packet gave `rejected: bad signature`; with the flag removed no auth-event lines; integration test 6 passed, 0 failed, 3 skipped.

## 10q. Sessions: one active session per user (sprint 29, task 1.2)

Table `sessions` (one row per user: `user_xid`, `sid`, `created_at`); create it once in Workbench as root from `db/chat-schema.sql` (section 5 + the GRANT). Register / login start a session (a new login overwrites the previous sid), the JWT carries `sid`, logout ends the session only if it is still the current one. Old tokens are NOT rejected yet (task 1.4).
```powershell
$body = @{ username = 'sess' + (Get-Random); password = 'Session1!' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/register -ContentType 'application/json' -Body $body | Out-Null
$t1 = (Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/login -ContentType 'application/json' -Body $body).token
$t2 = (Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/login -ContentType 'application/json' -Body $body).token
$me1 = (Invoke-RestMethod -Uri http://localhost:3000/api/auth/me -Headers @{ Authorization = "Bearer $t1" }).user
$me2 = (Invoke-RestMethod -Uri http://localhost:3000/api/auth/me -Headers @{ Authorization = "Bearer $t2" }).user
"xid $($me2.xid)  sid1 $($me1.sid)  sid2 $($me2.sid)"
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/logout -Headers @{ Authorization = "Bearer $t1" }   # old token: row stays
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/logout -Headers @{ Authorization = "Bearer $t2" }   # current token: row removed
```
Workbench after each step: `SELECT user_xid, sid, created_at FROM chat_practice.sessions WHERE user_xid = '<xid>';`
Expected: two different sids; 1 row with sid = sid2; still 1 row after the old token's logout; 0 rows after the current token's logout.
**[verified]** 28 Oct: xid 000000028, sid1 `c864…db70`, sid2 `e516…44f3` (different); `sessions` had 1 row for 000000028 with sid = sid2 (checked by Claude with a read-only query). The two logout steps: reported by the user on 28 Oct as matching the expected result (row kept after the old token's logout, removed after the current one); output not pasted.
**[verified]** regression after 1.2, 28 Oct (round-robin, `SG_URL=http://localhost:6100`): integration test 6 passed, 0 failed, 3 skipped, exit code 0; step 6 `left: nothing`.

## 10r. Log out the previous device (sprint 29, task 1.3)

On a `login` auth event the gateway disconnects the user's sockets with a different sid (sends `session:ended`, reason `new_login`); on `logout` it closes the other tabs of that session. The Messaging page shows the reason and returns to the login page after 3 s. Chat, Dashboard and Home load `public/session-watch.js`: a watch-only gateway socket (`auth: { token, watch: true }`, room `watch:<xid>`, no presence, no service calls) that shows a toast (shared `window.sessionEnded()`, also used by Messaging) and after 3 s opens `/index.html?ended=<reason>`, where the login page repeats the reason above the form. Toast version **[verified]** 29 Oct (user checked Chat, Messaging, Dashboard, Home). Needs `AUTH_EVENTS=true` on the cluster AND the gateway.
**[verified]** 29 Oct, Messaging page: T3 `000000002: 1 socket(s) of an ended session disconnected (login)` and the old window was logged out (reported by the user). Chat / Dashboard / Home with the watcher **[verified]** 29 Oct (user checked all pages): T3 `1 socket(s) … disconnected (login)` and `2 socket(s) … (login)` (two open pages of the old session), `2 socket(s) … (logout)` on logout; watcher connections print no `connected, N tab(s)` line (not counted as online).
```powershell
$env:AUTH_EVENTS='true'; $env:UDP_HEARTBEAT='true'; $env:RATE_LIMIT_DISABLED='true'; npm run cluster   # T1
$env:AUTH_EVENTS='true'; $env:SG_PORT='6100'; node gateway/socket-gateway.js                             # T3
```
Test: normal window log in as X, open Messaging; incognito window log in as X, open Messaging.
Expected: normal window "You were logged out because you logged in on another device." then login page; T3 `[gw] <xid>: 1 socket(s) of an ended session disconnected (login)`; incognito stays connected. **[not run yet]**

## 10s. Failover fix: retry on ECONNRESET (sprint 29, task 5.2)

`forward()` in `loadbalancer/lb.js` retries on another instance when nothing reached the client yet: ECONNREFUSED for every method, ECONNRESET (dead keep-alive connection to a stopped instance) only for GET/HEAD. Every backend error is logged with its code (`[lb] instance 300x: <code> …`).
```powershell
$env:SG_URL='http://localhost:6100'; $env:TEST_FAILOVER='true'; node scripts/integration-test.js; "exit code: $LASTEXITCODE"
Remove-Item Env:TEST_FAILOVER
```
Expected: step 8 PASS (no request served by the stopped instance); T2 may show `ECONNRESET, retrying GET /api/health`. Restart the stopped instance afterwards with the SAME env as T1 (`$env:AUTH_EVENTS='true'; $env:UDP_HEARTBEAT='true'; $env:RATE_LIMIT_DISABLED='true'; node scripts/start-instances.js <port>`), or the balancer never sends it traffic (no heartbeat).
29 Oct, first run after the balancer change: step 8 still `FAIL ECONNRESET`, and T2 logged no backend error. **Cause found [verified]:** the test, not the balancer. `execSync` froze the test ~2.3 s while PowerShell ran; `fetch` then reused a keep-alive connection the balancer had already closed (Node closes idle connections after 5 s). Reproduced without stopping anything (`fetch 1 FAILED ECONNRESET`, fetches 2-6 OK). Fix: `stopInstance` uses async `exec`. **[verified]** rerun 29 Oct: step 8 `PASS served by instance-3003, instance-3001, instance-3003, instance-3001, instance-3003, instance-3001` (3002 stopped); 7 passed, 0 failed, 2 skipped, exit code 0.

## 10t. Server-side session check (sprint 29, task 1.4)

Every use of a token checks that its sid is the user's current session (`sessionStore.isCurrent`, 5 s in-memory cache `SESSION_CACHE_MS`): API (`middleware/authenticate.js`, 401 `{"error":"Session ended"}`), Chat sockets on the instances (handshake + each `send`), gateway sockets (handshake + each service call). The gateway updates its cache from login events at once; other instances may accept an old token for up to 5 s. Pages show the toast on "Session ended".
Start (all with the auth-events flag, or the old device is not kicked live):
```powershell
$env:AUTH_EVENTS='true'; $env:UDP_HEARTBEAT='true'; $env:RATE_LIMIT_DISABLED='true'; npm run cluster   # T1
$env:AUTH_EVENTS='true'; $env:SG_PORT='6100'; node gateway/socket-gateway.js                             # T3 (must print "auth events on udp 127.0.0.1:4001")
```
Old-token check (after the `$t1` / `$t2` commands of 10q; wait 5 s):
```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/auth/me -Headers @{ Authorization = "Bearer $t1" }   # expect 401 Session ended
Invoke-RestMethod -Uri http://localhost:3000/api/auth/me -Headers @{ Authorization = "Bearer $t2" }   # expect 200
```
30 Oct, first try: the NEW browser got "You were logged out" (a stale 5 s cache on another instance rejected the new sid). Fixed: the cache only confirms a match; a mismatch is checked in MySQL. **[verified]** after the fix (user, browser): the old window is logged out, the new browser stays logged in. Old-token API check **[verified]** 30 Oct (reported by the user): old token 401 `Session ended`, new token returns the user. Regression after 1.4: 6 passed, 0 failed, 3 skipped (reported).

Integration step 10 **[verified]** 30 Oct: `PASS old token: API 401, gateway "Session ended"; new token: API 200; old socket told: yes`; 7 passed, 0 failed, 3 skipped, exit code 0.

## 10u. Location at registration + previous-device notice (sprint 29, task 1.5 + supervisor's request)

Offline lookup: `geo/dbip-city-lite-2026-10.mmdb` (DB-IP Lite, CC BY 4.0, git-ignored; download the newest monthly file from `https://download.db-ip.com/free/dbip-city-lite-YYYY-MM.mmdb.gz` and unzip into `geo/`), read by `services/geo.js` (`maxmind` package). Register stores country/city in `users`; register/login store it in `sessions`. Login returns `previousDevice` (place + start time of the replaced session); the new device shows a blue toast. The old device deletes this app's browser data (localStorage + sessionStorage, theme kept). Only the result is stored, never the IP. Local IPs (127.0.0.1, ::1) give unknown.
When running behind a trusted public reverse proxy, start the load balancer with `$env:TRUST_UPSTREAM_PROXY='true'; npm run lb`; it preserves the leftmost client IP from the proxy's `X-Forwarded-For` header. Leave this flag off for direct/local traffic.
**[verified]** 30 Oct (Claude, lookup only): `8.8.8.8` US Mountain View, `1.1.1.1` AU Sydney, `39.32.0.1` PK Islamabad, `127.0.0.1` / `::1` null. Columns `country`, `city` already exist in `users` and `sessions`.
Test a real location (directly to an instance; trust proxy uses X-Forwarded-For):
```powershell
$body = @{ username = 'geo' + (Get-Random); password = 'Session1!' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3001/api/auth/register -ContentType 'application/json' -Body $body -Headers @{ 'X-Forwarded-For' = '39.32.0.1' } | Out-Null
(Invoke-RestMethod -Method Post -Uri http://localhost:3001/api/auth/login -ContentType 'application/json' -Body $body -Headers @{ 'X-Forwarded-For' = '8.8.8.8' }).previousDevice
```
Expected: previousDevice `country PK, city Islamabad` (the register session). Workbench: `SELECT username, country, city FROM chat_practice.users ORDER BY id DESC LIMIT 1;` gives PK / Islamabad. Browser: second login shows the blue "Your other device was signed out (unknown location, …)" toast.
**[verified]** 30 Oct (reported by the user): previousDevice PK / Islamabad; Workbench users PK / Islamabad, sessions US / Mountain View. Browser toast check: **[not run yet]**.

## 10v. Message requests, three-message limit and aliases (Sprint 29, tasks 3.1-3.2)

The Day 7 backend test uses three fresh users and verifies the server-side rules:
the first three messages create/use a pending request, message four is refused,
the recipient cannot reply before accepting, acceptance enables two-way messaging,
decline permanently blocks the sender, and an accepted friend can have a private alias.

Start the gateway on 6100 and the message service with the same gateway URL:
```powershell
$env:SG_PORT='6100'; node gateway/socket-gateway.js
$env:GATEWAY_URL='http://localhost:6100'; node microservices/message-service/index.js
```

Apply the `friendships` table from `db/chat-schema.sql` in MySQL Workbench, then run
the focused test from the session command if needed. Expected result:
`firstThree: [true,true,true]`, fourth message refused with
`message request limit reached`, reply before acceptance refused, acceptance and
post-acceptance reply succeed, alias returns the saved value, and a declined sender
is refused with `messaging this user was declined`.

**[verified]** 2 Nov 2026: focused runtime test passed all of those cases with
fresh Xids `000000057`, `000000058`, and `000000059`.

## 11. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `connect_error: Unauthorized` | token expired, empty, or from a failed register |
| exit code 28 on port 3000 | balancer accepted but never answered: check `forward` in `lb.js` |
| `ALGO` has no effect | variable set in a different terminal; check the balancer startup line |
| Port busy | another copy is running: `Get-NetTCPConnection -LocalPort <port> -State Listen` |
| register returns 429 | rate limit used up: restart cluster with `RATE_LIMIT_DISABLED=true` |
| `Invalid URL` from ioredis | `REDIS_URL` in `.env` has extra text; keep only `redis://default:PASSWORD@HOST:PORT` |
| `ECONNREFUSED 127.0.0.1:6379` | `REDIS_URL` missing or not loaded; the service falls back to MySQL |
| `value: null, ttl: -2` in redis-get | key expired (60 s TTL) or never created |
| all instances DOWN, `"udp": false`, same `heartbeatAgoMs` for every instance | balancer has `UDP_HEARTBEAT=true` but the cluster was started without it: no heartbeat ever arrived. Set it in both terminals (or neither) and restart |
| `instancesUp: 0` and nothing listens on 3001-3003 | the cluster is not running: `Get-NetTCPConnection -LocalPort 3001 -State Listen` |