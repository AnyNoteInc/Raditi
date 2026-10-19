// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { serverRefusal } from '@/components/billing/testing'

import {
  NOT_READY_RETRY_MS,
  PREVIEW_SANDBOX,
  PreviewFrame,
  TICKET_REQUEST_TYPE,
  ticketRequestAllowed,
  ticketRequestPath,
} from './preview-frame'
import { TASK_ID } from './testing'

const { ticket } = vi.hoisted(() => ({
  ticket:
    vi.fn<(input: { taskId: string; to?: string }) => Promise<{ url: string; expiresAt: Date }>>(),
}))

vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({ preview: { ticket: { mutate: ticket } } }),
}))

const ORIGIN = 'http://site-0a1b2c3d-chat-4e5f6a.localhost:8090'
const HOST = 'site-0a1b2c3d-chat-4e5f6a.localhost'
let issued = 0
const entry = (to = '/') => {
  issued += 1
  const token = String(issued).padStart(43, 'a')
  return {
    url: `${ORIGIN}/__raditi/enter?t=${token}&to=${encodeURIComponent(to)}`,
    expiresAt: new Date(),
  }
}

function showFrame(revision = 1) {
  const client = new QueryClient()
  const view = render(
    <QueryClientProvider client={client}>
      <PreviewFrame taskId={TASK_ID} origin={ORIGIN} revision={revision} />
    </QueryClientProvider>,
  )
  return {
    ...view,
    rerenderAt: (next: number) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <PreviewFrame taskId={TASK_ID} origin={ORIGIN} revision={next} />
        </QueryClientProvider>,
      ),
  }
}

const TITLE = 'Предпросмотр сайта с изменениями диалога'
const frame = () => screen.getByTitle<HTMLIFrameElement>(TITLE)
const shown = () => screen.findByTitle<HTMLIFrameElement>(TITLE)

function ask(source: unknown, data: unknown, origin = ORIGIN) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }))
  })
}
const request = (path = '/catalog/') => ({ type: TICKET_REQUEST_TYPE, host: HOST, path })

beforeEach(() => {
  issued = 0
  ticket.mockReset()
  ticket.mockImplementation(async ({ to }) => entry(to))
})
afterEach(() => vi.restoreAllMocks())

