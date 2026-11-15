// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  appleDeviceOf,
  browserPushState,
  browserPushStateText,
  browserPushText,
  canonicalKey,
  keyBytes,
  keyOfBytes,
  pushSupportOf,
  useBrowserPush,
  type BrowserEnvironment,
  type BrowserPushHere,
} from './use-browser-push'

const vapidKey = (fill: number) =>
  Buffer.from([4, ...Array.from({ length: 64 }, () => fill)]).toString('base64url')
const KEY_NOW = vapidKey(7)
const KEY_BEFORE = vapidKey(9)
const HERE = 'https://fcm.googleapis.com/fcm/send/here'
const ELSEWHERE = 'https://updates.push.services.mozilla.com/wpush/v2/elsewhere'

/** The cabinet: the endpoints of the user's browsers and the key it subscribes by. */
const server = vi.hoisted(() => ({
  endpoints: new Set<string>(),
  publicKey: null as string | null,
  /** How many `settings` requests more the cabinet does not answer (503 during a deploy). */
  settingsFailures: 0,
  calls: [] as { name: string; input: unknown }[],
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    notification: {
      settings: {
        queryOptions: (input?: { endpoint?: string }) => ({
          queryKey: [['notification', 'settings'], { input, type: 'query' }],
          queryFn: () => {
            server.calls.push({ name: 'settings', input })
            if (server.settingsFailures > 0) {
              server.settingsFailures--
              throw new Error('503')
            }
            const here = input?.endpoint !== undefined && server.endpoints.has(input.endpoint)
            return {
              push: false,
              email: true,
              browsers: server.endpoints.size,
              otherBrowsers: server.endpoints.size - (here ? 1 : 0),
              publicKey: server.publicKey,
            }
          },
        }),
        queryKey: () => [['notification', 'settings'], { type: 'query' }],
      },
      subscribe: {
        mutationOptions: () => ({
          mutationFn: async (input: { endpoint: string }) => {
            server.calls.push({ name: 'subscribe', input })
            server.endpoints.add(input.endpoint)
            return { subscribed: true }
          },
        }),
      },
      resubscribe: {
        mutationOptions: () => ({
          mutationFn: async (input: { endpoint: string; oldEndpoint: string | null }) => {
            server.calls.push({ name: 'resubscribe', input })
            if (input.oldEndpoint) server.endpoints.delete(input.oldEndpoint)
            server.endpoints.add(input.endpoint)
            return { resubscribed: true }
          },
        }),
      },
      unsubscribe: {
        mutationOptions: () => ({
          mutationFn: async (input: { endpoint: string }) => {
            server.calls.push({ name: 'unsubscribe', input })
            server.endpoints.delete(input.endpoint)
            return { unsubscribed: true }
          },
        }),
      },
    },
  }),
}))

interface FakeSubscription {
  endpoint: string
  options: { applicationServerKey: ArrayBuffer }
  toJSON: () => PushSubscriptionJSON
  unsubscribe: ReturnType<typeof vi.fn>
}

/** A browser with Web Push: a worker registration, its push manager and Notification. */
function fakeBrowser(options: {
  permission?: NotificationPermission
  answer?: NotificationPermission
  subscription?: { endpoint: string; key: string } | null
}) {
  let current: FakeSubscription | null = null
  const make = (endpoint: string, key: ArrayBuffer): FakeSubscription => {
    const subscription: FakeSubscription = {
      endpoint,
      options: { applicationServerKey: key },
      toJSON: () => ({ endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }),
      unsubscribe: vi.fn(async () => {
        if (current === subscription) current = null
        return true
      }),
    }
    return subscription
  }
  if (options.subscription)
    current = make(options.subscription.endpoint, keyBytes(options.subscription.key).buffer)
  const order: string[] = []
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (init: { applicationServerKey: Uint8Array<ArrayBuffer> }) => {
      order.push('subscribe')
      current = make(HERE, init.applicationServerKey.buffer)
      return current
    }),
  }
  const registration = { pushManager }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(async () => registration),
    },
  })
  const notification = {
    permission: options.permission ?? 'default',
    requestPermission: vi.fn(async () => {
      order.push('permission')
      notification.permission = options.answer ?? 'granted'
      return notification.permission
    }),
  }
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('Notification', notification)
  return { pushManager, notification, order, current: () => current }
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'serviceWorker')
  server.endpoints.clear()
  server.publicKey = null
  server.settingsFailures = 0
  server.calls.length = 0
})

