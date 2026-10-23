import { Buffer } from 'node:buffer'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { getQueueToken } from '@nestjs/bullmq'
import {
  Global,
  Module,
  type DynamicModule,
  type INestApplication,
  type Type,
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Registry } from '@prometheus-io/client'
import { renewalJobs, renewalOutcomes } from '@repo/billing'
import type { YookassaClient } from '@repo/yookassa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRISMA } from '@repo/service-runtime'

import { AppModule } from '../app.module.ts'
import type { CoreConfig } from '../config/config.ts'
import { CoreConfigModule } from '../config/config.module.ts'
import { MetricsRegistryModule } from '../metrics/metrics-registry.module.ts'
import { METRICS_REGISTRY } from '../metrics/metrics.tokens.ts'
import { fakeInfra, overrideCoreInfra, testCoreConfig } from '../testing/fakes.ts'
import { BILLING_QUEUE, BillingJobs } from './billing-jobs.ts'
import { BillingScheduler } from './billing-scheduler.ts'
import { BillingModule } from './billing.module.ts'
import { BillingProcessor } from './billing.processor.ts'
import { YOOKASSA } from './billing.tokens.ts'

const apps: INestApplication[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  )
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
      imports: [AppModule.forRoot({ config: testCoreConfig(), background: false })],
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
  const moduleRef = await billingModule(config, true, queue)
    .overrideProvider(YOOKASSA)
    .useValue(null)
    .compile()
  const app = moduleRef.createNestApplication({ logger: false })
  apps.push(app)
  await app.init()
  return { app, queue }
}

/** The billing module beside a fake database and queue, with the registry of the process. */
function billingModule(config: CoreConfig, background: boolean, queue = fakeQueue()) {
  @Global()
  @Module({
    providers: [
      { provide: PRISMA, useValue: {} },
      { provide: getQueueToken(BILLING_QUEUE), useValue: queue },
    ],
    exports: [PRISMA, getQueueToken(BILLING_QUEUE)],
  })
  class FakeConnections {}
  return Test.createTestingModule({
    imports: [
      CoreConfigModule.forRoot({ config, background }),
      FakeConnections,
      MetricsRegistryModule,
      BillingModule,
    ],
  })
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

  it('belongs to core: its root module imports it', () => {
    // No other app can: apps-are-isolated, and the runner reaches no billing even transitively
    // (runner-no-platform-access).
    const coreModule = AppModule.forRoot({ config: testCoreConfig(), background: false })
    expect(imports(coreModule, BillingModule)).toBe(true)
  })
})

describe('BillingModule: the ЮKassa client', () => {
  it('provides none while payments are off', async () => {
    expect(testCoreConfig().yookassa).toBeNull()
    const moduleRef = await billingModule(testCoreConfig(), false).compile()

    expect(moduleRef.get<YookassaClient | null>(YOOKASSA)).toBeNull()
    await moduleRef.close()
  })

  it('provides a client of the configured shop that calls the configured address', async () => {
    const requests: { url: string | undefined; authorization: string | undefined }[] = []
    const server = createServer((req, res) => {
      requests.push({ url: req.url, authorization: req.headers.authorization })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'pmt_1',
          status: 'succeeded',
          paid: true,
          amount: { value: '4900.00', currency: 'RUB' },
          created_at: '2026-10-04T00:00:00Z',
        }),
      )
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    const moduleRef = await billingModule(
      {
        ...testCoreConfig(),
        yookassa: {
          shopId: '123456',
          secretKey: 'test_shop-secret-key',
          baseUrl: `http://127.0.0.1:${port}/v3`,
          webhookAllowlist: ['127.0.0.1'],
          autopayments: true,
        },
      },
      false,
    ).compile()
    const client = moduleRef.get<YookassaClient>(YOOKASSA)

    expect((await client.getPayment('pmt_1')).status).toBe('succeeded')
    expect(requests).toEqual([
      {
        url: '/v3/payments/pmt_1',
        authorization: `Basic ${Buffer.from('123456:test_shop-secret-key').toString('base64')}`,
      },
    ])
    // The credentials stay inside the client: nothing of them shows on the provided object.
    expect(JSON.stringify(client)).not.toContain('test_shop-secret-key')
    await moduleRef.close()
  })
})
