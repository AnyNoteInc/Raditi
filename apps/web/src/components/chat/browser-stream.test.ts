import { encodeBrowserFrame, type BrowserFrame } from '@repo/domain/browser/stream-codec'
import { browserStreamCloseCodes } from '@repo/domain/browser/stream-messages'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  backoffMs,
  BrowserStreamClient,
  sameStreamUrl,
  STREAM_SILENCE_MS,
  type BrowserState,
  type StreamConnection,
  type StreamSocket,
} from './browser-stream'

const STREAM_URL = 'wss://stream.raditi.test/v1/browser/stream'
const SESSION = '0199a3f2-0000-7000-8000-0000000000e1'
const OTHER_SESSION = '0199a3f2-0000-7000-8000-0000000000e2'
const VIEWER = '0199a3f2-0000-7000-8000-0000000000aa'
const NEXT_VIEWER = '0199a3f2-0000-7000-8000-0000000000bb'
const TICKET = 'A'.repeat(43)

class FakeSocket implements StreamSocket {
  binaryType = 'blob'
  sent: unknown[] = []
  closed: number | null = null
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as unknown)
  }
  close(code?: number) {
    this.closed = code ?? 1000
  }
  // The server's side.
  open() {
    this.onopen?.({})
  }
  text(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  binary(bytes: Uint8Array) {
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })
  }
  end(code: number) {
    this.onclose?.({ code })
  }
}

const state = (patch: Partial<BrowserState> = {}): BrowserState => ({
  session: SESSION,
  status: 'ready',
  controller: 'agent',
  controlEpoch: 1,
  manualReady: false,
  holder: null,
  pageId: 1,
  viewportVersion: 1,
  viewport: { width: 1280, height: 800 },
  url: 'https://kroshka.example/wp-admin/edit.php',
  title: 'Записи',
  tabs: [{ pageId: 1, url: 'https://kroshka.example/wp-admin/edit.php', title: 'Записи' }],
  ...patch,
})

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const frame = (
  frameSeq: number,
  patch: { sessionId?: string; pageId?: number; viewportVersion?: number } = {},
) =>
  encodeBrowserFrame(
    {
      flags: 0,
      frameSeq,
      pageId: patch.pageId ?? 1,
      viewportVersion: patch.viewportVersion ?? 1,
      controlEpoch: 1,
      width: 1280,
      height: 800,
      timestamp: 1_760_000_000_000,
      sessionId: patch.sessionId ?? SESSION,
    },
    jpeg,
  )

function setup(options: { url?: string; gone?: boolean; heldBy?: string | null } = {}) {
  const sockets: FakeSocket[] = []
  const connections: StreamConnection[] = []
  const states: BrowserState[] = []
  let tickets = 0
  const drawn: BrowserFrame[] = []
  const draws: Array<() => void> = []
  const ticket = vi.fn(async () => {
    tickets += 1
    if (options.gone) throw Object.assign(new Error('gone'), { data: { code: 'NOT_FOUND' } })
    return { url: options.url ?? STREAM_URL, ticket: TICKET, sessionId: SESSION }
  })
  const client = new BrowserStreamClient({
    streamUrl: STREAM_URL,
    heldBy: options.heldBy,
    ticket,
    isGone: (error) => (error as { data?: { code?: string } }).data?.code === 'NOT_FOUND',
    // A draw resolves when the test lets it: the acknowledgement must wait for it.
    draw: (next) =>
      new Promise((resolve) => {
        drawn.push(next)
        draws.push(() => resolve(true))
      }),
    createSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    events: {
      connection: (connection) => connections.push(connection),
      state: (next) => states.push(next),
      viewer: () => {},
      refused: () => {},
    },
  })
  return {
    client,
    sockets,
    connections,
    states,
    drawn,
    draws,
    ticket,
    tickets: () => tickets,
    socket: () => sockets.at(-1)!,
  }
}

/** Lets the ticket promise and the microtasks after it run. */
const settle = () => vi.advanceTimersByTimeAsync(0)

