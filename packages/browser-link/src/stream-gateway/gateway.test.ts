import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  decodeBrowserFrame,
  encodeBrowserFrame,
  type BrowserServerMessage,
  type BrowserSessionState,
} from '@repo/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { browserStreamCloseCodes } from './close-codes.ts'
import {
  BROWSER_STREAM_PATH,
  createBrowserStreamGateway,
  type BrowserStreamGateway,
  type BrowserStreamGatewayOptions,
} from './gateway.ts'
import {
  browserStreamGatewayLimitDefaults,
  type BrowserStreamStore,
  type BrowserStreamViewer,
} from './settings.ts'

const APP_ORIGIN = 'http://localhost:3000'
const TOKEN = 'worker-token-0123456789abcdef0123456789abcdef'
const sessionId = '0196abcd-0000-7000-8000-000000000001'
const otherSessionId = '0196abcd-0000-7000-8000-000000000009'
const userId = '0196abcd-0000-7000-8000-000000000005'
const viewerOf: BrowserStreamViewer = { sessionId, userId }

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const newTicket = () => randomBytes(32).toString('base64url')

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition')
    await sleep(5)
  }
}

async function listening(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return (server.address() as AddressInfo).port
}

// ---------------------------------------------------------------------------------------------
// The store: tickets in memory, spent once
// ---------------------------------------------------------------------------------------------

interface FakeStore extends BrowserStreamStore {
  tickets: Map<string, BrowserStreamViewer>
  allowed: boolean | 'throws'
  consumed: number
  checks: number
}

function fakeStore(tickets: Record<string, BrowserStreamViewer> = {}): FakeStore {
  const store: FakeStore = {
    tickets: new Map(Object.entries(tickets)),
    allowed: true,
    consumed: 0,
    checks: 0,
    async consumeTicket(ticket) {
      store.consumed += 1
      // Asynchronous like the database: messages of the viewer arrive in the meantime.
      await sleep(10)
      const viewer = store.tickets.get(ticket) ?? null
      store.tickets.delete(ticket)
      return viewer
    },
    async viewerAllowed() {
      store.checks += 1
      await sleep(1)
      if (store.allowed === 'throws') throw new Error(`database down near ${userId}`)
      return store.allowed
    },
  }
  return store
}

// ---------------------------------------------------------------------------------------------
// The worker: a WebSocket server on loopback that records what reaches it
// ---------------------------------------------------------------------------------------------

interface WorkerConnection {
  ws: WebSocket
  url: URL
  authorization: string | undefined
  texts: unknown[]
  binaries: number
  pings: number
  closed: Promise<void>
}

interface FakeWorker {
  baseUrl: string
  connections: WorkerConnection[]
  next(): Promise<WorkerConnection>
}

interface FakeWorkerOptions {
  /** Answer the upgrade with this status instead. */
  refuse?: number
  /** Stop reading right after the greeting: pings go unanswered. */
  deaf?: boolean
}

const stateOf = (overrides: Partial<BrowserSessionState> = {}): BrowserSessionState => ({
  session: sessionId,
  status: 'ready',
  controller: 'agent',
  controlEpoch: 0,
  manualReady: false,
  holder: null,
  pageId: 1,
  viewportVersion: 1,
  viewport: { width: 1280, height: 800 },
  url: 'https://news.example.ru/wp-admin/edit.php',
  title: 'Записи',
  tabs: [{ pageId: 1, url: 'https://news.example.ru/wp-admin/edit.php', title: 'Записи' }],
  ...overrides,
})

function frameOf(frameSeq: number, size = 1_000, session = sessionId): Buffer {
  const jpeg = new Uint8Array(size)
  jpeg.set([0xff, 0xd8, 0xff, 0xe0])
  const header = {
    flags: 0,
    frameSeq,
    pageId: 1,
    viewportVersion: 1,
    controlEpoch: 0,
    width: 1280,
    height: 800,
    timestamp: 1_760_000_000_000,
    sessionId: session,
  }
  return Buffer.from(encodeBrowserFrame(header, jpeg))
}

