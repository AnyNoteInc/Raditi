// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TASK_ID } from './testing'
import { useBrowserWatching, WATCH_EVERY_MS } from './use-browser-watching'

const watch = vi.hoisted(() =>
  vi.fn<(input: { taskId: string }) => Promise<{ watched: boolean }>>(),
)

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    browser: {
      watch: {
        mutationOptions: (options?: UseMutationOptions) => ({ ...options, mutationFn: watch }),
      },
    },
  }),
}))

// The chat counts as watching the browser (docs/plan/59, И18; owner's answer of 30.10.2026).
describe('the client looking at the dialog of a task in the browser', () => {
  let visibility: DocumentVisibilityState = 'visible'
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
  )
  const show = (enabled: boolean) =>
    renderHook((props: { enabled: boolean }) => useBrowserWatching({ taskId: TASK_ID, ...props }), {
      wrapper,
      initialProps: { enabled },
    })
  const turn = (to: DocumentVisibilityState) => {
    visibility = to
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    watch.mockReset()
    watch.mockResolvedValue({ watched: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('says it at once and then every minute while the page is on the screen', async () => {
    show(true)
    await act(async () => {})
    expect(watch).toHaveBeenCalledTimes(1)
    expect(watch.mock.calls[0]![0]).toEqual({ taskId: TASK_ID })
    await act(async () => vi.advanceTimersByTime(WATCH_EVERY_MS))
    await act(async () => vi.advanceTimersByTime(WATCH_EVERY_MS))
    expect(watch).toHaveBeenCalledTimes(3)
  })

  it('says nothing while the page is out of sight, and at once when it is back', async () => {
    show(true)
    await act(async () => {})
    turn('hidden')
    await act(async () => vi.advanceTimersByTime(3 * WATCH_EVERY_MS))
    expect(watch).toHaveBeenCalledTimes(1)
    turn('visible')
    await act(async () => {})
    expect(watch).toHaveBeenCalledTimes(2)
  })

  it('says nothing for a browser that holds no session, and stops once it closed', async () => {
    const { rerender, unmount } = show(false)
    await act(async () => vi.advanceTimersByTime(2 * WATCH_EVERY_MS))
    expect(watch).not.toHaveBeenCalled()
    rerender({ enabled: true })
    await act(async () => {})
    expect(watch).toHaveBeenCalledTimes(1)
    rerender({ enabled: false })
    await act(async () => vi.advanceTimersByTime(2 * WATCH_EVERY_MS))
    expect(watch).toHaveBeenCalledTimes(1)
    unmount()
  })
})
