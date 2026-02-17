// ═══════════════════════════════════════════
// AgentDeck Service Worker
// Push notifications + offline caching
// ═══════════════════════════════════════════

var CACHE_NAME = 'agentdeck-v1';
var STATIC_ASSETS = [
  '/',
  '/public/style.css',
  '/public/app.js',
  '/public/manifest.json',
  '/public/icons/icon-192.svg',
  '/public/icons/icon-512.svg',
];

// Cache static assets on install
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Clean old caches on activate
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names
          .filter(function(name) { return name !== CACHE_NAME; })
          .map(function(name) { return caches.delete(name); })
      );
    })
  );
  self.clients.claim();
});

// Serve from cache, fallback to network
self.addEventListener('fetch', function(event) {
  // Only cache GET requests for static assets
  if (event.request.method !== 'GET') return;

  // Don't cache API requests or WebSocket
  var url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  event.respondWith(
    caches.match(event.request).then(function(cached) {
      return cached || fetch(event.request).then(function(response) {
        // Cache successful responses for static assets
        if (response.ok && url.pathname.startsWith('/public/')) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      });
    })
  );
});

// Handle push notifications
self.addEventListener('push', function(event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'AgentDeck', body: event.data ? event.data.text() : 'Notification' };
  }

  var options = {
    body: data.body || 'Your agent needs attention',
    icon: '/public/icons/icon-192.svg',
    badge: '/public/icons/badge-72.svg',
    vibrate: [200, 100, 200],
    tag: data.id || 'agentdeck',
    renotify: true,
    requireInteraction: data.type === 'permission_request',
    data: data,
    actions: data.actions || [],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'AgentDeck', options)
  );
});

// Handle notification click/actions
self.addEventListener('notificationclick', function(event) {
  var data = event.notification.data || {};
  event.notification.close();

  if (event.action === 'allow' || event.action === 'deny') {
    // Send decision to server via fetch
    event.waitUntil(
      fetch('/api/hook/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: data.id || data.decisionId,
          behavior: event.action,
        }),
      }).catch(function() {
        // Ignore errors — user can still use the PWA
      })
    );
  } else {
    // Tapped notification body — open/focus the PWA
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(function(windowClients) {
        for (var i = 0; i < windowClients.length; i++) {
          if (windowClients[i].url.indexOf(self.location.origin) !== -1) {
            return windowClients[i].focus();
          }
        }
        return self.clients.openWindow('/');
      })
    );
  }
});
