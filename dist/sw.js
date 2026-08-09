// ShortwaveHQ service worker
// Network-first for the app shell and live schedule data so users never get
// stuck on a stale cached page; falls back to cache only when offline.
var CACHE = "shortwavehq-v1";
var NETWORK_FIRST_PATHS = ["/", "/index.html", "/data/schedule.json"];

self.addEventListener("install", function (event) {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  var isNetworkFirst = NETWORK_FIRST_PATHS.indexOf(url.pathname) !== -1;

  if (isNetworkFirst) {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req);
      })
    );
    return;
  }

  // Cache-first for static assets (icons, etc.)
  event.respondWith(
    caches.match(req).then(function (cached) {
      return cached || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        return res;
      });
    }).catch(function () { return caches.match(req); })
  );
});
