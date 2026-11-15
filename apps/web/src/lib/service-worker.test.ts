import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContext, Script } from 'node:vm'

import {
  chatNotifyKinds,
  notificationKinds,
  notificationPushPayloadSchema,
  notificationTitle,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { NAVIGATE_ANSWER, NAVIGATE_MESSAGE } from '@/components/notifications/cabinet-messages'

// The service worker of the cabinet (public/sw.js; docs/plan/82-scheduled-tasks.md, Зп40, Зп41) is
// one plain file without imports. It runs here in a context of its own with a fake `self`, so its
// titles are compared with the domain's and its handlers are driven like a browser drives them.

const SOURCE = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8')
const ORIGIN = 'https://raditi.ru'
const NOTICE = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const SCHEDULE = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60'

interface FakeWindow {
  url: string
  focused?: boolean
  focus: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
  navigate?: ReturnType<typeof vi.fn>
}

/**
 * A window of the browser. `answers` — its page mounted the bridge of the cabinet and answers a
 * `raditi:navigate` on the port the worker gives; `controlled` — the worker controls it, so it can
 * move it (`WindowClient.navigate`); a window it does not control refuses.
 */
function fakeWindow(
  path: string,
  options: { focused?: boolean; origin?: string; answers?: boolean; controlled?: boolean } = {},
): FakeWindow {
  const { focused = false, origin = ORIGIN, answers = true, controlled = true } = options
  const window: FakeWindow = {
    url: `${origin}${path}`,
    focused,
    focus: vi.fn(async () => window),
    postMessage: vi.fn((_message: unknown, ports?: MessagePort[]) => {
      if (answers) ports?.[0]?.postMessage(NAVIGATE_ANSWER)
    }),
    navigate: vi.fn(async (to: string) => {
      if (!controlled) throw new TypeError('not controlled by this worker')
      window.url = `${origin}${to}`
      return window
    }),
  }
  return window
}

/** A notification the browser shows now, as `getNotifications` gives it. */
interface ShownNotification {
  title: string
  body: string
  icon: string
  tag: string
  timestamp: number
  data: unknown
}

/** The worker in a context of its own: its listeners, its top-level names, what it called. */
function loadWorker(options: {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** What the browser shows now; undefined — a browser without `getNotifications`. */
  shown?: ShownNotification[]
}) {
  const listeners = new Map<string, (event: unknown) => void>()
  const windows: FakeWindow[] = []
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: vi.fn(),
    location: { origin: ORIGIN },
    registration: {
      showNotification: vi.fn(async () => undefined),
      ...(options.shown === undefined
        ? {}
        : { getNotifications: vi.fn(async () => options.shown ?? []) }),
      pushManager: {
        subscribe: vi.fn(async () => ({
          endpoint: 'https://fcm.googleapis.com/fcm/send/new',
          toJSON: () => ({ keys: { p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) } }),
        })),
      },
    },
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null),
    },
  }
  const fetch = vi.fn(options.fetch ?? (async () => new Response('{}', { status: 401 })))
  const context = createContext({ self, fetch, URL, MessageChannel, setTimeout, clearTimeout })
  new Script(SOURCE).runInContext(context)
  const read = <T>(name: string): T => new Script(name).runInContext(context) as T
  /** Fires an event and waits for what it gave `waitUntil`. */
  async function fire(type: string, event: Record<string, unknown>) {
    const waits: Promise<unknown>[] = []
    listeners.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    })
    await Promise.all(waits)
  }
  return { self, fetch, windows, read, fire }
}

const pushOf = (payload: unknown) => ({ data: { json: () => payload } })

