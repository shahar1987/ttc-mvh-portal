/* Service worker להתראות דחיפה (FCM). חייב לשבת בשורש האתר. */
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
importScripts('config.js');
firebase.initializeApp(self.PORTAL_CONFIG.firebase);
const messaging = firebase.messaging();
messaging.onBackgroundMessage(payload => {
  const n = payload.notification || payload.data || {};
  self.registration.showNotification(n.title || 'הודעה מהמועדון', {
    body: n.body || '', icon: 'assets/icon-192.png', badge: 'assets/icon-192.png', dir: 'rtl', lang: 'he',
    data: { url: self.registration.scope + '#/news' },
  });
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate(e.notification.data.url); return c.focus(); }
    return clients.openWindow(e.notification.data.url);
  }));
});
