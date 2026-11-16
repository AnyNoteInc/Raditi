'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { plural } from '@/lib/plural'
import { useTRPC } from '@/trpc/client'

// Web Push in this browser (docs/plan/82-scheduled-tasks.md, Зп36, Зп37, Зп41; plan 75, ВВ8). A
// browser takes notifications only where the client turned them on in it: its subscription is a
// row of `push_subscriptions`, and core sends to every row of the user. Turning them off here takes
// only this browser's row away. The state is read from the browser itself (support, permission,
// the subscription and the key it was made under) and from the cabinet (does it know this
// subscription, how many other browsers take notifications). The settings, the window of a
// scheduled task and its card in the feed all read it through this hook.

/** Where this browser stands: what the client sees and what a click does. */
export type BrowserPushState =
  /** Not read yet: render nothing that would jump. */
  | 'loading'
  /** No Web Push here at all. */
  | 'unsupported'
  /** iPhone or iPad in Safari: notifications come only to Радити added to the home screen. */
  | 'ios_install'
  /** The client (or the browser) forbade notifications of Радити. */
  | 'denied'
  /** Can be turned on: no subscription here, one the cabinet does not know, or of another key. */
  | 'off'
  /** This browser takes the notifications. */
  | 'on'

/** What the browser itself can do. */
export type BrowserPushSupport = 'supported' | 'unsupported' | 'ios_install'

/** An iPhone or an iPad: the hint of Зп36 names the device the client holds. */
export type AppleDevice = 'iphone' | 'ipad'

/** What the page learns of this browser without the cabinet. */
export interface BrowserPushHere {
  support: BrowserPushSupport
  device: AppleDevice | null
  /** null where there is no Notification. */
  permission: NotificationPermission | null
  /** The endpoint of the subscription of this browser; null — none. */
  endpoint: string | null
  /** The VAPID key the subscription was made under, URL-safe base64; null — none or not told. */
  key: string | null
}

/** What the cabinet says (`notification.settings({ endpoint })`). */
export interface BrowserPushServer {
  /** The VAPID key the cabinet subscribes by; null — Web Push is not set up on this server. */
  publicKey: string | null
  browsers: number
  otherBrowsers: number
}

/** The texts of Web Push in this browser (Зп36). */
export const browserPushText = Object.freeze({
  enable: 'Включить в этом браузере',
  on: 'Уведомления в этом браузере включены',
  unsupported: 'Этот браузер не умеет присылать уведомления',
  denied: 'Уведомления запрещены в настройках браузера',
  iosInstall: (device: AppleDevice) =>
    `Чтобы получать уведомления на ${device === 'ipad' ? 'iPad' : 'iPhone'}, добавьте Радити на экран «Домой», откройте его оттуда, войдите и включите уведомления`,
  unavailable: 'Уведомления в браузере пока не настроены.',
  enableFailed: 'Не удалось включить уведомления. Попробуйте ещё раз.',
  disableFailed: 'Не удалось выключить уведомления. Попробуйте ещё раз.',
  otherBrowsers: (count: number) =>
    `Ещё в ${count} ${plural(count, 'браузере', 'браузерах', 'браузерах')}`,
})

/** The text of a state the client cannot turn on from here; null — the state has a button. */
export function browserPushStateText(
  state: BrowserPushState,
  device: AppleDevice | null,
): string | null {
  switch (state) {
    case 'unsupported':
      return browserPushText.unsupported
    case 'denied':
      return browserPushText.denied
    case 'ios_install':
      return browserPushText.iosInstall(device ?? 'iphone')
    default:
      return null
  }
}

/** What the page knows of the browser it runs in, read once by `readBrowserEnvironment`. */
export interface BrowserEnvironment {
  userAgent: string
  maxTouchPoints: number
  /** Opened from the home screen (`display-mode: standalone`, or `navigator.standalone` of iOS). */
  standalone: boolean
  serviceWorker: boolean
  pushManager: boolean
  notification: boolean
}

/** An iPhone or an iPad; an iPad that says it is a Mac is known by its touch screen. */
export function appleDeviceOf(
  env: Pick<BrowserEnvironment, 'userAgent' | 'maxTouchPoints'>,
): AppleDevice | null {
  if (/iPhone|iPod/.test(env.userAgent)) return 'iphone'
  if (/iPad/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1))
    return 'ipad'
  return null
}

/**
 * Whether Web Push can work here. Safari on iPhone and iPad has no PushManager in a tab: only Радити
 * opened from the home screen gets it (iOS 16.4 and later, Зп42) — that is the hint, not «нет
 * поддержки». An app on the home screen without it is an iOS too old for Web Push.
 */
