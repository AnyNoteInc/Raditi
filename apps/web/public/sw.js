// The service worker of the cabinet (docs/plan/75-chat-input-output.md, ВВ8;
// docs/plan/82-scheduled-tasks.md, Зп40, Зп41): it shows the notifications of chats and of
// scheduled tasks. A push carries no word of the client — the push services are abroad (rule 1):
// only `{ id, path, kind, scheduled, tag, at }`, the id of the notification, the path of the
// cabinet it opens, its kind, whether it is of a scheduled task, the tag a newer one replaces it by
// and when the cabinet made it. The words are read here from the cabinet, with the cookie of the
// session; without a session the notification says what happened in general words of its kind and
// still opens its path. Nothing is cached. No imports: the worker is one plain file;
// src/lib/service-worker.test.ts keeps its titles and checks in step with @repo/domain.

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
  // A run in a project with a repository that left changes in the chat's branch (plan 84).
  ready: 'Запланированная задача подготовила изменения',
  failed: 'Запланированная задача не выполнена',
  limit: 'Запланированная задача остановилась',
  not_started: 'Запланированная задача не запустилась',
  paused: 'Запланированная задача приостановлена',
  missed: 'Запланированная задача пропустила запуск',
})

const ICON = '/brand-icon.png'

const GENERAL = Object.freeze({
  title: 'Радити',
  body: 'Откройте Радити, чтобы посмотреть подробности',
  path: '/chats',
})

/** The sections of the cabinet: a window on one of them listens for `raditi:navigate`. */
const CABINET_SECTIONS = Object.freeze([
  '/app',
  '/artifacts',
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

/** A moment the cabinet named, in ms since the epoch; null — none, or not one. */
function momentOf(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * What a push named, field by field: a field that is not what the cabinet sends is null (false for
 * `scheduled`), so a push of an older cabinet — only `{ id }`, or no `at` — still shows.
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
    at: momentOf(raw.at),
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

/** The notifications shown now under a tag; none where the browser does not tell. */
async function shownUnder(tag) {
  try {
    return await self.registration.getNotifications({ tag })
  } catch {
    return []
  }
}

/**
 * A notice shown under the tag that the cabinet made after this push's one, or null (Зп41). A push
 * service gives an urgent push at once and holds one of normal urgency on a phone that sleeps, so
 * an older notice — «пропустила запуск» — can come after a newer, urgent one — «не запустилась» —
 * and must not replace it. A push or a notice without its moment is not ordered: it replaces.
 */
async function newerShown(tag, at) {
  if (at === null) return null
  const shown = await shownUnder(tag)
  return shown.find((notification) => (momentOf(notification.data?.at) ?? 0) > at) || null
}

/**
 * Shows the newer notice again as it is, without a sound: it stays on top of the older one, and
 * this push still shows a notification — Safari drops a subscription whose pushes show none.
 */
function showAgain(notification) {
  return self.registration.showNotification(notification.title, {
    body: notification.body,
    icon: notification.icon || ICON,
    lang: 'ru',
    timestamp: notification.timestamp,
    tag: notification.tag,
    renotify: false,
    data: notification.data,
  })
}

async function showPush(push) {
  const words = await wordsOf(push)
  // A newer run of a task, a newer pass of a chat replaces the notice before it, and says so.
  const tag = push.tag || words.path
  // Asked after the words are read: a newer push may have been shown meanwhile.
  const newer = await newerShown(tag, push.at)
  if (newer !== null) return showAgain(newer)
  return self.registration.showNotification(words.title, {
    body: words.body,
    icon: ICON,
    lang: 'ru',
    timestamp: push.at ?? Date.now(),
    tag,
    renotify: true,
    data: { path: words.path, at: push.at },
  })
}

self.addEventListener('push', (event) => {
  event.waitUntil(showPush(payloadOf(event.data)))
})

const sameOrigin = (client) => new URL(client.url).origin === self.location.origin
const pathOfClient = (client) => new URL(client.url).pathname
const inCabinet = (path) =>
  CABINET_SECTIONS.some((section) => path === section || path.startsWith(`${section}/`))

/** How long a window of the cabinet has to answer that it goes to the path (Зп41). */
const ANSWER_MS = 500

/**
 * Tells a window of the cabinet the path, with a port to answer on: true — it answered that it
 * goes there (the bridge of the cabinet, `{ ok: true }`). A page of an older cabinet, or one that
 * did not mount the bridge, answers nothing. Not longer than ANSWER_MS: Firefox lets a worker open
 * a window only within a second of the click.
 */
function told(client, path) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    let timer = null
    const done = (answered) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(answered)
    }
    timer = setTimeout(() => done(false), ANSWER_MS)
    channel.port1.onmessage = (event) => done(event.data?.ok === true)
    try {
      client.postMessage({ type: 'raditi:navigate', path }, [channel.port2])
    } catch {
      done(false)
    }
  })
}

/**
 * Where a click on a notification goes (Зп41): a window already on its path is brought forward; a
 * window of the cabinet is brought forward and told the path, and goes there itself without a
 * reload, keeping what the client was typing; a window that does not answer is moved by the worker
 * when it controls it, and otherwise — or with no window of the cabinet — a new window opens on
 * the path.
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
    if (await told(target, path)) return target
    if (typeof target.navigate === 'function') {
      try {
        return await target.navigate(path)
      } catch {
        // A window this worker does not control: it stays, and a new one opens.
      }
    }
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
