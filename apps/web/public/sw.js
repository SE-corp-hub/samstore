// Rice Ops M10 — the installable app's service worker.
// * The app screens (pages, scripts, styles, fonts, icons) are cached so the app opens
//   with a weak or no signal.
// * API calls are NEVER cached or replayed here: signed steps go through the app's own
//   queue (with an Idempotency-Key), so the server decides, once, what happened.
const CACHE = "tindahan-v1";
const SHELL = ["/admin/dashboard", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => undefined).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only this app's own files; the API (another origin or /admin API paths) is never touched.
  if (url.origin !== self.location.origin) {
    if (url.hostname === "fonts.gstatic.com" || url.hostname === "fonts.googleapis.com") {
      event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
    }
    return;
  }
  if (req.mode === "navigate") {
    // Pages: the network first (fresh), the cached copy when there is no signal.
    event.respondWith(
      fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/admin/dashboard"))),
    );
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || /\.(png|svg|ico|woff2?|css|js)$/.test(url.pathname)) {
    // Built files never change under the same name: cache first.
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
  }
});
