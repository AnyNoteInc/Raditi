import { performance } from 'node:perf_hooks'

import { DomainError, type SiteLeaseGrant, type SiteLeaseStore } from '@repo/domain'

/** A conservative local watchdog continues to expire even while a DB call is pending. */
export class LeaseGuard {
  readonly controller = new AbortController()
  reason: 'lease_lost' | 'cancelled' | 'timeout' = 'lease_lost'
  #expiry: NodeJS.Timeout | undefined
  #heartbeat: NodeJS.Timeout
  #hardDeadline: NodeJS.Timeout
  #renewing = false
  #closed = false
  #leaseDeadline = 0
  readonly #turnDeadline: number
  readonly #cancel = () => this.abort('cancelled')

  constructor(
    readonly lease: SiteLeaseGrant,
    private readonly store: SiteLeaseStore,
    private readonly ttlMs: number,
    hardTimeoutMs: number,
    private readonly externalSignal?: AbortSignal,
    acquireElapsedMs = 0,
  ) {
    this.#turnDeadline = performance.now() + hardTimeoutMs
    this.arm(lease, acquireElapsedMs)
    this.#heartbeat = setInterval(() => void this.renew(), Math.floor(ttlMs / 3))
    this.#hardDeadline = setTimeout(() => this.abort('timeout'), hardTimeoutMs)
    externalSignal?.addEventListener('abort', this.#cancel, { once: true })
    if (externalSignal?.aborted) this.#cancel()
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }
  get remainingMs(): number {
    this.assertActive()
    const remaining = Math.floor(
      Math.min(this.#turnDeadline, this.#leaseDeadline) - performance.now(),
    )
    if (remaining <= 0) {
      this.abort('timeout')
      this.assertActive()
    }
    return remaining
  }

  abort(reason: 'lease_lost' | 'cancelled' | 'timeout'): void {
    if (this.signal.aborted || this.#closed) return
    this.reason = reason
    this.controller.abort(new DomainError('TURN_INTERRUPTED', reason, 409))
  }

  assertActive(): void {
    if (this.signal.aborted) throw new DomainError('TURN_INTERRUPTED', this.reason, 409)
  }

  async assertFence(): Promise<void> {
    this.assertActive()
    try {
      if (!(await this.interruptible(this.store.assert(this.lease)))) this.abort('lease_lost')
    } catch {
      this.abort('lease_lost')
    }
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

  close(): void {
    this.#closed = true
    clearTimeout(this.#expiry)
    clearTimeout(this.#hardDeadline)
    clearInterval(this.#heartbeat)
    this.externalSignal?.removeEventListener('abort', this.#cancel)
  }

  private arm(grant: SiteLeaseGrant, elapsedMs: number): void {
    clearTimeout(this.#expiry)
    const remaining = grant.expiresAt.getTime() - grant.serverNow.getTime() - elapsedMs - 5_000
    this.#leaseDeadline = performance.now() + remaining
    if (!Number.isFinite(remaining) || remaining <= 0) this.abort('lease_lost')
    else this.#expiry = setTimeout(() => this.abort('lease_lost'), remaining)
  }

  private async renew(): Promise<void> {
    if (this.#closed || this.#renewing || this.signal.aborted) return
    this.#renewing = true
    const started = performance.now()
    try {
      const grant = await this.store.renew(this.lease, this.ttlMs)
      if (this.#closed || this.signal.aborted) return
      if (
        !grant ||
        grant.epoch !== this.lease.epoch ||
        grant.taskId !== this.lease.taskId ||
        grant.siteId !== this.lease.siteId
      )
        this.abort('lease_lost')
      else this.arm(grant, performance.now() - started)
    } catch {
      this.abort('lease_lost')
    } finally {
      this.#renewing = false
    }
  }
}
