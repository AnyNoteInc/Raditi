// @vitest-environment jsdom
import { encodeBrowserFrame } from '@repo/domain/browser/stream-codec'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FramePainter } from './browser-canvas'
import type { StreamSocket } from './browser-stream'
import { SESSION_ID, TASK_ID } from './testing'
import { useBrowserStream } from './use-browser-stream'

// The hook of the window of a task (docs/plan/57-browser-tasks.md, Б12, Б14): a fresh ticket for
// every connection, no connection while the panel is hidden — unless a press waits for one — and
// frames handed to the canvas before they are acknowledged.

const STREAM_URL = 'wss://stream.raditi.test/v1/browser/stream'
const VIEWER = '0199a3f2-0000-7000-8000-0000000000aa'
const VIEWER2 = '0199a3f2-0000-7000-8000-0000000000ab'
const OTHER_TAB = '0199a3f2-0000-7000-8000-0000000000ac'

const calls = vi.hoisted(() => ({
  ticket: vi.fn(async (_input: { taskId: string }) => ({
    url: 'wss://stream.raditi.test/v1/browser/stream',
    ticket: 'T'.repeat(43),
    sessionId: '0199a3f2-0000-7000-8000-0000000000e1',
  })),
}))

// One client for the whole run, as the provider of the app gives it.
const client = vi.hoisted(() => ({
  browser: { streamTicket: { mutate: (input: { taskId: string }) => calls.ticket(input) } },
}))
vi.mock('@/trpc/client', () => ({ useTRPCClient: () => client }))

class FakeSocket implements StreamSocket {
  binaryType = 'blob'
  sent: unknown[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  closed = false
  send(data: string) {
    this.sent.push(JSON.parse(data) as unknown)
  }
  close() {
    this.closed = true
  }
}

const state = {
  t: 'state',
  session: '0199a3f2-0000-7000-8000-0000000000e1',
  status: 'ready',
  controller: 'agent',
  controlEpoch: 0,
  manualReady: false,
  holder: null,
  pageId: 1,
  viewportVersion: 1,
  viewport: { width: 1280, height: 800 },
  url: 'https://kroshka.example/wp-admin/edit.php',
  title: 'Записи',
  tabs: [],
}

function setup(initial: { visible: boolean }) {
  const sockets: FakeSocket[] = []
  const createSocket = (_url: string) => {
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  }
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    ({ visible }) =>
      useBrowserStream({
        taskId: TASK_ID,
        streamUrl: STREAM_URL,
        live: true,
        visible,
        createSocket,
      }),
    { wrapper, initialProps: initial },
  )
  /** Opens the latest socket (the `count`-th one) as `viewer`, with `first` as its state. */
  const open = async ({
    count = 1,
    viewer = VIEWER,
    first = state,
  }: { count?: number; viewer?: string; first?: object } = {}) => {
    await waitFor(() => expect(sockets.length).toBe(count))
    const socket = sockets.at(-1)!
    act(() => {
      socket.onopen?.({})
      socket.onmessage?.({ data: JSON.stringify({ t: 'viewer', viewer }) })
      socket.onmessage?.({ data: JSON.stringify(first) })
    })
    return socket
  }
  const receive = (socket: FakeSocket, message: object) =>
    act(() => socket.onmessage?.({ data: JSON.stringify(message) }))
  return { hook, sockets, open, receive, queryClient }
}

/** The page of the cabinet is hidden (another tab, a minimised window) or shown again. */
function pageHidden(hidden: boolean) {
  if (hidden)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  else Reflect.deleteProperty(document, 'visibilityState')
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  Reflect.deleteProperty(document, 'visibilityState')
})

/** The browser under this tab's control: `holder` is the viewer that took it. */
const held = (holder: string) => ({ ...state, controller: 'user', holder, controlEpoch: 1 })

