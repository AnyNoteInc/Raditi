import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import { Global, Module, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import {
  isRenewalOrder,
  renewalJobAuditActions,
  renewalJobs,
  renewalKey,
  writeBillingAudit,
} from '@repo/billing'
import { createPrismaClient, ensurePersonalWorkspace, type PrismaClient } from '@repo/db'
import type { ChargeSavedInput, Payment } from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PRISMA } from '@repo/service-runtime'

import type { BillingConfig } from '../config/config.ts'
import { CoreConfigModule } from '../config/config.module.ts'
import { MetricsRegistryModule } from '../metrics/metrics-registry.module.ts'
import { testCoreConfig } from '../testing/fakes.ts'
import { BILLING_QUEUE, BillingJobs } from './billing-jobs.ts'
import { BillingModule } from './billing.module.ts'
import { BillingProcessor } from './billing.processor.ts'
import { YOOKASSA } from './billing.tokens.ts'

// Only verify:db's disposable PostgreSQL (and the gateway-db job of CI): the passes look at
// every due row of the database. The rows stand in 2021, where nothing else is due.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const START = new Date('2021-03-10T09:00:00.000Z')
const NOW = new Date('2021-04-10T10:00:00.000Z')
/** More subscriptions than one batch of a pass takes (50). */
const SUBSCRIPTIONS = 55

const config: BillingConfig = {
  appUrl: 'https://raditi.example',
  renewalNoticeDays: 3,
  pastDueDays: 7,
  tickSeconds: 300,
}

/** A shop where every charge succeeds at once; a repeated key answers with its first payment. */
function shop() {
  const payments = new Map<string, Payment>()
  const idByKey = new Map<string, string>()
  const charges: string[] = []
  return {
    charges,
    payments,
    async chargeWithSavedMethod(input: ChargeSavedInput, idempotenceKey: string) {
      charges.push(idempotenceKey)
      // The answer takes a moment: two passes overlap inside it.
      await new Promise((resolve) => setTimeout(resolve, 2))
      const id = idByKey.get(idempotenceKey) ?? randomUUID()
      idByKey.set(idempotenceKey, id)
      const payment: Payment = payments.get(id) ?? {
        id,
        status: 'succeeded',
        paid: true,
        amount: { value: input.amount.value, currency: 'RUB' },
        created_at: NOW.toISOString(),
        captured_at: NOW.toISOString(),
        ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        payment_method: { id: input.payment_method_id, type: 'bank_card', saved: true },
      }
      payments.set(id, payment)
      return structuredClone(payment)
    },
    async getPayment(paymentId: string) {
      const payment = payments.get(paymentId)
      if (payment === undefined) throw new Error(`No payment ${paymentId}`)
      return structuredClone(payment)
    },
  }
}

