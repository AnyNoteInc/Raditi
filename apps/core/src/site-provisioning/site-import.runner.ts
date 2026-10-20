import { provisioningLimits, siteImportLimits, withTimeout, type JobQueue } from '@repo/domain'

import { isTransientDatabaseError } from './database-errors.ts'
import { hiccup, isImportFailure, isLeaseLost } from './import-failure.ts'
import type { ImportedVersion } from './site-import.ts'
import type { ClaimedStage, SiteImportStore, StageLease } from './stage-store.ts'
import { wakeNextImport, type EndedImport } from './wake.ts'

/** How a job of the import queue ended; the label of raditi_site_imports_total. */
export const siteImportOutcomes = [
  'succeeded',
  'failed',
  // A hiccup: the stage is queued again within its attempt.
  'requeued',
  // Shutdown of core: the stage is queued again after releaseDelayMs.
  'released',
  // Another run holds the stage now: nothing was written.
  'lease_lost',
  // The end could not be written (the database away): the sweep returns the stage later.
  'unsettled',
  // The job found nothing to start: not queued, or another import of the workspace runs.
  'skipped',
] as const
export type SiteImportOutcome = (typeof siteImportOutcomes)[number]

export interface SiteImportTiming {
  heartbeatMs: number
  /** A run whose heartbeat has not been written for this long stops: the sweep may own it. */
  staleMs: number
  stageMs: number
  /**
   * After an abort, how long the run waits for the import to stop. A trusted command cannot be
   * interrupted (60 s at most): the run writes its end without it, and the import, left behind,
   * can no longer write anything — every write of it is fenced.
   */
  abandonMs: number
  /** Delay of a requeue after a hiccup, by the enqueues the attempt has used. */
  retryDelayMs: (enqueues: number) => number
}

export const defaultSiteImportTiming: SiteImportTiming = {
  heartbeatMs: provisioningLimits.heartbeatMs,
  staleMs: provisioningLimits.staleMs,
  stageMs: siteImportLimits.stageMs,
  abandonMs: 5_000,
  retryDelayMs: (enqueues) => 30_000 * enqueues,
}

export interface SiteImportRunnerOptions {
  store: SiteImportStore
  /** importSite with its dependencies bound. */
  importer: (stage: ClaimedStage, signal: AbortSignal) => Promise<ImportedVersion>
  queue: JobQueue
  logger: { log(message: string): void; warn(message: string): void }
  count?: (outcome: SiteImportOutcome) => void
  timing?: Partial<SiteImportTiming>
}

type Settled =
  | { status: 'ok'; value: ImportedVersion }
  | { status: 'error'; error: unknown }
  | { status: 'abandoned' }

/**
 * The work, or `abandoned` once `signal` aborted and the work did not stop within `graceMs`.
 * An abandoned rejection is already handled: it reaches nobody.
 */
function settle(
  work: Promise<ImportedVersion>,
  signal: AbortSignal,
  graceMs: number,
): Promise<Settled> {
  const settled = work.then(
    (value): Settled => ({ status: 'ok', value }),
    (error: unknown): Settled => ({ status: 'error', error }),
  )
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined
    const onAbort = () => {
      timer = setTimeout(() => resolve({ status: 'abandoned' }), graceMs)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    void settled.then((result) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    })
  })
}

/**
 * One job of the import queue (docs/plan/39-site-connection-wizard.md, «Импорт»): claim the stage,
 * keep its heartbeat, run the import under one signal — the lease lost, the shutdown of core, the
 * deadline of the stage — and write how it ended, fenced by the epoch of the claim. Logs carry
 * ids and codes only: no host, path, user name or secret ever reaches them.
 */
export class SiteImportRunner {
  readonly #options: SiteImportRunnerOptions
  readonly #timing: SiteImportTiming

  constructor(options: SiteImportRunnerOptions) {
    this.#options = options
    this.#timing = { ...defaultSiteImportTiming, ...options.timing }
  }

