// Paseo web PWA service worker.
// Strategy:
//   - install:  precache the navigation shell + manifest + icons.
//   - activate: drop caches whose name prefix does not match the current version.
//   - fetch:
//       * WebSocket upgrade / non-GET / cross-origin / /api / /mcp / /public:
//         pass through untouched (daemon traffic must not be intercepted).
//       * Same-origin hashed/static assets: cache-first with network fallback.
//       * Navigations: network-first with cached /index.html fallback (so the
//         shell boots offline and a single PWA cold start is instant).
//   - message:  accept SKIP_WAITING so a future hot-update can short-circuit.

const CACHE_VERSION = "v1";
const SHELL_CACHE = `paseo-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `paseo-static-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/apple-touch-icon.png",
  "/pwa-icon-192.png",
  "/pwa-icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (name) => name.startsWith("paseo-") && name !== SHELL_CACHE && name !== STATIC_CACHE,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

const PASSTHROUGH_PREFIXES = ["/api/", "/mcp/", "/public/"];

function shouldPassThrough(request, url) {
  if (request.method !== "GET") return true;

  const upgrade = request.headers.get("Upgrade");
  if (upgrade && upgrade.toLowerCase() === "websocket") return true;

  if (url.origin !== self.location.origin) return true;

  for (const prefix of PASSTHROUGH_PREFIXES) {
    if (url.pathname === prefix.slice(0, -1) || url.pathname.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function isHashedAsset(pathname) {
  // Match Expo's hashed asset pattern: e.g. index-84d237479f52c7a9176a8f375c7be7f9.js
  return /[-.][0-9a-f]{16,}[-.]/i.test(pathname);
}

function cacheFirst(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;
    return fetch(request)
      .then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const copy = response.clone();
          caches
            .open(STATIC_CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => undefined);
        }
        return response;
      })
      .catch(() => caches.match("/index.html"));
  });
}

function networkFirst(request) {
  return fetch(request)
    .then((response) => {
      if (response && response.status === 200 && response.type === "basic") {
        const copy = response.clone();
        caches
          .open(SHELL_CACHE)
          .then((cache) => cache.put("/", copy))
          .catch(() => undefined);
      }
      return response;
    })
    .catch(async () => {
      const cachedShell = await caches.match("/index.html");
      if (cachedShell) return cachedShell;
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><title>Paseo offline</title>' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          "<style>body{font-family:system-ui,sans-serif;background:#181B1A;color:#fff;" +
          "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}" +
          "main{text-align:center;padding:24px;max-width:420px;}" +
          "h1{font-size:20px;margin:0 0 8px;}p{opacity:.7;margin:0;font-size:14px;}</style></head>" +
          "<body><main><h1>Paseo is offline</h1><p>Reconnect to your daemon to resume.</p>" +
          "</main></body></html>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  if (shouldPassThrough(request, url)) return;

  if (
    isHashedAsset(url.pathname) ||
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/_expo/")
  ) {
    event.respondWith(cacheFirst(request));
  }
});