describe('the titles a push shows without the words of the cabinet (Зп40)', () => {
  const worker = loadWorker({})
  const titleOf = worker.read<(kind: string | null, scheduled: boolean) => string>('titleOf')

  it('are the titles of the domain, kind by kind', () => {
    for (const kind of notificationKinds)
      for (const scheduled of [false, true])
        expect(titleOf(kind, scheduled), `${kind}, scheduled ${scheduled}`).toBe(
          notificationTitle(kind, { scheduled }),
        )
  })

  it('know every kind of the domain and no other', () => {
    expect(Object.keys(worker.read<object>('SCHEDULED_TITLES')).sort()).toEqual(
      [...notificationKinds].sort(),
    )
    expect(Object.keys(worker.read<object>('CHAT_TITLES')).sort()).toEqual(
      [...chatNotifyKinds].sort(),
    )
  })

  it('open only the paths the domain lets a push name', () => {
    const cabinetPath = worker.read<(value: unknown) => string | null>('cabinetPath')
    const samples = [
      '/chats',
      `/chats/${NOTICE}`,
      `/scheduled/${SCHEDULE}`,
      '/',
      '//evil.example',
      '/\\evil.example',
      'https://evil.example/chats',
      '/chats?x=1',
      '/chats#top',
      '/a b',
      '',
      `/${'a'.repeat(200)}`,
    ]
    for (const sample of samples)
      expect(cabinetPath(sample) !== null, sample).toBe(
        notificationPushPayloadSchema.shape.path.safeParse(sample).success,
      )
    expect(cabinetPath(42)).toBeNull()
  })

  it('take the moment of a push as the cabinet sends it (notificationPushPayloadSchema.at)', () => {
    const momentOf = worker.read<(value: unknown) => number | null>('momentOf')
    const samples = [
      Date.UTC(2026, 10, 16, 9),
      1,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 2,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1763283600000',
      null,
      undefined,
    ]
    for (const sample of samples)
      expect(momentOf(sample) !== null, String(sample)).toBe(
        notificationPushPayloadSchema.shape.at.safeParse(sample).success,
      )
  })

  it('know every section of the cabinet a window can listen in', () => {
    const sections = worker.read<readonly string[]>('CABINET_SECTIONS')
    const cabinet = fileURLToPath(new URL('../app/(protected)', import.meta.url))
    const folders = readdirSync(cabinet, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !/^[([]/.test(entry.name))
      .map((entry) => `/${entry.name}`)
    expect(folders.length).toBeGreaterThan(0)
    for (const folder of folders) expect(sections).toContain(folder)
  })
})

describe('a push (Зп40, Зп41)', () => {
  const payload = {
    id: NOTICE,
    path: `/chats/${NOTICE}`,
    kind: 'answered',
    scheduled: true,
    tag: `schedule:${SCHEDULE}`,
  }

  it('shows the words of the cabinet, read with the cookie of the session', async () => {
    const worker = loadWorker({
      fetch: async () =>
        Response.json({
          title: 'Запланированная задача выполнена',
          body: 'Заявки за сутки',
          url: `/chats/${NOTICE}`,
        }),
    })
    await worker.fire('push', pushOf(payload))
    expect(worker.fetch).toHaveBeenCalledWith(`/api/notifications/${NOTICE}`, {
      credentials: 'same-origin',
    })
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
      'Запланированная задача выполнена',
      expect.objectContaining({
        body: 'Заявки за сутки',
        lang: 'ru',
        tag: `schedule:${SCHEDULE}`,
        timestamp: expect.any(Number),
        data: { path: `/chats/${NOTICE}`, at: null },
      }),
    )
  })

  it('says it in the general words of its kind without a session, and still opens its path', async () => {
    const worker = loadWorker({})
    await worker.fire(
      'push',
      pushOf({ ...payload, kind: 'not_started', path: `/scheduled/${SCHEDULE}` }),
    )
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
      'Запланированная задача не запустилась',
      expect.objectContaining({
        body: 'Откройте Радити, чтобы посмотреть подробности',
        data: { path: `/scheduled/${SCHEDULE}`, at: null },
      }),
    )
  })

  it('names a chat with its client by it as before', async () => {
    const worker = loadWorker({ fetch: async () => new Response('{}', { status: 404 }) })
    await worker.fire(
      'push',
      pushOf({ ...payload, scheduled: false, kind: 'question', tag: `chat:${NOTICE}` }),
    )
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
      'Агент задал вопрос',
      expect.objectContaining({ tag: `chat:${NOTICE}` }),
    )
  })

  it('trusts no field that is not what the cabinet sends', async () => {
    const worker = loadWorker({
      fetch: async () => Response.json({ title: 'x', body: 'y', url: 'https://evil.example' }),
    })
    await worker.fire(
      'push',
      pushOf({ id: 'nope', path: '//evil.example', kind: 'boom', tag: '<b>' }),
    )
    expect(worker.fetch).not.toHaveBeenCalled()
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
      'Радити',
      expect.objectContaining({ tag: '/chats', data: { path: '/chats', at: null } }),
    )
    // A path the cabinet answers that is not of the cabinet gives way to the push's own.
    await worker.fire('push', pushOf(payload))
    expect(worker.self.registration.showNotification).toHaveBeenLastCalledWith(
      'x',
      expect.objectContaining({ data: { path: `/chats/${NOTICE}`, at: null } }),
    )
  })

  it('shows a push of an older cabinet that named only the id', async () => {
    const worker = loadWorker({})
    await worker.fire('push', pushOf({ id: NOTICE }))
    expect(worker.fetch).toHaveBeenCalled()
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
      'Радити',
      expect.objectContaining({ data: { path: '/chats', at: null } }),
    )
  })
})

