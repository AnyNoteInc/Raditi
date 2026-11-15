// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CabinetBrowserBridge } from './cabinet-browser-bridge'
import { NAVIGATE_ANSWER, ZONE_MARK_KEY } from './cabinet-messages'

const calls = vi.hoisted(() => ({
  push: vi.fn(),
  remember: vi.fn(async (input: { timezone: string }) => input),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: calls.push }) }))
const LIST_KEY = [['schedule', 'list'], { type: 'query' }]

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    schedule: {
      rememberTimezone: {
        mutationOptions: (options?: object) => ({ ...options, mutationFn: calls.remember }),
      },
      list: { queryKey: () => LIST_KEY },
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

function show(userId = 'u1', client = new QueryClient()) {
  return render(
    <QueryClientProvider client={client}>
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

  it('answers the worker on the port of its message, so the worker does not move the window', async () => {
    const container = fakeContainer()
    show()
    await waitFor(() => expect(container.startMessages).toHaveBeenCalled())
    const say = (data: unknown) => {
      const port = { postMessage: vi.fn() }
      container.dispatchEvent(Object.assign(new Event('message'), { data, ports: [port] }))
      return port
    }
    const taken = say({
      type: 'raditi:navigate',
      path: '/chats/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    })
    expect(taken.postMessage).toHaveBeenCalledWith(NAVIGATE_ANSWER)
    expect(calls.push).toHaveBeenCalledWith('/chats/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')
    // A path it does not go to is not answered: the worker opens it the way it can.
    expect(
      say({ type: 'raditi:navigate', path: '//evil.example' }).postMessage,
    ).not.toHaveBeenCalled()
    expect(say({ type: 'something else' }).postMessage).not.toHaveBeenCalled()
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

  it('reads the list of the tasks again once the zone is remembered: it names the zone of a new task', async () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    show('u1', client)
    await waitFor(() => expect(calls.remember).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: LIST_KEY }))
  })

  it('works in a browser without service workers', async () => {
    show()
    await waitFor(() => expect(calls.remember).toHaveBeenCalled())
  })
})