async function fakeWorker(options: FakeWorkerOptions = {}): Promise<FakeWorker> {
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  const connections: WorkerConnection[] = []
  const waiting: ((connection: WorkerConnection) => void)[] = []
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    if (options.refuse !== undefined) {
      socket.end(`HTTP/1.1 ${options.refuse} Refused\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection: WorkerConnection = {
        ws,
        url: new URL(request.url ?? '/', 'http://worker'),
        authorization: request.headers.authorization,
        texts: [],
        binaries: 0,
        pings: 0,
        closed: once(ws, 'close').then(() => undefined),
      }
      ws.on('message', (data, isBinary) => {
        if (isBinary) connection.binaries += 1
        else connection.texts.push(JSON.parse(String(data)))
      })
      ws.on('ping', () => {
        connection.pings += 1
      })
      // The worker greets every viewer with the state at once (Б14).
      ws.send(JSON.stringify({ t: 'state', ...stateOf() }))
      if (options.deaf === true) ws.pause()
      connections.push(connection)
      waiting.shift()?.(connection)
    })
  })
  const port = await listening(server)
  cleanups.push(() => {
    for (const client of wss.clients) client.terminate()
    wss.close()
  })
  let handed = 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    connections,
    next: () =>
      new Promise((resolve) => {
        const ready = connections[handed]
        const hand = (connection: WorkerConnection) => {
          handed += 1
          resolve(connection)
        }
        if (ready === undefined) waiting.push(hand)
        else hand(ready)
      }),
  }
}

// ---------------------------------------------------------------------------------------------
// The gateway and its viewers
// ---------------------------------------------------------------------------------------------

interface Running {
  port: number
  gateway: BrowserStreamGateway
  logs: string[]
}

async function gatewayWith(
  store: BrowserStreamStore,
  worker: { baseUrl: string },
  overrides: Partial<BrowserStreamGatewayOptions> = {},
): Promise<Running> {
  const logs: string[] = []
  const gateway = createBrowserStreamGateway({
    store,
    worker: { baseUrl: worker.baseUrl, token: TOKEN },
    appOrigin: `${APP_ORIGIN}/`,
    logger: { warn: (message) => logs.push(message) },
    ...overrides,
  })
  const server = createServer()
  gateway.attach(server)
  const port = await listening(server)
  cleanups.push(() => gateway.close())
  return { port, gateway, logs }
}

interface Viewer {
  ws: WebSocket
  texts: BrowserServerMessage[]
  frames: Buffer[]
  opened: Promise<unknown>
  closed: Promise<{ code: number; reason: string }>
  send(message: unknown): void
}

function viewer(port: number, origin: string | undefined = APP_ORIGIN): Viewer {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${BROWSER_STREAM_PATH}`,
    origin === undefined ? {} : { origin },
  )
  const texts: BrowserServerMessage[] = []
  const frames: Buffer[] = []
  ws.on('error', () => undefined)
  ws.on('message', (data, isBinary) => {
    if (isBinary) frames.push(data as Buffer)
    else texts.push(JSON.parse(String(data)) as BrowserServerMessage)
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  )
  cleanups.push(() => ws.terminate())
  return {
    ws,
    texts,
    frames,
    opened: once(ws, 'open'),
    closed,
    send: (message) => ws.send(JSON.stringify(message)),
  }
}

/** A viewer through hello, the worker's stream open and its first state relayed. */
async function watching(running: Running, worker: FakeWorker, ticket: string) {
  const client = viewer(running.port)
  await client.opened
  client.send({ t: 'hello', ticket })
  const side = await worker.next()
  await until(() => client.texts.some((message) => message.t === 'state'))
  return { client, side }
}

/** The status an upgrade is refused with. */
function refusedWith(port: number, path: string, origin: string | undefined): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin === undefined ? {} : { origin })
  ws.on('error', () => undefined)
  cleanups.push(() => ws.terminate())
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
    ws.on('open', () => reject(new Error('The upgrade was accepted')))
  })
}