const desktop: BrowserEnvironment = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/142',
  maxTouchPoints: 0,
  standalone: false,
  serviceWorker: true,
  pushManager: true,
  notification: true,
}
const iphoneSafari = {
  ...desktop,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Version/18.5 Safari/605',
  maxTouchPoints: 5,
  pushManager: false,
}

describe('what this browser can do (docs/plan/82, Зп36, Зп42)', () => {
  it('knows an iPhone, an iPad and an iPad that says it is a Mac', () => {
    expect(appleDeviceOf(iphoneSafari)).toBe('iphone')
    expect(appleDeviceOf({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_5)', maxTouchPoints: 5 })).toBe(
      'ipad',
    )
    expect(
      appleDeviceOf({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        maxTouchPoints: 5,
      }),
    ).toBe('ipad')
    expect(
      appleDeviceOf({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        maxTouchPoints: 0,
      }),
    ).toBeNull()
  })

  it('sends Safari on iPhone outside the home screen to install, and only it', () => {
    expect(pushSupportOf(desktop)).toEqual({ support: 'supported', device: null })
    expect(pushSupportOf(iphoneSafari)).toEqual({ support: 'ios_install', device: 'iphone' })
    // From the home screen on an iOS without Web Push: nothing to install.
    expect(pushSupportOf({ ...iphoneSafari, standalone: true }).support).toBe('unsupported')
    expect(pushSupportOf({ ...iphoneSafari, pushManager: true }).support).toBe('supported')
    expect(pushSupportOf({ ...desktop, pushManager: false }).support).toBe('unsupported')
  })
})

describe('the state of this browser (Зп37)', () => {
  const here = (change: Partial<BrowserPushHere> = {}): BrowserPushHere => ({
    support: 'supported',
    device: null,
    permission: 'granted',
    endpoint: HERE,
    key: KEY_NOW,
    ...change,
  })
  const known = { publicKey: KEY_NOW, browsers: 2, otherBrowsers: 1 }

  it('is on only for a subscription under the key of now that the cabinet keeps', () => {
    expect(browserPushState(here(), known)).toBe('on')
    expect(browserPushState(here(), { ...known, otherBrowsers: 2 })).toBe('off')
    expect(browserPushState(here({ key: KEY_BEFORE }), known)).toBe('off')
    // A browser that does not tell the key of its subscription is taken at its word.
    expect(browserPushState(here({ key: null }), known)).toBe('on')
    expect(browserPushState(here({ endpoint: null }), known)).toBe('off')
    expect(browserPushState(here({ permission: 'default' }), known)).toBe('off')
  })

  it('lets the browser decide first, and waits for both', () => {
    expect(browserPushState(undefined, known)).toBe('loading')
    expect(browserPushState(here(), undefined)).toBe('loading')
    expect(browserPushState(here({ permission: 'denied' }), undefined)).toBe('denied')
    expect(browserPushState(here({ support: 'unsupported' }), undefined)).toBe('unsupported')
    expect(browserPushState(here({ support: 'ios_install' }), undefined)).toBe('ios_install')
  })

  it('says the states without a button in the words of Зп36', () => {
    expect(browserPushStateText('unsupported', null)).toBe(
      'Этот браузер не умеет присылать уведомления',
    )
    expect(browserPushStateText('denied', null)).toBe('Уведомления запрещены в настройках браузера')
    expect(browserPushStateText('ios_install', 'iphone')).toBe(
      'Чтобы получать уведомления на iPhone, добавьте Радити на экран «Домой», откройте его оттуда, войдите и включите уведомления',
    )
    expect(browserPushStateText('ios_install', 'ipad')).toContain('на iPad,')
    expect(browserPushStateText('off', null)).toBeNull()
    expect(browserPushStateText('on', null)).toBeNull()
  })

  it('counts the other browsers in Russian', () => {
    expect(browserPushText.otherBrowsers(1)).toBe('Ещё в 1 браузере')
    expect(browserPushText.otherBrowsers(3)).toBe('Ещё в 3 браузерах')
    expect(browserPushText.otherBrowsers(11)).toBe('Ещё в 11 браузерах')
    expect(browserPushText.otherBrowsers(21)).toBe('Ещё в 21 браузере')
  })

  it('reads a key in any spelling of base64 as the same key', () => {
    const standard = Buffer.from(keyBytes(KEY_NOW)).toString('base64')
    expect(canonicalKey(standard)).toBe(KEY_NOW)
    expect(keyOfBytes(keyBytes(standard).buffer)).toBe(KEY_NOW)
    expect(keyOfBytes(null)).toBeNull()
    expect(keyOfBytes(new ArrayBuffer(0))).toBeNull()
  })
})

describe('useBrowserPush', () => {
  it('is on where this browser is known, and counts the others by its endpoint', async () => {
    fakeBrowser({ permission: 'granted', subscription: { endpoint: HERE, key: KEY_NOW } })
    server.publicKey = KEY_NOW
    server.endpoints.add(HERE).add(ELSEWHERE)
    const { result } = renderHook(() => useBrowserPush(), { wrapper })
    await waitFor(() => expect(result.current.state).toBe('on'))
    expect(result.current.endpoint).toBe(HERE)
    expect(result.current.otherBrowsers).toBe(1)
    expect(server.calls).toContainEqual({ name: 'settings', input: { endpoint: HERE } })
  })

  it('asks the permission first, subscribes and gives the subscription to the cabinet', async () => {
    const browser = fakeBrowser({ permission: 'default', answer: 'granted' })
    server.publicKey = KEY_NOW
    const { result } = renderHook(() => useBrowserPush(), { wrapper })
    await waitFor(() => expect(result.current.state).toBe('off'))
    let on = false
    await act(async () => {
      on = await result.current.enable()
    })
    expect(on).toBe(true)
    expect(browser.order).toEqual(['permission', 'subscribe'])
    expect(server.calls).toContainEqual({
      name: 'subscribe',
      input: { endpoint: HERE, p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
    })
    await waitFor(() => expect(result.current.state).toBe('on'))
  })

  it('goes from off to on and back without showing «loading» between', async () => {
    fakeBrowser({ permission: 'granted' })
    server.publicKey = KEY_NOW
    const states: string[] = []
    const { result } = renderHook(
      () => {
        const push = useBrowserPush()
        states.push(push.state)
        return push
      },
      { wrapper },
    )
    await waitFor(() => expect(result.current.state).toBe('off'))
    states.length = 0
    await act(async () => {
      await result.current.enable()
    })
    await waitFor(() => expect(result.current.state).toBe('on'))
    await act(async () => {
      await result.current.disable()
    })
    await waitFor(() => expect(result.current.state).toBe('off'))
    expect(states).not.toContain('loading')
  })

  it('makes the subscription anew when the key of the cabinet changed', async () => {
    const before = 'https://fcm.googleapis.com/fcm/send/before'
    const browser = fakeBrowser({
      permission: 'granted',
      subscription: { endpoint: before, key: KEY_BEFORE },
    })
    server.publicKey = KEY_NOW
    server.endpoints.add(before)
    const { result } = renderHook(() => useBrowserPush(), { wrapper })
    await waitFor(() => expect(result.current.state).toBe('off'))
    const stale = browser.current()
    await act(async () => {
      await result.current.enable()
    })
    expect(stale?.unsubscribe).toHaveBeenCalled()
    expect(keyOfBytes(browser.current()?.options.applicationServerKey)).toBe(KEY_NOW)
    expect(server.calls).toContainEqual({
      name: 'resubscribe',
      input: { endpoint: HERE, p256dh: 'B'.repeat(87), auth: 'a'.repeat(22), oldEndpoint: before },
    })
    expect([...server.endpoints]).toEqual([HERE])
    await waitFor(() => expect(result.current.state).toBe('on'))
  })

  it('subscribes to nothing when the client does not allow it', async () => {
    const browser = fakeBrowser({ permission: 'default', answer: 'denied' })
    server.publicKey = KEY_NOW
    const { result } = renderHook(() => useBrowserPush(), { wrapper })
    await waitFor(() => expect(result.current.state).toBe('off'))
    await act(async () => {
      expect(await result.current.enable()).toBe(false)
    })
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled()
    expect(result.current.problem).toBeNull()
    await waitFor(() => expect(result.current.state).toBe('denied'))
  })

  it('says so when the cabinet has no key to subscribe by', async () => {
    const browser = fakeBrowser({ permission: 'default' })
    const { result } = renderHook(() => useBrowserPush(), { wrapper })
    await waitFor(() => expect(result.current.state).toBe('off'))
    await act(async () => {
      expect(await result.current.enable()).toBe(false)
    })
    expect(browser.notification.requestPermission).not.toHaveBeenCalled()
    expect(result.current.problem).toBe(browserPushText.unavailable)
  })

  describe('when the cabinet did not answer (Зп37)', () => {
    const settingsCalls = () => server.calls.filter((call) => call.name === 'settings').length

    it('asks it again instead of saying push is not set up, and the next click subscribes', async () => {
      const browser = fakeBrowser({ permission: 'default', answer: 'granted' })
      server.publicKey = KEY_NOW
      server.settingsFailures = 1
      const { result } = renderHook(() => useBrowserPush(), { wrapper })
      await waitFor(() => expect(result.current.state).toBe('off'))
      const before = settingsCalls()
      await act(async () => {
        expect(await result.current.enable()).toBe(false)
      })
      expect(settingsCalls()).toBe(before + 1)
      expect(result.current.problem).toBe(browserPushText.enableFailed)
      // Safari asks only from the click itself: not after the request.
      expect(browser.notification.requestPermission).not.toHaveBeenCalled()
      await act(async () => {
        expect(await result.current.enable()).toBe(true)
      })
      expect(result.current.problem).toBeNull()
      await waitFor(() => expect(result.current.state).toBe('on'))
    })

    it('asks again on every click while it is still silent', async () => {
      fakeBrowser({ permission: 'default' })
      server.publicKey = KEY_NOW
      server.settingsFailures = Number.POSITIVE_INFINITY
      const { result } = renderHook(() => useBrowserPush(), { wrapper })
      await waitFor(() => expect(result.current.state).toBe('off'))
      for (const _click of [1, 2]) {
        const before = settingsCalls()
        await act(async () => {
          expect(await result.current.enable()).toBe(false)
        })
        expect(settingsCalls()).toBe(before + 1)
        expect(result.current.problem).toBe(browserPushText.enableFailed)
      }
      expect(result.current.working).toBe(false)
    })

    it('is on at once where its answer knows this browser', async () => {
      const browser = fakeBrowser({
        permission: 'granted',
        subscription: { endpoint: HERE, key: KEY_NOW },
      })
      server.publicKey = KEY_NOW
      server.endpoints.add(HERE)
      server.settingsFailures = 1
      const { result } = renderHook(() => useBrowserPush(), { wrapper })
      await waitFor(() => expect(result.current.state).toBe('off'))
      await act(async () => {
        expect(await result.current.enable()).toBe(true)
      })
      expect(result.current.problem).toBeNull()
      expect(browser.pushManager.subscribe).not.toHaveBeenCalled()
      await waitFor(() => expect(result.current.state).toBe('on'))
    })

    it('says push is not set up only when its answer says so', async () => {
      fakeBrowser({ permission: 'default' })
      server.settingsFailures = 1
      const { result } = renderHook(() => useBrowserPush(), { wrapper })
      await waitFor(() => expect(result.current.state).toBe('off'))
      await act(async () => {
        expect(await result.current.enable()).toBe(false)
      })
      expect(result.current.problem).toBe(browserPushText.unavailable)
    })
  })

  it('turns off only this browser, here and in the cabinet', async () => {
    const browser = fakeBrowser({
      permission: 'granted',
      subscription: { endpoint: HERE, key: KEY_NOW },
    })
    server.publicKey = KEY_NOW
    server.endpoints.add(HERE).add(ELSEWHERE)
    const { result } = renderHook(() => useBrowserPush(), { wrapper })
    await waitFor(() => expect(result.current.state).toBe('on'))
    const subscription = browser.current()
    await act(async () => {
      expect(await result.current.disable()).toBe(true)
    })
    expect(subscription?.unsubscribe).toHaveBeenCalled()
    expect([...server.endpoints]).toEqual([ELSEWHERE])
    await waitFor(() => expect(result.current.state).toBe('off'))
    expect(result.current.otherBrowsers).toBe(1)
  })

  it('is unsupported in a browser without Web Push', async () => {
    const { result } = renderHook(() => useBrowserPush(), { wrapper })
    await waitFor(() => expect(result.current.state).toBe('unsupported'))
  })
})
