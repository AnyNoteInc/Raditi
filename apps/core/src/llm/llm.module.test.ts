import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Registry } from '@prometheus-io/client'
import type { PrismaClient } from '@repo/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRISMA } from '@repo/service-runtime'
import { CredentialSweeper, GatewayTurnCredentials } from '@repo/turn-keys'

import type { CoreConfig } from '../config/config.ts'
import { CoreConfigModule } from '../core/core-config.module.ts'
import { InfraModule } from '../infra/infra.module.ts'
import { TURN_CREDENTIALS, METRICS_REGISTRY } from '../infra/tokens.ts'
import { fakeInfra, overrideCoreInfra, testCoreConfig } from '../testing/fakes.ts'
import { sampleBackendId, sampleDriverId } from '../testing/ids.ts'
import {
  CoreCredentialRuntime,
  LlmModule,
  TURN_CREDENTIAL_SWEEP_INTERVAL_MS,
} from './llm.module.ts'

const apps: INestApplication[] = []
const runtimes: CoreCredentialRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.onModuleDestroy()
  for (const app of apps.splice(0)) await app.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function application(config: CoreConfig = testCoreConfig(), prisma?: PrismaClient) {
  const infra = fakeInfra()
  const builder = overrideCoreInfra(
    Test.createTestingModule({
      imports: [CoreConfigModule.forRoot({ config, background: false }), InfraModule, LlmModule],
    }),
    infra,
  )
  if (prisma) builder.overrideProvider(PRISMA).useValue(prisma)
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication({ logger: false })
  apps.push(app)
  await app.init()
  return { app, infra }
}

function runtime(background = true) {
  const sweeper = { tick: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const logger = { warn: vi.fn() }
  const runtime = new CoreCredentialRuntime(sweeper, background, logger)
  runtimes.push(runtime)
  return { runtime, sweeper, logger }
}

describe('LlmModule core wiring', () => {
  it('exports the durable credential port and starts no I/O with background jobs disabled', async () => {
    const sweep = vi.spyOn(CredentialSweeper.prototype, 'tick')
    const { app, infra } = await application()
    const credentials = app.get<GatewayTurnCredentials>(TURN_CREDENTIALS)
    expect(credentials).toBeInstanceOf(GatewayTurnCredentials)
    expect(app.get(GatewayTurnCredentials)).toBe(credentials)
    expect(app.get(CredentialSweeper)).toBeInstanceOf(CredentialSweeper)
    expect(app.get(CoreCredentialRuntime)).toBeInstanceOf(CoreCredentialRuntime)
    expect(infra.prisma.$queryRaw).not.toHaveBeenCalled()
    expect(infra.secrets.health).not.toHaveBeenCalled()
    expect(infra.redis.ping).not.toHaveBeenCalled()
    expect(sweep).not.toHaveBeenCalled()
    const metrics = await app.get<Registry>(METRICS_REGISTRY).metrics()
    expect(metrics).toContain('raditi_llm_credentials_swept_total{kind="expired",app="core"} 0')
  })

  it('constructs the configured private probe without issuing a request at bootstrap', async () => {
    const { app, infra } = await application({
      ...testCoreConfig(),
      llmControlUrl: 'http://127.0.0.1:1',
      minTurnHeadroomPct: 17,
    })
    expect(app.get(TURN_CREDENTIALS)).toBeInstanceOf(GatewayTurnCredentials)
    expect(infra.prisma.$queryRaw).not.toHaveBeenCalled()
    expect(infra.secrets.health).not.toHaveBeenCalled()
  })

  it('counts successful cleanup by aggregate kind in the core metrics registry', async () => {
    const key = {
      id: '00000000-0000-4000-8000-000000000001',
      taskId: '00000000-0000-4000-8000-000000000002',
      sessionId: 'synthetic-session',
      turnNo: 1,
      firstEpoch: 1,
      revokeRequestedAt: null,
      expired: true,
    }
    const query = vi.fn(async (parts: TemplateStringsArray) =>
      parts.join(' ').includes('FROM llm_keys k WHERE k.revoked_at IS NULL') ? [key] : [],
    )
    const prisma = {
      $queryRaw: query,
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({ $queryRaw: query }),
      ),
      $disconnect: vi.fn(async () => {}),
    } as unknown as PrismaClient
    const { app } = await application(testCoreConfig(), prisma)
    const revoke = vi
      .spyOn(app.get<GatewayTurnCredentials>(TURN_CREDENTIALS), 'revoke')
      .mockResolvedValue()
    await app.get<CredentialSweeper>(CredentialSweeper).tick()
    expect(revoke).toHaveBeenCalledExactlyOnceWith({
      taskId: key.taskId,
      sessionId: key.sessionId,
      turn: 1,
      epoch: 1,
    })
    const metrics = await app.get<Registry>(METRICS_REGISTRY).metrics()
    expect(metrics).toContain('raditi_llm_credentials_swept_total{kind="expired",app="core"} 1')
    expect(metrics).not.toContain(key.taskId)
    expect(metrics).not.toContain(key.sessionId)
  })

  it('issues no key outside an open assignment of the turn', async () => {
    const ref = {
      taskId: '00000000-0000-4000-8000-000000000002',
      sessionId: 'synthetic-session',
      turn: 1,
      epoch: 1,
    }
    const now = new Date()
    const query = vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join(' ')
      if (sql.includes('FOR UPDATE OF l'))
        return [{ id: ref.taskId, attempt: 1, dataClass: 'synthetic', now }]
      if (sql.includes('SELECT EXISTS')) return [{ owned: true }]
      return [{ now }]
    })
    const tx = {
      $queryRaw: query,
      taskEvent: { findFirst: vi.fn(async () => null) },
      turnAssignment: { findFirst: vi.fn(async () => null) },
      llmKey: { findUnique: vi.fn(async () => null) },
    }
    const prisma = {
      $queryRaw: query,
      $transaction: vi.fn(async (work: (value: unknown) => Promise<unknown>) => work(tx)),
      $disconnect: vi.fn(async () => {}),
    } as unknown as PrismaClient
    const { app, infra } = await application(testCoreConfig(), prisma)
    await expect(
      app.get<GatewayTurnCredentials>(TURN_CREDENTIALS).issue(ref, {
        driverId: sampleDriverId,
        backend: sampleBackendId,
        modelSlug: 'synthetic',
        modelClass: 'standard',
        reasoningEffort: null,
        ttlMs: 600_000,
        deadlineAt: new Date(now.getTime() + 1_200_000),
        budgetRub: '200.00',
        boundSource: null,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.turnAssignment.findFirst).toHaveBeenCalled()
    // Refused before the key lookup, selection or any Vault access.
    expect(tx.llmKey.findUnique).not.toHaveBeenCalled()
    expect(infra.secrets.health).not.toHaveBeenCalled()
  })
})

