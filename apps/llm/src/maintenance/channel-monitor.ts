import { Inject, Injectable } from '@nestjs/common'

import { EgressHealth } from '../egress/egress-probe.ts'
import { SubscriptionPoolHealth } from '../pool/pool-health.ts'
import { MaintenanceJobs } from './maintenance-jobs.ts'

/**
 * The probes of the channel to the providers, and the account recheck that alone may lift a
 * confirmed region block. The channel is probed again sooner after a failure and when a region
 * recheck is due.
 */
@Injectable()
export class ChannelMonitor {
  readonly #channel: EgressHealth
  readonly #pool: Pick<SubscriptionPoolHealth, 'recheckRegion'>
  readonly #jobs: MaintenanceJobs
  #timer: ReturnType<typeof setTimeout> | undefined
  #stopped = false

  constructor(
    @Inject(EgressHealth) channel: EgressHealth,
    @Inject(SubscriptionPoolHealth) pool: Pick<SubscriptionPoolHealth, 'recheckRegion'>,
    @Inject(MaintenanceJobs) jobs: MaintenanceJobs,
  ) {
    this.#channel = channel
    this.#pool = pool
    this.#jobs = jobs
  }

  start(): void {
    this.#schedule()
  }

  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
  }

  #schedule(): void {
    if (this.#stopped) return
    this.#timer = setTimeout(() => {
      void this.#jobs.run('channel', () => this.#check()).finally(() => this.#schedule())
    }, this.#channel.nextCheckMs())
    this.#timer.unref()
  }

  async #check(): Promise<void> {
    await this.#channel.check()
    const recheck = this.#channel.regionRecheck()
    if (recheck && (await this.#pool.recheckRegion(recheck.accountId)))
      this.#channel.clearRegion(recheck.revision)
  }
}
