import { Buffer } from 'node:buffer'
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'

import {
  browserStreamDefaults,
  browserStreamQuerySchema,
  FrameFlow,
  parseBrowserClientMessage,
  type BrowserCloseReason,
  type BrowserServerMessage,
  type BrowserSessionState,
  type BrowserStreamRefusal,
  type FrameFlowDrops,
  type FrameFlowOptions,
} from '@repo/domain'
import { bearerTokenMatches } from '@repo/observability'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

import { frameDropReasons, type BrowserWorkerMetrics } from '../metrics/worker-metrics.ts'
import type { EncodedFrame, SessionViewer, WorkerSession } from '../sessions/worker-session.ts'
import type { BrowserWorkerStore } from '../store/worker-store.ts'

const STREAM_PATH =
  /^\/v1\/sessions\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/stream$/
/** A message of the gateway is JSON text of at most 64 Ki characters: up to three bytes each. */
const MAX_PAYLOAD_BYTES = 192 * 1024
/** Never a frame to a page or a size: a pageId the worker never gives (they start at 1). */
const NOWHERE = Object.freeze({ pageId: 0, viewportVersion: 0 })

export interface BrowserStreamServerOptions {
  /** BROWSER_WORKER_TOKEN; never logged. */
  token: string
  sessions: { session(sessionId: string): WorkerSession | null }
  store: Pick<BrowserWorkerStore, 'viewerAllowed'>
  metrics: BrowserWorkerMetrics
  /** Delivery of frames to one viewer (Б13); the domain's defaults where not given. */
  flow: Partial<FrameFlowOptions>
  /** The worker pings each viewer this often; one that answered nothing since is cut (Б14). */
  pingMs?: number
  /** Messages of one viewer a second; past them it hears `busy` and they are dropped. */
  messagesPerSecond?: number
  now?: () => number
  warn(event: string, error?: unknown): void
}

/**
 * The stream of a session for the gateway (docs/plan/57-browser-tasks.md, Б12–Б17, §3.6):
 * `WS /v1/sessions/:id/stream?viewer=&user=` on the worker's HTTP server, behind its token. Each
 * connection is one viewer (a tab of the cabinet): it gets the state and the last frame at once,
 * then frames through its own FrameFlow, and its messages go to the session. Nothing a message
 * carries — input, an address, a frame — is ever logged.
 */
export class BrowserStreamServer {
  readonly #options: BrowserStreamServerOptions
  readonly #wss: WebSocketServer
  readonly #viewers = new Set<StreamViewer>()
  #closed = false

  constructor(options: BrowserStreamServerOptions) {
    this.#options = options
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    })
  }

  get viewers(): number {
    return this.#viewers.size
  }

  /** Takes the upgrades of the app's HTTP server; any other upgrade is refused. */
  attach(server: Server): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => undefined)
      void this.#upgrade(request, socket, head).catch((error: unknown) => {
        this.#options.warn('browser_stream_upgrade_failed', error)
        refuse(socket, 503)
      })
    })
  }

  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const { token, sessions, store } = this.#options
    if (this.#closed) return refuse(socket, 503)
    const url = new URL(request.url ?? '/', 'http://worker')
    const match = STREAM_PATH.exec(url.pathname)
    if (!match || request.method !== 'GET') return refuse(socket, 404)
    if (!bearerTokenMatches(request.headers.authorization, token)) return refuse(socket, 401)
    const query = streamQuery(url.searchParams)
    if (query === null) return refuse(socket, 400)
    const sessionId = (match[1] ?? '').toLowerCase()
    const session = sessions.session(sessionId)
    if (!session) return refuse(socket, 404)
    // The gateway authenticated the user; the worker checks the membership once more itself.
    if (!(await store.viewerAllowed({ sessionId, userId: query.user }))) return refuse(socket, 403)
    if (socket.destroyed) return
    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      const viewer = new StreamViewer(ws, query.viewer, query.user, session, this.#options, () =>
        this.#viewers.delete(viewer),
      )
      this.#viewers.add(viewer)
      if (!this.#closed && session.attach(viewer)) viewer.attached()
      // A viewer id already watching is another tab's: never taken over by a second connection.
      else viewer.end(session.live && !this.#closed ? 'forbidden' : 'unavailable')
    })
  }

  /** Every connection ends; the sessions said `closed` to theirs first when they ended. */
  close(): void {
    this.#closed = true
    for (const viewer of [...this.#viewers]) viewer.end('unavailable')
    this.#wss.close()
  }
}

/** `viewer` and `user`, each exactly once, nothing else. */
function streamQuery(params: URLSearchParams): { viewer: string; user: string } | null {
  const keys = [...params.keys()]
  if (keys.length !== 2 || new Set(keys).size !== 2) return null
  const parsed = browserStreamQuerySchema.safeParse(Object.fromEntries(params))
  return parsed.success
    ? { viewer: parsed.data.viewer.toLowerCase(), user: parsed.data.user.toLowerCase() }
    : null
}

/** An upgrade that is not taken: a status, no body, the socket closed. */
function refuse(socket: Duplex, status: number): void {
  if (socket.destroyed) return
  // Closed once the answer is out, as ws aborts a handshake.
  socket.once('finish', () => socket.destroy())
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
  )
}

type EndReason = BrowserCloseReason | 'unavailable' | 'forbidden'

/**
 * One viewer: its socket, its flow of frames (one newest waiting, a window of unacknowledged ones,
 * a rate, a ceiling of buffered bytes, Б13), its heartbeat (Б14) and its share of messages.
 */