describe('useBrowserStream', () => {
  it('opens nothing while the panel is hidden', async () => {
    const { sockets } = setup({ visible: false })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls.ticket).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(0)
  })

  it('takes a fresh ticket for the panel shown, and one more after it was hidden', async () => {
    const { hook, sockets, open, queryClient } = setup({ visible: true })
    const socket = await open()
    expect(calls.ticket).toHaveBeenCalledWith({ taskId: TASK_ID })
    expect(socket.sent[0]).toEqual({ t: 'hello', ticket: 'T'.repeat(43) })
    expect(hook.result.current.connection).toBe('open')
    expect(hook.result.current.state?.url).toBe('https://kroshka.example/wp-admin/edit.php')
    // The ticket is not kept anywhere once it was used.
    expect(queryClient.getQueryCache().findAll({ queryKey: ['chat', 'browser-ticket'] })).toEqual(
      [],
    )
    hook.rerender({ visible: false })
    await waitFor(() => expect(hook.result.current.connection).toBe('idle'))
    hook.rerender({ visible: true })
    await waitFor(() => expect(sockets).toHaveLength(2))
    expect(calls.ticket).toHaveBeenCalledTimes(2)
  })

  it('hands a frame to the canvas and acknowledges it once drawn', async () => {
    const { hook, open } = setup({ visible: true })
    let finish = () => {}
    const paint = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => resolve(true)
        }),
    )
    hook.result.current.setPainter({ paint } as unknown as FramePainter)
    const socket = await open()
    const frame = encodeBrowserFrame(
      {
        flags: 0,
        frameSeq: 9,
        pageId: 1,
        viewportVersion: 1,
        controlEpoch: 0,
        width: 1280,
        height: 800,
        timestamp: 1,
        sessionId: SESSION_ID,
      },
      new Uint8Array([0xff, 0xd8, 0xff, 1]),
    )
    act(() => socket.onmessage?.({ data: frame.buffer }))
    expect(paint).toHaveBeenCalledTimes(1)
    expect(socket.sent).not.toContainEqual({ t: 'ack', frameSeq: 9 })
    await act(async () => finish())
    expect(socket.sent).toContainEqual({ t: 'ack', frameSeq: 9 })
  })

  it('takes the control back on the next stream after the panel was hidden and shown', async () => {
    const { hook, open, receive } = setup({ visible: true })
    const first = await open()
    act(() => hook.result.current.take())
    receive(first, held(VIEWER))
    expect(hook.result.current.holding).toBe(true)
    hook.rerender({ visible: false })
    await waitFor(() => expect(hook.result.current.connection).toBe('idle'))
    expect(first.closed).toBe(true)
    hook.rerender({ visible: true })
    // A new connection is a new viewer: the browser still names the old one, and it is ours.
    const second = await open({ count: 2, viewer: VIEWER2, first: held(VIEWER) })
    expect(second.sent).toEqual([{ t: 'hello', ticket: 'T'.repeat(43) }, { t: 'take' }])
  })

  it('does not take the control back from a tab that took it meanwhile', async () => {
    const { hook, open, receive } = setup({ visible: true })
    const first = await open()
    act(() => hook.result.current.take())
    receive(first, held(VIEWER))
    hook.rerender({ visible: false })
    await waitFor(() => expect(hook.result.current.connection).toBe('idle'))
    hook.rerender({ visible: true })
    const second = await open({ count: 2, viewer: VIEWER2, first: held(OTHER_TAB) })
    expect(second.sent).toEqual([{ t: 'hello', ticket: 'T'.repeat(43) }])
    expect(hook.result.current.holding).toBe(false)
  })

  it('closes the stream while the page is hidden and opens it with a new ticket after', async () => {
    const { hook, sockets, open } = setup({ visible: true })
    const first = await open()
    pageHidden(true)
    await waitFor(() => expect(hook.result.current.connection).toBe('idle'))
    expect(first.closed).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sockets).toHaveLength(1)
    pageHidden(false)
    await open({ count: 2, viewer: VIEWER2 })
    expect(calls.ticket).toHaveBeenCalledTimes(2)
    expect(hook.result.current.connection).toBe('open')
  })

  it('keeps the control of a tab whose page was hidden and shown again', async () => {
    const { hook, open, receive } = setup({ visible: true })
    const first = await open()
    act(() => hook.result.current.take())
    receive(first, held(VIEWER))
    pageHidden(true)
    await waitFor(() => expect(hook.result.current.connection).toBe('idle'))
    pageHidden(false)
    const second = await open({ count: 2, viewer: VIEWER2, first: held(VIEWER) })
    expect(second.sent).toContainEqual({ t: 'take' })
  })

  it('says a refusal while the browser stands where it came, not after the page moved', async () => {
    const { hook, open, receive } = setup({ visible: true })
    const socket = await open()
    receive(socket, { t: 'refused', reason: 'address_denied' })
    expect(hook.result.current.refusal).toEqual({ reason: 'address_denied', seq: 1 })
    // Another title of the same page: still so.
    receive(socket, { ...state, title: 'Записи ‹ Крошка' })
    expect(hook.result.current.refusal).toEqual({ reason: 'address_denied', seq: 1 })
    // Another address: the sentence is history.
    receive(socket, { ...state, url: 'https://kroshka.example/wp-admin/post-new.php' })
    expect(hook.result.current.refusal).toBeNull()
    // A refusal that comes after is told again, under a new counter.
    receive(socket, { t: 'refused', reason: 'address_denied' })
    expect(hook.result.current.refusal).toEqual({ reason: 'address_denied', seq: 2 })
    // Another tab took over: history again.
    receive(socket, { ...held(OTHER_TAB), url: 'https://kroshka.example/wp-admin/post-new.php' })
    expect(hook.result.current.refusal).toBeNull()
  })

  it('opens the stream for «Взять управление» pressed while the panel is hidden', async () => {
    const { hook, open } = setup({ visible: false })
    act(() => hook.result.current.take())
    const socket = await open()
    expect(socket.sent).toEqual([{ t: 'hello', ticket: 'T'.repeat(43) }, { t: 'take' }])
    // Taken: the press is done and the hidden panel's stream is closed again.
    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({ ...state, controller: 'user', holder: VIEWER, controlEpoch: 1 }),
      }),
    )
    await waitFor(() => expect(hook.result.current.connection).toBe('idle'))
  })
})
