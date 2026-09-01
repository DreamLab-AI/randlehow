// Randlehow service worker — repeat-visit caching of the APP SHELL only.
//
// Safety rule (never recreate the stale-client problem): the cache key is the
// build stamp, and the encrypted DATA is NEVER cached — bundle.enc, media/*, and
// the plaintext scene assets always go to the network, so a republished bundle
// is seen immediately. Only build-stamped code (html/js/wasm/scene) is cached.
//
// On a new deploy the stamp changes → this file changes byte-for-byte →
// (registered with updateViaCache:'none') the browser installs the new worker,
// which precaches the new code under a new cache name and deletes the old one.
// skipWaiting + clients.claim make the NEXT navigation use the fresh code, so
// the one transitional load (old code + new data) is caught by the app's
// stale-client "please refresh" notice and self-heals on reload.

const BUILD = '2026-09-01T13:48:25Z';
const CACHE = 'rlhw-' + BUILD;

// Build-stamped code that is safe to cache (never the encrypted data).
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './pkg/randlehow.js',
  './pkg/randlehow_bg.wasm',
  './scene/scene.js',
  './scene/vendor/three.module.js',
  './scene/vendor/three.core.js',
  './scene/vendor/OrbitControls.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {
        /* fail-open: if precache fails, run without a SW */
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const p = url.pathname;
  // NEVER cache the encrypted record or the plaintext scene data — always
  // network, so a republish (possibly a new envelope version) is seen at once.
  if (p.endsWith('/bundle.enc') || p.includes('/media/') || p.includes('/assets/')) {
    return; // fall through to the network
  }

  // App shell (code): serve from the build-stamped cache, fall back to network.
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
