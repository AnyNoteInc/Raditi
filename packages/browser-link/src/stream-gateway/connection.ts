import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import {
  decodeBrowserFrame,
  parseBrowserClientMessage,
  parseBrowserServerMessage,
  type BrowserClientMessage,
  type BrowserServerMessage,
  type BrowserStreamEndReason,
  type BrowserStreamRefusal,
} from '@repo/domain'
import { WebSocket, type RawData } from 'ws'

import { browserStreamUrl } from '../worker-url.ts'
import { browserStreamCloseCode } from './close-codes.ts'
import type {
  BrowserStreamGatewayLimits,
  BrowserStreamStore,
  BrowserStreamTimings,
  BrowserStreamViewer,
} from './settings.ts'

/** What one connection needs of its gateway. */
export interface StreamConnectionContext {
  store: BrowserStreamStore
  worker: { baseUrl: string; token: string }
  timings: BrowserStreamTimings
  limits: BrowserStreamGatewayLimits
  /** An event name and the name of an error: never a ticket, an input, a frame or an address. */
  warn(event: string, error?: unknown): void
  frameRelayed(): void
  frameDropped(): void
  ended(connection: StreamConnection): void
}

/**
 * `hello` — the socket waits for its ticket; `opening` — the ticket is spent and the stream to
 * the worker opens, messages of the viewer wait; `relaying` — both ways; `ended` — both closed.
 */
type Phase = 'hello' | 'opening' | 'relaying' | 'ended'

interface EndHow {
  /** Tell the viewer why in a `closed` message first (default). */
  notify?: boolean
  /** This side stopped answering: it is cut, not closed. */
  dead?: 'client' | 'worker'
}

/** How often a frame kept for a full socket looks whether the socket has drained. */
const DRAIN_CHECK_MS = 50

const textOf = (data: RawData): string => bytesOf(data).toString('utf8')

function bytesOf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
}

/**
 * One viewer (a tab of the cabinet) and its stream (docs/plan/57-browser-tasks.md, Б12–Б14,
 * §3.6). The first message spends a one-time ticket; the gateway then opens the worker's stream
 * of that session for a new viewer id, tells the viewer that id (`viewer`) and relays: messages
 * of the viewer only as the domain's
 * client messages, never a binary one; frames and messages of the worker only for this session.
 * Either side ending ends both. Nothing a message carries is ever logged.
 */
export class StreamConnection {
  readonly #client: WebSocket
  readonly #context: StreamConnectionContext
  #phase: Phase = 'hello'
  #viewer: BrowserStreamViewer | undefined
  /** The viewer id of this connection at the worker; the viewer hears it once relaying starts. */
  #viewerId = ''
  /** The session's id as frame headers spell it (lower-case). */
  #sessionId = ''
  #worker: WebSocket | undefined
  /** Messages of the viewer while the worker's stream opens, as JSON text. */
  #pending: string[] = []
  #clientAlive = true
  #workerAlive = true
  #rechecking = false
  #warnedWorker = false
  /** The viewer's messages in the current second, and whether it was told `busy` in it. */
  #window = { start: 0, count: 0, refused: false }
  /** Frames relayed that an acknowledgement passed outside the rate has not yet answered. */
  #acksOwed = 0
  /** The newest frame that met a full socket: it goes once the socket drains (Б13). */
  #held: Buffer | null = null
  #drain: ReturnType<typeof setTimeout> | undefined
  /** Until `hello` (4401), then until the worker's stream is open (4503). */
  #deadline: ReturnType<typeof setTimeout>
  readonly #heartbeat: ReturnType<typeof setInterval>
  #recheck: ReturnType<typeof setInterval> | undefined

