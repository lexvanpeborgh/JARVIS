// Service worker: cachet uitsluitend de app-shell (statische bestanden).
// /api/-responses (koersen, signalen, instellingen, secrets) worden NOOIT gecachet.
const VERSION = 'fnx-shell-v2';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/views.js', '/js/api.js', '/js/chart.js', '/js/trade.js',
  '/vendor/preact.mjs', '/vendor/preact-hooks.mjs', '/vendor/htm.mjs', '/vendor/lightweight-charts.mjs',
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // netwerk eerst (nieuwe logica laadt betrouwbaar), cache als offline-terugval
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
