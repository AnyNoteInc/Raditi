/**
 * The JPEG quality of a session's screencast, by its viewers' links
 * (docs/plan/85-browser-stream-mobile.md, ТР9): one screencast serves every viewer, so the worst
 * link sets it. A link is judged by the excess of its acknowledgements — how much longer a frame
 * takes than the fastest one of the last 20 s, which is about the round trip and the drawing —:
 * a heavy frame on a thin link waits to be carried, a light one does not. Down a step when the
 * worst median excess of 3 s is over 150 ms, up a step after 10 s under 60 ms, never two steps
 * within 4 s. No samples — a page that does not change — changes nothing. Time comes from the
 * caller.
 */

/** The steps below the configured quality (`BROWSER_STREAM_QUALITY`); never below the last. */
export const BROWSER_STREAM_QUALITY_STEPS = Object.freeze([55, 40, 30])

export const browserStreamQualityRule = Object.freeze({
  /** The fastest acknowledgement of this long is the link's own time. */
  baseMs: 20_000,
  /** The median excess is read over this long… */
  windowMs: 3_000,
  /** …from at least this many acknowledgements. */
  minSamples: 4,
  /** A worse link than this steps down. */
  downExcessMs: 150,
  /** Every link better than this, for `upAfterMs`, steps up. */
  upExcessMs: 60,
  upAfterMs: 10_000,
  /** Two changes are at least this far apart: each restarts the screencast. */
  minChangeMs: 4_000,
})

export interface StreamAck {
  /** When the acknowledgement came. */
  at: number
  ms: number
}

/** The qualities from the configured one down: the configured one first, each once. */
export function browserStreamQualities(top: number): number[] {
  return [top, ...BROWSER_STREAM_QUALITY_STEPS.filter((step) => step < top)]
}

/**
 * The median excess of one viewer's acknowledgements over the last `windowMs`, or null with too
 * few of them. `acks` are its acknowledgements of the last `baseMs` at least, oldest first.
 */
export function ackExcessMs(acks: readonly StreamAck[], now: number): number | null {
  const rule = browserStreamQualityRule
  const base = acks.filter((ack) => ack.at >= now - rule.baseMs)
  const recent = base.filter((ack) => ack.at >= now - rule.windowMs)
  if (recent.length < rule.minSamples) return null
  const fastest = Math.min(...base.map((ack) => ack.ms))
  const excess = recent.map((ack) => ack.ms - fastest).sort((a, b) => a - b)
  return excess[Math.floor((excess.length - 1) / 2)] ?? null
}

export class BrowserStreamQuality {
  readonly #qualities: number[]
  #step = 0
  #changedAt: number
  #goodSince: number | null = null

  constructor(top: number, now: number) {
    this.#qualities = browserStreamQualities(top)
    this.#changedAt = now
  }

  get quality(): number {
    return this.#qualities[this.#step] ?? this.#qualities[0] ?? 0
  }

  /**
   * The viewers' acknowledgements at `now`, one list each; the new quality when it changes,
   * null when it stays.
   */
  observe(viewers: readonly (readonly StreamAck[])[], now: number): number | null {
    const rule = browserStreamQualityRule
    const excesses = viewers
      .map((acks) => ackExcessMs(acks, now))
      .filter((excess): excess is number => excess !== null)
    if (excesses.length === 0) {
      // Nothing carried, nothing learnt: a quiet page holds its quality and its count of good time.
      return null
    }
    const worst = Math.max(...excesses)
    if (worst >= rule.upExcessMs) this.#goodSince = null
    else this.#goodSince ??= now
    if (now - this.#changedAt < rule.minChangeMs) return null
    if (worst > rule.downExcessMs && this.#step < this.#qualities.length - 1)
      return this.#move(this.#step + 1, now)
    if (this.#goodSince !== null && now - this.#goodSince >= rule.upAfterMs && this.#step > 0)
      return this.#move(this.#step - 1, now)
    return null
  }

  #move(step: number, now: number): number {
    this.#step = step
    this.#changedAt = now
    this.#goodSince = null
    return this.quality
  }
}
