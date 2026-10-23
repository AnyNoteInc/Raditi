import type { AddressInfo } from 'node:net'

import { Inject, Injectable, type Logger, type OnApplicationShutdown } from '@nestjs/common'
import { withTimeout } from '@repo/domain'

import { LostCallCollector } from '../accounting/lost-call-collector.ts'
import type { LlmRoleConfig } from '../config/config.ts'
import { LLM_CONFIG } from '../config/config.module.ts'
import { EgressHealth } from '../egress/egress-probe.ts'
import type { DatabaseShutdown } from '../infra/database-shutdown.ts'
import { DATABASE_SHUTDOWN, LLM_LOGGER } from '../infra/infra.tokens.ts'
import { ChannelMonitor } from '../maintenance/channel-monitor.ts'
import { MaintenanceJobs } from '../maintenance/maintenance-jobs.ts'
import { PoolTicker } from '../maintenance/pool-ticker.ts'
import { SubscriptionPoolHealth } from '../pool/pool-health.ts'
import { LLM_GATEWAY } from './gateway.tokens.ts'
import { GatewayReadiness } from './readiness.ts'
import type { LlmGateway } from './server.ts'

/**
 * The order the role starts and stops in, in one place. Nest stops the providers of one level
 * of a module at once; these steps follow one another, each within its bound: the HTTP drain
 * (≤30 s, the gateway's own), the pool and the channel (3 s), the jobs (1 s), the collector
 * (1 s) and the database (2 s). The HTTP server and collector stop before the one database pool
 * is disconnected, and the 37 s fit the 40 s stop grace period of the llm service.
 */
@Injectable()
export class LlmRuntime implements OnApplicationShutdown {
  readonly #egressPath: 'proxy' | 'direct'
  readonly #logger: Pick<Logger, 'log' | 'warn'>
  readonly #collector: LostCallCollector
  readonly #channel: EgressHealth
  readonly #pool: Pick<SubscriptionPoolHealth, 'close'>
  readonly #jobs: MaintenanceJobs
  readonly #poolTicker: PoolTicker
  readonly #channelMonitor: ChannelMonitor
  readonly #readiness: GatewayReadiness
  readonly #gateway: Pick<LlmGateway, 'listen' | 'close'>
  readonly #closeDatabase: DatabaseShutdown

  constructor(
    @Inject(LLM_CONFIG) config: LlmRoleConfig,
    @Inject(LLM_LOGGER) logger: Pick<Logger, 'log' | 'warn'>,
    @Inject(LostCallCollector) collector: LostCallCollector,
    @Inject(EgressHealth) channel: EgressHealth,
    @Inject(SubscriptionPoolHealth) pool: Pick<SubscriptionPoolHealth, 'close'>,
    @Inject(MaintenanceJobs) jobs: MaintenanceJobs,
    @Inject(PoolTicker) poolTicker: PoolTicker,
    @Inject(ChannelMonitor) channelMonitor: ChannelMonitor,
    @Inject(GatewayReadiness) readiness: GatewayReadiness,
    @Inject(LLM_GATEWAY) gateway: Pick<LlmGateway, 'listen' | 'close'>,
    @Inject(DATABASE_SHUTDOWN) closeDatabase: DatabaseShutdown,
  ) {
    this.#egressPath = config.egress.proxyUrl === null ? 'direct' : 'proxy'
    this.#logger = logger
    this.#collector = collector
    this.#channel = channel
    this.#pool = pool
    this.#jobs = jobs
    this.#poolTicker = poolTicker
    this.#channelMonitor = channelMonitor
    this.#readiness = readiness
    this.#gateway = gateway
    this.#closeDatabase = closeDatabase
  }

  async listen(): Promise<AddressInfo> {
    // The role serves with a proxy and without one: which of the two is read here, not guessed
    // from a missing variable.
    this.#logger.log(JSON.stringify({ event: 'llm_egress_path', path: this.#egressPath }))
    await Promise.all([this.#collector.collect(), this.#channel.check()])
    const address = await this.#gateway.listen()
    this.#collector.start()
    this.#poolTicker.start()
    this.#channelMonitor.start()
    return address
  }

  async onApplicationShutdown(): Promise<void> {
    this.#readiness.close()
    this.#collector.stop()
    this.#channelMonitor.stop()
    this.#jobs.close()
    const timedOut = () => {
      this.#logger.warn(JSON.stringify({ event: 'llm_maintenance_shutdown_timeout' }))
    }
    try {
      // The HTTP drain (≤30 s) fits the 40 s stop grace period of the llm service.
      await this.#gateway.close()
      await withTimeout(
        Promise.allSettled([this.#pool.close(), this.#channel.close()]),
        3000,
        'LLM maintenance shutdown timed out',
      ).catch(timedOut)
      await this.#jobs.drain(1000)
      await this.#collector.settle(1000)
    } finally {
      await this.#closeDatabase(2000)
    }
  }
}
