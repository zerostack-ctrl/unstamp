// Bump this any time you change app code — it invalidates the old cache.
const CACHE = 'unstamp-v3';

const PRECACHE = [
  './',
  './index.html',
  './css/theme.css',
  './css/app.css',
  './js/app.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  // Never cache HTML, JS, or CSS aggressively — always prefer network
  const url = new URL(e.request.url);
  const isCode = /\.(js|mjs|html|css|webmanifest)$/.test(url.pathname);
  const isVideoOrImage = /\.(mp4|webm|mov|m4v|png|jpg|jpeg|webp|svg|onnx)$/.test(url.pathname);

  if (isCode) {
    // Network first, fall back to cache
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request)),
    );
    return;
  }

  if (isVideoOrImage) return;   // let the browser handle media directly

  // Everything else: cache first
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request)),
  );
});