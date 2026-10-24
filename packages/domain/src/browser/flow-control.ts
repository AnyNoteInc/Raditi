import { browserStreamDefaults } from './session.ts'

/**
 * Who gets which frame when (docs/plan/57-browser-tasks.md, Б13): the worker keeps one flow per
 * viewer. Chromium paints faster than a slow link carries, so nothing queues: one newest frame
 * waits (an older one is replaced), at most `window` frames are on the way unacknowledged, frames
 * leave at most `maxFps` a second and only while the socket buffers little. A frame on the way
 * holds its place until the viewer acknowledges it, however long that takes: the socket loses
 * nothing, it is only slow, and a place freed by a clock would pile frames up in front of a slow
 * viewer. A frame the gateway drops it acknowledges itself; a viewer that is gone is cut by the
 * heartbeat (Б14). A frame of a page or a window size the viewer no longer sees is dropped before
 * it is sent. Time comes from the caller.
 */
export interface FlowFrame {
  /** The frame's number in the header; acknowledgements name it. */
  seq: number
  pageId: number
  viewportVersion: number
  /** Size of the whole message. */
  bytes: number
}

export interface FrameFlowOptions {
  maxFps: number
  window: number
  maxBufferedBytes: number
}

/**
 * What the worker does now: send this frame, look again in `ms`, or wait — for a new frame or,
 * with the window full, for an acknowledgement.
 */
export type FrameFlowDecision<F> =
  { kind: 'send'; frame: F } | { kind: 'wait'; ms: number } | { kind: 'idle' }

/** Frames that never left, by why: a newer one came, or the page or window changed. */
export interface FrameFlowDrops {
  replaced: number
  stale: number
}

export class FrameFlow<F extends FlowFrame> {
  readonly #options: FrameFlowOptions
  readonly #minIntervalMs: number
  #pending: F | null = null
  /** Sent and not acknowledged, in the order sent. */
  readonly #unacked = new Set<number>()
  #lastSentAt = Number.NEGATIVE_INFINITY
  readonly #drops: FrameFlowDrops = { replaced: 0, stale: 0 }

  constructor(options: Partial<FrameFlowOptions> = {}) {
    this.#options = {
      maxFps: options.maxFps ?? browserStreamDefaults.maxFps,
      window: options.window ?? browserStreamDefaults.window,
      maxBufferedBytes: options.maxBufferedBytes ?? browserStreamDefaults.maxBufferedBytes,
    }
    const { maxFps, window, maxBufferedBytes } = this.#options
    if (!(maxFps > 0) || !Number.isInteger(window) || window < 1)
      throw new RangeError('Invalid frame flow: rate or window')
    if (!(maxBufferedBytes > 0)) throw new RangeError('Invalid frame flow: buffer')
    this.#minIntervalMs = 1000 / maxFps
  }

  /** A new frame of the page: it replaces the one still waiting. */
  offer(frame: F): void {
    if (this.#pending !== null) this.#drops.replaced++
    this.#pending = frame
  }

  /**
   * The viewer drew `seq`. The socket keeps order, so the frames sent before it have arrived too
   * and leave the window with it; a number that is not on the way changes nothing. True when it
   * freed a place: the caller never lets a rate drop such an acknowledgement, or the window would
   * stay full for good.
   */
  ack(seq: number): boolean {
    if (!this.#unacked.has(seq)) return false
    for (const sent of [...this.#unacked]) {
      this.#unacked.delete(sent)
      if (sent === seq) break
    }
    return true
  }

  /**
   * What to do at `now` with `bufferedAmount` bytes still in the socket, while the viewer is to
   * see `current`. The caller asks again after a `wait`, an `offer` and an `ack`.
   */
  next(
    now: number,
    bufferedAmount: number,
    current: { pageId: number; viewportVersion: number },
  ): FrameFlowDecision<F> {
    const frame = this.#pending
    if (frame === null) return { kind: 'idle' }
    if (frame.pageId !== current.pageId || frame.viewportVersion !== current.viewportVersion) {
      this.#pending = null
      this.#drops.stale++
      return { kind: 'idle' }
    }
    // Only an acknowledgement frees a place, never time: the caller asks again after one.
    if (this.#unacked.size >= this.#options.window) return { kind: 'idle' }
    const sinceLast = now - this.#lastSentAt
    if (sinceLast < this.#minIntervalMs) return wait(this.#minIntervalMs - sinceLast)
    if (bufferedAmount > 0 && bufferedAmount + frame.bytes > this.#options.maxBufferedBytes)
      return wait(this.#minIntervalMs)
    this.#pending = null
    this.#unacked.add(frame.seq)
    this.#lastSentAt = now
    return { kind: 'send', frame }
  }

  /** Frames on the way and not acknowledged. */
  get unacknowledged(): number {
    return this.#unacked.size
  }

  get drops(): Readonly<FrameFlowDrops> {
    return { ...this.#drops }
  }
}

/** Never less than a millisecond: a timer of 0 would spin. */
const wait = (ms: number) => ({ kind: 'wait', ms: Math.max(1, Math.ceil(ms)) }) as const
