import {
  BROWSER_FRAME_HEADER_BYTES,
  decodeBrowserFrame,
  type BrowserFrame,
} from '@repo/domain/browser/stream-codec'
import {
  browserStreamCloseCode,
  browserStreamCloseCodes,
  parseBrowserServerMessage,
  type BrowserClientMessage,
  type BrowserServerMessage,
  type BrowserStreamEndReason,
  type BrowserStreamRefusal,
} from '@repo/domain/browser/stream-messages'

import { StreamStats, STREAM_STATS_PERIOD_MS } from './stream-stats'

// The cabinet's end of the stream of a task's browser (docs/plan/57-browser-tasks.md, §3.6,
// Б12–Б14): a one-time ticket, `hello` as the first message, frames drawn and acknowledged, pings
// answered, a new ticket and a new connection when the stream goes silent or breaks. No React
// here: the hook drives it, the tests drive it with a fake socket and fake timers.

/** What the gateway says about the browser: the `state` message without its type. */
export type BrowserState = Omit<Extract<BrowserServerMessage, { t: 'state' }>, 't'>

/** How the stream stands for this tab. */
export type StreamConnection =
  /** Not started, or stopped. */
  | 'idle'
  | 'connecting'
  /** The state arrived: frames and input go. */
  | 'open'
  /** It was open and broke; a new ticket is on its way. */
  | 'reconnecting'
  /** It cannot be shown: a broken address or protocol; «Повторить» starts again. */
  | 'failed'
  /** The session ended, or this user may not watch it: nothing to reconnect to. */
  | 'ended'

export interface StreamTicket {
  url: string
  ticket: string
  sessionId: string
}

/** The part of a WebSocket the client uses: a fake one in the tests. */
export interface StreamSocket {
  binaryType: string
  send(data: string): void
  close(code?: number): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export interface StreamTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface StreamEvents {
  connection(connection: StreamConnection, reason: BrowserStreamEndReason | null): void
  state(state: BrowserState): void
  viewer(viewer: string | null): void
  refused(reason: BrowserStreamRefusal): void
}

/** An input message as the panel makes it; the client numbers it (ТР7). */
export type BrowserInputMessage = Omit<Extract<BrowserClientMessage, { t: 'input' }>, 'seq'>

/** Window pixels the picture is moved by: the scroll sent and not yet in a drawn frame. */
export interface PictureShift {
  dx: number
  dy: number
}

/** A scroll the picture shows ahead of the frames for at most this long (ТР7). */
export const PREDICTION_MAX_MS = 1_000
/** From an input to its frame, longer than this is no sample: the page did not move for it. */
const INPUT_SAMPLE_MAX_MS = 3_000
/** Inputs remembered until a frame shows them. */
const PENDING_INPUTS = 512

export interface BrowserStreamOptions {
  /** A fresh one-time ticket (`browser.streamTicket`): one per connection. */
  ticket: () => Promise<StreamTicket>
  /** `BROWSER_STREAM_PUBLIC_URL` of the cabinet: the ticket's address must be exactly it. */
  streamUrl: string
  /** Draws a frame; resolves when it is on the screen (false — it was not drawn). */
  draw: (frame: BrowserFrame) => Promise<boolean>
  events: StreamEvents
  /** A ticket refusal that asking again will not change: the session is closed or not ours. */
  isGone: (error: unknown) => boolean
  createSocket?: (url: string) => StreamSocket
  timers?: StreamTimers
  /**
   * The viewer an earlier stream of this tab held the control under (Б17): taken back on the
   * first state if it still holds it — hiding the panel and showing it again keeps the control.
   */
  heldBy?: string | null
  /**
   * The picture is to be moved by `shift` window pixels of `viewport` (ТР7): the scroll this tab
   * sent that the drawn frame does not show yet. Called before a frame is drawn and whenever it
   * changes; `redraw` false — for the frame about to be drawn, which shows it.
   */
  shift?: (
    shift: PictureShift,
    viewport: { width: number; height: number },
    redraw: boolean,
  ) => void
  /** This tab's clock in milliseconds; `performance.now()`. */
  now?: () => number
  /** The main pointer of this device is a finger: told to the worker with the numbers (ТР3). */
  touch?: boolean
}

/** Silence this long from the gateway and the stream is opened anew (Б14). */
export const STREAM_SILENCE_MS = 25_000
/** The pauses before a new connection: doubled after each failed one, up to 10 s. */
export const STREAM_BACKOFF = Object.freeze({ firstMs: 500, maxMs: 10_000 })

const realTimers: StreamTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * The ticket's address is the configured one exactly: the same scheme (`ws:` or `wss:`), host,
 * port and path, and nothing a browser would send elsewhere. Anything else is never opened.
 */
export function sameStreamUrl(url: string, configured: string): boolean {
  if (!URL.canParse(url) || !URL.canParse(configured)) return false
  const given = new URL(url)
  const wanted = new URL(configured)
  return (
    (given.protocol === 'wss:' || given.protocol === 'ws:') &&
    given.protocol === wanted.protocol &&
    given.host === wanted.host &&
    given.pathname === wanted.pathname &&
    given.search === '' &&
    given.hash === '' &&
    given.username === '' &&
    given.password === ''
  )
}

/** The pause before the n-th new connection in a row (from 0). */
export const backoffMs = (attempt: number): number =>
  Math.min(STREAM_BACKOFF.maxMs, STREAM_BACKOFF.firstMs * 2 ** Math.max(0, attempt))

export class BrowserStreamClient {
  readonly #options: BrowserStreamOptions
  readonly #timers: StreamTimers
  #running = false
  /** Moves on with every connection: answers of an older one are ignored. */
  #generation = 0
  #socket: StreamSocket | null = null
  #connection: StreamConnection = 'idle'
  #sessionId: string | null = null
  #state: BrowserState | null = null
  #viewer: string | null = null
  /** The viewer of the connection before this one, while it held the control. */
  #heldBy: string | null = null
  #endReason: BrowserStreamEndReason | null = null
  #attempt = 0
  #opened = false
  #silence: unknown = null
  #retry: unknown = null
  #drawing = false
  #waiting: BrowserFrame | null = null
  #pending: 'take' | 'release' | null = null
  /** What this tab measured of the stream (docs/plan/85-browser-stream-mobile.md, ТР3). */
  readonly stats = new StreamStats()
  readonly #now: () => number
  #statsTimer: unknown = null
  /** This connection's numbers of input, the ones no frame shows yet, and the frames that do. */
  #inputSeq = 0
  #inputs: { seq: number; at: number; dx: number; dy: number }[] = []
  #marks: { frameSeq: number; inputSeq: number }[] = []
  #shift: PictureShift = { dx: 0, dy: 0 }
  #predictionTimer: unknown = null

