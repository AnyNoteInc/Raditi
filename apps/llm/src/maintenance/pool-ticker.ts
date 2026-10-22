import { Inject, Injectable } from '@nestjs/common'

import { SubscriptionPoolHealth } from '../pool/pool-health.ts'
import { MaintenanceJobs } from './maintenance-jobs.ts'

/** The pass of the pool over its accounts, once a minute, as a maintenance job. */
@Injectable()
export class PoolTicker {
  readonly #pool: Pick<SubscriptionPoolHealth, 'tick'>
  readonly #jobs: MaintenanceJobs

  constructor(
    @Inject(SubscriptionPoolHealth) pool: Pick<SubscriptionPoolHealth, 'tick'>,
    @Inject(MaintenanceJobs) jobs: MaintenanceJobs,
  ) {
    this.#pool = pool
    this.#jobs = jobs
  }

  start(): void {
    this.#jobs.every('pool', 60_000, () => this.#pool.tick())
  }
}
