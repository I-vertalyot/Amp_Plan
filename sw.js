// Amp Plan offline support: keep the app and its fonts so it opens without internet.
// The page itself comes from the network first, so an update shows at once when online;
// without internet the saved copy opens instead. Fonts and icons come from the cache first.
const CACHE = 'amp-plan-v3';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  const font = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!same && !font) return;
  const page = req.mode === 'navigate' || (same && /(\/|\.html)$/.test(url.pathname));
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const key = page ? './index.html' : req;
    if (page) {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res && res.ok) cache.put(key, res.clone());
        return res;
      } catch (err) {
        return (await cache.match(key)) || Response.error();
      }
    }
    const hit = await cache.match(key);
    const fresh = fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone());
      return res;
    }).catch(() => hit);
    return hit || fresh;
  }));
});
