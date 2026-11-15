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
}

function fakeWindow(path: string, focused = false, origin = ORIGIN): FakeWindow {
  const window: FakeWindow = {
    url: `${origin}${path}`,
    focused,
    focus: vi.fn(async () => window),
    postMessage: vi.fn(),
  }
  return window
}

/** The worker in a context of its own: its listeners, its top-level names, what it called. */
function loadWorker(options: { fetch?: (url: string, init?: RequestInit) => Promise<Response> }) {
  const listeners = new Map<string, (event: unknown) => void>()
  const windows: FakeWindow[] = []
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: vi.fn(),
    location: { origin: ORIGIN },
    registration: {
      showNotification: vi.fn(async () => undefined),
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
  const context = createContext({ self, fetch, URL })
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
        data: { path: `/chats/${NOTICE}` },
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
        data: { path: `/scheduled/${SCHEDULE}` },
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
      expect.objectContaining({ tag: '/chats', data: { path: '/chats' } }),
    )
    // A path the cabinet answers that is not of the cabinet gives way to the push's own.
    await worker.fire('push', pushOf(payload))
    expect(worker.self.registration.showNotification).toHaveBeenLastCalledWith(
      'x',
      expect.objectContaining({ data: { path: `/chats/${NOTICE}` } }),
    )
  })

  it('shows a push of an older cabinet that named only the id', async () => {
    const worker = loadWorker({})
    await worker.fire('push', pushOf({ id: NOTICE }))
    expect(worker.fetch).toHaveBeenCalled()
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
      'Радити',
      expect.objectContaining({ data: { path: '/chats' } }),
    )
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
    worker.windows.push(landing, cabinet, fakeWindow('/chats', false, 'https://evil.example'))
    await worker.fire('notificationclick', click(`/scheduled/${SCHEDULE}`))
    expect(cabinet.focus).toHaveBeenCalled()
    expect(cabinet.postMessage).toHaveBeenCalledWith({
      type: 'raditi:navigate',
      path: `/scheduled/${SCHEDULE}`,
    })
    expect(landing.postMessage).not.toHaveBeenCalled()
    expect(worker.self.clients.openWindow).not.toHaveBeenCalled()
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
