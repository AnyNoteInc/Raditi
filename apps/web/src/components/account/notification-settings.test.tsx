// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { browserPushText, keyBytes } from '@/components/notifications/use-browser-push'

import { NotificationSettings, notificationText } from './notification-settings'

const KEY = Buffer.from([4, ...Array.from({ length: 64 }, () => 7)]).toString('base64url')
const HERE = 'https://fcm.googleapis.com/fcm/send/here'

const calls = vi.hoisted(() => ({
  browsers: 0,
  here: false,
  settings: vi.fn(),
  setSettings: vi.fn(async (input: { push?: boolean; email?: boolean }) => ({
    push: input.push ?? false,
    email: input.email ?? true,
  })),
  unsubscribe: vi.fn(async () => ({ unsubscribed: true })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    notification: {
      settings: {
        queryOptions: (input?: { endpoint?: string }) => ({
          queryKey: [['notification', 'settings'], { input, type: 'query' }],
          queryFn: async () => {
            calls.settings(input)
            const here = calls.here && input?.endpoint === HERE
            return {
              push: false,
              email: true,
              browsers: calls.browsers,
              otherBrowsers: calls.browsers - (here ? 1 : 0),
              publicKey: KEY,
            }
          },
        }),
        queryKey: () => [['notification', 'settings'], { type: 'query' }],
      },
      setSettings: { mutationOptions: () => ({ mutationFn: calls.setSettings }) },
      subscribe: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      resubscribe: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      unsubscribe: { mutationOptions: () => ({ mutationFn: calls.unsubscribe }) },
    },
  }),
}))

/** A browser with Web Push, notifications allowed and a subscription under the key of now. */
function browserWithPush() {
  const subscription = {
    endpoint: HERE,
    options: { applicationServerKey: keyBytes(KEY).buffer },
    unsubscribe: vi.fn(async () => true),
  }
  let current: typeof subscription | null = subscription
  subscription.unsubscribe.mockImplementation(async () => {
    current = null
    return true
  })
  const registration = { pushManager: { getSubscription: vi.fn(async () => current) } }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn(async () => registration) },
  })
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() })
  return subscription
}

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationSettings />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'serviceWorker')
  calls.browsers = 0
  calls.here = false
  vi.clearAllMocks()
})

describe('«Уведомления» of the settings (docs/plan/75, ВВ10; docs/plan/82, Зп37)', () => {
  it('has letters on by default, and turns letters off', async () => {
    show()
    const letters = await screen.findByRole<HTMLInputElement>('switch', {
      name: notificationText.email,
    })
    expect(letters.checked).toBe(true)
    fireEvent.click(letters)
    await waitFor(() => expect(calls.setSettings).toHaveBeenCalled())
    expect(calls.setSettings.mock.calls[0]![0]).toEqual({ email: false })
  })

  it('says so where the browser shows no notifications, and counts the other browsers', async () => {
    calls.browsers = 2
    show()
    const browser = await screen.findByRole<HTMLInputElement>('switch', {
      name: notificationText.push,
    })
    expect(browser.checked).toBe(false)
    expect(browser).toBeDisabled()
    expect(browser).toHaveAccessibleDescription(
      `${browserPushText.unsupported} ${browserPushText.otherBrowsers(2)}`,
    )
  })

  it('is the switch of this browser: off takes only its subscription away', async () => {
    const subscription = browserWithPush()
    calls.browsers = 2
    calls.here = true
    show()
    const browser = await screen.findByRole<HTMLInputElement>('switch', {
      name: notificationText.push,
    })
    await waitFor(() => expect(browser.checked).toBe(true))
    expect(screen.getByText(browserPushText.otherBrowsers(1))).toBeInTheDocument()
    expect(calls.settings).toHaveBeenCalledWith({ endpoint: HERE })
    fireEvent.click(browser)
    await waitFor(() => expect(calls.unsubscribe).toHaveBeenCalled())
    expect(subscription.unsubscribe).toHaveBeenCalled()
    expect(calls.unsubscribe.mock.calls[0]).toEqual([{ endpoint: HERE }, expect.anything()])
    // «В этом браузере» is no setting of the account any more: nothing reads it.
    expect(calls.setSettings).not.toHaveBeenCalled()
  })
})