describe.skipIf(!enabled)('renewal passes of core with PostgreSQL', () => {
  let db: PrismaClient
  const userIds: string[] = []
  const workspaceIds: string[] = []
  const planIds: string[] = []
  const emails: string[] = []
  const apps: INestApplication[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close()
    const workspaces = { workspaceId: { in: workspaceIds.splice(0) } }
    for (const email of emails.splice(0)) {
      await db.outboxEvent.deleteMany({
        where: { topic: 'notifications', payload: { path: ['to'], equals: email } },
      })
    }
    await db.creditLedger.deleteMany({ where: { account: workspaces } })
    await db.billingAccount.deleteMany({ where: workspaces })
    await db.order.deleteMany({ where: workspaces })
    await db.subscription.deleteMany({ where: workspaces })
    await db.auditLog.deleteMany({ where: workspaces })
    await db.workspace.deleteMany({ where: { id: workspaces.workspaceId } })
    await db.plan.deleteMany({ where: { id: { in: planIds.splice(0) } } })
    await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /**
   * Subscriptions whose period has ended, with a saved card and the notice of the period
   * recorded — the mark and the audit entry of what the letter named: every one of them is
   * due for its charge. Their periods end a second apart, in an order that is neither the
   * order of their creation nor of their ids. Returned by the end of the period, the earliest
   * first.
   */
  async function dueSubscriptions(count: number) {
    const plan = await db.plan.create({
      data: {
        slug: `test-${randomUUID()}`,
        name: 'Проверочный',
        kind: 'quota',
        price: '4900.00',
        creditsPerMonth: 30,
        maxSites: 1,
        isActive: false,
      },
    })
    planIds.push(plan.id)
    const subscriptions: { id: string; periodEnd: Date }[] = []
    for (let index = 0; index < count; index += 1) {
      const email = `${randomUUID()}@billing.example.ru`
      const user = await db.user.create({ data: { name: 'Billing verification', email } })
      userIds.push(user.id)
      emails.push(email)
      const workspace = await db.$transaction((tx) =>
        ensurePersonalWorkspace(tx, { userId: user.id, appEnv: 'test' }),
      )
      workspaceIds.push(workspace.id)
      // 37 and the count share no divisor: every second from 0 to count - 1 is taken once.
      const periodStart = new Date(START.getTime() + ((index * 37) % count) * 1_000)
      // March has 31 days: a month after the start, to the second.
      const periodEnd = new Date(periodStart.getTime() + 31 * 24 * 60 * 60_000)
      const subscription = await db.subscription.create({
        data: {
          workspaceId: workspace.id,
          planId: plan.id,
          status: 'active',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          periodAnchor: periodStart,
          paymentMethodId: `pm-${user.id}`,
          paymentMethodType: 'bank_card',
          renewalNoticePeriodEnd: periodEnd,
        },
      })
      await writeBillingAudit(db, {
        actor: { type: 'system', id: 'billing' },
        workspaceId: workspace.id,
        action: renewalJobAuditActions.notice,
        target: { type: 'subscription', id: subscription.id },
        meta: {
          planSlug: plan.slug,
          amount: plan.price.toFixed(2),
          chargeAt: periodEnd.toISOString(),
        },
      })
      subscriptions.push({ id: subscription.id, periodEnd })
    }
    return subscriptions.sort((a, b) => a.periodEnd.getTime() - b.periodEnd.getTime())
  }

  const core = (yookassa: ReturnType<typeof shop>) =>
    new BillingJobs({
      prisma: db,
      yookassa,
      config,
      logger: { log: vi.fn(), warn: vi.fn() },
      now: () => NOW,
    })

  async function renewalOrders() {
    const orders = await db.order.findMany({ where: { workspaceId: { in: workspaceIds } } })
    return orders.filter(isRenewalOrder)
  }

  it(
    'works through more than one batch in the order of the period ends',
    { timeout: 60_000 },
    async () => {
      const subscriptions = await dueSubscriptions(SUBSCRIPTIONS)
      const yookassa = shop()

      await core(yookassa).run('charges')

      expect(yookassa.charges).toEqual(
        subscriptions.map(({ id, periodEnd }) => renewalKey(id, periodEnd)),
      )
      const orders = await renewalOrders()
      expect(orders).toHaveLength(SUBSCRIPTIONS)
      expect(orders.every((order) => order.status === 'paid')).toBe(true)
      // The months went on from the anchor: nothing was re-anchored on the way.
      const anchored = await db.subscription.count({
        where: { workspaceId: { in: workspaceIds }, periodAnchor: { lt: NOW } },
      })
      expect(anchored).toBe(SUBSCRIPTIONS)
    },
  )

  it('charges only what the last notice named: a price changed since is announced first', async () => {
    await dueSubscriptions(1)
    // The notice of the period named 4 900 ₽; the price of the plan was changed afterwards.
    await db.plan.updateMany({ where: { id: { in: planIds } }, data: { price: '6900.00' } })
    const yookassa = shop()
    const jobs = core(yookassa)

    await jobs.run('charges')
    expect(yookassa.charges).toEqual([])
    expect(await renewalOrders()).toEqual([])

    // The next ticks: the letter with the real amount, then the charge of that amount.
    await jobs.run('notices')
    await jobs.run('charges')

    const [order, ...others] = await renewalOrders()
    expect(others).toEqual([])
    expect(order?.status).toBe('paid')
    expect(order?.amount.toFixed(2)).toBe('6900.00')
    expect(yookassa.charges).toHaveLength(1)
    const letters = await db.outboxEvent.findMany({
      where: { topic: 'notifications', payload: { path: ['to'], equals: emails[0] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    expect(letters.map((letter) => [letter.type, letter.payload])).toEqual([
      ['billing.renewal_notice', expect.objectContaining({ amount: '6900.00' })],
      ['billing.payment_succeeded', expect.objectContaining({ amount: '6900.00' })],
    ])
  })

  it(
    'makes one renewal order and one charge per subscription when two ticks, of two processes, run at once',
    { timeout: 60_000 },
    async () => {
      const subscriptions = await dueSubscriptions(SUBSCRIPTIONS)
      const yookassa = shop()
      const first = core(yookassa)
      const second = core(yookassa)

      await Promise.all([
        first.run('charges'),
        second.run('charges'),
        first.run('charges'),
        second.run('stuck_orders'),
        first.run('period_ends'),
      ])

      const orders = await renewalOrders()
      expect(orders).toHaveLength(SUBSCRIPTIONS)
      expect(new Set(orders.map((order) => order.subscriptionId)).size).toBe(SUBSCRIPTIONS)
      expect(new Set(orders.map((order) => order.idempotenceKey))).toEqual(
        new Set(subscriptions.map(({ id, periodEnd }) => renewalKey(id, periodEnd))),
      )
      expect(orders.every((order) => order.status === 'paid')).toBe(true)
      // One request and one payment for each: nobody was charged twice.
      expect(yookassa.charges).toHaveLength(SUBSCRIPTIONS)
      expect(new Set(yookassa.charges).size).toBe(SUBSCRIPTIONS)
      expect(yookassa.payments.size).toBe(SUBSCRIPTIONS)

      // Every subscription moved one period on, was granted one quota and told once.
      const rows = await db.subscription.findMany({ where: { workspaceId: { in: workspaceIds } } })
      expect(rows).toHaveLength(SUBSCRIPTIONS)
      for (const row of rows) {
        const before = subscriptions.find(({ id }) => id === row.id)
        expect(row.status).toBe('active')
        expect(row.currentPeriodStart).toEqual(before?.periodEnd)
        expect(row.currentPeriodEnd.getTime()).toBeGreaterThan(NOW.getTime())
      }
      const accounts = await db.billingAccount.findMany({
        where: { workspaceId: { in: workspaceIds }, unit: 'credit_tariff' },
      })
      expect(accounts).toHaveLength(SUBSCRIPTIONS)
      expect(accounts.every((account) => account.balance.equals(30))).toBe(true)
      expect(
        await db.creditLedger.count({ where: { account: { workspaceId: { in: workspaceIds } } } }),
      ).toBe(SUBSCRIPTIONS)
      for (const email of emails.slice(0, 5)) {
        const letters = await db.outboxEvent.findMany({
          where: { topic: 'notifications', payload: { path: ['to'], equals: email } },
        })
        expect(letters.map((letter) => letter.type)).toEqual(['billing.payment_succeeded'])
      }

      // The next tick finds nothing to do.
      await Promise.all(renewalJobs.map((job) => first.run(job)))
      expect(yookassa.charges).toHaveLength(SUBSCRIPTIONS)
      expect(await renewalOrders()).toHaveLength(SUBSCRIPTIONS)
    },
  )

  describe('the module on the real database', () => {
    const fakeQueue = () => ({
      name: BILLING_QUEUE,
      on: vi.fn(),
      close: vi.fn(() => Promise.resolve()),
      upsertJobScheduler: vi.fn(() => Promise.resolve({ id: 'job' })),
    })

    /** BillingModule with the real PostgreSQL, a scripted shop and a queue that records. */
    async function module(background: boolean, yookassa: ReturnType<typeof shop> | null) {
      const queue = fakeQueue()
      @Global()
      @Module({
        providers: [
          { provide: PRISMA, useValue: db },
          { provide: getQueueToken(BILLING_QUEUE), useValue: queue },
        ],
        exports: [PRISMA, getQueueToken(BILLING_QUEUE)],
      })
      class Connections {}
      const moduleRef = await Test.createTestingModule({
        imports: [
          CoreConfigModule.forRoot({ config: testCoreConfig(), background }),
          Connections,
          MetricsRegistryModule,
          BillingModule,
        ],
      })
        .overrideProvider(YOOKASSA)
        .useValue(yookassa)
        .compile()
      const app = moduleRef.createNestApplication({ logger: false })
      apps.push(app)
      await app.init()
      return { app, queue }
    }

    it('registers its schedulers only with background work on', async () => {
      const off = await module(false, null)
      await new Promise((resolve) => setImmediate(resolve))
      expect(off.queue.upsertJobScheduler).not.toHaveBeenCalled()

      const on = await module(true, null)
      await vi.waitFor(() => expect(on.queue.upsertJobScheduler).toHaveBeenCalledTimes(4))
      expect(on.queue.upsertJobScheduler.mock.calls).toEqual(
        renewalJobs.map((job) => [
          `billing.${job}`,
          { every: testCoreConfig().billing.tickSeconds * 1_000 },
          { name: job },
        ]),
      )
    })

    it('runs every pass as a job of the queue against the database', async () => {
      const { app } = await module(false, null)
      const processor = app.get(BillingProcessor)

      // Payments are off in the test configuration and nothing is due «now»: the four passes
      // read the real tables and change nothing.
      for (const job of renewalJobs) {
        await expect(
          processor.process({ name: job, id: `repeat:billing.${job}:1`, data: {} } as never),
        ).resolves.toBeUndefined()
      }
    })
  })
})