  constructor(options: BrowserStreamOptions) {
    this.#options = options
    this.#timers = options.timers ?? realTimers
    this.#heldBy = options.heldBy ?? null
    this.#now = options.now ?? (() => performance.now())
  }

  get connection(): StreamConnection {
    return this.#connection
  }

  get state(): BrowserState | null {
    return this.#state
  }

  get viewer(): string | null {
    return this.#viewer
  }

  /**
   * The viewer of this tab that holds the control, or held it before a break or `stop()`: for the
   * next stream of the tab.
   */
  get heldBy(): string | null {
    return this.holding ? this.#viewer : this.#heldBy
  }

  /** This tab drives the browser: the client controls it through this very connection. */
  get holding(): boolean {
    return (
      this.#state !== null &&
      this.#viewer !== null &&
      this.#state.controller === 'user' &&
      this.#state.holder === this.#viewer
    )
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    void this.#connect()
  }

  stop(): void {
    this.#running = false
    this.#generation += 1
    this.#clearTimers()
    this.#drop()
    this.#set('idle')
  }

  /** «Повторить»: a stream that failed or ended is opened anew, the pauses forgotten. */
  retry(): void {
    this.stop()
    this.#attempt = 0
    this.#endReason = null
    this.start()
  }

  /** «Взять управление»: sent at once when the stream is open, else as soon as it is. */
  take(): void {
    if (!this.send({ t: 'take' })) this.#pending = 'take'
    else this.#pending = null
  }

  /** «Продолжить работу агента» while a turn runs. */
  release(): void {
    if (!this.send({ t: 'release' })) this.#pending = 'release'
    else this.#pending = null
  }