async function opened(stand: ReturnType<typeof setup>, patch: Partial<BrowserState> = {}) {
  stand.client.start()
  await settle()
  const socket = stand.socket()
  socket.open()
  socket.text({ t: 'viewer', viewer: VIEWER })
  socket.text({ t: 'state', ...state(patch) })
  return socket
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the stream of a task browser', () => {
  it('opens the configured address with a fresh ticket and sends hello before anything else', async () => {
    const stand = setup()
    stand.client.start()
    expect(stand.connections).toEqual(['connecting'])
    await settle()
    const socket = stand.socket()
    expect(socket.url).toBe(STREAM_URL)
    expect(socket.binaryType).toBe('arraybuffer')
    expect(socket.sent).toEqual([])
    socket.open()
    expect(socket.sent).toEqual([{ t: 'hello', ticket: TICKET }])
    socket.text({ t: 'viewer', viewer: VIEWER })
    socket.text({ t: 'state', ...state() })
    expect(stand.connections.at(-1)).toBe('open')
    expect(stand.client.state?.url).toBe('https://kroshka.example/wp-admin/edit.php')
  })

  it('never opens a ticket of another address', async () => {
    const stand = setup({ url: 'wss://evil.example/v1/browser/stream' })
    stand.client.start()
    await settle()
    expect(stand.sockets).toHaveLength(0)
    expect(stand.connections.at(-1)).toBe('failed')
  })

  it('acknowledges a frame only after it is drawn, and draws the newest that waited', async () => {
    const stand = setup()
    const socket = await opened(stand)
    socket.binary(frame(1))
    socket.binary(frame(2))
    socket.binary(frame(3))
    expect(stand.drawn.map((next) => next.header.frameSeq)).toEqual([1])
    expect(socket.sent.filter((message) => (message as { t: string }).t === 'ack')).toEqual([])
    stand.draws.shift()!()
    await settle()
    // Frame 2 was replaced by 3 while 1 was drawn; the acknowledgement of 3 covers both.
    expect(stand.drawn.map((next) => next.header.frameSeq)).toEqual([1, 3])
    stand.draws.shift()!()
    await settle()
    expect(socket.sent.filter((message) => (message as { t: string }).t === 'ack')).toEqual([
      { t: 'ack', frameSeq: 1 },
      { t: 'ack', frameSeq: 3 },
    ])
  })

  it('drops frames of another session and gives back those of another page or window size', async () => {
    const stand = setup()
    const socket = await opened(stand)
    socket.binary(frame(1, { sessionId: OTHER_SESSION }))
    socket.binary(frame(2, { pageId: 2 }))
    socket.binary(frame(3, { viewportVersion: 2 }))
    socket.binary(new Uint8Array([1, 2, 3]))
    expect(stand.drawn).toEqual([])
    expect(socket.sent.slice(1)).toEqual([
      { t: 'ack', frameSeq: 2 },
      { t: 'ack', frameSeq: 3 },
    ])
  })

  it('answers a ping with a pong', async () => {
    const stand = setup()
    const socket = await opened(stand)
    socket.text({ t: 'ping', ts: 42 })
    expect(socket.sent.at(-1)).toEqual({ t: 'pong', ts: 42 })
  })

  it('opens the stream anew with a new ticket when it is silent for 25 s', async () => {
    const stand = setup()
    const first = await opened(stand)
    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS - 1)
    first.text({ t: 'ping', ts: 1 })
    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS - 1)
    expect(stand.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(first.closed).toBe(1000)
    expect(stand.connections.at(-1)).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(backoffMs(0))
    expect(stand.tickets()).toBe(2)
    expect(stand.sockets).toHaveLength(2)
    stand.socket().open()
    expect(stand.socket().sent).toEqual([{ t: 'hello', ticket: TICKET }])
  })

  it('takes a new ticket at once for a spent one, and waits longer after each failure', async () => {
    const stand = setup()
    const first = await opened(stand)
    first.end(browserStreamCloseCodes.unauthorized)
    await settle()
    expect(stand.tickets()).toBe(2)
    const second = stand.socket()
    second.end(1006)
    await vi.advanceTimersByTimeAsync(backoffMs(1) - 1)
    expect(stand.tickets()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(stand.tickets()).toBe(3)
    expect(backoffMs(10)).toBe(10_000)
  })

  it('stops for good when the session ends or the user may not watch it', async () => {
    const stand = setup()
    const socket = await opened(stand)
    socket.text({ t: 'closed', reason: 'idle' })
    socket.end(1006)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(stand.connections.at(-1)).toBe('ended')
    expect(stand.tickets()).toBe(1)

    const refused = setup({ gone: true })
    refused.client.start()
    await settle()
    expect(refused.connections.at(-1)).toBe('ended')
    expect(refused.sockets).toHaveLength(0)
  })

  it('sends a press made before the stream opened with its first state', async () => {
    const stand = setup()
    stand.client.take()
    const socket = await opened(stand)
    expect(socket.sent).toEqual([{ t: 'hello', ticket: TICKET }, { t: 'take' }])
  })

  it('takes the control back after a reconnect when this tab held it', async () => {
    const stand = setup()
    const first = await opened(stand, { controller: 'user', holder: VIEWER, manualReady: true })
    expect(stand.client.holding).toBe(true)
    first.end(1006)
    await vi.advanceTimersByTimeAsync(backoffMs(0))
    const second = stand.socket()
    second.open()
    second.text({ t: 'viewer', viewer: NEXT_VIEWER })
    // The browser still names the old connection as the holder.
    second.text({ t: 'state', ...state({ controller: 'user', holder: VIEWER, manualReady: true }) })
    expect(second.sent).toEqual([{ t: 'hello', ticket: TICKET }, { t: 'take' }])
  })

  it('names the viewer it held under once stopped, and a next client takes the control back', async () => {
    const stand = setup()
    await opened(stand, { controller: 'user', holder: VIEWER, manualReady: true })
    expect(stand.client.heldBy).toBe(VIEWER)
    stand.client.stop()
    expect(stand.client.holding).toBe(false)
    expect(stand.client.heldBy).toBe(VIEWER)
    // The panel shown again: another client, another viewer, the same holder in the state.
    const next = setup({ heldBy: stand.client.heldBy })
    next.client.start()
    await settle()
    const socket = next.socket()
    socket.open()
    socket.text({ t: 'viewer', viewer: NEXT_VIEWER })
    socket.text({ t: 'state', ...state({ controller: 'user', holder: VIEWER, manualReady: true }) })
    expect(socket.sent).toEqual([{ t: 'hello', ticket: TICKET }, { t: 'take' }])
    // A client that never held the control has nobody to carry on.
    const watcher = setup()
    await opened(watcher)
    watcher.client.stop()
    expect(watcher.client.heldBy).toBeNull()
  })

  it('does not take the control from another tab after a reconnect', async () => {
    const stand = setup()
    const first = await opened(stand)
    first.end(1006)
    await vi.advanceTimersByTimeAsync(backoffMs(0))
    const second = stand.socket()
    second.open()
    second.text({ t: 'viewer', viewer: NEXT_VIEWER })
    second.text({ t: 'state', ...state({ controller: 'user', holder: VIEWER }) })
    expect(second.sent).toEqual([{ t: 'hello', ticket: TICKET }])
  })
})

describe('sameStreamUrl', () => {
  it('takes the configured address only', () => {
    expect(sameStreamUrl(STREAM_URL, STREAM_URL)).toBe(true)
    expect(sameStreamUrl('ws://stream.raditi.test/v1/browser/stream', STREAM_URL)).toBe(false)
    expect(sameStreamUrl('wss://stream.raditi.test:444/v1/browser/stream', STREAM_URL)).toBe(false)
    expect(sameStreamUrl(`${STREAM_URL}?t=1`, STREAM_URL)).toBe(false)
    expect(
      sameStreamUrl(
        'https://stream.raditi.test/v1/browser/stream',
        'https://stream.raditi.test/v1/browser/stream',
      ),
    ).toBe(false)
    expect(sameStreamUrl('not a url', STREAM_URL)).toBe(false)
  })
})
