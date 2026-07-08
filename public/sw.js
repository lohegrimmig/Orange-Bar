// Service Worker: App-Shell cachen (offline-fähige Oberfläche).
// API-Anfragen gehen immer ans Netz – Wallet-Daten dürfen nie veralten.
const CACHE = 'orange-bar-v3';
const SHELL = [
  '/', '/index.html', '/style.css', '/app.js', '/webauthn-client.js',
  '/vendor/qrcode.js', '/manifest.webmanifest', '/icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Eingehende Push-Nachrichten anzeigen.
self.addEventListener('push', (e) => {
  let data = { title: 'Orange-Bar', body: 'Neue Aktivität' };
  try { data = e.data.json(); } catch { /* Standardtext */ }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'orange-bar',
    vibrate: [80, 40, 80],
  }));
});

// Klick auf die Benachrichtigung öffnet/fokussiert die App.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow('/');
  }));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // API: nur Netz
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/')))
  );
});