  /**
   * An input to the page, numbered for this connection (ТР7): a scroll moves the picture at once,
   * until a frame shows it. False — the stream is not open, nothing was sent.
   */
  input(message: BrowserInputMessage): boolean {
    if (this.#socket === null || this.#connection !== 'open') return false
    const seq = (this.#inputSeq = (this.#inputSeq + 1) % 0x1_0000_0000)
    const event = message.event
    const wheel = event.kind === 'wheel'
    this.#inputs.push({ seq, at: this.#now(), dx: wheel ? event.dx : 0, dy: wheel ? event.dy : 0 })
    if (this.#inputs.length > PENDING_INPUTS)
      this.#inputs.splice(0, this.#inputs.length - PENDING_INPUTS)
    this.#socket.send(JSON.stringify({ ...message, seq }))
    if (wheel) this.#reshift()
    return true
  }

  /** A message to the browser; false — the stream is not open, nothing was sent. */
  send(message: BrowserClientMessage): boolean {
    if (this.#socket === null || this.#connection !== 'open') return false
    this.#socket.send(JSON.stringify(message))
    return true
  }

  #set(connection: StreamConnection): void {
    if (this.#connection === connection && connection !== 'ended') return
    this.#connection = connection
    this.#options.events.connection(connection, connection === 'ended' ? this.#endReason : null)
  }

  #clearTimers(): void {
    if (this.#silence !== null) this.#timers.clear(this.#silence)
    if (this.#retry !== null) this.#timers.clear(this.#retry)
    this.#silence = null
    this.#retry = null
    this.#stopStats()
  }

  /** Every period the numbers of this tab go to the worker, while the stream is open (ТР3). */
  #armStats(): void {
    this.#stopStats()
    const generation = this.#generation
    this.#statsTimer = this.#timers.set(() => {
      this.#statsTimer = null
      if (generation !== this.#generation) return
      const period = this.stats.period(this.#options.touch ?? false)
      if (period !== null) this.send({ t: 'stats', ...period })
      this.#armStats()
    }, STREAM_STATS_PERIOD_MS)
  }

  #stopStats(): void {
    if (this.#statsTimer !== null) this.#timers.clear(this.#statsTimer)
    this.#statsTimer = null
  }

  /**
   * The frame `frameSeq` is about to be drawn: the inputs it shows leave the shift (ТР7). Answers
   * when the scrolls among them were sent, to be timed once the frame is on the screen.
   */
  #shown(frameSeq: number): number[] {
    let upTo: number | null = null
    this.#marks = this.#marks.filter((mark) => {
      if (mark.frameSeq > frameSeq) return true
      upTo = upTo === null ? mark.inputSeq : Math.max(upTo, mark.inputSeq)
      return false
    })
    if (upTo === null) return []
    const shown = upTo
    const sent: number[] = []
    this.#inputs = this.#inputs.filter((input) => {
      if (input.seq > shown) return true
      if (input.dx !== 0 || input.dy !== 0) sent.push(input.at)
      return false
    })
    return sent
  }

