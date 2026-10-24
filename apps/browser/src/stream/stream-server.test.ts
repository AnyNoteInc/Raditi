import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  decodeBrowserFrame,
  parseBrowserServerMessage,
  type BrowserClientMessage,
  type BrowserServerMessage,
} from '@repo/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { BrowserStreamServer } from './stream-server.ts'
import { countingMetrics, TEST_WORKER_TOKEN } from '../testing/fakes.ts'
import { sessionHarness } from '../testing/harness.ts'

interface Received {
  messages: BrowserServerMessage[]
  frames: { frameSeq: number; pageId: number; sessionId: string }[]
  /** Text and binary in the order they came: `state`, `frame:<seq>`, … */
  order: string[]
  closed: Promise<number>
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const until = async (check: () => boolean, ms = 2_000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function stand(
  options: { pingMs?: number; window?: number; messagesPerSecond?: number } = {},
) {
  const harness = sessionHarness()
  const { metrics, counts } = countingMetrics()
  const stream = new BrowserStreamServer({
    token: TEST_WORKER_TOKEN,
    sessions: harness.manager,
    store: harness.store,
    metrics,
    flow: { maxFps: 30, window: options.window ?? 2 },
    ...(options.pingMs ? { pingMs: options.pingMs } : {}),
    ...(options.messagesPerSecond ? { messagesPerSecond: options.messagesPerSecond } : {}),
    warn: () => undefined,
  })
  const server: Server = createServer((_request, response) => response.writeHead(404).end())
  stream.attach(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  cleanups.push(async () => {
    await harness.manager.shutdown()
    stream.close()
    await new Promise((resolve) => server.close(resolve))
  })
  const opened = await harness.ensured()
  const user = randomUUID()
  harness.store.members.add(`${opened.row.id}:${user}`)

  const url = (sessionId: string, viewer: string, extra = '') =>
    `ws://127.0.0.1:${port}/v1/sessions/${sessionId}/stream?viewer=${viewer}&user=${user}${extra}`

  /** A connection of the gateway; the status of a refused upgrade, or what it hears. */
  const connect = (
    target: { sessionId?: string; viewer?: string; token?: string; extra?: string } = {},
    wsOptions: { autoPong?: boolean } = {},
  ) =>
    new Promise<{ ws: WebSocket; got: Received } | { status: number }>((resolve) => {
      const ws = new WebSocket(
        url(target.sessionId ?? opened.row.id, target.viewer ?? randomUUID(), target.extra),
        { headers: { authorization: `Bearer ${target.token ?? TEST_WORKER_TOKEN}` }, ...wsOptions },
      )
      const got: Received = {
        messages: [],
        frames: [],
        order: [],
        closed: new Promise((done) => ws.on('close', (code) => done(code))),
      }
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const frame = decodeBrowserFrame(new Uint8Array(data as Buffer))
          if (!frame) throw new Error('not a frame')
          got.frames.push(frame.header)
          got.order.push(`frame:${frame.header.frameSeq}`)
          return
        }
        const message = parseBrowserServerMessage(String(data))
        if (!message) throw new Error('not a message of the contract')
        got.messages.push(message)
        got.order.push(message.t)
      })
      ws.on('unexpected-response', (_request, response) =>
        resolve({ status: response.statusCode ?? 0 }),
      )
      ws.on('open', () => {
        cleanups.push(() => ws.terminate())
        resolve({ ws, got })
      })
    })

  const open = async (target: Parameters<typeof connect>[0] = {}, wsOptions = {}) => {
    const result = await connect(target, wsOptions)
    if ('status' in result) throw new Error(`refused ${result.status}`)
    return result
  }
  const send = (ws: WebSocket, message: BrowserClientMessage) => ws.send(JSON.stringify(message))
  return { ...harness, ...opened, user, stream, counts, connect, open, send }
}

