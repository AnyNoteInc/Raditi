import { performance } from 'node:perf_hooks'

import { Logger } from '@nestjs/common'
import {
  DomainError,
  type SiteLeaseFence,
  type SiteLeaseGrant,
  type SiteLeaseStore,
  type TurnPhase,
} from '@repo/domain'
import { throttledLogger, type ThrottledLog } from '@repo/observability'

const holdLogger = new Logger('TurnLease')

/**
 * Keeps the site for an operator after an ambiguous write. The caller is already failing, so a
 * hold that throws or finds no fence is logged, not thrown: an ambiguous write is then unguarded
 * and an operator must know. Only the epoch and the last phase: no ids, error text or secrets.
 */
export async function holdForRecovery(
  store: Pick<SiteLeaseStore, 'holdForRecovery'>,
  fence: SiteLeaseFence,
  phase: TurnPhase,
): Promise<boolean> {
  let outcome = 'was refused'
  const held = await store.holdForRecovery(fence).catch(() => {
    outcome = 'failed'
    return false
  })
  if (!held)
    holdLogger.error(
      `Site lease hold for recovery ${outcome} (epoch ${fence.epoch}, phase ${phase})`,
    )
  return held
}

/**
 * The lease is never renewed: its TTL already covers the hard limit plus the publication grace.
 * Periodic and output-time checks (checkFence) stop the turn only on an explicit loss; a failed
 * read is logged and retried, while a local watchdog still expires the turn at lease expiry.
 * assertFence() before S3 writes, push and other side effects stays strict. Both deadlines
 * count from the lease request.
 */
export class LeaseGuard {
  readonly #controller = new AbortController()
  reason: 'lease_lost' | 'cancelled' | 'timeout' = 'lease_lost'
  readonly #expiry: NodeJS.Timeout | undefined
  readonly #hardDeadline: NodeJS.Timeout
  #check: NodeJS.Timeout | undefined
  #closed = false
  readonly #leaseDeadline: number
  readonly #turnDeadline: number
  readonly #cancel = () => this.#abort('cancelled')
  readonly #warn: ThrottledLog

  constructor(
    private readonly lease: SiteLeaseGrant,
    private readonly store: SiteLeaseStore,
    hardTimeoutMs: number,
    private readonly externalSignal?: AbortSignal,
    acquireElapsedMs = 0,
    logger: { warn(message: string): void } = new Logger('TurnLease'),
  ) {
    this.#warn = throttledLogger((line) => logger.warn(line))
    const now = performance.now()
    const hard = Math.max(0, hardTimeoutMs - acquireElapsedMs)
    const ttl = lease.expiresAt.getTime() - lease.serverNow.getTime()
    const remaining = ttl - acquireElapsedMs - 5_000
    this.#turnDeadline = now + hard
    this.#leaseDeadline = now + remaining
    if (hard <= 0) this.#abort('timeout')
    else if (!Number.isFinite(remaining) || remaining <= 0) this.#abort('lease_lost')
    else this.#expiry = setTimeout(() => this.#abort('lease_lost'), remaining)
    this.#hardDeadline = setTimeout(() => this.#abort('timeout'), hard)
    if (!this.signal.aborted) this.#schedule(Math.min(30_000, Math.floor(ttl / 3)))
    externalSignal?.addEventListener('abort', this.#cancel, { once: true })
    if (externalSignal?.aborted) this.#cancel()
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }
  get remainingMs(): number {
    this.assertActive()
    const remaining = Math.floor(
      Math.min(this.#turnDeadline, this.#leaseDeadline) - performance.now(),
    )
    if (remaining <= 0) {
      this.#abort('timeout')
      this.assertActive()
    }
    return remaining
  }

  /**
   * Time a step may take while `reserveMs` of the turn stays for the steps after it. With less
   * than that left the turn ends as a timeout instead of starting the step.
   */
  remainingBeforeReserveMs(reserveMs: number): number {
    const remaining = this.remainingMs - reserveMs
    if (remaining <= 0) {
      this.#abort('timeout')
      this.assertActive()
    }
    return remaining
  }

  /** Time left before the local lease deadline (5 s before the DB expiry); never aborts. */
  get leaseRemainingMs(): number {
    const remaining = Math.floor(this.#leaseDeadline - performance.now())
    return Number.isFinite(remaining) ? Math.max(0, remaining) : 0
  }

  assertActive(): void {
    if (this.signal.aborted) throw new DomainError('TURN_INTERRUPTED', this.reason, 409)
  }

  async assertFence(): Promise<void> {
    this.assertActive()
    try {
      if (!(await this.interruptible(this.store.assert(this.lease)))) this.#abort('lease_lost')
    } catch {
      this.#abort('lease_lost')
    }
    this.assertActive()
  }

  /**
   * The tolerant check of the periodic probe: an explicit loss aborts as lease_lost, a read
   * error only warns. For steps whose own write is fenced, such as the output journal.
   */
  async checkFence(): Promise<void> {
    this.assertActive()
    await this.#probe()
    this.assertActive()
  }

  /** Pending work stays observed, but cannot keep the local turn alive after its deadline. */
  async interruptible<T>(work: Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      void work.catch(() => {})
      this.assertActive()
    }
    let abort: () => void = () => {}
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new DomainError('TURN_INTERRUPTED', this.reason, 409))
      this.signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([work, interrupted])
    } finally {
      this.signal.removeEventListener('abort', abort)
    }
  }

  /** As interruptible, and a resource that only arrives after the interruption is released. */
  async interruptibleResource<T>(
    work: Promise<T>,
    release: (late: T) => Promise<void>,
  ): Promise<T> {
    void work.then((late) => (this.signal.aborted ? release(late) : undefined)).catch(() => {})
    return this.interruptible(work)
  }

  close(): void {
    this.#closed = true
    clearTimeout(this.#expiry)
    clearTimeout(this.#hardDeadline)
    clearTimeout(this.#check)
    this.externalSignal?.removeEventListener('abort', this.#cancel)
  }

  #abort(reason: 'lease_lost' | 'cancelled' | 'timeout'): void {
    if (this.signal.aborted || this.#closed) return
    this.reason = reason
    this.#controller.abort(new DomainError('TURN_INTERRUPTED', reason, 409))
  }

  /** One check at a time. Only an explicit "fence lost" aborts; a read error waits a tick. */
  #schedule(intervalMs: number): void {
    this.#check = setTimeout(() => {
      void this.#probe().then(() => {
        if (!this.#closed && !this.signal.aborted) this.#schedule(intervalMs)
      })
    }, intervalMs)
  }

  async #probe(): Promise<void> {
    try {
      if (!(await this.interruptible(this.store.assert(this.lease)))) this.#abort('lease_lost')
    } catch (error) {
      if (!this.signal.aborted) this.#warn('site lease check failed, retrying', error)
    }
  }
}
