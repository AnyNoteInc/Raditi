import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { provisioningLimits, type JobQueue } from '@repo/domain'

import type { SiteImportStore } from './stage-store.ts'
import { wakeImport, wakeNextImport } from './wake.ts'

export interface SiteImportSweeperOptions {
  store: Pick<SiteImportStore, 'sweepSilent' | 'waiting' | 'nextQueued'>
  queue: JobQueue
  /** false in tests and tools: no timer. */
  background: boolean
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => number
  intervalMs?: number
}

/**
 * Recovery of imports in core, in this process (docs/plan/39-site-connection-wizard.md): a stage
 * left `running` without a heartbeat for staleMs — its core was killed or went silent — goes back
 * to the queue with a new outbox event, or fails `interrupted` once the attempt has used its
 * enqueues; a stage `queued` for queuedStaleMs — its job lost, or claimed while another import of
 * the workspace ran — gets a wake-up straight into BullMQ, at most one per five-minute bucket of
 * the clock. Passes never overlap; the one running is awaited when the module stops.
 */
export class SiteImportSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #options: SiteImportSweeperOptions
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => number
  #timer: NodeJS.Timeout | undefined
  #pending: Promise<void> | undefined
  #closing = false

  constructor(options: SiteImportSweeperOptions) {
    this.#options = options
    this.#logger = options.logger ?? new Logger('SiteImport')
    this.#now = options.now ?? Date.now
  }

  onApplicationBootstrap(): void {
    if (!this.#options.background || this.#timer || this.#closing) return
    this.#timer = setInterval(
      () => void this.tick(),
      this.#options.intervalMs ?? provisioningLimits.sweepMs,
    )
    this.#timer.unref()
    void this.tick()
  }

  /** One pass; a call while one runs joins it. Never rejects. */
  tick(): Promise<void> {
    if (this.#closing) return Promise.resolve()
    if (this.#pending) return this.#pending
    const pending = this.#sweep()
      .catch(() => {
        if (!this.#closing) this.#logger.warn('site_import_sweep_failed')
      })
      .finally(() => {
        if (this.#pending === pending) this.#pending = undefined
      })
    this.#pending = pending
    return pending
  }

  async onModuleDestroy(): Promise<void> {
    this.#closing = true
    clearInterval(this.#timer)
    this.#timer = undefined
    await this.#pending
  }

  async #sweep(): Promise<void> {
    const { store, queue } = this.#options
    const { requeued, interrupted } = await store.sweepSilent()
    for (const stage of requeued)
      this.#logger.warn(`site_import_requeued site=${stage.siteId} code=silent`)
    for (const stage of interrupted)
      this.#logger.warn(`site_import_failed site=${stage.siteId} code=interrupted`)
    for (const stage of [...requeued, ...interrupted]) {
      if (this.#closing) return
      await wakeNextImport(store, queue, stage).catch(() =>
        this.#logger.warn(`site_import_wake_failed site=${stage.siteId}`),
      )
    }
    const bucket = String(Math.floor(this.#now() / provisioningLimits.queuedStaleMs))
    for (const stage of await store.waiting()) {
      if (this.#closing) return
      await wakeImport(queue, stage, bucket).catch(() =>
        this.#logger.warn(`site_import_wake_failed site=${stage.siteId}`),
      )
    }
  }
}
