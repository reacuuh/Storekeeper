// Lets the app install like normal software and open without internet.
const CACHE = 'warehouse-v5';
const SHELL = ['./', './index.html', './styles.css', './app.js', './config.js', './vendor/supabase.js', './icon.svg', './manifest.json', './icon-192.png'];
const FONTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const keep = (req, res) => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; };

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Fonts never change at the same address: use the saved copy, so receipts look the same offline.
  if (FONTS.includes(url.origin)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => keep(e.request, res))));
    return;
  }
  // Only the app's own files. Data requests (fetch() calls, which have no destination) go straight to the network.
  if (url.origin !== location.origin || e.request.destination === '') return;
  // Network first, so updates show up straight away. A dead connection can hang for a long
  // time, so after 3 seconds the saved copy is used if there is one.
  const net = fetch(e.request).then(res => res.ok ? keep(e.request, res) : res);
  const saved = () => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
  const slow = new Promise(resolve => setTimeout(resolve, 3000)).then(() => caches.match(e.request));
  e.respondWith(Promise.race([net.catch(saved), slow.then(r => r || net.catch(saved))]));
});
