import { performance } from 'node:perf_hooks'

import { Logger } from '@nestjs/common'
import {
  DomainError,
  TURN_LEASE_TTL_MS,
  TURN_PUBLICATION_GRACE_MS,
  TURN_RENEW_INTERVAL_MS,
  type SiteLeaseFence,
  type SiteLeaseGrant,
  type SiteLeaseStore,
  type TurnAssignmentStore,
  type TurnPhase,
} from '@repo/domain'
import { throttledLogger, type ThrottledLog } from '@repo/observability'

const holdLogger = new Logger('TurnLease')

/**
 * The lease a turn holds at a time (docs/plan/70-turn-without-time-limit.md, ВР2): its container
 * lives TURN_LEASE_TTL_MS past the last renewal, the lease the publication grace longer.
 */
export const TURN_LEASE_MS = TURN_LEASE_TTL_MS + TURN_PUBLICATION_GRACE_MS

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
 * How a turn without a time limit lives (docs/plan/70-turn-without-time-limit.md, ВР2): every
 * `intervalMs` its owner renews the lease, the assignment and the keys in one statement
 * (TurnAssignmentStore.renewTurn); each renewal keeps the turn `turnMs` more. A turn whose
 * renewals stop — its core died, or its database is gone longer than that — ends as lease_lost.
 */
export interface TurnRenewal {
  renew(): Promise<SiteLeaseGrant | null>
  /** What one renewal keeps the turn's container: TURN_LEASE_TTL_MS. */
  turnMs: number
  /** TURN_RENEW_INTERVAL_MS. */
  intervalMs?: number
}

/**
 * Two kinds of turns hold a guard. A turn of the agent renews itself (TurnRenewal) and has no
 * deadline of its own: only its lease ends it. A step of recovery that only finishes a turn —
 * its checkpoint, its publication — has a fixed limit (`limitMs`) and its one grant covers it.
 * Periodic and output-time checks stop the turn only on an explicit loss; a failed read or
 * renewal is logged and retried, while a local timer still expires the turn at lease expiry.
 * assertFence() before S3 writes, push and other side effects stays strict. Deadlines count
 * from the lease request.
 */
export class LeaseGuard {
  readonly #controller = new AbortController()
  reason: 'lease_lost' | 'cancelled' | 'timeout' = 'lease_lost'
  #expiry: NodeJS.Timeout | undefined
  #hardDeadline: NodeJS.Timeout | undefined
  #final: NodeJS.Timeout | undefined
  #finalDeadline: number | undefined
  #check: NodeJS.Timeout | undefined
  #closed = false
  #leaseDeadline: number
  #turnDeadline: number
  readonly #renewal: TurnRenewal | null
  readonly #renewed = new Set<(remainingMs: number) => void>()
  readonly #cancel = () => this.#abort('cancelled')
  readonly #warn: ThrottledLog