  async run(siteId: string, shutdown: AbortSignal): Promise<SiteImportOutcome> {
    const { store, logger } = this.#options
    // A job taken while core is stopping is left for another process.
    if (shutdown.aborted) return this.#count('skipped')
    const claim = await store.claim(siteId)
    if (claim.kind === 'idle' || claim.kind === 'busy') return this.#count('skipped')
    if (claim.kind === 'refused') {
      logger.warn(`site_import_failed site=${siteId} code=access_refused`)
      await this.#wakeNext({ siteId, workspaceId: claim.workspaceId, leaseEpoch: claim.leaseEpoch })
      return this.#count('failed')
    }

    const stage = claim.stage
    const lease: StageLease = { siteId: stage.siteId, leaseEpoch: stage.leaseEpoch }
    logger.log(
      `site_import_started site=${stage.siteId} attempt=${stage.attempt} enqueues=${stage.enqueues} epoch=${stage.leaseEpoch}`,
    )
    const lost = new AbortController()
    const deadline = new AbortController()
    const deadlineTimer = setTimeout(() => deadline.abort(), this.#timing.stageMs)
    const signal = AbortSignal.any([lost.signal, shutdown, deadline.signal])
    const stopHeartbeat = this.#heartbeat(lease, lost)
    let outcome: SiteImportOutcome
    try {
      const work = Promise.resolve().then(() => this.#options.importer(stage, signal))
      const result = await settle(work, signal, this.#timing.abandonMs)
      outcome = await this.#finish(stage, lease, result, {
        lost: lost.signal,
        shutdown,
        deadline: deadline.signal,
      })
    } finally {
      clearTimeout(deadlineTimer)
      await stopHeartbeat()
    }
    if (outcome !== 'lease_lost' && outcome !== 'unsettled')
      await this.#wakeNext({
        siteId: stage.siteId,
        workspaceId: stage.workspaceId,
        leaseEpoch: stage.leaseEpoch,
      })
    return this.#count(outcome)
  }

  /** Writes how the run ended; every write is fenced, a lost lease writes nothing. */
  async #finish(
    stage: ClaimedStage,
    lease: StageLease,
    result: Settled,
    signals: { lost: AbortSignal; shutdown: AbortSignal; deadline: AbortSignal },
  ): Promise<SiteImportOutcome> {
    const { store, logger } = this.#options
    const site = stage.siteId
    const failed = async (code: Parameters<SiteImportStore['fail']>[1]) => {
      await store.fail(lease, code)
      logger.warn(`site_import_failed site=${site} code=${code}`)
      return 'failed' as const
    }
    try {
      if (signals.lost.aborted || (result.status === 'error' && isLeaseLost(result.error))) {
        logger.warn(`site_import_lease_lost site=${site} epoch=${lease.leaseEpoch}`)
        return 'lease_lost'
      }
      if (result.status === 'ok') {
        try {
          await store.succeed(lease, result.value.commitSha)
        } catch (error) {
          if (isImportFailure(error)) return await failed(error.code)
          throw error
        }
        logger.log(`site_import_succeeded site=${site}`)
        return 'succeeded'
      }
      if (signals.shutdown.aborted) {
        const released = await store.release(lease)
        if (released === 'failed') {
          logger.warn(`site_import_failed site=${site} code=interrupted`)
          return 'failed'
        }
        logger.log(`site_import_released site=${site}`)
        return 'released'
      }
      if (signals.deadline.aborted) return await failed('timed_out')
      const thrown = result.status === 'error' ? result.error : undefined
      // A blip of PostgreSQL under the import is a hiccup, as Vault away is; nothing else is.
      const error = isTransientDatabaseError(thrown) ? hiccup('internal') : thrown
      if (!isImportFailure(error)) return await failed('internal')
      if (!error.transient) return await failed(error.code)
      const requeued = await store.retry(
        lease,
        error.code,
        this.#timing.retryDelayMs(stage.enqueues),
      )
      if (requeued === 'failed') {
        logger.warn(`site_import_failed site=${site} code=${error.code}`)
        return 'failed'
      }
      logger.log(`site_import_requeued site=${site} code=${error.code}`)
      return 'requeued'
    } catch (error) {
      if (isLeaseLost(error)) {
        logger.warn(`site_import_lease_lost site=${site} epoch=${lease.leaseEpoch}`)
        return 'lease_lost'
      }
      // The database away: the stage keeps `running` without a heartbeat until the sweep.
      logger.warn(`site_import_unsettled site=${site}`)
      return 'unsettled'
    }
  }

  /**
   * Writes the heartbeat every heartbeatMs while the import runs. 0 rows — the stage is no longer
   * this run's; no write for staleMs — the sweep may have given it to another run. Either aborts
   * the import. Staleness is checked on every tick, before anything else: a write that hangs (a
   * pooled connection that died without a word) is the silence it is. Each write is bounded by
   * heartbeatMs, so the stop resolves within that once the last write has settled or given up.
   */
  #heartbeat(lease: StageLease, lost: AbortController): () => Promise<void> {
    const { store, logger } = this.#options
    const { heartbeatMs, staleMs } = this.#timing
    let lastWritten = Date.now()
    let pending: Promise<void> | undefined
    const beat = () => {
      if (lost.signal.aborted) return
      if (Date.now() - lastWritten >= staleMs) {
        lost.abort()
        return
      }
      if (pending) return
      pending = withTimeout(store.heartbeat(lease), heartbeatMs, 'Site import heartbeat timed out')
        .then((held) => {
          if (held) lastWritten = Date.now()
          else lost.abort()
        })
        .catch(() => {
          logger.warn(`site_import_heartbeat_failed site=${lease.siteId}`)
          if (Date.now() - lastWritten >= staleMs) lost.abort()
        })
        .finally(() => {
          pending = undefined
        })
    }
    const timer = setInterval(beat, heartbeatMs)
    return async () => {
      clearInterval(timer)
      await pending
    }
  }

  async #wakeNext(ended: EndedImport): Promise<void> {
    try {
      await wakeNextImport(this.#options.store, this.#options.queue, ended)
    } catch {
      // The sweep wakes a waiting stage after queuedStaleMs.
      this.#options.logger.warn(`site_import_wake_failed site=${ended.siteId}`)
    }
  }

  #count(outcome: SiteImportOutcome): SiteImportOutcome {
    this.#options.count?.(outcome)
    return outcome
  }
}
