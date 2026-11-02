HTTP vs WEBSOCKETS:
half duplex - full duplex
request/response cycle - request/hand shake synced live communication
one way - two way 
usage: messaging apps, docs, live location, games, live stream, 
stateless connection open request - persistant stays open until closed


MIDDLEWARES:
express functions that run during the request response cycle 


server.js -	Starts the HTTP server, attaches WebSockets, loads .env
app.js - Builds the Express app: middleware, then routes, then error handling
routes/*.js	- Maps URL + method to a handler
controllers/*.js - The actual logic (what happens when the route is hit)
middleware/*.js - Reusable checks that run before or after handlers
websocket/index.js - Handles WebSocket connections and messages


--Learned About:
- 1. WS Package
- 2. JWT Tokenization (header, payload, signature)
- 3. Broadcasting
- 4. Server & Client side syncing
- 5. Middleware Implementation
- 6. Routes
- 7. Nodemon package
- 8. Socket.io (lib build on WS)
- 9. syncing test done
- 10. FS + Path Package
- 11. Pagination
- 12. E-tags for express
- 13. Rate limiter 429  
- 14. Multiple Instances
- 15. Load Balancer (distribute requests - user traffic with round robin, least connection, IP hash)
- 16. Round robin (in a sequential order)
- 17. Least connection (minimum connection per instance)
- 18. IP hash (based on the client ip address it sends request to the socket if same ip same instance)
- 19. Fill first (connection based on the socket limit )
- 20. Reverse proxy (HTTP proxy, WS proxy, Socket.io proxy)
- 21. Plausibale (New connections spilling to the next instance) ?
- 22. caveat ?
- 23. Multiple Sockets 
- 24. Commands for network request (HTTP): Invoke-RestMethod & curl.exe
- 25. Long Pooling (request over HTTP repeatedly by user) ?
- 26. Trust proxy (built-in express setting )
- 27. Sticky session (session affinity - load balancer remembers which instance served a client )
- 28. Pooling (group of server running same service )
- 29. Cookie session 
- 30. Callbacks (function to call something later)
- 31. Flight mode (current request being handled)
- 32. Gateway (main entry point of the project )
- 33. Redis (in app cache memory)
- 34. Redis cloud
- 35. SQL Workbench 
- 36. Dgram ()
- 37. TTL (time to live)
- 38. Heartbeat ()
- 39. port 3000 (TCP - Load balancer)
- 40. port 3001,3002,3003 (instances)
- 41. port 4000 UDP (heartbeat)
- 42. port 6100 TCP (socket gateway)
- 43. port 6000 (X11)
- 44. query cost (MySql different query have different cost )
- 45. Terminal $env: UDP_Heartbeat: instances send UDP packet, Rate_limiter: off register and login, Queue_Max: wait for new connection  , SG_port: socket gateway port   , Gateway: url, Pending_Max: msg wait in redis, Mover_interval: check for old msg, Delete_every: empty DB & Redis  
- 46. Hashing/Encryption (bycrypt version 2b + 10 cost 2^10 rounds & random salt 16 random bytes)
- 47. Alias 
- 48. AWS Bucket
- 49. Binlog (binary log in MySQL)
- 50. DB-IP
- 51. MMDB (max mind database IP address lookup )
- 52. Proxy 39.32.0.1 (Pakistan) & 8.8.8.8 (US)
- 

 




- Sprint 28:
- Load Balancer implementation.
- Multiple Sockets interconnections.
- Dgram implementation.
- Sticky Sessions.  


- Sprint 29:
- Hashing.
- Access denied across multiple devices
- Alias
- 1-1 chatting
- IP checking
- AWS Bucket
- 
- 