  constructor(
    private lease: SiteLeaseGrant,
    private readonly store: SiteLeaseStore,
    limit: number | TurnRenewal,
    private readonly externalSignal?: AbortSignal,
    acquireElapsedMs = 0,
    logger: { warn(message: string): void } = new Logger('TurnLease'),
  ) {
    this.#warn = throttledLogger((line) => logger.warn(line))
    this.#renewal = typeof limit === 'number' ? null : limit
    const now = performance.now()
    const hard = Math.max(0, (typeof limit === 'number' ? limit : limit.turnMs) - acquireElapsedMs)
    const ttl = lease.expiresAt.getTime() - lease.serverNow.getTime()
    const remaining = ttl - acquireElapsedMs - 5_000
    this.#turnDeadline = now + hard
    this.#leaseDeadline = now + remaining
    if (hard <= 0) this.#abort(this.#renewal ? 'lease_lost' : 'timeout')
    else if (!Number.isFinite(remaining) || remaining <= 0) this.#abort('lease_lost')
    else this.#arm(now)
    if (!this.signal.aborted)
      this.#schedule(
        this.#renewal
          ? (this.#renewal.intervalMs ?? 30_000)
          : Math.min(30_000, Math.floor(ttl / 3)),
      )
    externalSignal?.addEventListener('abort', this.#cancel, { once: true })
    if (externalSignal?.aborted) this.#cancel()
  }

  /**
   * The agent ended: what is left of the turn — its quiesce, capture, candidate, save and push —
   * must end within `limitMs` (TURN_FINALIZE_MS), or the turn times out. Renewals go on meanwhile:
   * the lease covers a push in flight. Never later than a limit already set.
   */
  finalize(limitMs: number): void {
    if (this.#closed || this.signal.aborted) return
    const until = performance.now() + Math.max(0, limitMs)
    if (this.#finalDeadline !== undefined && this.#finalDeadline <= until) return
    this.#finalDeadline = until
    clearTimeout(this.#final)
    this.#final = setTimeout(() => this.#abort('timeout'), Math.max(0, limitMs))
  }

  /**
   * Renews at once instead of at the next tick: a turn recovery took over may have only seconds
   * of its last renewal left. Resolves when the renewal settled; its outcome acts as at a tick.
   */
  async renewNow(): Promise<void> {
    if (this.#renewal && !this.#closed && !this.signal.aborted) await this.#renew(this.#renewal)
  }

  /**
   * Called with the time a renewal kept the turn (`turnMs` less what the renewal took): the
   * owner extends its container by it (TurnExecution.extend). Never called for a fixed limit.
   */
  onRenewed(listener: (remainingMs: number) => void): () => void {
    this.#renewed.add(listener)
    return () => this.#renewed.delete(listener)
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }
  get remainingMs(): number {
    this.assertActive()
    const now = performance.now()
    const remaining = Math.floor(
      Math.min(this.#turnDeadline, this.#leaseDeadline, this.#finalDeadline ?? Infinity) - now,
    )
    if (remaining <= 0) {
      this.#abort(
        this.#finalDeadline !== undefined && this.#finalDeadline <= now
          ? 'timeout'
          : this.#renewal
            ? 'lease_lost'
            : 'timeout',
      )
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
    clearTimeout(this.#final)
    clearTimeout(this.#check)
    this.#renewed.clear()
    this.externalSignal?.removeEventListener('abort', this.#cancel)
  }

  /** The timers of the deadlines as they stand now: the lease's, and the turn's own. */
  #arm(now: number): void {
    clearTimeout(this.#expiry)
    clearTimeout(this.#hardDeadline)
    this.#expiry = setTimeout(() => this.#abort('lease_lost'), this.#leaseDeadline - now)
    // A renewing turn has no deadline of its own: its container ends with its last renewal, and
    // the turn is lost with it, never timed out.
    this.#hardDeadline = setTimeout(
      () => this.#abort(this.#renewal ? 'lease_lost' : 'timeout'),
      this.#turnDeadline - now,
    )
  }

  #abort(reason: 'lease_lost' | 'cancelled' | 'timeout'): void {
    if (this.signal.aborted || this.#closed) return
    this.reason = reason
    this.#controller.abort(new DomainError('TURN_INTERRUPTED', reason, 409))
  }

  /** One check at a time. Only an explicit "fence lost" aborts; a read error waits a tick. */
  #schedule(intervalMs: number): void {
    this.#check = setTimeout(() => {
      void (this.#renewal ? this.#renew(this.#renewal) : this.#probe()).then(() => {
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

  /** The renewal of a turn: the explicit loss of its fence aborts, a failure waits a tick. */
  async #renew(renewal: TurnRenewal): Promise<void> {
    const started = performance.now()
    let grant: SiteLeaseGrant | null
    try {
      grant = await this.interruptible(renewal.renew())
    } catch (error) {
      if (!this.signal.aborted) this.#warn('turn renewal failed, retrying', error)
      return
    }
    if (this.#closed || this.signal.aborted) return
    if (!grant) return this.#abort('lease_lost')
    // Counted from before the request, as the first grant is: the database may have waited.
    this.lease = grant
    this.#turnDeadline = Math.max(this.#turnDeadline, started + renewal.turnMs)
    this.#leaseDeadline = Math.max(
      this.#leaseDeadline,
      started + grant.expiresAt.getTime() - grant.serverNow.getTime() - 5_000,
    )
    const now = performance.now()
    this.#arm(now)
    const remainingMs = Math.floor(this.#turnDeadline - now)
    for (const listener of this.#renewed) {
      try {
        listener(remainingMs)
      } catch {
        // A listener's failure is its own: the turn goes on under its lease.
      }
    }
  }
}

/**
 * The renewal of a turn of the agent at `fence` (TurnAssignmentStore.renewTurn): the same for
 * the supervisor that started it and for recovery that took it over.
 */
export function turnRenewal(
  assignments: { renewTurn: TurnAssignmentStore['renewTurn'] },
  fence: SiteLeaseFence,
  turn: number,
): TurnRenewal {
  return {
    renew: () =>
      assignments.renewTurn({ fence, turn, turnMs: TURN_LEASE_TTL_MS, leaseMs: TURN_LEASE_MS }),
    turnMs: TURN_LEASE_TTL_MS,
    intervalMs: TURN_RENEW_INTERVAL_MS,
  }
}