describe('a push that comes late (Зп41)', () => {
  // Within one tick core tells «пропустила запуск» (normal urgency), then «не запустилась»
  // (urgent); a phone that sleeps gets the urgent one first.
  const MISSED_AT = Date.UTC(2026, 10, 15, 9, 0, 0)
  const REFUSED_AT = MISSED_AT + 4_000
  const refusedShown: ShownNotification = {
    title: 'Запланированная задача не запустилась',
    body: 'Сводка заявок — нет кредитов',
    icon: `${ORIGIN}/brand-icon.png`,
    tag: `schedule:${SCHEDULE}`,
    timestamp: REFUSED_AT,
    data: { path: `/scheduled/${SCHEDULE}`, at: REFUSED_AT },
  }
  const missed = {
    id: NOTICE,
    path: `/scheduled/${SCHEDULE}`,
    kind: 'missed',
    scheduled: true,
    tag: `schedule:${SCHEDULE}`,
    at: MISSED_AT,
  }
  const missedWords = async () =>
    Response.json({
      title: 'Запланированная задача пропустила запуск',
      body: 'Сводка заявок',
      url: `/scheduled/${SCHEDULE}`,
    })

  it('does not replace a newer notice of its tag: the newer one is shown again, silently', async () => {
    const worker = loadWorker({ fetch: missedWords, shown: [refusedShown] })
    await worker.fire('push', pushOf(missed))
    expect(worker.self.registration.getNotifications).toHaveBeenCalledWith({
      tag: `schedule:${SCHEDULE}`,
    })
    expect(worker.self.registration.showNotification).toHaveBeenCalledTimes(1)
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
      'Запланированная задача не запустилась',
      {
        body: 'Сводка заявок — нет кредитов',
        icon: `${ORIGIN}/brand-icon.png`,
        lang: 'ru',
        timestamp: REFUSED_AT,
        tag: `schedule:${SCHEDULE}`,
        renotify: false,
        data: { path: `/scheduled/${SCHEDULE}`, at: REFUSED_AT },
      },
    )
  })

  it('replaces an older notice, timed by when the cabinet made it', async () => {
    const worker = loadWorker({
      fetch: missedWords,
      shown: [{ ...refusedShown, timestamp: MISSED_AT - 1, data: { at: MISSED_AT - 1 } }],
    })
    await worker.fire('push', pushOf(missed))
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
      'Запланированная задача пропустила запуск',
      expect.objectContaining({
        timestamp: MISSED_AT,
        renotify: true,
        data: { path: `/scheduled/${SCHEDULE}`, at: MISSED_AT },
      }),
    )
  })

  it('replaces as before where a time is not known: of the push, of the notice or of the browser', async () => {
    for (const [push, shown] of [
      [{ ...missed, at: undefined }, [refusedShown]],
      [{ ...missed, at: 'soon' }, [refusedShown]],
      [missed, [{ ...refusedShown, data: { path: `/scheduled/${SCHEDULE}` } }]],
      [missed, undefined],
    ] as const) {
      const worker = loadWorker({ fetch: missedWords, shown: shown ? [...shown] : undefined })
      await worker.fire('push', pushOf(push))
      expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
        'Запланированная задача пропустила запуск',
        expect.objectContaining({ renotify: true, tag: `schedule:${SCHEDULE}` }),
      )
    }
  })
})

