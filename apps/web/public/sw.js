'use strict';

const NOTIFICATIONS_PATH = '/wiki/notifications';

self.addEventListener('push', (event) => {
  let tag = 'minewiki-notification';
  try {
    const payload = event.data ? event.data.json() : null;
    if (payload && typeof payload.tag === 'string' && /^minewiki-notification-[0-9]+$/.test(payload.tag)) {
      tag = payload.tag;
    }
  } catch {
    // A malformed payload still results in a privacy-safe generic notification.
  }
  event.waitUntil(self.registration.showNotification('MineWiki', {
    body: 'MineWiki에 새 알림이 있습니다.',
    icon: '/icon',
    badge: '/icon',
    tag,
    renotify: false,
    data: { path: NOTIFICATIONS_PATH },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const targetUrl = new URL(NOTIFICATIONS_PATH, self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ('navigate' in client) await client.navigate(targetUrl);
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