class StreamViewer implements SessionViewer {
  readonly id: string
  readonly userId: string
  readonly #ws: WebSocket
  readonly #session: WorkerSession
  readonly #options: BrowserStreamServerOptions
  readonly #now: () => number
  readonly #flow: FrameFlow<EncodedFrame>
  readonly #onEnd: () => void
  #current: { pageId: number; viewportVersion: number } | null = null
  #timer: ReturnType<typeof setTimeout> | undefined
  readonly #heartbeat: ReturnType<typeof setInterval>
  #alive = true
  #ended = false
  /** The session took it: only then does its end let go of what it held. */
  #attached = false
  #counted: FrameFlowDrops = { replaced: 0, stale: 0 }
  #window = { start: 0, count: 0, refused: false }

  constructor(
    ws: WebSocket,
    id: string,
    userId: string,
    session: WorkerSession,
    options: BrowserStreamServerOptions,
    onEnd: () => void,
  ) {
    this.id = id
    this.userId = userId
    this.#ws = ws
    this.#session = session
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#flow = new FrameFlow<EncodedFrame>(options.flow)
    this.#onEnd = onEnd
    ws.on('error', () => undefined)
    ws.on('message', (data, isBinary) => this.#message(data, isBinary))
    ws.on('pong', () => {
      this.#alive = true
    })
    ws.on('close', () => this.#closed())
    this.#heartbeat = setInterval(
      () => this.#beat(),
      options.pingMs ?? browserStreamDefaults.pingMs,
    )
    this.#heartbeat.unref()
  }

  attached(): void {
    this.#attached = true
  }

  // --- what the session says -------------------------------------------------------------------

  state(state: BrowserSessionState): void {
    this.#current =
      state.pageId === null
        ? null
        : { pageId: state.pageId, viewportVersion: state.viewportVersion }
    this.#send({ t: 'state', ...state })
    this.#pump()
  }

  frame(frame: EncodedFrame): void {
    if (this.#ended) return
    this.#flow.offer(frame)
    this.#pump()
  }

  refused(reason: BrowserStreamRefusal): void {
    this.#send({ t: 'refused', reason })
  }

  closed(reason: BrowserCloseReason): void {
    this.end(reason)
  }

  /** Ends the connection, saying why first; a second call changes nothing. */
  end(reason: EndReason): void {
    if (this.#ended) return
    this.#send({ t: 'closed', reason })
    this.#finish()
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.close(1000)
    else this.#ws.terminate()
  }

  // --- what the gateway says -------------------------------------------------------------------

  #message(data: RawData, isBinary: boolean): void {
    this.#alive = true
    if (this.#ended) return
    const message = isBinary ? null : parseBrowserClientMessage(textOf(data))
    // Only an acknowledgement frees a place in the window (Б13): one that does is never dropped
    // for the rate, or a fast pointer would stop the frames for good. The gateway lets through no
    // more of them than frames it was sent.
    if (message?.t === 'ack' && this.#flow.ack(message.frameSeq)) return this.#pump()
    if (!this.#admitted()) return
    // `hello` is the gateway's own; a frame comes from the worker only.
    if (message === null || message.t === 'hello') return this.refused('bad_message')
    // An acknowledgement of nothing on the way, or a pong: nothing to do.
    if (message.t === 'ack' || message.t === 'pong') return
    this.#session.message(this, message)
  }

  /** At most `messagesPerSecond` a second; the first one over hears `busy`. */
  #admitted(): boolean {
    const now = this.#now()
    if (now - this.#window.start >= 1_000) this.#window = { start: now, count: 0, refused: false }
    this.#window.count += 1
    if (this.#window.count <= (this.#options.messagesPerSecond ?? 200)) return true
    if (!this.#window.refused) {
      this.#window.refused = true
      this.refused('busy')
    }
    return false
  }

  // --- frames ----------------------------------------------------------------------------------

  /** Sends what the flow lets go now, and looks again when it says. */
  #pump(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#ended || this.#ws.readyState !== WebSocket.OPEN) return
    for (;;) {
      const decision = this.#flow.next(
        this.#now(),
        this.#ws.bufferedAmount,
        this.#current ?? NOWHERE,
      )
      if (decision.kind === 'send') {
        this.#ws.send(decision.frame.data, { binary: true })
        this.#options.metrics.frameSent()
        continue
      }
      if (decision.kind === 'wait') {
        this.#timer = setTimeout(() => this.#pump(), decision.ms)
        this.#timer.unref()
      }
      break
    }
    this.#countDrops()
  }

  #countDrops(): void {
    const drops = this.#flow.drops
    for (const reason of frameDropReasons)
      this.#options.metrics.framesDropped(reason, drops[reason] - this.#counted[reason])
    this.#counted = drops
  }

  // --- liveness --------------------------------------------------------------------------------

  /** Every `pingMs`: a WebSocket ping and a `ping` message; silence since the last one cuts it. */
  #beat(): void {
    if (this.#ended) return
    if (!this.#alive) {
      this.#finish()
      this.#ws.terminate()
      return
    }
    this.#alive = false
    if (this.#ws.readyState !== WebSocket.OPEN) return
    this.#ws.ping()
    this.#send({ t: 'ping', ts: this.#now() })
  }

  #send(message: BrowserServerMessage): void {
    if (this.#ended || this.#ws.readyState !== WebSocket.OPEN) return
    this.#ws.send(JSON.stringify(message))
  }

  #closed(): void {
    this.#finish()
  }

  #finish(): void {
    if (this.#ended) return
    this.#ended = true
    clearTimeout(this.#timer)
    clearInterval(this.#heartbeat)
    this.#countDrops()
    // The pause holds; the keys and buttons this viewer held are let go (Б17).
    if (this.#attached) this.#session.detach(this.id)
    this.#onEnd()
  }
}

function textOf(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : Buffer.from(data).toString('utf8')
}
