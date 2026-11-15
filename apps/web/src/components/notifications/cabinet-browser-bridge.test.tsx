// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CabinetBrowserBridge } from './cabinet-browser-bridge'
import { ZONE_MARK_KEY } from './cabinet-messages'

const calls = vi.hoisted(() => ({
  push: vi.fn(),
  remember: vi.fn(async (input: { timezone: string }) => input),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: calls.push }) }))
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    schedule: {
      rememberTimezone: { mutationOptions: () => ({ mutationFn: calls.remember }) },
    },
  }),
}))

/** The container of the service workers: what the page listens on for their messages. */
function fakeContainer() {
  const target = new EventTarget()
  const container = Object.assign(target, { startMessages: vi.fn() })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
  return container
}

function show(userId = 'u1') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CabinetBrowserBridge userId={userId} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker')
  sessionStorage.clear()
  calls.push.mockClear()
  calls.remember.mockClear()
})

describe('the bridge of the cabinet (docs/plan/82, Зп12, Зп41)', () => {
  it('goes where the service worker says, without a reload, and only within the cabinet', async () => {
    const container = fakeContainer()
    const view = show()
    await waitFor(() => expect(container.startMessages).toHaveBeenCalled())
    const say = (data: unknown) => container.dispatchEvent(new MessageEvent('message', { data }))
    say({ type: 'raditi:navigate', path: '/scheduled/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' })
    say({ type: 'raditi:navigate', path: '//evil.example' })
    say({ type: 'raditi:navigate', path: '/api/notifications/x' })
    say({ type: 'something else', path: '/chats' })
    expect(calls.push.mock.calls).toEqual([['/scheduled/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b']])
    view.unmount()
    say({ type: 'raditi:navigate', path: '/chats' })
    expect(calls.push).toHaveBeenCalledTimes(1)
  })

  it('tells the zone of the browser once a session', async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    show().unmount()
    await waitFor(() => expect(calls.remember).toHaveBeenCalledTimes(1))
    expect(calls.remember.mock.calls[0]?.[0]).toEqual({ timezone: zone })
    expect(sessionStorage.getItem(ZONE_MARK_KEY)).toBe(`u1:${zone}`)
    show()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.remember).toHaveBeenCalledTimes(1)
  })

  it('works in a browser without service workers', async () => {
    show()
    await waitFor(() => expect(calls.remember).toHaveBeenCalled())
  })
})
