import type { Sandbox, SandboxProvider } from '@repo/domain'

// The warm containers of turns (owner's decision of 26.10.2026; spec §8, «Тёплая песочница»):
// the container of a completed turn waits a few minutes for the next turn of its task instead
// of being removed, and that turn takes it instead of creating one. A container never outlives
// the deadline it was created with — the watchdog's, the lease's and recovery's — so it is
// offered only while it leaves a turn `WARM_MIN_LEFT_MS`. While it waits nothing runs in it: it
// was reset (Sandbox.reset), its turn's credentials are revoked, no lease covers it.

/** What a waiting container must still leave the turn that takes it: half of a turn. */
export const WARM_MIN_LEFT_MS = 10 * 60_000
/** How often the tasks of waiting containers are checked. */
export const WARM_SWEEP_MS = 10_000
/**
 * At most as many waiting containers as core runs turns at once (AGENT_TURN_CONCURRENCY): one
 * more waits in the place of the one whose wait ends first.
 */
export const WARM_MAX_WAITING = 8

export interface WarmSandboxesOptions {
  sandboxes: Pick<SandboxProvider, 'get'>
  /** How long the container of a completed turn waits for the next turn of its task. */
  warmMs: number
  /**
   * Of these tasks, the ones that may still run a turn: not ended, on a site not deleted. Asked
   * before a container waits and while any does; a failure removes them all.
   */
  wanted(taskIds: readonly string[]): Promise<ReadonlySet<string>>
  sweepMs?: number
  maxWaiting?: number
  now?: () => number
  logger?: { warn(message: string): void }
}

interface Waiting {
  sandbox: Sandbox
  key: string
  deadline: number
  until: number
  timer: NodeJS.Timeout
}

export class WarmSandboxes {
  readonly #options: WarmSandboxesOptions
  readonly #now: () => number
  /** Waiting for the next turn of their task, by container id. */
  readonly #waiting = new Map<string, Waiting>()
  /** Taken by a turn of this process, until it removes the container or it waits again. */
  readonly #taken = new Set<string>()
  #sweeper: NodeJS.Timeout | undefined
  #sweeping: Promise<void> | undefined
  #closed = false

  constructor(options: WarmSandboxesOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  /**
   * Whether this process holds the container: waiting here, or taken by a turn it runs. Such a
   * container is no orphan, whatever its labels say (TurnReconciler).
   */
  holds(containerId: string): boolean {
    return this.#waiting.has(containerId) || this.#taken.has(containerId)
  }

  /**
   * The waiting container of `key` for a turn that holds its lease, when it leaves the turn
   * `needMs`: checked again by its provider — unchanged, with its network intact — and held as
   * taken until the turn removes it or it waits again. null — none: the turn creates one.
   */
  async take(key: string, needMs: number): Promise<{ sandbox: Sandbox; deadline: number } | null> {
    for (;;) {
      if (this.#closed) return null
      const found = [...this.#waiting.values()].find((waiting) => waiting.key === key)
      if (!found) return null
      const { sandbox, deadline } = found
      this.#unwait(sandbox.id)
      if (deadline - this.#now() < needMs) {
        void this.#remove(sandbox)
        continue
      }
      this.#taken.add(sandbox.id)
      const fresh = await this.#options.sandboxes.get(sandbox.id).catch(() => null)
      if (
        fresh?.id === sandbox.id &&
        JSON.stringify(fresh.labels) === JSON.stringify(sandbox.labels)
      )
        return { sandbox: fresh, deadline }
      this.#taken.delete(sandbox.id)
      void this.#remove(sandbox)
    }
  }

  /**
   * After a completed turn: the container waits for the next turn of its task, reset, until
   * `warmMs` pass or it would leave a turn less than WARM_MIN_LEFT_MS. false — it does not wait,
   * and the caller removes it as before.
   */
  async park(sandbox: Sandbox, key: string, deadline: number): Promise<boolean> {
    const { warmMs, wanted } = this.#options
    const until = Math.min(this.#now() + warmMs, deadline - WARM_MIN_LEFT_MS)
    if (this.#closed || !sandbox.reset || until <= this.#now()) return false
    try {
      await sandbox.reset()
      if (!(await wanted([sandbox.labels.taskId])).has(sandbox.labels.taskId)) return false
    } catch {
      return false
    }
    if (this.#closed || until <= this.#now()) return false
    this.#taken.delete(sandbox.id)
    if (this.#waiting.size >= (this.#options.maxWaiting ?? WARM_MAX_WAITING)) {
      const first = [...this.#waiting.values()].reduce((a, b) => (b.until < a.until ? b : a))
      this.#expire(first.sandbox.id)
    }
    const timer = setTimeout(() => this.#expire(sandbox.id), until - this.#now())
    timer.unref()
    this.#waiting.set(sandbox.id, { sandbox, key, deadline, until, timer })
    this.#sweeper ??= setInterval(() => void this.sweep(), this.#options.sweepMs ?? WARM_SWEEP_MS)
    this.#sweeper.unref()
    return true
  }

  /** The container was removed by a turn or by recovery: this process holds it no more. */
  forget(containerId: string): void {
    this.#taken.delete(containerId)
    this.#unwait(containerId)
  }

  /**
   * Removes the containers whose tasks ended or whose sites were deleted. One check at a time;
   * a failed one removes every waiting container: none is kept on a guess.
   */
  sweep(): Promise<void> {
    return (this.#sweeping ??= (async () => {
      try {
        const ids = [...new Set([...this.#waiting.values()].map((w) => w.sandbox.labels.taskId))]
        if (ids.length === 0) return
        const wanted = await this.#options.wanted(ids).catch(() => new Set<string>())
        for (const [id, waiting] of this.#waiting)
          if (!wanted.has(waiting.sandbox.labels.taskId)) this.#expire(id)
      } finally {
        this.#sweeping = undefined
      }
    })())
  }

  /** Removes every waiting container; a taken one stays with its turn. Nothing waits after it. */
  async close(): Promise<void> {
    this.#closed = true
    const removals = [...this.#waiting.values()].map(({ sandbox }) => {
      this.#unwait(sandbox.id)
      return this.#remove(sandbox)
    })
    await Promise.all(removals)
    await this.#sweeping
  }

  #expire(id: string): void {
    const waiting = this.#waiting.get(id)
    if (!waiting) return
    this.#unwait(id)
    void this.#remove(waiting.sandbox)
  }

  #unwait(id: string): void {
    const waiting = this.#waiting.get(id)
    if (!waiting) return
    clearTimeout(waiting.timer)
    this.#waiting.delete(id)
    if (this.#waiting.size === 0) {
      clearInterval(this.#sweeper)
      this.#sweeper = undefined
    }
  }

  /** What is not removed here is no longer held: the reconciler and the watchdog remove it. */
  async #remove(sandbox: Sandbox): Promise<void> {
    await sandbox
      .destroy('completed')
      .catch(() => this.#options.logger?.warn('warm_sandbox_remove_failed'))
  }
}
