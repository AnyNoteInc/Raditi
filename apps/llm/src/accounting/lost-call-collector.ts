import { Inject, Injectable } from '@nestjs/common'
import { withTimeout } from '@repo/domain'

import { LLM_LOGGER } from '../infra/infra.tokens.ts'
import { GATEWAY_STORE } from './accounting.tokens.ts'
import type { PostgresGatewayStore } from './gateway-store.ts'

/** A scan that has not finished in this time closes admission (it keeps running). */
const SCAN_BOUND_MS = 10_000
const SCAN_EVERY_MS = 30_000

/**
 * The gateway's collector of lost calls: the reservations of calls whose process stopped are
 * closed by the ledger (collectLost). Admission stays closed until a scan has finished in time;
 * core's sweeper has a backup of its own.
 */
@Injectable()
export class LostCallCollector {
  readonly #store: Pick<PostgresGatewayStore, 'collectLost'>
  readonly #logger: { warn(message: string): void }
  #timer: ReturnType<typeof setInterval> | undefined
  #collecting: Promise<void> | undefined
  #collectionWait: Promise<void> | undefined
  #healthy = false

  constructor(
    @Inject(GATEWAY_STORE) store: Pick<PostgresGatewayStore, 'collectLost'>,
    @Inject(LLM_LOGGER) logger: { warn(message: string): void },
  ) {
    this.#store = store
    this.#logger = logger
  }

  /** The last scan finished in time: admission may open. */
  healthy(): boolean {
    return this.#healthy
  }

  collect(): Promise<void> {
    // A timeout closes admission but retains the underlying scan until it really settles.
    // Retrying a hung query must never accumulate overlapping collectors or pool waiters.
    if (this.#collecting) return this.#collectionWait ?? Promise.resolve()
    let timedOut = false
    this.#collecting = Promise.resolve()
      .then(() => this.#store.collectLost())
      .then(() => {
        this.#healthy = !timedOut
      })
      .catch(() => {
        this.#healthy = false
        this.#logger.warn(JSON.stringify({ event: 'llm_collector_failed' }))
      })
      .finally(() => {
        this.#collecting = undefined
        this.#collectionWait = undefined
      })
    this.#collectionWait = withTimeout(
      this.#collecting,
      SCAN_BOUND_MS,
      'LLM collector timed out',
    ).catch(() => {
      timedOut = true
      this.#healthy = false
      this.#logger.warn(JSON.stringify({ event: 'llm_collector_timeout' }))
    })
    return this.#collectionWait
  }

  /** A scan every 30 s once the role listens. */
  start(): void {
    this.#timer = setInterval(() => {
      void this.collect()
    }, SCAN_EVERY_MS)
    this.#timer.unref()
  }

  stop(): void {
    clearInterval(this.#timer)
  }

  /** Waits for the scan still running at shutdown, at most `withinMs`. */
  async settle(withinMs: number): Promise<void> {
    if (this.#collecting)
      await withTimeout(this.#collecting, withinMs, 'LLM collector shutdown timed out').catch(
        () => {},
      )
  }
}
