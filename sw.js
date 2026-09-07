// ShortwaveHQ Service Worker v1.1
const CACHE = 'shortwavehq-v2';
const STATIC = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install — cache static shell (NOT index.html/navigation — see fetch handler)
self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){ return c.addAll(STATIC); })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE; })
            .map(function(k){ return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch strategy:
// - navigation requests (page loads, including '/' and '/index.html') AND
//   data/*.json (schedule, propagation, reception) → network first, cache
//   fallback ONLY for offline use. This guarantees every new deploy shows
//   up on a normal reload — no hard refresh required.
// - true static assets (icons, manifest) → cache first, network fallback
self.addEventListener('fetch', function(e){
  var url = e.request.url;
  var isNavigation = e.request.mode === 'navigate';
  var isData = url.includes('/data/') && url.endsWith('.json');
  var isExternal = !url.startsWith(self.location.origin);

  // Don't intercept external requests (NOAA, analytics, etc.)
  if(isExternal){ return; }

  if(isNavigation || isData){
    // Network first — always try to get the freshest deploy/data,
    // fall back to cache only if the network request fails (offline).
    e.respondWith(
      fetch(e.request).then(function(r){
        var clone = r.clone();
        caches.open(CACHE).then(function(c){ c.put(e.request, clone); });
        return r;
      }).catch(function(){
        return caches.match(e.request);
      })
    );
  } else {
    // Cache first for true static assets (icons, manifest — these only
    // change when their filename changes, so caching them is safe).
    e.respondWith(
      caches.match(e.request).then(function(cached){
        if(cached) return cached;
        return fetch(e.request).then(function(r){
          var clone = r.clone();
          caches.open(CACHE).then(function(c){ c.put(e.request, clone); });
          return r;
        });
      })
    );
  }
});
