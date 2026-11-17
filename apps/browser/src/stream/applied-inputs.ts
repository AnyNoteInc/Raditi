/**
 * Which of a viewer's numbered inputs a frame already shows (docs/plan/85-browser-stream-mobile.md,
 * ТР7). The page takes them one after another, so their times only grow; a frame Chromium painted
 * at `timestamp` shows every input it took by then. Input keeps coming while frames are on their
 * way — a finger moves every animation frame — so the newest input is usually later than the frame
 * that reaches the viewer: the frame names the newest one before it, never just the latest.
 */

/** How much earlier than the answer of an input a frame may be painted and still show it. */
export const APPLIED_SLACK_MS = 2
/** Inputs remembered until a frame shows them: more than a second of a finger at 60 Hz. */
const KEPT = 128

export class AppliedInputs {
  readonly #taken: { seq: number; at: number }[] = []
  #told: number | null = null

  /** The page took input `seq` by `at`. */
  taken(seq: number, at: number): void {
    this.#taken.push({ seq, at })
    if (this.#taken.length > KEPT) this.#taken.splice(0, this.#taken.length - KEPT)
  }

  /**
   * The newest input a frame painted at `timestamp` shows, when it is newer than the one told
   * already; null otherwise. Inputs it shows are forgotten: a later frame shows them too.
   */
  shownBy(timestamp: number): number | null {
    let shown: number | null = null
    while (this.#taken.length > 0) {
      const first = this.#taken[0]
      if (first === undefined || first.at > timestamp + APPLIED_SLACK_MS) break
      shown = first.seq
      this.#taken.shift()
    }
    if (shown === null || (this.#told !== null && shown <= this.#told)) return null
    this.#told = shown
    return shown
  }
}
