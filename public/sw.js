const CACHE_NAME = "gta6-voice-offline-v0.57";
const CORE_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest?v=0.57"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_SHELL).catch(() => {}))
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map(key => (key !== CACHE_NAME ? caches.delete(key) : Promise.resolve()))
      );
      await self.clients.claim();
    })()
  );
});

function isImmutableRuntimeAsset(url) {
  const path = url.pathname.toLowerCase();
  if (/\.(wasm|onnx|tar|bin|yml|yaml|woff2)$/.test(path)) return true;
  if (path.includes("/assets/") || path.includes("/models/")) return true;
  if (/(huggingface\.co|jsdelivr\.net|unpkg\.com|bcebos\.com)$/i.test(url.hostname)) return true;
  return false;
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Never cache live paid TTS API requests
  if (url.hostname.includes("elevenlabs.io")) return;

  // 1. Cache-First for OCR models (.tar/.onnx), WASM binaries, and hashed Vite bundles
  if (isImmutableRuntimeAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request, { ignoreSearch: false }) ||
          await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;

        const networkResponse = await fetch(request);
        if (networkResponse && (networkResponse.ok || networkResponse.type === "opaque")) {
          cache.put(request, networkResponse.clone()).catch(() => {});
        }
        return networkResponse;
      })()
    );
    return;
  }

  // 2. Network-First with instant offline cache fallback for HTML, CSS, and app shell
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok) {
            cache.put(request, fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch (_) {
          const cached = await cache.match(request) ||
            await cache.match(request, { ignoreSearch: true }) ||
            (request.mode === "navigate" ? await cache.match("./index.html") : null);
          if (cached) return cached;
          throw new Error("Offline and not in cache");
        }
      })()
    );
  }
});