const closedMessages = (client: Viewer) => client.texts.filter((message) => message.t === 'closed')

describe('createBrowserStreamGateway: the way in', () => {
  it('refuses a socket from another Origin, without one, or on another path, before the upgrade', async () => {
    const store = fakeStore()
    const worker = await fakeWorker()
    const { port } = await gatewayWith(store, worker)
    expect(await refusedWith(port, BROWSER_STREAM_PATH, 'https://evil.example')).toBe(403)
    expect(await refusedWith(port, BROWSER_STREAM_PATH, 'http://localhost:3001')).toBe(403)
    expect(await refusedWith(port, BROWSER_STREAM_PATH, undefined)).toBe(403)
    expect(await refusedWith(port, '/v1/browser/other', APP_ORIGIN)).toBe(404)
    // A ticket in a URL would land in access logs: no query at all.
    expect(
      await refusedWith(port, `${BROWSER_STREAM_PATH}?ticket=${newTicket()}`, APP_ORIGIN),
    ).toBe(404)
    // Plain HTTP is no way in either.
    expect((await fetch(`http://127.0.0.1:${port}${BROWSER_STREAM_PATH}`)).status).toBe(426)
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404)
    expect(store.consumed).toBe(0)
    expect(worker.connections).toHaveLength(0)
  })

  it('closes a socket whose first message is not hello in time with 4401', async () => {
    const store = fakeStore()
    const worker = await fakeWorker()
    const { port, gateway } = await gatewayWith(store, worker, { timings: { helloMs: 50 } })

    const silent = viewer(port)
    await silent.opened
    expect(await silent.closed).toEqual({
      code: browserStreamCloseCodes.unauthorized,
      reason: 'unauthorized',
    })
    expect(closedMessages(silent)).toEqual([{ t: 'closed', reason: 'unauthorized' }])

    const early = viewer(port)
    await early.opened
    early.send({ t: 'take' })
    expect((await early.closed).code).toBe(browserStreamCloseCodes.unauthorized)

    const binary = viewer(port)
    await binary.opened
    binary.ws.send(Buffer.from([1, 2, 3]))
    expect((await binary.closed).code).toBe(browserStreamCloseCodes.unauthorized)

    expect(store.consumed).toBe(0)
    expect(worker.connections).toHaveLength(0)
    await until(() => gateway.stats().connections === 0)
  })

  it('spends a ticket once: a second socket with it is closed with 4401', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    await watching(running, worker, ticket)

    const again = viewer(running.port)
    await again.opened
    again.send({ t: 'hello', ticket })
    expect(await again.closed).toEqual({
      code: browserStreamCloseCodes.unauthorized,
      reason: 'unauthorized',
    })
    expect(worker.connections).toHaveLength(1)
  })

  it('refuses a user who may not watch the session (4403); the worker never hears of it', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: { sessionId: otherSessionId, userId } })
    store.allowed = false
    const worker = await fakeWorker()
    const { port } = await gatewayWith(store, worker)
    const client = viewer(port)
    await client.opened
    client.send({ t: 'hello', ticket })
    expect(await client.closed).toEqual({
      code: browserStreamCloseCodes.forbidden,
      reason: 'forbidden',
    })
    expect(closedMessages(client)).toEqual([{ t: 'closed', reason: 'forbidden' }])
    expect(worker.connections).toHaveLength(0)
  })

  it('takes no stream past the connection limit', async () => {
    const store = fakeStore()
    const worker = await fakeWorker()
    const { port } = await gatewayWith(store, worker, { limits: { connections: 1 } })
    const first = viewer(port)
    await first.opened
    expect(await refusedWith(port, BROWSER_STREAM_PATH, APP_ORIGIN)).toBe(503)
  })

  it('refuses settings it cannot use', () => {
    const store = fakeStore()
    const base = { store, worker: { baseUrl: 'http://127.0.0.1:8086', token: TOKEN } }
    expect(() => createBrowserStreamGateway({ ...base, appOrigin: 'not a url' })).toThrow(
      /not a URL/,
    )
    expect(() => createBrowserStreamGateway({ ...base, appOrigin: 'file:///etc' })).toThrow(
      /http or https/,
    )
    expect(() =>
      createBrowserStreamGateway({
        ...base,
        appOrigin: APP_ORIGIN,
        worker: { baseUrl: 'http://127.0.0.1:8086/v1', token: TOKEN },
      }),
    ).toThrow(/without a path/)
    expect(() =>
      createBrowserStreamGateway({
        ...base,
        appOrigin: APP_ORIGIN,
        worker: { baseUrl: 'http://127.0.0.1:8086', token: 'a b\r\n' },
      }),
    ).toThrow(/token/)
  })
})

