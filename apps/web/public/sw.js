// Rice Ops M10 — the installable app's service worker.
// * The app screens (pages, scripts, styles, fonts, icons) are cached so the app opens
//   with a weak or no signal.
// * API calls are NEVER cached or replayed here: signed steps go through the app's own
//   queue (with an Idempotency-Key), so the server decides, once, what happened.
const CACHE = "tindahan-v2";
const SHELL = ["/admin/dashboard", "/admin/login", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];
// A sleeping beta server takes 30 s or more to answer the first page. Past this wait the
// saved copy of the screen opens instead, and the fresh copy is still saved for next time.
const PAGE_WAIT_MS = 3000;

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
    // Pages: the network first (fresh), the cached copy when there is no signal or the
    // server is slow to wake.
    const fresh = fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    });
    event.waitUntil(fresh.catch(() => undefined));
    const saved = () => caches.match(req).then((hit) => hit || caches.match("/admin/dashboard"));
    event.respondWith(new Promise((resolve, reject) => {
      let done = false;
      const finish = (res) => { if (!done && res) { done = true; resolve(res); } };
      const timer = setTimeout(() => saved().then(finish), PAGE_WAIT_MS);
      fresh.then((res) => { clearTimeout(timer); finish(res); })
        .catch(() => { clearTimeout(timer); saved().then((hit) => (hit ? finish(hit) : reject(new Error("offline")))); });
    }));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || /\.(png|svg|ico|woff2?|css|js)$/.test(url.pathname)) {
    // Built files never change under the same name: cache first.
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
  }
});
