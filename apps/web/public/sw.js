/* Strata service worker: keeps the app shell available offline and receives Web Push. */
const CACHE = 'strata-shell-v3';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/manifest-violet.webmanifest', '/icons/violet-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Conversation data is never cached here. It lives in IndexedDB, under the app's own control.
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok && url.pathname.startsWith('/assets/')) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Strata', body: 'New activity', url: '/' };
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((windows) => {
      // If Strata is already on screen, the app shows this itself.
      if (windows.some((w) => w.visibilityState === 'visible')) return undefined;
      return self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/icons/violet-192.png',
        badge: '/icons/violet-64.png',
        // The same tag replaces the last one, so a busy conversation is one entry that updates.
        tag: data.tag,
        renotify: !!data.tag,
        data: { url: data.url },
      });
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((windows) => {
      const open = windows[0];
      if (open) {
        open.navigate(url);
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