describe('createBrowserStreamGateway: the relay', () => {
  it('opens the worker stream with its token, the user and a new viewer for every socket', async () => {
    const first = newTicket()
    const second = newTicket()
    const store = fakeStore({ [first]: viewerOf, [second]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    const a = await watching(running, worker, first)
    const b = await watching(running, worker, second)

    for (const { side } of [a, b]) {
      expect(side.authorization).toBe(`Bearer ${TOKEN}`)
      expect(side.url.pathname).toBe(`/v1/sessions/${sessionId}/stream`)
      expect(side.url.searchParams.get('user')).toBe(userId)
      expect(side.url.searchParams.get('viewer')).toMatch(/^[0-9a-f-]{36}$/)
    }
    expect(a.side.url.searchParams.get('viewer')).not.toBe(b.side.url.searchParams.get('viewer'))
    expect(running.gateway.stats().connections).toBe(2)
  })

  it('relays the state and frames of the worker and the messages of the viewer', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    const client = viewer(running.port)
    await client.opened
    // Sent before the worker's stream is open: kept and passed on once it is.
    client.send({ t: 'hello', ticket })
    client.send({ t: 'take' })
    const side = await worker.next()
    await until(() => side.texts.length === 1 && client.texts.length === 2)
    expect(side.texts).toEqual([{ t: 'take' }])
    // First the viewer id the worker knows this tab by — the holder of `state` — then the state.
    const viewerId = side.url.searchParams.get('viewer')
    expect(client.texts[0]).toEqual({ t: 'viewer', viewer: viewerId })
    expect(client.texts[1]).toEqual({ t: 'state', ...stateOf() })

    const input = {
      t: 'input',
      pageId: 1,
      controlEpoch: 1,
      viewportVersion: 1,
      event: { kind: 'text', text: 'Новость о запуске' },
    }
    client.send(input)
    client.send({ t: 'ack', frameSeq: 7 })
    await until(() => side.texts.length === 3)
    expect(side.texts.slice(1)).toEqual([input, { t: 'ack', frameSeq: 7 }])

    const frame = frameOf(7)
    side.ws.send(frame)
    side.ws.send(JSON.stringify({ t: 'refused', reason: 'not_holder' }))
    await until(() => client.frames.length === 1 && client.texts.length === 3)
    expect(Buffer.compare(client.frames[0] ?? Buffer.alloc(0), frame)).toBe(0)
    expect(client.texts[2]).toEqual({ t: 'refused', reason: 'not_holder' })
    expect(running.gateway.stats()).toMatchObject({ framesRelayed: 1, framesDropped: 0 })
  })

  it('passes on nothing the viewer may not send: hello again, unknown messages, binary', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    const { client, side } = await watching(running, worker, ticket)

    client.send({ t: 'hello', ticket: newTicket() })
    client.send({ t: 'eval', code: 'document.cookie' })
    client.send({ t: 'take', extra: true })
    client.ws.send('not json')
    client.ws.send(frameOf(1))
    client.send({ t: 'release' })
    await until(() => side.texts.length === 1)
    expect(side.texts).toEqual([{ t: 'release' }])
    expect(side.binaries).toBe(0)
    expect(client.texts.filter((message) => message.t === 'refused')).toEqual(
      Array.from({ length: 5 }, () => ({ t: 'refused', reason: 'bad_message' })),
    )
  })

  it('drops frames and states of another session and anything else the worker should not say', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    const { client, side } = await watching(running, worker, ticket)

    side.ws.send(frameOf(1, 1_000, otherSessionId))
    side.ws.send(Buffer.from('not a frame'))
    side.ws.send(JSON.stringify({ t: 'state', ...stateOf({ session: otherSessionId }) }))
    side.ws.send(JSON.stringify({ t: 'cookies', value: 'wordpress_logged_in=…' }))
    // The viewer id is the gateway's: one the worker names is not passed on.
    side.ws.send(JSON.stringify({ t: 'viewer', viewer: otherSessionId }))
    side.ws.send(JSON.stringify({ t: 'state', ...stateOf({ title: 'Новая запись' }) }))
    await until(() => client.texts.length === 3)
    expect(client.texts.filter((message) => message.t === 'viewer')).toHaveLength(1)
    expect(client.texts[2]).toMatchObject({ t: 'state', title: 'Новая запись' })
    expect(client.frames).toHaveLength(0)
    expect(running.logs).toEqual([
      JSON.stringify({ event: 'browser_stream_worker_message_dropped' }),
    ])
  })

  it('keeps only the newest frame for a viewer that does not read, never the messages', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    const { client, side } = await watching(running, worker, ticket)
    const acked = () =>
      side.texts.flatMap((message) => {
        const { t, frameSeq } = message as { t?: string; frameSeq?: number }
        return t === 'ack' && frameSeq !== undefined ? [frameSeq] : []
      })
    const seqOf = (frame: Buffer) => decodeBrowserFrame(new Uint8Array(frame))?.header.frameSeq

    client.ws.pause()
    const sent = 32
    for (let seq = 1; seq <= sent; seq++) side.ws.send(frameOf(seq, 1024 * 1024))
    side.ws.send(JSON.stringify({ t: 'state', ...stateOf({ title: 'after' }) }))
    // A frame that meets the full socket is acknowledged to the worker at once: its place in the
    // window goes to the next frame, and the last one of the burst is the one kept (Б13).
    await until(() => acked().includes(sent), 10_000)
    const early = acked()
    expect(early).toEqual([...new Set(early)].sort((left, right) => left - right))
    expect(running.gateway.stats().framesRelayed).toBeGreaterThan(0)

    client.ws.resume()
    await until(
      () =>
        client.texts.some((message) => 'title' in message && message.title === 'after') &&
        seqOf(client.frames.at(-1) ?? Buffer.alloc(0)) === sent,
      10_000,
    )
    // The kept frame went once the socket drained; the ones it replaced never go, nothing older
    // follows a newer one.
    const seqs = client.frames.map(seqOf)
    expect(seqs).toEqual([...seqs].sort((left, right) => (left ?? 0) - (right ?? 0)))
    const { framesRelayed, framesDropped } = running.gateway.stats()
    expect(framesDropped).toBeGreaterThan(0)
    expect(client.frames).toHaveLength(framesRelayed)
    expect(framesRelayed + framesDropped).toBe(sent)
    expect(browserStreamGatewayLimitDefaults.clientBufferedBytes).toBe(1024 * 1024)
  })

  it('takes at most clientMessagesPerSecond messages of a viewer a second', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker, { limits: { clientMessagesPerSecond: 3 } })
    const { client, side } = await watching(running, worker, ticket)

    for (let index = 0; index < 6; index++) client.send({ t: 'ack', frameSeq: index })
    await until(() => client.texts.some((message) => message.t === 'refused'))
    await sleep(50)
    expect(side.texts).toEqual([0, 1, 2].map((frameSeq) => ({ t: 'ack', frameSeq })))
    expect(client.texts.filter((message) => message.t === 'refused')).toEqual([
      { t: 'refused', reason: 'busy' },
    ])
  })

  it('passes an acknowledgement of each relayed frame past the rate, and no more', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker, { limits: { clientMessagesPerSecond: 3 } })
    const { client, side } = await watching(running, worker, ticket)
    side.ws.send(frameOf(1))
    side.ws.send(frameOf(2))
    await until(() => client.frames.length === 2)

    // A fast pointer spends the second's share; the acknowledgements still free the window.
    for (let index = 0; index < 3; index++) client.send({ t: 'release' })
    client.send({ t: 'ack', frameSeq: 1 })
    client.send({ t: 'ack', frameSeq: 2 })
    // One more than frames relayed is an ordinary message: past the rate, it is dropped.
    client.send({ t: 'ack', frameSeq: 2 })
    await until(() => client.texts.some((message) => message.t === 'refused'))
    await sleep(50)
    expect(side.texts).toEqual([
      ...Array.from({ length: 3 }, () => ({ t: 'release' })),
      { t: 'ack', frameSeq: 1 },
      { t: 'ack', frameSeq: 2 },
    ])
    expect(client.texts.filter((message) => message.t === 'refused')).toEqual([
      { t: 'refused', reason: 'busy' },
    ])
  })

  it('closes a viewer whose message is too long (1009), and the worker stream with it', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    const { client, side } = await watching(running, worker, ticket)

    client.ws.send('x'.repeat(browserStreamGatewayLimitDefaults.clientMessageBytes + 1))
    expect((await client.closed).code).toBe(1009)
    await side.closed
    await until(() => running.gateway.stats().connections === 0)
  })
})

