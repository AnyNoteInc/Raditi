import { Logger, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { withTimeout, type SecretStore } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { cachedHealthProbe, databaseCheck, vaultCheck } from '@repo/observability'
import { createVaultSecretStore } from '@repo/vault'
import { createAppPrisma, PRISMA, SECRET_STORE } from '@repo/service-runtime'
import { PostgresGatewayStore } from '@repo/turn-keys'

import type { LlmRoleConfig } from '../config.ts'
import { createCredentialSource } from './credentials.ts'
import { createControlEgress, createEgressTransport, EgressNotSentError } from './egress.ts'
import { createEgressProbe, EgressHealth } from './egress-probe.ts'
import { SubscriptionPoolHealth } from './pool-health.ts'
import { createLlmGateway, type LlmGateway } from './server.ts'

/** The HTTP server and collector stop before the one database pool is disconnected. */
export class LlmRuntime implements OnApplicationShutdown {
  readonly gateway: LlmGateway
  readonly #store: PostgresGatewayStore
  readonly #logger = new Logger('LlmGateway')
  readonly #channel: EgressHealth
  readonly #pool: SubscriptionPoolHealth
  readonly #egressPath: 'proxy' | 'direct'
  readonly #maintenance = new Set<ReturnType<typeof setInterval>>()
  readonly #jobs = new Map<string, Promise<void>>()
  #channelTimer: ReturnType<typeof setTimeout> | undefined
  #collector: ReturnType<typeof setInterval> | undefined
  #collecting: Promise<void> | undefined
  #collectionWait: Promise<void> | undefined
  #collectorHealthy = false
  #closing = false

  constructor(
    config: LlmRoleConfig,
    private readonly prisma: PrismaClient,
    secrets: SecretStore,
  ) {
    this.#store = new PostgresGatewayStore(prisma, {
      maxRequestsPerKey: config.maxRequestsPerKey,
      maxCallsPerKey30s: config.maxCallsPerKey30s,
      maxCallsPerKey: config.maxCallsPerKey,
      logger: { warn: (message) => this.#logger.warn(message) },
    })
    const health = cachedHealthProbe({
      database: databaseCheck(() => prisma),
      vault: vaultCheck(() => secrets),
    })
    // The set the role's configuration read its provider origins and stand overrides from.
    const backends = llmBackends
    const credentials = createCredentialSource(secrets)
    this.#egressPath = config.egress.proxyUrl === null ? 'direct' : 'proxy'
    this.#channel = new EgressHealth(createEgressProbe(config.egress), this.#logger)
    const transport = createEgressTransport(config.egress, backends, {
      onDirectConnection: (established) => this.#channel.observeDirect(established),
    })
    const channelHealthy = () => this.#channel.healthy()
    const onRegion = (accountId: string) => this.#channel.blockRegion(accountId)
    // A closed gate sends nothing: a generation spends no quota.
    const gate = (open: () => boolean) => ({
      request: (...args: Parameters<typeof transport.request>) =>
        open() ? transport.request(...args) : Promise.reject(new EgressNotSentError()),
    })
    const gatedTransport = gate(channelHealthy)
    const http = createControlEgress(gatedTransport)
    this.#pool = new SubscriptionPoolHealth({
      prisma,
      credentials,
      backends,
      http,
      regionHttp: createControlEgress(gate(() => this.#channel.reachable())),
      channelHealthy,
      onRegion,
      logger: this.#logger,
    })
    this.gateway = createLlmGateway({
      config,
      backends,
      store: this.#store,
      credentials,
      egress: gatedTransport,
      lifecycle: {
        pause: (key) => this.#pool.pause(key.accountId),
        observe: (call, finish) => this.#pool.observe(call, finish),
        // Both callers ask because the windows are unknown: admission and core's issue.
        probeAccounts: async (accountIds, unknownWindows = {}) => {
          await Promise.all(
            accountIds.map((accountId) => this.#pool.probeAccount(accountId, unknownWindows)),
          )
        },
        // The snapshot has only grown old: one probe of the account in five minutes is enough.
        refreshAccount: async (accountId) => {
          await this.#pool.refreshAccount(accountId)
        },
      },
      metricsToken: config.metricsToken,
      ready: () => !this.#closing && this.#collectorHealthy && channelHealthy(),
      // Without a proxy the last line is all that tells of a provider out of reach; it closes
      // nothing, because only a request that is let through can find the provider again.
      health: async () =>
        (await health()).status === 'ok' &&
        this.#collectorHealthy &&
        channelHealthy() &&
        this.#channel.directReachable(),
      logger: this.#logger,
    })
  }

  #runJob(name: string, work: () => Promise<void>): Promise<void> {
    if (this.#closing) return Promise.resolve()
    const running = this.#jobs.get(name)
    if (running) return running
    const job = Promise.resolve()
      .then(work)
      .catch(() => {
        this.#logger.warn(JSON.stringify({ event: 'llm_maintenance_failed', job: name }))
      })
      .finally(() => this.#jobs.delete(name))
    this.#jobs.set(name, job)
    return job
  }

  #every(name: string, milliseconds: number, work: () => Promise<void>): void {
    const timer = setInterval(() => {
      void this.#runJob(name, work)
    }, milliseconds)
    timer.unref()
    this.#maintenance.add(timer)
  }

  #collect(): Promise<void> {
    // A timeout closes admission but retains the underlying scan until it really settles.
    // Retrying a hung query must never accumulate overlapping collectors or pool waiters.
    if (this.#collecting) return this.#collectionWait ?? Promise.resolve()
    let timedOut = false
    this.#collecting = Promise.resolve()
      .then(() => this.#store.collectLost())
      .then(() => {
        this.#collectorHealthy = !timedOut
      })
      .catch(() => {
        this.#collectorHealthy = false
        this.#logger.warn(JSON.stringify({ event: 'llm_collector_failed' }))
      })
      .finally(() => {
        this.#collecting = undefined
        this.#collectionWait = undefined
      })
    this.#collectionWait = withTimeout(this.#collecting, 10_000, 'LLM collector timed out').catch(
      () => {
        timedOut = true
        this.#collectorHealthy = false
        this.#logger.warn(JSON.stringify({ event: 'llm_collector_timeout' }))
      },
    )
    return this.#collectionWait
  }

  /** The channel is probed again sooner after a failure and when a region recheck is due. */
  #scheduleChannel(): void {
    if (this.#closing) return
    this.#channelTimer = setTimeout(() => {
      void this.#runJob('channel', () => this.#checkChannel()).finally(() =>
        this.#scheduleChannel(),
      )
    }, this.#channel.nextCheckMs())
    this.#channelTimer.unref()
  }

  async #checkChannel(): Promise<void> {
    await this.#channel.check()
    const recheck = this.#channel.regionRecheck()
    if (recheck && (await this.#pool.recheckRegion(recheck.accountId)))
      this.#channel.clearRegion(recheck.revision)
  }

  async listen() {
    // The role serves with a proxy and without one: which of the two is read here, not guessed
    // from a missing variable.
    this.#logger.log(JSON.stringify({ event: 'llm_egress_path', path: this.#egressPath }))
    await Promise.all([this.#collect(), this.#channel.check()])
    const address = await this.gateway.listen()
    this.#collector = setInterval(() => {
      void this.#collect()
    }, 30_000)
    this.#collector.unref()
    this.#every('pool', 60_000, () => this.#pool.tick())
    this.#scheduleChannel()
    return address
  }

  async onApplicationShutdown(): Promise<void> {
    this.#closing = true
    clearInterval(this.#collector)
    clearTimeout(this.#channelTimer)
    for (const timer of this.#maintenance) clearInterval(timer)
    const timedOut = () => {
      this.#logger.warn(JSON.stringify({ event: 'llm_maintenance_shutdown_timeout' }))
    }
    try {
      // The HTTP drain (≤30 s) fits the 40 s stop grace period of the llm service.
      await this.gateway.close()
      await withTimeout(
        Promise.allSettled([this.#pool.close(), this.#channel.close()]),
        3000,
        'LLM maintenance shutdown timed out',
      ).catch(timedOut)
      if (this.#jobs.size)
        await withTimeout(
          Promise.allSettled([...this.#jobs.values()]),
          1000,
          'LLM jobs shutdown timed out',
        ).catch(() => {})
      if (this.#collecting)
        await withTimeout(this.#collecting, 1000, 'LLM collector shutdown timed out').catch(
          () => {},
        )
    } finally {
      await withTimeout(this.prisma.$disconnect(), 2000, 'LLM database shutdown timed out').catch(
        () => {
          this.#logger.warn(JSON.stringify({ event: 'llm_database_shutdown_timeout' }))
        },
      )
    }
  }
}

@Module({})
export class LlmAppModule {
  static forRoot(config: LlmRoleConfig): DynamicModule {
    return {
      module: LlmAppModule,
      providers: [
        { provide: PRISMA, useFactory: () => createAppPrisma(config.db) },
        { provide: SECRET_STORE, useFactory: () => createVaultSecretStore(config.vault) },
        {
          provide: LlmRuntime,
          useFactory: (prisma: PrismaClient, secrets: SecretStore) =>
            new LlmRuntime(config, prisma, secrets),
          inject: [PRISMA, SECRET_STORE],
        },
      ],
    }
  }
}
