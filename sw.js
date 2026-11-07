// Кэш оболочки приложения: страница открывается и без сети, каналы — по сети.
const CACHE = 'p2pm-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'favicon.svg', 'site.webmanifest'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.includes('/wallet-lab/')) return; // у wallet-lab свой загрузчик

  e.respondWith(fetch(e.request.url, { cache: 'no-cache' }).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
