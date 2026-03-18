// ═══════════════════════════════════════════════════════════
//  Knight & King Sudoku — Service Worker v3
//  • Cache-first pour assets, Network-first pour HTML
//  • Notification de mise à jour
//  • Fallback hors ligne complet
//  • Nettoyage automatique anciens caches
// ═══════════════════════════════════════════════════════════

const APP_VERSION  = '1.0.0';
const CACHE_STATIC = `kk-sudoku-static-v${APP_VERSION}`;
const CACHE_FONTS  = `kk-sudoku-fonts-v1`;

const STATIC_ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192x192.png',
  './icon-512x512.png',
  './icon-48x48.png',
  './icon-96x96.png',
];

// ── Installation : précache assets statiques ────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.error('[SW] Install failed:', err))
  );
});

// ── Activation : purge anciens caches ───────────────────────
self.addEventListener('activate', event => {
  const VALID = [CACHE_STATIC, CACHE_FONTS];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => !VALID.includes(k))
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch : stratégie par type de ressource ─────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Ignorer les requêtes non-GET et extensions Chrome
  if (event.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Google Fonts : Cache-first (longue durée, rarement changé)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(CACHE_FONTS).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(res => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          }).catch(() => cached);
        })
      )
    );
    return;
  }

  // Document HTML : Network-first avec fallback cache
  if (event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res.ok) {
            caches.open(CACHE_STATIC).then(c => c.put(event.request, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Tout le reste : Cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res && res.ok && res.type !== 'opaque') {
          caches.open(CACHE_STATIC).then(c => c.put(event.request, res.clone()));
        }
        return res;
      }).catch(() => {
        // Fallback image si asset manquant
        if (event.request.destination === 'image') {
          return caches.match('./icon-192x192.png');
        }
      });
    })
  );
});

// ── Messages client → SW ─────────────────────────────────────
self.addEventListener('message', event => {
  if (!event.data) return;
  switch (event.data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'GET_VERSION':
      event.ports[0]?.postMessage({ version: APP_VERSION });
      break;
    case 'CLEAR_CACHE':
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => event.ports[0]?.postMessage({ ok: true }));
      break;
  }
});

// ── Periodic Background Sync ─────────────────────────────────
self.addEventListener('periodicsync', event => {
  if (event.tag === 'refresh-cache') {
    event.waitUntil(
      caches.open(CACHE_STATIC).then(cache =>
        Promise.all(
          STATIC_ASSETS.map(url =>
            fetch(url, { cache: 'no-cache' })
              .then(res => { if (res.ok) cache.put(url, res); })
              .catch(() => {})
          )
        )
      )
    );
  }
});

// ── Push notifications (stub pour extension future) ──────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json().catch(() => ({ title: 'KK Sudoku', body: '' }));
  event.waitUntil(
    self.registration.showNotification(data.title || 'Knight & King Sudoku', {
      body:    data.body  || 'Nouvelle grille du jour disponible !',
      icon:    './icon-192x192.png',
      badge:   './icon-96x96.png',
      vibrate: [200, 100, 200],
      data:    { url: data.url || './' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if (client.url === event.notification.data?.url && 'focus' in client)
          return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(event.notification.data?.url || './');
    })
  );
});

// ── Background Sync : file d'attente hors ligne ──────────────
const SYNC_QUEUE = 'kk-sync-queue';

// Enregistrer une action à synchroniser plus tard
async function queueForSync(data) {
  const db = await openSyncDB();
  const tx = db.transaction('queue', 'readwrite');
  tx.objectStore('queue').add({ ...data, ts: Date.now() });
  await tx.complete;
  try { await self.registration.sync.register('kk-sync'); } catch(e) {}
}

function openSyncDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('kk-sync-db', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('queue', { autoIncrement: true });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

self.addEventListener('sync', event => {
  if (event.tag === 'kk-sync') {
    event.waitUntil(processSyncQueue());
  }
});

async function processSyncQueue() {
  // Pour ce jeu solo, on vide simplement la queue
  // (point d'extension pour un futur leaderboard en ligne)
  try {
    const db = await openSyncDB();
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').clear();
    console.log('[SW] Background sync: queue processed');
  } catch(e) {
    console.warn('[SW] Sync failed, will retry:', e);
    throw e; // force retry
  }
}