describe('createBrowserStreamGateway: ends', () => {
  it('passes on the worker’s closed once and closes the viewer with 4000', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    const { client, side } = await watching(running, worker, ticket)

    // The worker says why and leaves the closing to the gateway: both sides close.
    side.ws.send(JSON.stringify({ t: 'closed', reason: 'task_done' }))
    await side.closed
    expect(await client.closed).toEqual({
      code: browserStreamCloseCodes.ended,
      reason: 'task_done',
    })
    expect(closedMessages(client)).toEqual([{ t: 'closed', reason: 'task_done' }])
    expect(running.gateway.stats().connections).toBe(0)
  })

  it('closes the worker stream when the viewer leaves', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    const { client, side } = await watching(running, worker, ticket)

    client.ws.close(1000)
    await side.closed
    await until(() => running.gateway.stats().connections === 0)
  })

  it('closes with 4503 when the worker goes without a word', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    const { client, side } = await watching(running, worker, ticket)

    side.ws.terminate()
    expect(await client.closed).toEqual({
      code: browserStreamCloseCodes.unavailable,
      reason: 'unavailable',
    })
    expect(closedMessages(client)).toEqual([{ t: 'closed', reason: 'unavailable' }])
  })

  it('closes with 4503 when the worker refuses the stream or cannot be reached', async () => {
    const refusedTicket = newTicket()
    const refusing = await fakeWorker({ refuse: 401 })
    const store = fakeStore({ [refusedTicket]: viewerOf })
    const running = await gatewayWith(store, refusing)
    const client = viewer(running.port)
    await client.opened
    client.send({ t: 'hello', ticket: refusedTicket })
    expect(await client.closed).toEqual({
      code: browserStreamCloseCodes.unavailable,
      reason: 'unavailable',
    })
    expect(closedMessages(client)).toEqual([{ t: 'closed', reason: 'unavailable' }])

    const goneServer = createServer()
    const gonePort = await listening(goneServer)
    await new Promise((resolve) => goneServer.close(resolve))
    const goneTicket = newTicket()
    const gone = await gatewayWith(fakeStore({ [goneTicket]: viewerOf }), {
      baseUrl: `http://127.0.0.1:${gonePort}`,
    })
    const lost = viewer(gone.port)
    await lost.opened
    lost.send({ t: 'hello', ticket: goneTicket })
    expect((await lost.closed).code).toBe(browserStreamCloseCodes.unavailable)

    // Only names: no ticket, token, address or user in a line of the log.
    const logs = [...running.logs, ...gone.logs].join('\n')
    expect(logs).toContain('browser_stream_worker_unavailable')
    for (const secret of [refusedTicket, goneTicket, TOKEN, userId, sessionId, String(gonePort)])
      expect(logs).not.toContain(secret)
  })

  it('closes with 4503 when the stream does not open in time', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    // A database that never answers.
    store.consumeTicket = () => new Promise(() => undefined)
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker, { timings: { openMs: 50 } })
    const client = viewer(running.port)
    await client.opened
    client.send({ t: 'hello', ticket })
    expect(await client.closed).toEqual({
      code: browserStreamCloseCodes.unavailable,
      reason: 'unavailable',
    })
    expect(worker.connections).toHaveLength(0)
    expect(running.gateway.stats().connections).toBe(0)
  })

  it('closes with 4503 when the database cannot spend a ticket, and logs no ticket', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    store.consumeTicket = () => Promise.reject(new Error(`no row for ${ticket}`))
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    const client = viewer(running.port)
    await client.opened
    client.send({ t: 'hello', ticket })
    expect((await client.closed).code).toBe(browserStreamCloseCodes.unavailable)
    expect(running.logs).toEqual([
      JSON.stringify({ event: 'browser_stream_ticket_check_failed', reason: 'Error' }),
    ])
  })

  it('closes with 4403 when a recheck finds the user may no longer watch', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker, { timings: { recheckMs: 30 } })
    const { client, side } = await watching(running, worker, ticket)

    await until(() => store.checks >= 3)
    store.allowed = false
    expect(await client.closed).toEqual({
      code: browserStreamCloseCodes.forbidden,
      reason: 'forbidden',
    })
    expect(closedMessages(client)).toEqual([{ t: 'closed', reason: 'forbidden' }])
    await side.closed
  })

  it('closes with 4503 when a recheck cannot be made', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker, { timings: { recheckMs: 30 } })
    const { client, side } = await watching(running, worker, ticket)

    store.allowed = 'throws'
    expect((await client.closed).code).toBe(browserStreamCloseCodes.unavailable)
    await side.closed
    expect(running.logs.join('\n')).not.toContain(userId)
  })

  it('pings both sides and cuts a viewer that stops answering', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker, { timings: { pingMs: 40 } })
    const { client, side } = await watching(running, worker, ticket)

    await until(() => client.texts.some((message) => message.t === 'ping') && side.pings > 0)
    expect(client.texts.find((message) => message.t === 'ping')).toEqual({
      t: 'ping',
      ts: expect.any(Number) as number,
    })
    // A tab the browser froze: it neither reads nor answers.
    client.ws.pause()
    await side.closed
    await until(() => running.gateway.stats().connections === 0)
  })

  it('cuts a worker that stops answering and tells the viewer (4503)', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker({ deaf: true })
    const running = await gatewayWith(store, worker, { timings: { pingMs: 40 } })
    const { client } = await watching(running, worker, ticket)

    expect(await client.closed).toEqual({
      code: browserStreamCloseCodes.unavailable,
      reason: 'unavailable',
    })
    expect(closedMessages(client)).toEqual([{ t: 'closed', reason: 'unavailable' }])
  })

  it('close() ends every stream with 4503 and takes no new one', async () => {
    const ticket = newTicket()
    const store = fakeStore({ [ticket]: viewerOf })
    const worker = await fakeWorker()
    const running = await gatewayWith(store, worker)
    const { client, side } = await watching(running, worker, ticket)

    running.gateway.close()
    expect((await client.closed).code).toBe(browserStreamCloseCodes.unavailable)
    await side.closed
    expect(await refusedWith(running.port, BROWSER_STREAM_PATH, APP_ORIGIN)).toBe(503)
  })
})
