// Task 1.3: pages without their own gateway socket (chat, dashboard, home) watch for "session:ended".
// When the same user logs in on another device, the socket gateway ends this page's session at once.
(function () {
  const GATEWAY_URL = 'http://localhost:6100';

  // shared toast for every page: red = error (default), blue = 'info'; also used by the login page for its errors
  window.toast = function (text, kind, ms) {
    const t = document.createElement('div');
    t.setAttribute('role', kind === 'info' ? 'status' : 'alert');
    t.textContent = text;
    t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;max-width:calc(100% - 32px);' +
      'padding:12px 16px;border-radius:8px;color:#fff;font:14px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);' +
      'background:' + (kind === 'info' ? '#1d4ed8' : '#b91c1c');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 3000);
    return t;
  };

  // new device: the login page left a note about the session this login replaced; show it once (supervisor's request)
  try {
    const p = JSON.parse(sessionStorage.getItem('previousDevice') || 'null');
    if (p) {
      sessionStorage.removeItem('previousDevice');
      const place = [p.city, p.country].filter(Boolean).join(', ') || 'unknown location';
      const since = p.since ? new Date(p.since).toLocaleString() : 'unknown time';
      window.toast(`Your other device was signed out (${place}, logged in ${since}).`, 'info', 3000);
    }
  } catch { /* storage blocked or bad note: skip */ }

  // shared by every page (Messaging calls it too): toast, then the login page, which repeats the reason
  window.sessionEnded = function (reason, myToken) {
    try {
      // old device: delete this app's data from the browser, but only if the stored login is still ours
      // (a newer login in another tab of the same browser must survive). The theme is a setting, not user data.
      const stored = localStorage.getItem('token');
      if (!stored || stored === myToken) {
        const theme = localStorage.getItem('theme');
        localStorage.clear();
        sessionStorage.clear();
        if (theme) localStorage.setItem('theme', theme);
      }
    } catch { /* storage blocked */ }
    console.log('[session] ended:', reason);
    window.toast((reason === 'new_login'
      ? 'You were logged out because you logged in on another device.'
      : 'You were logged out.') + ' Going to the login page...');
    setTimeout(() => { location.href = '/index.html?ended=' + encodeURIComponent(reason); }, 3000);
  };

  if (window.SESSION_WATCH_SELF) return; // the page has its own gateway socket (Messaging): no watcher
  let token = null;
  try { token = localStorage.getItem('token'); } catch { /* storage blocked */ }
  if (!token) return; // not logged in: nothing to watch

  function start() {
    const s = io(GATEWAY_URL, { auth: { token, watch: true }, transports: ['websocket'] });
    s.on('session:ended', ({ reason }) => { s.disconnect(); window.sessionEnded(reason, token); });
    s.on('connect_error', (e) => { // task 1.4: the gateway refuses an old session
      if (e.message === 'Session ended') { s.disconnect(); window.sessionEnded('ended', token); }
    });
  }
  if (window.io) return start(); // the page already loaded the Socket.IO client
  const el = document.createElement('script'); // dashboard / home: load it first
  el.src = '/socket.io/socket.io.js';
  el.onload = start;
  document.head.appendChild(el);
})();
