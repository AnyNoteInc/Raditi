// The service worker of the cabinet (docs/plan/75-chat-input-output.md, ВВ8;
// docs/plan/82-scheduled-tasks.md, Зп40, Зп41): it shows the notifications of chats and of
// scheduled tasks. A push carries no word of the client — the push services are abroad (rule 1):
// only `{ id, path, kind, scheduled, tag }`, the id of the notification, the path of the cabinet it
// opens, its kind, whether it is of a scheduled task and the tag a newer one replaces it by. The
// words are read here from the cabinet, with the cookie of the session; without a session the
// notification says what happened in general words of its kind and still opens its path. Nothing
// is cached. No imports: the worker is one plain file; src/lib/service-worker.test.ts keeps its
// titles and checks in step with @repo/domain.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

/** The titles of a notice of a chat with its client by it (notificationTitle of the domain). */
const CHAT_TITLES = Object.freeze({
  answered: 'Агент ответил',
  question: 'Агент задал вопрос',
  ready: 'Изменения готовы',
  failed: 'Агент не смог закончить работу',
  limit: 'Работа агента остановилась',
})

/** The titles of a notice of a scheduled task (scheduledNoticeTitle of the domain, Зп38). */
const SCHEDULED_TITLES = Object.freeze({
  answered: 'Запланированная задача выполнена',
  question: 'Запланированной задаче нужен ваш ответ',
  ready: 'Запланированная задача: изменения готовы',
  failed: 'Запланированная задача не выполнена',
  limit: 'Запланированная задача остановилась',
  not_started: 'Запланированная задача не запустилась',
  paused: 'Запланированная задача приостановлена',
  missed: 'Запланированная задача пропустила запуск',
})

const GENERAL = Object.freeze({
  title: 'Радити',
  body: 'Откройте Радити, чтобы посмотреть подробности',
  path: '/chats',
})

/** The sections of the cabinet: a window on one of them listens for `raditi:navigate`. */
const CABINET_SECTIONS = Object.freeze([
  '/app',
  '/chats',
  '/pages',
  '/profile',
  '/projects',
  '/scheduled',
  '/settings',
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TAG = /^(?:schedule|chat):[0-9a-f-]{36}$/
// The path of notificationPushPayloadSchema: of this origin, never `//host`.
const PATH = /^\/(?!\/)[A-Za-z0-9/_-]*$/

/** A path of the cabinet, or null: a notification never opens another site. */
function cabinetPath(value) {
  return typeof value === 'string' && value.length <= 200 && PATH.test(value) ? value : null
}

/** The general title of a kind, as notificationTitle of the domain says it without a cause. */
function titleOf(kind, scheduled) {
  if (kind === null) return GENERAL.title
  return (scheduled ? SCHEDULED_TITLES[kind] : CHAT_TITLES[kind]) || SCHEDULED_TITLES[kind]
}

/** The JSON of a push; null — none, or not JSON. */
function json(data) {
  try {
    return data ? data.json() : null
  } catch {
    return null
  }
}

/**
 * What a push named, field by field: a field that is not what the cabinet sends is null (false for
 * `scheduled`), so a push of an older cabinet — only `{ id }` — still shows.
 */
function payloadOf(data) {
  const parsed = json(data)
  const raw = parsed !== null && typeof parsed === 'object' ? parsed : {}
  return {
    id: typeof raw.id === 'string' && UUID.test(raw.id) ? raw.id : null,
    path: cabinetPath(raw.path),
    kind:
      typeof raw.kind === 'string' && Object.hasOwn(SCHEDULED_TITLES, raw.kind) ? raw.kind : null,
    scheduled: raw.scheduled === true,
    tag: typeof raw.tag === 'string' && TAG.test(raw.tag) ? raw.tag : null,
  }
}

/** The general words of a push: of its kind, opening its path. */
function generalWords(push) {
  return {
    title: titleOf(push.kind, push.scheduled),
    body: GENERAL.body,
    path: push.path || GENERAL.path,
  }
}

/** The words of the notification from the cabinet; the general ones without a session. */
async function wordsOf(push) {
  const general = generalWords(push)
  if (push.id === null) return general
  try {
    const response = await fetch(`/api/notifications/${push.id}`, { credentials: 'same-origin' })
    if (!response.ok) return general
    const words = await response.json()
    if (typeof words.title !== 'string' || typeof words.body !== 'string') return general
    return { title: words.title, body: words.body, path: cabinetPath(words.url) || general.path }
  } catch {
    return general
  }
}

self.addEventListener('push', (event) => {
  const push = payloadOf(event.data)
  event.waitUntil(
    wordsOf(push).then((words) =>
      self.registration.showNotification(words.title, {
        body: words.body,
        icon: '/brand-icon.png',
        lang: 'ru',
        timestamp: Date.now(),
        // A newer run of a task, a newer pass of a chat replaces the notice before it, and says so.
        tag: push.tag || words.path,
        renotify: true,
        data: { path: words.path },
      }),
    ),
  )
})

const sameOrigin = (client) => new URL(client.url).origin === self.location.origin
const pathOfClient = (client) => new URL(client.url).pathname
const inCabinet = (path) =>
  CABINET_SECTIONS.some((section) => path === section || path.startsWith(`${section}/`))

/**
 * Where a click on a notification goes (Зп41): a window already on its path is brought forward; a
 * window of the cabinet is brought forward and told the path, and goes there itself without a
 * reload, keeping what the client was typing; otherwise a new window opens on the path.
 */
async function openPath(path) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const ours = windows.filter(sameOrigin)
  const there = ours.find((client) => pathOfClient(client) === path)
  if (there) return there.focus()
  const cabinet =
    ours.find((client) => client.focused && inCabinet(pathOfClient(client))) ||
    ours.find((client) => inCabinet(pathOfClient(client)))
  if (cabinet) {
    // A browser may refuse to bring it forward; it still goes to the path.
    const focused = await cabinet.focus().catch(() => null)
    const target = focused || cabinet
    target.postMessage({ type: 'raditi:navigate', path })
    return target
  }
  return self.clients.openWindow(path)
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data
  // `url` — a notification shown by the worker before plan 82.
  const path = cabinetPath(data && (data.path || data.url)) || GENERAL.path
  event.waitUntil(openPath(path))
})

/**
 * The browser replaced the subscription (Зп41): the cabinet keeps the new one and drops the old.
 * Safari gives the new subscription; Chrome and Firefox may not, and it is made again under the key
 * of the old one. With neither there is nothing to give: the switch in the settings shows «off».
 */
async function resubscribe(event) {
  const old = event.oldSubscription || null
  let next = event.newSubscription || null
  if (next === null) {
    const key = old && old.options && old.options.applicationServerKey
    if (!key) return
    next = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    })
  }
  const keys = next.toJSON().keys || {}
  await fetch('/api/notifications/resubscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      oldEndpoint: old ? old.endpoint : null,
      endpoint: next.endpoint,
      p256dh: keys.p256dh || '',
      auth: keys.auth || '',
    }),
  })
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(resubscribe(event).catch(() => undefined))
})