  constructor(client: WebSocket, context: StreamConnectionContext) {
    this.#client = client
    this.#context = context
    client.on('error', () => undefined)
    client.on('message', (data, isBinary) => this.#fromClient(data, isBinary))
    client.on('pong', () => {
      this.#clientAlive = true
    })
    client.on('close', () => this.#end('unavailable', { notify: false }))
    this.#deadline = setTimeout(() => this.#end('unauthorized'), context.timings.helloMs)
    this.#deadline.unref()
    this.#heartbeat = setInterval(() => this.#beat(), context.timings.pingMs)
    this.#heartbeat.unref()
  }

  /** Ends the stream for both sides; a second call changes nothing. */
  end(reason: BrowserStreamEndReason): void {
    this.#end(reason)
  }

  // -------------------------------------------------------------------------------------------
  // The viewer
  // -------------------------------------------------------------------------------------------

  #fromClient(data: RawData, isBinary: boolean): void {
    this.#clientAlive = true
    if (this.#phase === 'ended') return
    if (this.#phase === 'hello') {
      clearTimeout(this.#deadline)
      const hello = isBinary ? null : parseBrowserClientMessage(textOf(data))
      if (hello?.t !== 'hello') {
        this.#end('unauthorized')
        return
      }
      this.#phase = 'opening'
      // A database or a worker that hangs does not keep a viewer waiting for ever.
      this.#deadline = setTimeout(() => this.#end('unavailable'), this.#context.timings.openMs)
      this.#deadline.unref()
      void this.#authorize(hello.ticket)
      return
    }
    // A frame comes from the worker only; a viewer has nothing binary to say.
    const message = isBinary ? null : parseBrowserClientMessage(textOf(data))
    if (message === null || message.t === 'hello') {
      this.#refuse('bad_message')
      return
    }
    // Only an acknowledgement frees a place in the worker's window (Б13): one per frame relayed
    // passes outside the rate, or a fast pointer would stop the frames for good.
    if (message.t === 'ack' && this.#acksOwed > 0) {
      this.#acksOwed -= 1
      this.#toWorker(JSON.stringify(message))
      return
    }
    if (!this.#admitted()) return
    const text = JSON.stringify(message)
    if (this.#phase === 'relaying') this.#toWorker(text)
    else if (this.#pending.length < this.#context.limits.pendingMessages) this.#pending.push(text)
    else this.#refuse('busy')
  }

  /** At most `clientMessagesPerSecond` messages a second; the first one over hears `busy`. */
  #admitted(): boolean {
    const now = Date.now()
    if (now - this.#window.start >= 1_000) this.#window = { start: now, count: 0, refused: false }
    this.#window.count += 1
    if (this.#window.count <= this.#context.limits.clientMessagesPerSecond) return true
    if (!this.#window.refused) {
      this.#window.refused = true
      this.#refuse('busy')
    }
    return false
  }

  async #authorize(ticket: string): Promise<void> {
    const { store } = this.#context
    let viewer: BrowserStreamViewer | null
    let allowed = false
    try {
      // Spent here whatever comes next: a ticket opens one connection at most.
      viewer = await store.consumeTicket(ticket)
      if (viewer !== null && this.#phase === 'opening') allowed = await store.viewerAllowed(viewer)
    } catch (error) {
      this.#context.warn('browser_stream_ticket_check_failed', error)
      this.#end('unavailable')
      return
    }
    if (this.#phase !== 'opening') return
    if (viewer === null) {
      this.#end('unauthorized')
      return
    }
    if (!allowed) {
      this.#end('forbidden')
      return
    }
    this.#viewer = viewer
    this.#sessionId = viewer.sessionId.toLowerCase()
    this.#openWorker(viewer)
  }

  #toClient(text: string): void {
    const client = this.#client
    if (client.readyState !== WebSocket.OPEN) return
    // Frames stop at a far lower mark; a viewer this far behind reads nothing at all.
    if (client.bufferedAmount > this.#context.limits.clientStalledBytes) {
      this.#end('unavailable', { dead: 'client' })
      return
    }
    client.send(text)
  }

  #refuse(reason: BrowserStreamRefusal): void {
    this.#toClient(JSON.stringify({ t: 'refused', reason } satisfies BrowserServerMessage))
  }

  // -------------------------------------------------------------------------------------------
  // The worker
  // -------------------------------------------------------------------------------------------

  #openWorker(viewer: BrowserStreamViewer): void {
    const { worker: target, timings, limits } = this.#context
    let url: string
    // A new viewer id for every connection: the worker tells tabs of the cabinet apart by it.
    this.#viewerId = randomUUID()
    try {
      url = browserStreamUrl(target.baseUrl, { ...viewer, viewerId: this.#viewerId })
    } catch (error) {
      this.#context.warn('browser_stream_worker_address_refused', error)
      this.#end('unavailable')
      return
    }
    const worker = new WebSocket(url, {
      headers: { authorization: `Bearer ${target.token}` },
      handshakeTimeout: timings.openMs,
      maxPayload: limits.workerMessageBytes,
      followRedirects: false,
      perMessageDeflate: false,
    })
    this.#worker = worker
    worker.on('error', (error) => {
      if (this.#phase === 'opening') this.#context.warn('browser_stream_worker_unavailable', error)
    })
    worker.on('open', () => this.#relaying())
    worker.on('message', (data, isBinary) => this.#fromWorker(data, isBinary))
    worker.on('pong', () => {
      this.#workerAlive = true
    })
    // A worker that goes without its own `closed` is gone as far as the viewer can tell.
    worker.on('close', () => this.#end('unavailable'))
  }

  #relaying(): void {
    if (this.#phase !== 'opening') return
    clearTimeout(this.#deadline)
    this.#phase = 'relaying'
    this.#workerAlive = true
    // Before anything of the worker: the viewer compares `state.holder` with it (Б15).
    this.#toClient(
      JSON.stringify({ t: 'viewer', viewer: this.#viewerId } satisfies BrowserServerMessage),
    )
    for (const text of this.#pending.splice(0)) this.#toWorker(text)
    this.#recheck = setInterval(() => this.#recheckViewer(), this.#context.timings.recheckMs)
    this.#recheck.unref()
  }

  #fromWorker(data: RawData, isBinary: boolean): void {
    this.#workerAlive = true
    if (this.#phase !== 'relaying') return
    if (isBinary) {
      const bytes = bytesOf(data)
      const frame = decodeBrowserFrame(bytes)
      if (frame?.header.sessionId !== this.#sessionId) {
        this.#warnWorker()
        return
      }
      if (this.#client.readyState !== WebSocket.OPEN) return
      // A slow viewer gets the freshest frame, never a queue (Б13). A frame that meets a full
      // socket is acknowledged to the worker at once — it takes no room in the socket, so it holds
      // no place in the window — and kept, the newest only, until the socket drains: the last
      // picture of a burst always arrives, and the window alone bounds what piles up here.
      if (this.#client.bufferedAmount > this.#context.limits.clientBufferedBytes) {
        this.#hold(bytes)
        const ack: BrowserClientMessage = { t: 'ack', frameSeq: frame.header.frameSeq }
        this.#toWorker(JSON.stringify(ack))
        return
      }
      this.#dropHeld()
      this.#relayFrame(bytes)
      return
    }
    const message = parseBrowserServerMessage(textOf(data))
    if (
      message === null ||
      // The viewer id is the gateway's to tell: the worker never names one.
      message.t === 'viewer' ||
      (message.t === 'state' && message.session !== this.#sessionId)
    ) {
      this.#warnWorker()
      return
    }
    this.#toClient(JSON.stringify(message))
    // The session ended: the viewer has heard why, both sides close now.
    if (message.t === 'closed') this.#end(message.reason, { notify: false })
  }

  #relayFrame(bytes: Buffer): void {
    this.#client.send(bytes, { binary: true })
    this.#acksOwed += 1
    this.#context.frameRelayed()
  }

  /** Keeps the newest frame for a full socket; the one it replaces never goes. */
  #hold(bytes: Buffer): void {
    if (this.#held !== null) this.#context.frameDropped()
    this.#held = bytes
    if (this.#drain === undefined) this.#awaitDrain()
  }

  /** Looks every `DRAIN_CHECK_MS` whether the socket drained, then sends the kept frame. */
  #awaitDrain(): void {
    this.#drain = setTimeout(() => {
      this.#drain = undefined
      const held = this.#held
      if (held === null || this.#phase !== 'relaying') return
      if (this.#client.readyState !== WebSocket.OPEN) return
      if (this.#client.bufferedAmount > this.#context.limits.clientBufferedBytes) {
        this.#awaitDrain()
        return
      }
      this.#held = null
      this.#relayFrame(held)
    }, DRAIN_CHECK_MS)
    this.#drain.unref()
  }

  /** A newer frame went, or the stream ended: the kept one is older and never goes. */
  #dropHeld(): void {
    clearTimeout(this.#drain)
    this.#drain = undefined
    if (this.#held === null) return
    this.#held = null
    this.#context.frameDropped()
  }

  #toWorker(text: string): void {
    const worker = this.#worker
    if (worker?.readyState !== WebSocket.OPEN) return
    // The worker sits on the private network and reads at once; a backlog means it is stuck.
    if (worker.bufferedAmount > this.#context.limits.workerStalledBytes) {
      this.#end('unavailable', { dead: 'worker' })
      return
    }
    worker.send(text)
  }

  /** A message of the worker that is not the contract's, once per connection. */
  #warnWorker(): void {
    if (this.#warnedWorker) return
    this.#warnedWorker = true
    this.#context.warn('browser_stream_worker_message_dropped')
  }

  // -------------------------------------------------------------------------------------------
  // Liveness and rechecks
  // -------------------------------------------------------------------------------------------

  /** Every `pingMs` (Б14): a side that answered nothing since the last beat is cut. */
  #beat(): void {
    if (this.#phase === 'ended') return
    if (!this.#clientAlive) {
      this.#end('unavailable', { dead: 'client' })
      return
    }
    const worker = this.#worker
    if (worker?.readyState === WebSocket.OPEN && !this.#workerAlive) {
      this.#end('unavailable', { dead: 'worker' })
      return
    }
    this.#clientAlive = false
    if (this.#client.readyState === WebSocket.OPEN) this.#client.ping()
    if (worker?.readyState === WebSocket.OPEN) {
      this.#workerAlive = false
      worker.ping()
    }
    if (this.#phase === 'relaying')
      this.#toClient(JSON.stringify({ t: 'ping', ts: Date.now() } satisfies BrowserServerMessage))
  }

  /** Every `recheckMs` (Б12): the user still may watch the session, or the stream ends. */
  #recheckViewer(): void {
    const viewer = this.#viewer
    if (this.#rechecking || this.#phase !== 'relaying' || viewer === undefined) return
    this.#rechecking = true
    this.#context.store.viewerAllowed(viewer).then(
      (allowed) => {
        this.#rechecking = false
        if (!allowed) this.#end('forbidden')
      },
      (error: unknown) => {
        this.#rechecking = false
        this.#context.warn('browser_stream_recheck_failed', error)
        this.#end('unavailable')
      },
    )
  }

  #end(reason: BrowserStreamEndReason, how: EndHow = {}): void {
    if (this.#phase === 'ended') return
    this.#phase = 'ended'
    clearTimeout(this.#deadline)
    clearInterval(this.#heartbeat)
    clearInterval(this.#recheck)
    this.#dropHeld()
    this.#pending = []
    const client = this.#client
    if (how.dead === 'client') client.terminate()
    else if (client.readyState === WebSocket.OPEN) {
      if (how.notify !== false)
        client.send(JSON.stringify({ t: 'closed', reason } satisfies BrowserServerMessage))
      client.close(browserStreamCloseCode(reason), reason)
    }
    const worker = this.#worker
    if (worker !== undefined) {
      if (how.dead === 'worker' || worker.readyState === WebSocket.CONNECTING) worker.terminate()
      else if (worker.readyState === WebSocket.OPEN) worker.close(1000)
    }
    this.#context.ended(this)
  }
}