describe('the stream of a session', () => {
  it('refuses an upgrade without the token, of another path, query, session or user', async () => {
    const { connect, row, store } = await stand()
    expect(await connect({ token: 'wrong-token-of-the-gateway-0123456789' })).toEqual({
      status: 401,
    })
    expect(await connect({ extra: '&debug=1' })).toEqual({ status: 400 })
    expect(await connect({ viewer: 'not-a-uuid' })).toEqual({ status: 400 })
    expect(await connect({ sessionId: randomUUID() })).toEqual({ status: 404 })
    // A user who is not a member of the task's workspace (the worker checks it once more).
    store.members.clear()
    expect(await connect({ sessionId: row.id })).toEqual({ status: 403 })
  })

  it('gives a new viewer the state, then the last frame at once', async () => {
    const { open, session, browser, row } = await stand()
    // Someone watched before: there is a last frame.
    const earlier = await open()
    await until(() => browser.streaming)
    await browser.frame()
    await until(() => earlier.got.frames.length === 1)
    const { got } = await open()
    await until(() => got.order.length >= 2)
    expect(got.order.slice(0, 2)).toEqual(['state', 'frame:1'])
    expect(got.messages[0]).toMatchObject({
      t: 'state',
      session: row.id,
      status: 'ready',
      controller: 'agent',
      pageId: 1,
    })
    expect(got.frames[0]).toMatchObject({ frameSeq: 1, pageId: 1, sessionId: row.id })
    expect(session.viewerCount).toBe(2)
  })

  it('keeps at most the window of frames unacknowledged, one newest waiting, and never a backlog', async () => {
    const { open, browser, send, counts } = await stand({ window: 2 })
    const { ws, got } = await open()
    await until(() => browser.streaming)
    // Chromium paints 20 frames; the viewer acknowledges none of them.
    for (let index = 0; index < 20; index++) await browser.frame()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(got.frames.map((frame) => frame.frameSeq)).toEqual([1, 2])
    expect(counts.dropped.replaced).toBeGreaterThanOrEqual(17)
    // An acknowledgement frees the window: the newest frame goes, never an old one.
    send(ws, { t: 'ack', frameSeq: 2 })
    await until(() => got.frames.length === 3)
    expect(got.frames[2]?.frameSeq).toBe(20)
    expect(counts.sent).toBe(3)
  })

  it('keeps a frame on the way until it is acknowledged, then sends the newest one', async () => {
    const { open, browser, send, counts } = await stand({ window: 1 })
    const { ws, got } = await open()
    await until(() => browser.streaming)
    for (let index = 0; index < 3; index++) await browser.frame()
    // A slow link, not a lost frame: no clock frees the window.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(got.frames.map((frame) => frame.frameSeq)).toEqual([1])
    send(ws, { t: 'ack', frameSeq: 1 })
    await until(() => got.frames.length === 2)
    expect(got.frames[1]?.frameSeq).toBe(3)
    expect(counts.dropped.replaced).toBe(1)
  })

  it('takes an acknowledgement that frees the window past the rate of messages', async () => {
    const { open, browser, send } = await stand({ window: 1, messagesPerSecond: 2 })
    const { ws, got } = await open()
    await until(() => browser.streaming)
    await browser.frame()
    await until(() => got.frames.length === 1)
    // A fast pointer spends the second's share of messages; the next one hears `busy`.
    for (let index = 0; index < 3; index++) send(ws, { t: 'pong', ts: index })
    await until(() => got.messages.some((message) => message.t === 'refused'))
    await browser.frame()
    // The acknowledgement still frees the window: frames never stop for good.
    send(ws, { t: 'ack', frameSeq: 1 })
    await until(() => got.frames.length === 2)
    expect(got.frames.map((frame) => frame.frameSeq)).toEqual([1, 2])
    expect(got.messages.filter((message) => message.t === 'refused')).toEqual([
      { t: 'refused', reason: 'busy' },
    ])
  })

  it('pings the gateway and cuts a connection that stops answering', async () => {
    const { open, session } = await stand({ pingMs: 40 })
    const live = await open()
    await until(() => live.got.messages.some((message) => message.t === 'ping'))
    // A connection that answers no WebSocket ping and sends nothing is dead after two beats.
    const dead = await open({}, { autoPong: false })
    expect(session.viewerCount).toBe(2)
    expect(await dead.got.closed).toBe(1006)
    await until(() => session.viewerCount === 1)
    expect(live.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('takes the input of the holder only, for the epoch, page and size it saw', async () => {
    const { open, send, browser } = await stand()
    const holder = await open()
    const other = await open()
    send(holder.ws, { t: 'take' })
    await until(() =>
      holder.got.messages.some((message) => message.t === 'state' && message.controller === 'user'),
    )
    const input = (controlEpoch: number): BrowserClientMessage => ({
      t: 'input',
      pageId: 1,
      controlEpoch,
      viewportVersion: 1,
      event: { kind: 'mouse', type: 'down', x: 640, y: 400, button: 'left', clickCount: 1 },
    })
    send(holder.ws, input(1))
    send(other.ws, input(1))
    send(holder.ws, input(0))
    send(holder.ws, { t: 'navigate', url: 'https://evil.example.org/' })
    // Not a message of the contract, and the gateway's own `hello`.
    holder.ws.send('{"t":"input","event":"rm -rf"}')
    send(holder.ws, { t: 'hello', ticket: 'a'.repeat(43) })
    const refusals = (got: { messages: BrowserServerMessage[] }) =>
      got.messages.flatMap((message) => (message.t === 'refused' ? [message.reason] : [])).sort()
    await until(() => refusals(holder.got).length === 4)
    expect(browser.inputs).toEqual([
      { kind: 'mouse', type: 'down', x: 640, y: 400, button: 'left', clickCount: 1 },
    ])
    // A message that does not parse is refused at once, the rest in the order of the page.
    expect(refusals(holder.got)).toEqual([
      'address_denied',
      'bad_message',
      'bad_message',
      'stale_epoch',
    ])
    await until(() => refusals(other.got).length === 1)
    expect(refusals(other.got)).toEqual(['not_holder'])
  })

  it('refuses a second connection of a viewer already watching', async () => {
    const { open, session } = await stand()
    const viewer = randomUUID()
    const first = await open({ viewer })
    const second = await open({ viewer })
    await second.got.closed
    expect(second.got.messages).toEqual([{ t: 'closed', reason: 'forbidden' }])
    expect(first.ws.readyState).toBe(WebSocket.OPEN)
    expect(session.viewerCount).toBe(1)
  })

  it('tells why when the session ends, and stops the screencast when nobody watches', async () => {
    const { open, manager, row, browser } = await stand()
    const one = await open()
    await until(() => browser.streaming)
    one.ws.close()
    await until(() => !browser.streaming)
    const two = await open()
    await manager.close(row.id, 'task_done')
    expect(await two.got.closed).toBe(1000)
    expect(two.got.messages.at(-1)).toEqual({ t: 'closed', reason: 'task_done' })
  })
})
