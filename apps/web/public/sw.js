// The service worker of the cabinet (docs/plan/75-chat-input-output.md, ВВ8): it shows the
// notifications of chats that wait for the client. A push carries only the id of a notification —
// the push services are abroad, and nothing of a chat goes through them — so the words are read
// here from the cabinet, with the cookie of the session. Nothing is cached.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

const FALLBACK = { title: 'Радити', body: 'Агент ждёт вас в чате', url: '/chats' }

async function wordsOf(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return FALLBACK
  try {
    const response = await fetch(`/api/notifications/${id}`, { credentials: 'same-origin' })
    if (!response.ok) return FALLBACK
    const words = await response.json()
    return typeof words.title === 'string' && typeof words.url === 'string' ? words : FALLBACK
  } catch {
    return FALLBACK
  }
}

/** The id of the notification a push named; null — a push the cabinet did not send. */
function idOf(data) {
  try {
    return data ? data.json().id : null
  } catch {
    return null
  }
}

self.addEventListener('push', (event) => {
  const id = idOf(event.data)
  event.waitUntil(
    wordsOf(id).then((words) =>
      self.registration.showNotification(words.title, {
        body: words.body,
        icon: '/brand-icon.png',
        tag: words.url,
        data: { url: words.url },
      }),
    ),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = event.notification.data && event.notification.data.url
  // Only a path of the cabinet: a notification never opens another site.
  const url =
    typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : '/chats'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).pathname === url && 'focus' in client) return client.focus()
      }
      return self.clients.openWindow(url)
    }),
  )
})