  /**
   * The shift is the scroll sent and not shown, of the last second; told when it changes. Before
   * a frame it is told without a redraw: the frame itself puts it on the screen.
   */
  #reshift(redraw = true): void {
    const now = this.#now()
    let dx = 0
    let dy = 0
    let oldest: number | null = null
    for (const input of this.#inputs) {
      if ((input.dx === 0 && input.dy === 0) || now - input.at > PREDICTION_MAX_MS) continue
      dx += input.dx
      dy += input.dy
      oldest = oldest === null ? input.at : Math.min(oldest, input.at)
    }
    if (this.#predictionTimer !== null) this.#timers.clear(this.#predictionTimer)
    this.#predictionTimer = null
    // A scroll no frame showed in time stops moving the picture: the page did not go there.
    if (oldest !== null) {
      const generation = this.#generation
      this.#predictionTimer = this.#timers.set(
        () => {
          this.#predictionTimer = null
          if (generation === this.#generation) this.#reshift()
        },
        Math.max(1, oldest + PREDICTION_MAX_MS - now + 1),
      )
    }
    if (dx === this.#shift.dx && dy === this.#shift.dy) return
    this.#shift = { dx, dy }
    const viewport = this.#state?.viewport
    if (viewport) this.#options.shift?.(this.#shift, viewport, redraw)
  }

  /** A new connection numbers its input from the start; nothing it sent before is ahead. */
  #forgetInputs(): void {
    this.#inputSeq = 0
    this.#inputs = []
    this.#marks = []
    if (this.#predictionTimer !== null) this.#timers.clear(this.#predictionTimer)
    this.#predictionTimer = null
    if (this.#shift.dx === 0 && this.#shift.dy === 0) return
    this.#shift = { dx: 0, dy: 0 }
    const viewport = this.#state?.viewport
    if (viewport) this.#options.shift?.(this.#shift, viewport, true)
  }

  /** Forgets the socket of this connection without waiting for its close. */
  #drop(): void {
    const socket = this.#socket
    this.#socket = null
    if (this.holding) this.#heldBy = this.#viewer
    if (this.#viewer !== null) {
      this.#viewer = null
      this.#options.events.viewer(null)
    }
    this.#waiting = null
    this.#stopStats()
    this.#forgetInputs()
    if (socket === null) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    try {
      socket.close(1000)
    } catch {
      // Already closed.
    }
  }

  async #connect(): Promise<void> {
    if (!this.#running) return
    const generation = ++this.#generation
    this.#set(this.#opened ? 'reconnecting' : 'connecting')
    let ticket: StreamTicket
    try {
      ticket = await this.#options.ticket()
    } catch (error) {
      if (generation !== this.#generation) return
      if (this.#options.isGone(error)) return this.#end('forbidden')
      return this.#again()
    }
    if (generation !== this.#generation) return
    // Only the configured gateway: a ticket is never sent anywhere else.
    if (!sameStreamUrl(ticket.url, this.#options.streamUrl)) return this.#set('failed')
    this.#sessionId = ticket.sessionId.toLowerCase()
    this.#endReason = null
    const socket = (this.#options.createSocket ?? ((url) => new WebSocket(url) as StreamSocket))(
      ticket.url,
    )
    socket.binaryType = 'arraybuffer'
    this.#socket = socket
    const current = () => generation === this.#generation && this.#socket === socket
    socket.onopen = () => {
      if (!current()) return
      // The ticket goes first, never in the address.
      socket.send(JSON.stringify({ t: 'hello', ticket: ticket.ticket }))
      this.#armSilence()
    }
    socket.onmessage = (event) => {
      if (!current()) return
      this.#armSilence()
      this.#receive(event.data)
    }
    socket.onclose = (event) => {
      if (!current()) return
      this.#closed(event.code)
    }
    socket.onerror = () => {
      // A close always follows.
    }
  }

  #armSilence(): void {
    if (this.#silence !== null) this.#timers.clear(this.#silence)
    const generation = this.#generation
    this.#silence = this.#timers.set(() => {
      if (generation !== this.#generation) return
      // Nothing heard: this connection is given up and another one opened with a new ticket.
      this.#silence = null
      this.#generation += 1
      this.#drop()
      this.#again()
    }, STREAM_SILENCE_MS)
  }

  /** Another connection after a pause that grows with the failures in a row. */
  #again(delay = backoffMs(this.#attempt)): void {
    if (!this.#running) return
    this.#attempt += 1
    if (this.#opened) this.#set('reconnecting')
    if (this.#retry !== null) this.#timers.clear(this.#retry)
    this.#retry = this.#timers.set(() => {
      this.#retry = null
      void this.#connect()
    }, delay)
  }

  #end(reason: BrowserStreamEndReason | null): void {
    this.#endReason = reason
    this.#generation += 1
    this.#clearTimers()
    this.#drop()
    this.#running = false
    this.#set('ended')
  }

  #closed(code: number): void {
    // `closed { reason }` said why before the close: it is the reason, whatever the code.
    const reason = this.#endReason
    const said = reason === null ? code : browserStreamCloseCode(reason)
    this.#socket = null
    if (this.holding) this.#heldBy = this.#viewer
    if (this.#viewer !== null) {
      this.#viewer = null
      this.#options.events.viewer(null)
    }
    if (this.#silence !== null) this.#timers.clear(this.#silence)
    this.#silence = null
    this.#stopStats()
    this.#forgetInputs()
    switch (said) {
      case browserStreamCloseCodes.ended:
      case browserStreamCloseCodes.forbidden:
        return this.#end(
          reason ?? (said === browserStreamCloseCodes.forbidden ? 'forbidden' : null),
        )
      case browserStreamCloseCodes.protocol:
        this.#running = false
        return this.#set('failed')
      case browserStreamCloseCodes.unauthorized:
        // The ticket was spent or late: a new one at once, the first time.
        this.#endReason = null
        return this.#again(this.#attempt === 0 ? 0 : backoffMs(this.#attempt))
      default:
        this.#endReason = null
        return this.#again()
    }
  }

  #receive(data: unknown): void {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const frame = decodeBrowserFrame(
        data instanceof ArrayBuffer
          ? data
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      )
      if (frame !== null) this.#frame(frame)
      return
    }
    const message = parseBrowserServerMessage(data)
    if (message === null) return
    switch (message.t) {
      case 'viewer':
        this.#viewer = message.viewer
        this.#options.events.viewer(message.viewer)
        return
      case 'state': {
        const { t: _type, ...state } = message
        // A scroll sent on another tab or window size is no scroll of what is shown now.
        const before = this.#state
        if (
          before !== null &&
          (before.pageId !== state.pageId || before.viewportVersion !== state.viewportVersion)
        )
          this.#forgetInputs()
        this.#state = state
        const first = this.#connection !== 'open'
        if (first) {
          this.#attempt = 0
          this.#opened = true
          this.#set('open')
          this.#armStats()
        }
        this.#options.events.state(state)
        if (first) this.#afterOpen(state)
        if (this.holding) this.#heldBy = null
        return
      }
      case 'ping':
        this.send({ t: 'pong', ts: message.ts })
        return
      case 'refused':
        this.#options.events.refused(message.reason)
        return
      case 'closed':
        this.#endReason = message.reason
        return
      case 'applied':
        this.#marks.push({ frameSeq: message.frameSeq, inputSeq: message.inputSeq })
        if (this.#marks.length > PENDING_INPUTS)
          this.#marks.splice(0, this.#marks.length - PENDING_INPUTS)
        return
    }
  }

  /** The first state of a connection: what this tab asked for, or held before, goes now. */
  #afterOpen(state: BrowserState): void {
    const heldBy = this.#heldBy
    this.#heldBy = null
    // Every connection is a new viewer: a tab that held the control takes it back (Б15, Б17).
    const reclaim = heldBy !== null && state.controller === 'user' && state.holder === heldBy
    const pending = this.#pending
    this.#pending = null
    if (pending === 'release') this.send({ t: 'release' })
    else if (pending === 'take' || reclaim) this.send({ t: 'take' })
  }

