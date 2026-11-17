// Scrolling the page of a task's browser from the panel (docs/plan/85-browser-stream-mobile.md,
// ТР5, ТР6): the moves of a finger, two fingers or the wheel between two animation frames go as
// one `wheel` event, and a finger let go mid-swipe keeps the page going and slowing down, as a
// phone scrolls its own pages. Pure: the panel calls it from its handlers and its animation frames,
// time comes from the caller.

/** How far a finger moves before it scrolls instead of clicking, in CSS pixels of the panel. */
export const TOUCH_SCROLL_SLOP_PX = 10
/** The largest step of one `wheel` event, as `wheelDelta` bounds it. */
const DELTA_LIMIT = 10_000

export interface WheelStep {
  x: number
  y: number
  dx: number
  dy: number
}

/**
 * Deltas in pixels of the browser's window, summed until taken. Whole pixels go; the fraction
 * left waits for the next ones, so a slow finger still moves the page.
 */
export class WheelGatherer {
  #point: { x: number; y: number } | null = null
  #dx = 0
  #dy = 0

  /** A move at `point` of the window; the newest point is where the event is aimed. */
  add(point: { x: number; y: number }, dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    this.#point = point
    this.#dx += dx
    this.#dy += dy
  }

  /** The whole pixels gathered as one event, or null when they come to none. */
  take(): WheelStep | null {
    const point = this.#point
    if (point === null) return null
    const dx = clamp(Math.trunc(this.#dx))
    const dy = clamp(Math.trunc(this.#dy))
    if (dx === 0 && dy === 0) return null
    this.#dx -= dx
    this.#dy -= dy
    return { ...point, dx, dy }
  }

  /** A new gesture starts from nothing. */
  clear(): void {
    this.#point = null
    this.#dx = 0
    this.#dy = 0
  }
}

const clamp = (value: number) => Math.max(-DELTA_LIMIT, Math.min(DELTA_LIMIT, value))

/** The moves of the last this many milliseconds give the speed of a finger let go. */
const VELOCITY_WINDOW_MS = 100
/** Pixels of the window a millisecond: faster is cut, slower stops. */
const MAX_SPEED = 8
const MIN_SPEED = 0.05
/** Speed kept after each 16 ms, about a frame of 60 Hz. */
const DECAY_PER_FRAME = 0.95
const FRAME_MS = 1000 / 60
/** A fling ends in this long whatever its speed. */
const MAX_FLING_MS = 2_000

/**
 * The speed of a finger, then the coasting of a page let go: each step gives the distance since
 * the last one, slower and slower, until it is too slow to see.
 */
export class Fling {
  readonly #moves: { at: number; dx: number; dy: number }[] = []
  #speed: { x: number; y: number } | null = null
  #at = 0
  #started = 0

  /** The finger moved the page by `dx`, `dy` window pixels at `at`. */
  moved(dx: number, dy: number, at: number): void {
    this.#speed = null
    this.#moves.push({ at, dx, dy })
    while (this.#moves.length > 0 && (this.#moves[0]?.at ?? at) < at - VELOCITY_WINDOW_MS)
      this.#moves.shift()
  }

  /** The finger is lifted at `at`: whether the page goes on by itself. */
  release(at: number): boolean {
    const recent = this.#moves.filter((move) => move.at >= at - VELOCITY_WINDOW_MS)
    this.#moves.length = 0
    const first = recent[0]
    if (first === undefined) return false
    const span = Math.max(FRAME_MS, at - first.at)
    let x = recent.reduce((sum, move) => sum + move.dx, 0) / span
    let y = recent.reduce((sum, move) => sum + move.dy, 0) / span
    const speed = Math.hypot(x, y)
    if (speed < MIN_SPEED * 4) return false
    if (speed > MAX_SPEED) {
      x = (x / speed) * MAX_SPEED
      y = (y / speed) * MAX_SPEED
    }
    this.#speed = { x, y }
    this.#at = at
    this.#started = at
    return true
  }

  /** The distance since the last step, or null once the page has stopped. */
  step(at: number): { dx: number; dy: number } | null {
    const speed = this.#speed
    if (speed === null) return null
    const elapsed = Math.max(0, at - this.#at)
    this.#at = at
    // The distance of a speed decaying by DECAY_PER_FRAME a frame over `elapsed`.
    const frames = elapsed / FRAME_MS
    const kept = DECAY_PER_FRAME ** frames
    const travelled = frames === 0 ? 0 : (FRAME_MS * (1 - kept)) / (1 - DECAY_PER_FRAME)
    const step = { dx: speed.x * travelled, dy: speed.y * travelled }
    speed.x *= kept
    speed.y *= kept
    if (Math.hypot(speed.x, speed.y) < MIN_SPEED || at - this.#started > MAX_FLING_MS)
      this.#speed = null
    return step
  }

  /** A new touch stops the page where it is. */
  stop(): void {
    this.#speed = null
    this.#moves.length = 0
  }

  get active(): boolean {
    return this.#speed !== null
  }
}
