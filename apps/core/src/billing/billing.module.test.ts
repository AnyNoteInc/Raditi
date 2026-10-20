import { getQueueToken } from '@nestjs/bullmq'
import {
  Global,
  Module,
  type DynamicModule,
  type INestApplication,
  type Type,
} from '@nestjs/common'
import { testRunnerConfig } from '@repo/runner-engine/testing'
import { Test } from '@nestjs/testing'
import type { Registry } from '@prometheus-io/client'
import { renewalJobs, renewalOutcomes } from '@repo/billing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { METRICS_REGISTRY, PRISMA } from '@repo/service-runtime'
import { RunnerModule } from '@repo/runner-engine'

import type { CoreConfig } from '../config/config.ts'
import { CoreConfigModule } from '../core/core-config.module.ts'
import { CoreModule } from '../core/core.module.ts'
import { YOOKASSA } from '../infra/tokens.ts'
import { fakeInfra, overrideCoreInfra, testCoreConfig } from '../testing/fakes.ts'
import { BILLING_QUEUE, BillingJobs } from './billing-jobs.ts'
import { BillingScheduler } from './billing-scheduler.ts'
import { BillingModule } from './billing.module.ts'
import { BillingProcessor } from './billing.processor.ts'

const apps: INestApplication[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

const fakeQueue = () => ({
  name: BILLING_QUEUE,
  add: vi.fn(() => Promise.resolve({ id: 'job' })),
  on: vi.fn(),
  close: vi.fn(() => Promise.resolve()),
  getBackend: () => ({ close: vi.fn(() => Promise.resolve()) }),
  upsertJobScheduler: vi.fn(() => Promise.resolve({ id: 'job' })),
})

/** The whole core role as tests compile it: fakes for every connection, no background work. */
async function core() {
  const infra = fakeInfra()
  const queue = fakeQueue()
  const moduleRef = await overrideCoreInfra(
    Test.createTestingModule({
      imports: [CoreModule.forRoot({ config: testCoreConfig(), background: false })],
    }),
    infra,
  )
    .overrideProvider(getQueueToken(BILLING_QUEUE))
    .useValue(queue)
    .compile()
  const app = moduleRef.createNestApplication({ logger: false })
  apps.push(app)
  await app.init()
  return { app, infra, queue }
}

/**
 * The billing module alone with background work on. No BullModule.forRoot beside it, so no
 * worker is started and nothing connects to Redis: the queue is the fake.
 */
async function billingWithBackground(config: CoreConfig) {
  const queue = fakeQueue()
  @Global()
  @Module({
    providers: [
      { provide: PRISMA, useValue: {} },
      { provide: YOOKASSA, useValue: null },
      { provide: getQueueToken(BILLING_QUEUE), useValue: queue },
    ],
    exports: [PRISMA, YOOKASSA, getQueueToken(BILLING_QUEUE)],
  })
  class FakeConnections {}
  const moduleRef = await Test.createTestingModule({
    imports: [
      CoreConfigModule.forRoot({ config, background: true }),
      FakeConnections,
      BillingModule,
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  apps.push(app)
  await app.init()
  return { app, queue }
}

/** Whether `target` is among the modules a role module imports, however deep. */
function imports(root: DynamicModule | Type, target: Type, seen = new Set<unknown>()): boolean {
  const module = 'module' in root ? root.module : root
  if (module === target) return true
  if (seen.has(module)) return false
  seen.add(module)
  const declared = (Reflect.getMetadata('imports', module) ?? []) as (DynamicModule | Type)[]
  const dynamic = ('module' in root ? (root.imports ?? []) : []) as (DynamicModule | Type)[]
  return [...declared, ...dynamic].some(
    (imported) => typeof imported !== 'string' && imports(imported, target, seen),
  )
}

describe('BillingModule in the core role', () => {
  it('wires the passes, their worker and their schedulers', async () => {
    const { app } = await core()

    expect(app.get(BillingJobs)).toBeInstanceOf(BillingJobs)
    expect(app.get(BillingProcessor)).toBeInstanceOf(BillingProcessor)
    expect(app.get(BillingScheduler)).toBeInstanceOf(BillingScheduler)
  })

  it('starts no scheduler and no worker without background work', async () => {
    const { app, infra, queue } = await core()

    expect(queue.upsertJobScheduler).not.toHaveBeenCalled()
    // The worker of a processor exists only once BullMQ registered it.
    expect(() => app.get(BillingProcessor).worker).toThrow()
    // And nothing was read: the passes run only as jobs.
    expect(infra.prisma.$queryRaw).not.toHaveBeenCalled()
  })

  it('registers its schedulers with background work on, at the configured interval', async () => {
    const config = testCoreConfig()
    const { queue } = await billingWithBackground({
      ...config,
      billing: { ...config.billing, tickSeconds: 2 },
    })

    await vi.waitFor(() => expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(4))
    expect(queue.upsertJobScheduler.mock.calls).toEqual(
      renewalJobs.map((job) => [`billing.${job}`, { every: 2_000 }, { name: job }]),
    )
  })

  it('exposes a counter of rows by pass and outcome, at zero from the start', async () => {
    const { app } = await core()

    const metrics = await app.get<Registry>(METRICS_REGISTRY).metrics()

    for (const job of renewalJobs) {
      for (const outcome of renewalOutcomes[job]) {
        expect(metrics).toContain(
          `raditi_billing_renewal_rows_total{job="${job}",outcome="${outcome}",app="core"} 0`,
        )
      }
    }
    expect(metrics).toContain('raditi_billing_renewal_rows_total{job="charges",outcome="renewed"')
    expect(metrics).toContain('{job="period_ends",outcome="expired"')
    // No label but the pass and the outcome.
    const labels = [...metrics.matchAll(/^raditi_billing_renewal_rows_total\{([^}]*)\}/gm)].map(
      ([, inner = '']) => inner.replace(/="[^"]*"/g, ''),
    )
    expect(new Set(labels)).toEqual(new Set(['job,outcome,app']))
  })

  it('belongs to core alone: the runner renew nothing', () => {
    const coreModule = CoreModule.forRoot({ config: testCoreConfig(), background: false })
    expect(imports(coreModule, BillingModule)).toBe(true)

    const others = [RunnerModule.forRoot(testRunnerConfig())]
    for (const module of others) expect(imports(module, BillingModule)).toBe(false)
  })
})
