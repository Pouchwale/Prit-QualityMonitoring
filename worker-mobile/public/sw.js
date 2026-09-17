/* Service worker for the worker web app: shows "check is due" notifications sent by the
 * backend (Web Push) and opens the check when one is tapped. It does not cache the app, so a
 * new version is always picked up on the next load. */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Quality check', body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Quality check due'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      // One notification per check: the same check never stacks twice.
      tag: data.tag || (data.checkId ? `check-${data.checkId}` : undefined),
      data: { checkId: data.checkId || null },
      icon: new URL('icon-192.png', self.registration.scope).href,
      badge: new URL('icon-192.png', self.registration.scope).href,
      requireInteraction: !!data.checkId
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const checkId = event.notification.data && event.notification.data.checkId
  const scope = self.registration.scope
  const target = checkId ? `${scope}?check=${encodeURIComponent(checkId)}` : scope

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(scope))
      if (open) {
        if (checkId) open.postMessage({ type: 'open-check', checkId })
        return open.focus()
      }
      return self.clients.openWindow(target)
    })
  )
})
