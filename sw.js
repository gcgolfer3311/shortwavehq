// ShortwaveHQ Service Worker v1.0
const CACHE = 'shortwavehq-v1';
const STATIC = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install — cache static shell
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
// - data/*.json (schedule, propagation, reception) → network first, cache fallback
// - everything else → cache first, network fallback
self.addEventListener('fetch', function(e){
  var url = e.request.url;
  var isData = url.includes('/data/') && url.endsWith('.json');
  var isExternal = !url.startsWith(self.location.origin);

  // Don't intercept external requests (NOAA, analytics, etc.)
  if(isExternal){ return; }

  if(isData){
    // Network first for live data — fall back to cache if offline
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
    // Cache first for static assets
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