describe('CoreCredentialRuntime', () => {
  it('starts once immediately, then every minute, without keeping the process alive', async () => {
    vi.useFakeTimers()
    const interval = vi.spyOn(globalThis, 'setInterval')
    const t = runtime()
    t.runtime.onApplicationBootstrap()
    t.runtime.onApplicationBootstrap()
    await t.runtime.tick()
    expect(t.sweeper.tick).toHaveBeenCalledOnce()
    expect(interval).toHaveBeenCalledOnce()
    expect((interval.mock.results[0]!.value as NodeJS.Timeout).hasRef()).toBe(false)
    await vi.advanceTimersByTimeAsync(TURN_CREDENTIAL_SWEEP_INTERVAL_MS - 1)
    expect(t.sweeper.tick).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(t.sweeper.tick).toHaveBeenCalledTimes(2)
  })

  it('coalesces a running sweep across several timer intervals', async () => {
    vi.useFakeTimers()
    const t = runtime()
    const gate = Promise.withResolvers<void>()
    t.sweeper.tick.mockImplementationOnce(() => gate.promise)
    t.runtime.onApplicationBootstrap()
    const first = t.runtime.tick()
    expect(t.runtime.tick()).toBe(first)
    await vi.advanceTimersByTimeAsync(3 * TURN_CREDENTIAL_SWEEP_INTERVAL_MS)
    expect(t.sweeper.tick).toHaveBeenCalledOnce()
    gate.resolve()
    await first
    await vi.advanceTimersByTimeAsync(TURN_CREDENTIAL_SWEEP_INTERVAL_MS)
    expect(t.sweeper.tick).toHaveBeenCalledTimes(2)
  })

  it('does not start a timer or sweep in tools and tests', async () => {
    vi.useFakeTimers()
    const t = runtime(false)
    t.runtime.onApplicationBootstrap()
    await vi.advanceTimersByTimeAsync(10 * TURN_CREDENTIAL_SWEEP_INTERVAL_MS)
    expect(t.sweeper.tick).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await t.runtime.onModuleDestroy()
    expect(t.sweeper.close).toHaveBeenCalledOnce()
  })

  it('clears the timer before closing and refuses further sweeps while one is pending', async () => {
    vi.useFakeTimers()
    const t = runtime()
    const gate = Promise.withResolvers<void>()
    t.sweeper.tick.mockImplementationOnce(() => gate.promise)
    t.sweeper.close.mockImplementation(async () => {
      expect(vi.getTimerCount()).toBe(0)
    })
    t.runtime.onApplicationBootstrap()
    const pending = t.runtime.tick()
    await vi.advanceTimersByTimeAsync(0)
    await t.runtime.onModuleDestroy()
    await t.runtime.tick()
    await vi.advanceTimersByTimeAsync(2 * TURN_CREDENTIAL_SWEEP_INTERVAL_MS)
    expect(t.sweeper.tick).toHaveBeenCalledOnce()
    gate.resolve()
    await pending
    await t.runtime.onModuleDestroy()
    expect(t.sweeper.close).toHaveBeenCalledOnce()
  })

  it('logs a rejected sweep safely and keeps subsequent passes running', async () => {
    vi.useFakeTimers()
    const t = runtime()
    t.sweeper.tick.mockRejectedValueOnce(new Error('provider-secret-in-response'))
    t.runtime.onApplicationBootstrap()
    await t.runtime.tick()
    expect(t.logger.warn).toHaveBeenCalledExactlyOnceWith(
      'llm_credentials_sweep_failed kind=runtime',
    )
    await vi.advanceTimersByTimeAsync(TURN_CREDENTIAL_SWEEP_INTERVAL_MS)
    expect(t.sweeper.tick).toHaveBeenCalledTimes(2)
  })
})