export function pushSupportOf(env: BrowserEnvironment): {
  support: BrowserPushSupport
  device: AppleDevice | null
} {
  const device = appleDeviceOf(env)
  if (env.serviceWorker && env.pushManager && env.notification)
    return { support: 'supported', device }
  return { support: device !== null && !env.standalone ? 'ios_install' : 'unsupported', device }
}

/** URL-safe base64 without padding: the one spelling of a VAPID key here. */
export function canonicalKey(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The bytes of a VAPID key, as `PushManager.subscribe` takes them. */
export function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const url = canonicalKey(base64)
  const padded = (url + '='.repeat((4 - (url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  return bytes
}

/** The key of a subscription (`options.applicationServerKey`), spelled as `canonicalKey`. */
export function keyOfBytes(bytes: ArrayBuffer | null | undefined): string | null {
  if (!bytes || bytes.byteLength === 0) return null
  let raw = ''
  for (const byte of new Uint8Array(bytes)) raw += String.fromCharCode(byte)
  return canonicalKey(btoa(raw))
}

/**
 * The state of this browser (Зп36, Зп37). The browser decides first — no support, the hint of iOS,
 * notifications forbidden — then the cabinet: `on` only for a subscription made under the key of
 * now that the cabinet keeps for this user; any other is `off`, and turning on makes it anew.
 * A cabinet that did not answer leaves the switch `off`: turning on asks it again (`enable`).
 */
export function browserPushState(
  here: BrowserPushHere | undefined,
  server: BrowserPushServer | undefined,
): BrowserPushState {
  if (here === undefined) return 'loading'
  if (here.support !== 'supported') return here.support
  if (here.permission === 'denied') return 'denied'
  if (server === undefined) return 'loading'
  if (here.endpoint === null || here.permission !== 'granted') return 'off'
  if (here.key !== null && server.publicKey !== null && here.key !== canonicalKey(server.publicKey))
    return 'off'
  return server.browsers - server.otherBrowsers > 0 ? 'on' : 'off'
}

function readBrowserEnvironment(): BrowserEnvironment {
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    notification: 'Notification' in window,
  }
}

/** The subscription of this browser, if it has a worker that holds one. */
async function subscriptionHere(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration('/')
  return (await registration?.pushManager.getSubscription()) ?? null
}

/** Reads the browser: never throws, a browser that will not tell is one without a subscription. */
export async function probeBrowserPush(): Promise<BrowserPushHere> {
  const { support, device } = pushSupportOf(readBrowserEnvironment())
  if (support !== 'supported')
    return { support, device, permission: null, endpoint: null, key: null }
  const subscription = await subscriptionHere().catch(() => null)
  return {
    support,
    device,
    permission: Notification.permission,
    endpoint: subscription?.endpoint ?? null,
    key: keyOfBytes(subscription?.options.applicationServerKey),
  }
}

/** The subscription as the cabinet takes it (`PushSubscription.toJSON()`, flattened). */
function flatten(subscription: PushSubscription) {
  const json = subscription.toJSON()
  return {
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
  }
}

/**
 * The subscription of this browser under `publicKey`: the one it has, or a new one. One made under
 * another key — the key of the server changed — is given up first and named in `replaced`, so the
 * cabinet drops its row (Зп37).
 */
async function subscribeHere(publicKey: string) {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  const registration = await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  const existingKey = keyOfBytes(existing?.options.applicationServerKey)
  const stale = existing !== null && existingKey !== null && existingKey !== canonicalKey(publicKey)
  if (stale) await existing.unsubscribe()
  const subscription =
    existing !== null && !stale
      ? existing
      : await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        })
  return { subscription: flatten(subscription), replaced: stale ? existing.endpoint : null }
}

/** Gives the subscription of this browser up; the endpoint it had, or null — there was none. */
async function unsubscribeHere(): Promise<string | null> {
  const subscription = await subscriptionHere()
  if (!subscription) return null
  const endpoint = subscription.endpoint
  await subscription.unsubscribe()
  return endpoint
}

/** The query of what this browser says; every user of the hook on a page shares it. */
export const BROWSER_PUSH_QUERY_KEY = ['browser-push', 'here'] as const

/** What `useBrowserPush` gives. */
export interface BrowserPush {
  state: BrowserPushState
  /** An iPhone or an iPad, for the hint; null — another device. */
  device: AppleDevice | null
  /** The endpoint of this browser's subscription; null — none (or not read yet). */
  endpoint: string | null
  /** Other browsers of the user that take notifications; null — not known yet. */
  otherBrowsers: number | null
  /** A turn on or off is under way. */
  working: boolean
  /** Why the last turn on or off failed, in the client's words; null — it did not fail. */
  problem: string | null
  /**
   * Asks the browser's permission, subscribes under the key of the cabinet and gives the
   * subscription to the cabinet. Call it from the click itself: Safari asks only from a gesture.
   * true — on; false — not (the state or `problem` says why).
   */
  enable: () => Promise<boolean>
  /** Gives this browser's subscription up, here and in the cabinet; other browsers keep theirs. */
  disable: () => Promise<boolean>
}

export function useBrowserPush(): BrowserPush {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const here = useQuery({
    queryKey: BROWSER_PUSH_QUERY_KEY,
    queryFn: probeBrowserPush,
    // The client may allow or forbid notifications in the browser meanwhile: read it again.
    staleTime: 0,
    retry: false,
  })
  const endpoint = here.data?.endpoint ?? null
  const settings = useQuery({
    ...trpc.notification.settings.queryOptions(endpoint === null ? undefined : { endpoint }),
    enabled: here.isSuccess,
  })
  const subscribe = useMutation(trpc.notification.subscribe.mutationOptions())
  const resubscribe = useMutation(trpc.notification.resubscribe.mutationOptions())
  const unsubscribe = useMutation(trpc.notification.unsubscribe.mutationOptions())
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const server: BrowserPushServer | undefined = settings.data
    ? {
        publicKey: settings.data.publicKey,
        browsers: settings.data.browsers,
        otherBrowsers: settings.data.otherBrowsers,
      }
    : settings.isError
      ? { publicKey: null, browsers: 0, otherBrowsers: 0 }
      : undefined
  const state = browserPushState(here.data, server)

  /**
   * Reads the cabinet and the browser again. `next` — the endpoint this browser has now, when it
   * is known: the cabinet's answer for it is read before the browser is, so the state goes from
   * `off` to `on` (or back) without passing through `loading`.
   */
  async function refresh(next: string | null | undefined) {
    await queryClient.invalidateQueries({ queryKey: trpc.notification.settings.queryKey() })
    if (next !== undefined)
      await queryClient.prefetchQuery(
        trpc.notification.settings.queryOptions(next === null ? undefined : { endpoint: next }),
      )
    await queryClient.invalidateQueries({ queryKey: BROWSER_PUSH_QUERY_KEY })
  }

  /**
   * The cabinet did not answer, so which key to subscribe by is not known — not that Web Push is
   * not set up (Зп37). It is asked again, and this click goes no further: Safari asks the
   * permission only from the click itself, not after a request. true — the answer says this
   * browser already takes the notifications.
   */
  async function askAgain(): Promise<boolean> {
    setWorking(true)
    try {
      const answer = await settings.refetch()
      if (answer.data !== undefined && browserPushState(here.data, answer.data) === 'on')
        return true
      // Not set up only when the cabinet said so; a cabinet still silent — try again.
      setProblem(
        answer.data?.publicKey === null
          ? browserPushText.unavailable
          : browserPushText.enableFailed,
      )
      return false
    } finally {
      setWorking(false)
    }
  }

  async function enable(): Promise<boolean> {
    setProblem(null)
    if (here.data?.support !== 'supported') return false
    if (settings.data === undefined) return askAgain()
    const publicKey = settings.data.publicKey
    if (publicKey === null) {
      setProblem(browserPushText.unavailable)
      return false
    }
    setWorking(true)
    let next: string | undefined
    try {
      // First, while the click is still the gesture that lets Safari ask.
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') return false
      const made = await subscribeHere(publicKey)
      next = made.subscription.endpoint
      if (made.replaced === null) await subscribe.mutateAsync(made.subscription)
      else await resubscribe.mutateAsync({ ...made.subscription, oldEndpoint: made.replaced })
      return true
    } catch {
      setProblem(browserPushText.enableFailed)
      return false
    } finally {
      await refresh(next)
      setWorking(false)
    }
  }

  async function disable(): Promise<boolean> {
    setProblem(null)
    setWorking(true)
    let next: null | undefined
    try {
      const gone = await unsubscribeHere()
      next = null
      if (gone !== null) await unsubscribe.mutateAsync({ endpoint: gone })
      return true
    } catch {
      setProblem(browserPushText.disableFailed)
      return false
    } finally {
      await refresh(next)
      setWorking(false)
    }
  }

  return {
    state,
    device: here.data?.device ?? null,
    endpoint,
    otherBrowsers: settings.data ? settings.data.otherBrowsers : null,
    working,
    problem,
    enable,
    disable,
  }
}