  #frame(frame: BrowserFrame): void {
    if (frame.header.sessionId !== this.#sessionId) return
    const state = this.#state
    // A frame of another page or window size than the state names is not drawn; its place in
    // the window of the worker is given back at once.
    if (
      state !== null &&
      (frame.header.pageId !== state.pageId ||
        frame.header.viewportVersion !== state.viewportVersion)
    ) {
      this.send({ t: 'ack', frameSeq: frame.header.frameSeq })
      return
    }
    if (this.#drawing) {
      // Only the newest frame waits; an acknowledgement covers the ones before it.
      this.#waiting = frame
      return
    }
    void this.#drawFrames(frame)
  }

  async #drawFrames(first: BrowserFrame): Promise<void> {
    this.#drawing = true
    const generation = this.#generation
    let next: BrowserFrame | null = first
    try {
      while (next !== null) {
        const started = this.#now()
        // What this frame shows leaves the shift before it is drawn: the picture never jumps
        // ahead twice (ТР7).
        const scrolled = this.#shown(next.header.frameSeq)
        this.#reshift(false)
        const drawn = await this.#options.draw(next).catch(() => false)
        if (generation !== this.#generation) return
        if (drawn) {
          const done = this.#now()
          this.stats.drew(BROWSER_FRAME_HEADER_BYTES + next.jpeg.byteLength, done - started, done)
          // From a scroll sent to the frame that shows it on the screen: this tab's own clock.
          for (const at of scrolled)
            if (done - at <= INPUT_SAMPLE_MAX_MS) this.stats.input(done - at, done)
        }
        this.send({ t: 'ack', frameSeq: next.header.frameSeq })
        next = this.#waiting
        this.#waiting = null
      }
    } finally {
      this.#drawing = false
      // A frame of a newer connection that came while an old one was being drawn.
      const waiting = this.#waiting
      if (generation !== this.#generation && waiting !== null) {
        this.#waiting = null
        void this.#drawFrames(waiting)
      }
    }
  }
}