describe('the frame of a preview', () => {
  it('opens only by a fresh ticket, sandboxed, without a referrer', async () => {
    showFrame()
    const opened = await shown()
    const answer = (await ticket.mock.results[0]!.value) as { url: string }
    expect(opened.getAttribute('src')).toBe(answer.url)
    expect(ticket).toHaveBeenCalledTimes(1)
    expect(ticket).toHaveBeenCalledWith({ taskId: TASK_ID, to: '/' })
    expect(frame().getAttribute('sandbox')).toBe(PREVIEW_SANDBOX)
    expect(frame().getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame().getAttribute('src')?.startsWith(`${ORIGIN}/__raditi/enter?t=`)).toBe(true)
  })

  it('answers the request of its own frame with a new frame, never with a message', async () => {
    showFrame()
    const first = await shown()
    const post = vi.spyOn(first.contentWindow!, 'postMessage')
    ask(first.contentWindow, request('/catalog/?page=2'))
    await waitFor(() => expect(ticket).toHaveBeenCalledTimes(2))
    expect(ticket).toHaveBeenLastCalledWith({ taskId: TASK_ID, to: '/catalog/?page=2' })
    await waitFor(() => expect(frame()).not.toBe(first))
    expect(frame().getAttribute('src')).toContain(encodeURIComponent('/catalog/?page=2'))
    expect(post).not.toHaveBeenCalled()
  })

  it('drops what is not the request of this frame', async () => {
    showFrame()
    const own = (await shown()).contentWindow
    ask(window, request())
    ask(own, request(), 'http://site-0a1b2c3d-chat-ffffff.localhost:8090')
    ask(own, { ...request(), host: 'site-0a1b2c3d-chat-ffffff.localhost' })
    ask(own, { ...request(), type: 'raditi-preview-ticket' })
    ask(own, 'raditi-preview-ticket-request')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ticket).toHaveBeenCalledTimes(1)
  })

  it('answers at most once in 10 s', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    showFrame()
    ask((await shown()).contentWindow, request('/a'))
    await waitFor(() => expect(ticket).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(frame().getAttribute('src')).toContain('%2Fa'))
    now += 9_999
    ask(frame().contentWindow, request('/b'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ticket).toHaveBeenCalledTimes(2)
    now += 1
    ask(frame().contentWindow, request('/c'))
    await waitFor(() => expect(ticket).toHaveBeenCalledTimes(3))
  })

  it('takes a new ticket for a new revision of the preview', async () => {
    const view = showFrame(1)
    const first = await shown()
    view.rerenderAt(2)
    await waitFor(() => expect(ticket).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(frame()).not.toBe(first))
    expect(frame().getAttribute('src')).not.toBe(first.getAttribute('src'))
  })

  it('never frames an entry of another origin', async () => {
    ticket.mockResolvedValue({
      url: 'https://evil.example/__raditi/enter?t=x',
      expiresAt: new Date(),
    })
    showFrame()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByTitle('Предпросмотр сайта с изменениями диалога')).toBeNull()
  })

  it('says the preview is being built when the server says it is not ready', async () => {
    ticket.mockRejectedValue(
      serverRefusal('Предпросмотр ещё готовится. Откройте его через минуту', 'PREVIEW_NOT_READY'),
    )
    showFrame()
    expect(await screen.findByText('Готовим предпросмотр…')).toBeTruthy()
  })

  it('asks again by itself a minute after the preview was not ready, and opens it then', async () => {
    const timers = vi.spyOn(window, 'setTimeout')
    ticket.mockRejectedValueOnce(
      serverRefusal('Предпросмотр ещё готовится. Откройте его через минуту', 'PREVIEW_NOT_READY'),
    )
    showFrame()
    // The panel says the same while the first ticket is asked and after the refusal.
    expect(await screen.findByText('Готовим предпросмотр…')).toBeTruthy()
    const retry = await waitFor(() => {
      const found = timers.mock.calls.find(([, delay]) => delay === NOT_READY_RETRY_MS)
      expect(found).toBeDefined()
      return found!
    })
    expect(ticket).toHaveBeenCalledTimes(1)
    act(() => (retry[0] as () => void)())
    expect(await shown()).toBeTruthy()
    expect(ticket).toHaveBeenCalledTimes(2)
  })

  it('offers to try again after a ticket that failed', async () => {
    ticket.mockRejectedValueOnce(new Error('Failed to fetch'))
    showFrame()
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить' }))
    expect(await shown()).toBeTruthy()
    expect(ticket).toHaveBeenCalledTimes(2)
  })
})

describe('the rules of a ticket request', () => {
  const own = {}
  const target = { window: own, origin: ORIGIN, hostname: HOST }

  it('takes a path the gateway would lead to, else the start page', () => {
    expect(
      ticketRequestPath({ source: own, origin: ORIGIN, data: request('/a?b=1') }, target),
    ).toBe('/a?b=1')
    expect(
      ticketRequestPath({ source: own, origin: ORIGIN, data: request('//evil.example') }, target),
    ).toBe('/')
    expect(
      ticketRequestPath(
        { source: own, origin: ORIGIN, data: request('https://evil.example/') },
        target,
      ),
    ).toBe('/')
    expect(
      ticketRequestPath(
        { source: own, origin: ORIGIN, data: { type: TICKET_REQUEST_TYPE, host: HOST } },
        target,
      ),
    ).toBe('/')
  })

  it('refuses a frame that is gone', () => {
    expect(
      ticketRequestPath(
        { source: undefined, origin: ORIGIN, data: request() },
        { ...target, window: undefined },
      ),
    ).toBeNull()
  })

  it('allows a request 10 s after the last one answered', () => {
    expect(ticketRequestAllowed(null, 5)).toBe(true)
    expect(ticketRequestAllowed(1_000, 10_999)).toBe(false)
    expect(ticketRequestAllowed(1_000, 11_000)).toBe(true)
  })
})
