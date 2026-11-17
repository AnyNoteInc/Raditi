import type { BrowserStreamStats } from '@repo/domain'

/**
 * What one viewer's stream measured (docs/plan/85-browser-stream-mobile.md, ТР2, ТР3): how long a
 * frame took from leaving the worker to its acknowledgement, the round trip of `ping` and `pong`,
 * and the cabinet's own numbers from `stats`. Numbers only — never a page, an address or an id —
 * so the summary may go to the log of production, where there is no Prometheus (M9). Time comes
 * from the caller.
 */

/** Acknowledgements kept for the summary and the quality of the stream: the newest ones. */
export const MEASURE_SAMPLES = 2_000
/** A frame still unacknowledged this long is no sample: the viewer stopped reading. */
const MAX_ACK_MS = 60_000

export interface AckSample {
  /** When the acknowledgement came. */
  at: number
  ms: number
}

/** The line `browser_stream_viewer` of the log; milliseconds and kilobytes, rounded. */
export interface ViewerSummary {
  event: 'browser_stream_viewer'
  seconds: number
  framesSent: number
  frameKbAvg: number | null
  ackMsP50: number | null
  ackMsP95: number | null
  rttMsP50: number | null
  /** What the cabinet said, period by period (`stats` every few seconds). */
  framesDrawn: number
  drawMsP50: number | null
  drawMsP95: number | null
  inputMsP50: number | null
  inputMsP95: number | null
  inputs: number
  touch: boolean
  qualityMin: number | null
  qualityChanges: number
  dropped: { replaced: number; stale: number }
}

export class ViewerMeasure {
  readonly #startedAt: number
  /** Sent and not acknowledged: the frame's number and when it left. */
  readonly #sent = new Map<number, number>()
  readonly #acks: AckSample[] = []
  readonly #rtts: number[] = []
  #framesSent = 0
  #bytesSent = 0
  #framesDrawn = 0
  readonly #draw = { p50: [] as number[], p95: [] as number[] }
  readonly #input = { p50: [] as number[], p95: [] as number[] }
  #inputs = 0
  #touch = false
  /** The lowest JPEG quality it was sent and how many times the quality changed (ТР9). */
  #quality: { now: number | null; lowest: number | null; changes: number } = {
    now: null,
    lowest: null,
    changes: 0,
  }

  constructor(now: number) {
    this.#startedAt = now
  }

  sent(seq: number, bytes: number, now: number): void {
    this.#framesSent += 1
    this.#bytesSent += bytes
    this.#sent.set(seq, now)
  }

  /**
   * The viewer acknowledged `seq`; the frames sent before it leave with it, as in FrameFlow, but
   * only `seq` itself is a sample: their own acknowledgement never came. Returns the sample.
   */
  acked(seq: number, now: number): number | null {
    const at = this.#sent.get(seq)
    if (at === undefined) return null
    for (const [sent] of this.#sent) {
      this.#sent.delete(sent)
      if (sent === seq) break
    }
    const ms = now - at
    if (!(ms >= 0) || ms > MAX_ACK_MS) return null
    push(this.#acks, { at: now, ms })
    return ms
  }

  /** A `pong` of a `ping` stamped `ts` by the worker or the gateway on this machine's clock. */
  pong(ts: number | undefined, now: number): number | null {
    if (ts === undefined) return null
    const ms = now - ts
    if (!(ms >= 0) || ms > MAX_ACK_MS) return null
    push(this.#rtts, ms)
    return ms
  }

  stats(stats: BrowserStreamStats): void {
    this.#framesDrawn += stats.frames
    this.#inputs += stats.inputs
    if (stats.touch) this.#touch = true
    if (stats.draw) {
      push(this.#draw.p50, stats.draw.p50)
      push(this.#draw.p95, stats.draw.p95)
    }
    if (stats.input) {
      push(this.#input.p50, stats.input.p50)
      push(this.#input.p95, stats.input.p95)
    }
  }

  quality(quality: number): void {
    const state = this.#quality
    if (state.now === quality) return
    if (state.now !== null) state.changes += 1
    state.now = quality
    state.lowest = state.lowest === null ? quality : Math.min(state.lowest, quality)
  }

  /** Acknowledgements that came at `since` or later, oldest first. */
  acksSince(since: number): readonly AckSample[] {
    let first = this.#acks.length
    while (first > 0 && (this.#acks[first - 1]?.at ?? -Infinity) >= since) first -= 1
    return this.#acks.slice(first)
  }

  summary(now: number, dropped: { replaced: number; stale: number }): ViewerSummary {
    const acks = this.#acks.map((sample) => sample.ms)
    return {
      event: 'browser_stream_viewer',
      seconds: Math.round((now - this.#startedAt) / 1000),
      framesSent: this.#framesSent,
      frameKbAvg: this.#framesSent > 0 ? round(this.#bytesSent / this.#framesSent / 1024, 1) : null,
      ackMsP50: quantile(acks, 0.5),
      ackMsP95: quantile(acks, 0.95),
      rttMsP50: quantile(this.#rtts, 0.5),
      framesDrawn: this.#framesDrawn,
      // A median of the periods' medians and of their 95th percentiles: the cabinet sends no
      // single samples.
      drawMsP50: quantile(this.#draw.p50, 0.5),
      drawMsP95: quantile(this.#draw.p95, 0.5),
      inputMsP50: quantile(this.#input.p50, 0.5),
      inputMsP95: quantile(this.#input.p95, 0.5),
      inputs: this.#inputs,
      touch: this.#touch,
      qualityMin: this.#quality.lowest,
      qualityChanges: this.#quality.changes,
      dropped: { ...dropped },
    }
  }
}

function push<T>(list: T[], value: T): void {
  list.push(value)
  if (list.length > MEASURE_SAMPLES) list.splice(0, list.length - MEASURE_SAMPLES)
}

/** The `q` quantile by the nearest rank, rounded to a millisecond; null for no samples. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return Math.round(sorted[rank] ?? 0)
}

const round = (value: number, digits: number) => {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
