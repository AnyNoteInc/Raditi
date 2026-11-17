import type { BrowserStreamStats } from '@repo/domain/browser/stream-messages'

// What this tab measures of the stream of a task's browser (docs/plan/85-browser-stream-mobile.md,
// ТР3, ТР4): frames drawn, their bytes, decoding and drawing, and from an input to the first frame
// that shows it (ТР7). Every few seconds the period goes to the worker as `stats` — numbers only —;
// the last seconds feed the line of numbers that `?stream-stats=1` shows. Time comes from the
// caller, on this tab's own clock.

/** A period of `stats`. */
export const STREAM_STATS_PERIOD_MS = 5_000
/** What the line of numbers averages over. */
const LIVE_MS = 3_000
/** Samples kept for one period: more frames than a period holds at 30 a second. */
const PERIOD_SAMPLES = 1_000

export interface LiveStreamStats {
  fps: number
  kbPerFrame: number | null
  mbps: number
  drawMs: number | null
  inputMs: number | null
}

export class StreamStats {
  #frames = 0
  #bytes = 0
  #draws: number[] = []
  #inputs: number[] = []
  /** The last seconds: when each frame was drawn, its bytes and how long it took. */
  readonly #recent: { at: number; bytes: number; ms: number }[] = []
  readonly #recentInputs: { at: number; ms: number }[] = []

  /** A frame of `bytes`, header included, decoded and drawn in `ms`, done at `at`. */
  drew(bytes: number, ms: number, at: number): void {
    this.#frames += 1
    this.#bytes += bytes
    keep(this.#draws, ms)
    this.#recent.push({ at, bytes, ms })
    trim(this.#recent, at)
  }

  /** An input reached the screen `ms` after it was sent. */
  input(ms: number, at: number): void {
    keep(this.#inputs, ms)
    this.#recentInputs.push({ at, ms })
    trim(this.#recentInputs, at)
  }

  /** The period for `stats`, then a new one; null when nothing was drawn or measured. */
  period(touch: boolean): Omit<BrowserStreamStats, 't'> | null {
    if (this.#frames === 0 && this.#inputs.length === 0) return null
    const period: Omit<BrowserStreamStats, 't'> = {
      frames: Math.min(this.#frames, 100_000),
      bytes: Math.min(this.#bytes, 1_000_000_000),
      draw: quantiles(this.#draws),
      input: quantiles(this.#inputs),
      inputs: Math.min(this.#inputs.length, 100_000),
      touch,
    }
    this.#frames = 0
    this.#bytes = 0
    this.#draws = []
    this.#inputs = []
    return period
  }

  /** The last seconds, for the line of numbers. */
  live(now: number): LiveStreamStats {
    trim(this.#recent, now)
    trim(this.#recentInputs, now)
    const frames = this.#recent.length
    const bytes = this.#recent.reduce((sum, frame) => sum + frame.bytes, 0)
    return {
      fps: Math.round((frames / LIVE_MS) * 1000 * 10) / 10,
      kbPerFrame: frames > 0 ? Math.round(bytes / frames / 1024) : null,
      mbps: Math.round(((bytes * 8) / (LIVE_MS / 1000) / 1_000_000) * 10) / 10,
      drawMs: quantile(
        this.#recent.map((frame) => frame.ms),
        0.5,
      ),
      inputMs: quantile(
        this.#recentInputs.map((input) => input.ms),
        0.5,
      ),
    }
  }
}

function keep(list: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) return
  list.push(Math.min(value, 60_000))
  if (list.length > PERIOD_SAMPLES) list.splice(0, list.length - PERIOD_SAMPLES)
}

function trim(list: { at: number }[], now: number): void {
  while (list.length > 0 && (list[0]?.at ?? now) < now - LIVE_MS) list.shift()
}

function quantiles(values: readonly number[]): { p50: number; p95: number } | null {
  const p50 = quantile(values, 0.5)
  const p95 = quantile(values, 0.95)
  return p50 === null || p95 === null ? null : { p50, p95 }
}

/** The `q` quantile by the nearest rank, to a tenth of a millisecond; null for no samples. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return Math.round((sorted[rank] ?? 0) * 10) / 10
}