describe('a click on a notification (Зп41)', () => {
  const click = (path: unknown) => ({
    notification: { close: vi.fn(), data: { path } },
  })

  it('brings forward a window already there', async () => {
    const worker = loadWorker({})
    const there = fakeWindow(`/chats/${NOTICE}`)
    worker.windows.push(fakeWindow('/settings'), there)
    await worker.fire('notificationclick', click(`/chats/${NOTICE}`))
    expect(there.focus).toHaveBeenCalled()
    expect(there.postMessage).not.toHaveBeenCalled()
    expect(worker.self.clients.openWindow).not.toHaveBeenCalled()
  })

  it('tells an open window of the cabinet where to go instead of opening another', async () => {
    const worker = loadWorker({})
    const landing = fakeWindow('/')
    const cabinet = fakeWindow('/chats/another')
    worker.windows.push(landing, cabinet, fakeWindow('/chats', { origin: 'https://evil.example' }))
    await worker.fire('notificationclick', click(`/scheduled/${SCHEDULE}`))
    expect(cabinet.focus).toHaveBeenCalled()
    expect(cabinet.postMessage).toHaveBeenCalledWith(
      { type: NAVIGATE_MESSAGE, path: `/scheduled/${SCHEDULE}` },
      [expect.anything()],
    )
    // It answered: it goes there itself, keeping the draft.
    expect(cabinet.navigate).not.toHaveBeenCalled()
    expect(landing.postMessage).not.toHaveBeenCalled()
    expect(worker.self.clients.openWindow).not.toHaveBeenCalled()
  })

  it('moves a window of the cabinet that does not answer, when the worker controls it', async () => {
    const worker = loadWorker({})
    const yesterday = fakeWindow('/chats', { answers: false })
    worker.windows.push(yesterday)
    await worker.fire('notificationclick', click(`/chats/${NOTICE}`))
    expect(yesterday.postMessage).toHaveBeenCalled()
    expect(yesterday.navigate).toHaveBeenCalledWith(`/chats/${NOTICE}`)
    expect(worker.self.clients.openWindow).not.toHaveBeenCalled()
  })

  it('opens a new window when a window of the cabinet does not answer and cannot be moved', async () => {
    const worker = loadWorker({})
    const uncontrolled = fakeWindow('/chats', { answers: false, controlled: false })
    worker.windows.push(uncontrolled)
    await worker.fire('notificationclick', click(`/chats/${NOTICE}`))
    expect(uncontrolled.navigate).toHaveBeenCalled()
    expect(worker.self.clients.openWindow).toHaveBeenCalledWith(`/chats/${NOTICE}`)
    // A browser without WindowClient.navigate: the same.
    const older = loadWorker({})
    const window = fakeWindow('/chats', { answers: false })
    delete window.navigate
    older.windows.push(window)
    await older.fire('notificationclick', click(`/chats/${NOTICE}`))
    expect(older.self.clients.openWindow).toHaveBeenCalledWith(`/chats/${NOTICE}`)
  })

  it('opens a new window when no window of the cabinet is open, and never another site', async () => {
    const worker = loadWorker({})
    worker.windows.push(fakeWindow('/'))
    await worker.fire('notificationclick', click(`/chats/${NOTICE}`))
    expect(worker.self.clients.openWindow).toHaveBeenLastCalledWith(`/chats/${NOTICE}`)
    await worker.fire('notificationclick', click('https://evil.example/'))
    expect(worker.self.clients.openWindow).toHaveBeenLastCalledWith('/chats')
  })
})

describe('the browser replaced its subscription (Зп41)', () => {
  const answered = async () => Response.json({ ok: true })

  it('gives the new one and the old endpoint to the cabinet', async () => {
    const worker = loadWorker({ fetch: answered })
    await worker.fire('pushsubscriptionchange', {
      oldSubscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/old' },
      newSubscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/next',
        toJSON: () => ({ keys: { p256dh: 'N'.repeat(87), auth: 'n'.repeat(22) } }),
      },
    })
    expect(worker.fetch).toHaveBeenCalledWith('/api/notifications/resubscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        oldEndpoint: 'https://fcm.googleapis.com/fcm/send/old',
        endpoint: 'https://fcm.googleapis.com/fcm/send/next',
        p256dh: 'N'.repeat(87),
        auth: 'n'.repeat(22),
      }),
    })
  })

  it('subscribes again under the key of the old one when the browser gives no new one', async () => {
    const worker = loadWorker({ fetch: answered })
    const key = new ArrayBuffer(65)
    await worker.fire('pushsubscriptionchange', {
      oldSubscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/old',
        options: { applicationServerKey: key },
      },
    })
    expect(worker.self.registration.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: key,
    })
    const body = JSON.parse(String(worker.fetch.mock.calls[0]?.[1]?.body)) as Record<string, string>
    expect(body).toMatchObject({
      oldEndpoint: 'https://fcm.googleapis.com/fcm/send/old',
      endpoint: 'https://fcm.googleapis.com/fcm/send/new',
    })
  })

  it('gives nothing when there is neither a new subscription nor a key', async () => {
    const worker = loadWorker({ fetch: answered })
    await worker.fire('pushsubscriptionchange', { oldSubscription: null })
    expect(worker.fetch).not.toHaveBeenCalled()
  })
})
