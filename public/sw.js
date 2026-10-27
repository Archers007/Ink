// Ink service worker. The game runs on the server over a WebSocket, so there is no offline play — this makes the app
// installable and quick to open: the shell (HTML, CSS, JS, three.js) is precached and refreshed in the background,
// card images and fonts are cached as they're seen. /api and /ws are never touched.
const VERSION = 'v2';
const SHELL_CACHE = `ink-shell-${VERSION}`;
const CARDS_CACHE = 'ink-cards-v1';
const FONTS_CACHE = 'ink-fonts-v1';
const KEEP = new Set([SHELL_CACHE, CARDS_CACHE, FONTS_CACHE]);
const SHELL = [
  '/play', '/css/ink.css', '/css/play.css', '/js/pwa.js', '/js/account.js', '/js/play/main.js', '/js/play/board.js', '/js/play/net.js', '/js/play/rules.js', '/js/play/textures.js',
  '/vendor/three/build/three.module.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
];
const CARDS_MAX = 600;                                     // card images kept (oldest dropped first)

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));   // a missing file never blocks install
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!KEEP.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const cacheable = (res) => res && (res.ok || res.type === 'opaque');
async function networkFirst(req) {
  const c = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch {
    return (await c.match(req, { ignoreSearch: true })) || (await c.match('/play')) || Response.error();
  }
}
async function staleWhileRevalidate(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  const net = fetch(req).then((res) => { if (cacheable(res)) c.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}
async function cacheFirst(req, name, max) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req).catch(() => null);
  if (cacheable(res)) {
    await c.put(req, res.clone());
    const keys = await c.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - max))) await c.delete(k);
  }
  return res || Response.error();
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;          // live data, always the network
    if (req.mode === 'navigate') { e.respondWith(networkFirst(req)); return; }
    if (/^\/(?:css|js|vendor|icons|rulebook)\/|^\/manifest\.webmanifest$/.test(url.pathname)) e.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }
  if (url.hostname === 'cdn.dreamborn.ink') { e.respondWith(cacheFirst(req, CARDS_CACHE, CARDS_MAX)); return; }
  if (/(?:^|\.)fonts\.(?:googleapis|gstatic)\.com$/.test(url.hostname)) e.respondWith(staleWhileRevalidate(req, FONTS_CACHE));
});
