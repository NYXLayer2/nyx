// Keeps the last good copy of every page and asset. The network always goes first; the copy is only used when the host
// does not answer or answers with a gateway error, so a returning visitor still gets the site during an outage.
const CACHE = 'site-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname === '/healthz') return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.status >= 502 && res.status <= 504) { const old = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }); if (old) return old; }
      else if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const old = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) || (req.mode === 'navigate' ? await cache.match('/') : null);
      if (old) return old; throw err;
    }
  })());
});
