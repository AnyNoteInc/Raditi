import { randomUUID } from 'node:crypto'

import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import { YookassaApiError, YookassaError } from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { orderFailureReasons } from './failure-text.ts'
import { grantTariffCredits } from './ledger.ts'
import { getCreditBalances } from './read-models.ts'
import { listRefundsNeeded } from './refund.ts'
import {
  ABANDONED_CHECKOUT_AFTER_MS,
  endPeriods,
  RENEWAL_GIVE_UP_MARGIN_MS,
  RENEWAL_RETRY_WINDOW_MS,
  settleStuckOrders,
  type RenewalDeps,
} from './renewal.ts'
import { renewalKey } from './renewal-order.ts'
import {
  refundReasons,
  renewalAuditActions,
  settleOrder,
  settleOrderByPaymentId,
  settlementAuditActions,
  type SettlementDeps,
} from './settlement.ts'
import { billingFixtures, refundTestDeps, TEST_APP_URL, TEST_NOW } from './testing.ts'

// A payment whose id its order never stored: the request that made it was served and its
// answer lost. `settleOrderByPaymentId` — what a notification leads to — reads such a payment
// back and attaches it to the order its metadata names, then settles that order as usual.

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL payment no order holds', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  const emails: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    for (const email of emails.splice(0)) {
      await db.outboxEvent.deleteMany({
        where: { topic: 'notifications', payload: { path: ['to'], equals: email } },
      })
    }
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  const START = new Date('2026-09-04T09:00:00.000Z')
  const END = new Date('2026-10-04T09:00:00.000Z')
  const NEXT_END = new Date('2026-11-04T09:00:00.000Z')
  const { paymentAttached, refundNeeded } = settlementAuditActions

  /** A customer with a workspace, a tariff of 30 credits and the scripted shop. */
  async function customer() {
    const { userId, workspaceId } = await fixtures.workspace()
    const { email } = await db.user.findUniqueOrThrow({ where: { id: userId } })
    emails.push(email)
    const plan = await fixtures.plan()
    return { ...refundTestDeps(db), userId, email, workspaceId, plan }
  }

  /**
   * A tariff whose period ended at 09:00 and whose renewal charge, made at noon, got no answer:
   * the order of the charge is pending and holds no payment. Auto-renewal is still on unless
   * the subscription is given otherwise.
   */
  async function unansweredRenewal(
    subscriptionData: Partial<Prisma.SubscriptionUncheckedCreateInput> = {},
  ) {
    const c = await customer()
    const subscription = await fixtures.subscription({
      workspaceId: c.workspaceId,
      planId: c.plan.id,
      currentPeriodStart: START,
      currentPeriodEnd: END,
      periodAnchor: START,
      renewalNoticePeriodEnd: END,
      paymentMethodId: 'pm-saved',
      paymentMethodType: 'bank_card',
      ...subscriptionData,
    })
    const order = await fixtures.order({
      workspaceId: c.workspaceId,
      planId: c.plan.id,
      userId: c.userId,
      subscriptionId: subscription.id,
      status: 'pending',
      idempotenceKey: renewalKey(subscription.id, END),
      createdAt: TEST_NOW,
    })
    return {
      ...c,
      subscriptionId: subscription.id,
      orderId: order.id,
      // What `chargeOrder` writes into the payment it asks for.
      metadata: {
        order_id: order.id,
        workspace_id: c.workspaceId,
        subscription_id: subscription.id,
      },
    }
  }

  /** The passes of the scheduler over the scripted shop, at a moment after the tests' noon. */
  function passes(shop: SettlementDeps['yookassa'], afterMs: number): RenewalDeps {
    const at = new Date(TEST_NOW.getTime() + afterMs)
    return {
      prisma: db,
      yookassa: {
        getPayment: (id) => shop.getPayment(id),
        chargeWithSavedMethod: () => Promise.reject(new Error('Nobody may be charged here')),
      },
      appUrl: TEST_APP_URL,
      now: () => at,
      settings: { noticeDays: 3, pastDueDays: 7 },
    }
  }
  const GIVEN_UP_AFTER_MS = RENEWAL_RETRY_WINDOW_MS + RENEWAL_GIVE_UP_MARGIN_MS + 60_000

  async function written({ workspaceId }: { workspaceId: string }) {
    const audit = await db.auditLog.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const orders = await db.order.findMany({ where: { workspaceId } })
    return {
      orders,
      order: (id: string) => {
        const order = orders.find((row) => row.id === id)
        if (order === undefined) throw new Error(`The workspace has no order ${id}`)
        return order
      },
      subscriptions: await db.subscription.findMany({ where: { workspaceId } }),
      balances: await getCreditBalances(db, workspaceId),
      audit,
      entries: (action: string) => audit.filter((entry) => entry.action === action),
    }
  }

  const toReturn = async (t: { deps: SettlementDeps; workspaceId: string }) =>
    (await listRefundsNeeded(t.deps)).items.filter((item) => item.workspaceId === t.workspaceId)

  describe('of a renewal charge whose answer was lost', () => {
    it('is attached to its order by the notification and renews the tariff, once', async () => {
      const t = await unansweredRenewal()
      const payment = t.shop.paid('4900.00', t.metadata)

      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
        state: 'paid',
        orderId: t.orderId,
        refundNeeded: false,
      })

      let state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'paid',
        yookassaPaymentId: payment.id,
        periodStart: END,
        periodEnd: NEXT_END,
      })
      expect(state.subscriptions).toMatchObject([
        { status: 'active', currentPeriodStart: END, currentPeriodEnd: NEXT_END },
      ])
      expect(state.balances.tariff.balance).toBe(30)
      expect(state.entries(paymentAttached)).toHaveLength(1)
      expect(state.entries(paymentAttached)[0]).toMatchObject({
        actorType: 'system',
        actorId: 'billing',
        targetType: 'order',
        targetId: t.orderId,
        meta: { paymentId: payment.id, paymentStatus: 'succeeded', amount: '4900.00' },
      })
      expect(state.entries(renewalAuditActions.renewed)).toHaveLength(1)
      expect(await toReturn(t)).toEqual([])

      // The notification again: the order is found by the id now, and nothing happens twice.
      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toMatchObject({
        state: 'paid',
        refundNeeded: false,
      })
      state = await written(t)
      expect(state.balances.tariff.balance).toBe(30)
      expect(state.entries(paymentAttached)).toHaveLength(1)
      expect(state.entries(renewalAuditActions.renewed)).toHaveLength(1)
    })

    it('renews a tariff whose auto-renewal was switched off after the charge was sent', async () => {
      // What «Отвязать», the customer's switch and the operator's `billing:stop-renewal` leave:
      // the charge is not repeated, and it is not returned by itself either.
      const t = await unansweredRenewal({ cancelAtPeriodEnd: true, cancelledAt: TEST_NOW })
      const payment = t.shop.paid('4900.00', t.metadata)

      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toMatchObject({
        state: 'paid',
        refundNeeded: false,
      })

      expect((await written(t)).subscriptions).toMatchObject([
        // One more month, the last one: nothing more is charged.
        { status: 'active', currentPeriodEnd: NEXT_END, cancelAtPeriodEnd: true },
      ])
    })

    it('asks for the money back when the tariff was ended by an operator meanwhile', async () => {
      // `billing:refund --end-subscription` of the order of the period that ended.
      const t = await unansweredRenewal({ status: 'cancelled', cancelAtPeriodEnd: true })
      const payment = t.shop.paid('4900.00', t.metadata)

      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
        state: 'paid',
        orderId: t.orderId,
        refundNeeded: true,
      })

      const state = await written(t)
      expect(state.subscriptions).toMatchObject([{ status: 'cancelled', currentPeriodEnd: END }])
      expect(state.balances.tariff.balance).toBe(0)
      expect(await toReturn(t)).toMatchObject([
        {
          orderId: t.orderId,
          paymentId: payment.id,
          reason: refundReasons.staleRenewal,
          toReturn: '4900.00',
          // A paid order: the command returns it.
          byCommand: true,
        },
      ])
    })

    it('asks for the money back when it comes after the charge was given up', async () => {
      const t = await unansweredRenewal({ cancelAtPeriodEnd: true, cancelledAt: TEST_NOW })
      const payment = t.shop.paid('4900.00', t.metadata)
      expect(
        (await settleStuckOrders(passes(t.deps.yookassa, GIVEN_UP_AFTER_MS))).counts,
      ).toMatchObject({ gave_up: 1 })
      expect((await written(t)).order(t.orderId)).toMatchObject({
        status: 'failed',
        failureReason: orderFailureReasons.unknownResult,
        yookassaPaymentId: null,
      })

      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
        state: 'failed',
        orderId: t.orderId,
        refundNeeded: true,
      })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'failed',
        yookassaPaymentId: payment.id,
      })
      // Nothing is applied for an order that was closed.
      expect(state.subscriptions).toMatchObject([{ currentPeriodEnd: END }])
      expect(state.entries(paymentAttached)).toHaveLength(1)
      expect(state.entries(refundNeeded)).toMatchObject([
        { targetId: t.orderId, meta: { reason: refundReasons.orderClosed, paidAmount: '4900.00' } },
      ])
      expect(await toReturn(t)).toMatchObject([
        {
          orderId: t.orderId,
          paymentId: payment.id,
          reason: refundReasons.orderClosed,
          toReturn: '4900.00',
          byCommand: false,
        },
      ])
      // A repeated notification writes nothing more.
      await settleOrderByPaymentId(t.deps, { paymentId: payment.id })
      const again = await written(t)
      expect(again.entries(refundNeeded)).toHaveLength(1)
      expect(again.entries(paymentAttached)).toHaveLength(1)
    })

    it('fails the order when the bank declined the charge, and the tariff is past due', async () => {
      const t = await unansweredRenewal()
      const payment = t.shop.paid('4900.00', t.metadata)
      t.shop.cancel(payment.id, 'insufficient_funds')

      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
        state: 'failed',
        orderId: t.orderId,
        refundNeeded: false,
      })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'failed',
        failureReason: 'insufficient_funds',
        yookassaPaymentId: payment.id,
      })
      expect(state.subscriptions).toMatchObject([{ status: 'past_due', currentPeriodEnd: END }])
      expect(await toReturn(t)).toEqual([])
    })

    it('keeps the order pending while the payment has no outcome, and holds the tariff', async () => {
      const t = await unansweredRenewal({ cancelAtPeriodEnd: true, cancelledAt: TEST_NOW })
      const payment = t.shop.paid('4900.00', t.metadata)
      t.shop.patch(payment.id, { status: 'pending', paid: false })

      // The operator's `billing:settle-payment` with a payment the bank is still working on.
      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
        state: 'pending',
        orderId: t.orderId,
        refundNeeded: false,
      })

      expect((await written(t)).order(t.orderId)).toMatchObject({
        status: 'pending',
        yookassaPaymentId: payment.id,
      })
      // The tariff does not end while its payment is on its way, and the charge is not given up
      // as unknown: the payment is read back from now on.
      const late = passes(t.deps.yookassa, GIVEN_UP_AFTER_MS)
      expect((await endPeriods(late)).counts.cancelled).toBe(0)
      expect((await settleStuckOrders(late)).counts).toMatchObject({ pending: 1, gave_up: 0 })
      t.shop.succeed(payment.id, { capturedAt: '2026-10-04T12:10:00.000Z' })
      expect((await settleStuckOrders(late)).counts.paid).toBe(1)
      expect((await written(t)).subscriptions).toMatchObject([
        { status: 'active', currentPeriodEnd: NEXT_END },
      ])
    })

    it('is attached and applied once by notifications that come at the same time', async () => {
      const t = await unansweredRenewal()
      const payment = t.shop.paid('4900.00', t.metadata)

      const results = await Promise.all(
        Array.from({ length: 4 }, () => settleOrderByPaymentId(t.deps, { paymentId: payment.id })),
      )

      for (const result of results) {
        expect(result).toEqual({ state: 'paid', orderId: t.orderId, refundNeeded: false })
      }
      const state = await written(t)
      expect(state.entries(paymentAttached)).toHaveLength(1)
      expect(state.entries(renewalAuditActions.renewed)).toHaveLength(1)
      expect(state.balances.tariff.balance).toBe(30)
      expect(state.subscriptions).toMatchObject([{ currentPeriodEnd: NEXT_END }])
    })
  })

  describe('the attachment does not trust what it read a moment before', () => {
    /** The database as settlement sees it, with `then` run right before its first transaction. */
    function beforeAttaching(then: () => Promise<unknown>): PrismaClient {
      let done = false
      return new Proxy(db, {
        get(target, property, receiver) {
          if (property !== '$transaction') return Reflect.get(target, property, receiver)
          return async (...args: unknown[]) => {
            if (!done) {
              done = true
              await then()
            }
            return Reflect.apply(
              target.$transaction as (...a: unknown[]) => Promise<unknown>,
              target,
              args,
            )
          }
        },
      })
    }

    it('still attaches the payment to an order that was given up at that very moment', async () => {
      const t = await unansweredRenewal({ cancelAtPeriodEnd: true, cancelledAt: TEST_NOW })
      const payment = t.shop.paid('4900.00', t.metadata)
      // The order was read as pending; the pass of stuck orders closes it before the update.
      const prisma = beforeAttaching(async () => {
        const pass = await settleStuckOrders(passes(t.deps.yookassa, GIVEN_UP_AFTER_MS))
        expect(pass.counts.gave_up).toBe(1)
      })

      expect(
        await settleOrderByPaymentId({ ...t.deps, prisma }, { paymentId: payment.id }),
      ).toEqual({ state: 'failed', orderId: t.orderId, refundNeeded: true })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'failed',
        failureReason: orderFailureReasons.unknownResult,
        yookassaPaymentId: payment.id,
      })
      expect(state.entries(paymentAttached)).toHaveLength(1)
      expect(await toReturn(t)).toMatchObject([{ orderId: t.orderId, toReturn: '4900.00' }])
      expect((await listRefundsNeeded(t.deps)).unknownCharges.map((c) => c.orderId)).not.toContain(
        t.orderId,
      )
    })

    it('settles the order when the answer of the charge stored the same payment meanwhile', async () => {
      const t = await unansweredRenewal()
      const payment = t.shop.paid('4900.00', t.metadata)
      const prisma = beforeAttaching(() =>
        db.order.update({ where: { id: t.orderId }, data: { yookassaPaymentId: payment.id } }),
      )

      expect(
        await settleOrderByPaymentId({ ...t.deps, prisma }, { paymentId: payment.id }),
      ).toMatchObject({ state: 'paid', orderId: t.orderId, refundNeeded: false })

      const state = await written(t)
      // Stored by the charge itself: nothing was attached here.
      expect(state.entries(paymentAttached)).toEqual([])
      expect(state.subscriptions).toMatchObject([{ currentPeriodEnd: NEXT_END }])
    })

    it('settles the order when the answer of the charge stored the payment while the shop was being asked', async () => {
      const t = await unansweredRenewal()
      const payment = t.shop.paid('4900.00', t.metadata)
      // A notification that outruns the answer of its own charge: no order holds the payment
      // when the notification is taken, and the answer lands during the read-back.
      const yookassa: SettlementDeps['yookassa'] = {
        ...t.deps.yookassa,
        getPayment: async (id) => {
          const read = await t.deps.yookassa.getPayment(id)
          await db.order.update({
            where: { id: t.orderId },
            data: { yookassaPaymentId: payment.id },
          })
          return read
        },
      }

      expect(
        await settleOrderByPaymentId({ ...t.deps, yookassa }, { paymentId: payment.id }),
      ).toMatchObject({ state: 'paid', orderId: t.orderId, refundNeeded: false })

      const state = await written(t)
      // Stored by the charge itself: nothing was attached here.
      expect(state.entries(paymentAttached)).toEqual([])
      expect(state.order(t.orderId)).toMatchObject({ status: 'paid' })
      expect(state.subscriptions).toMatchObject([{ currentPeriodEnd: NEXT_END }])
      expect(state.balances.tariff.balance).toBe(30)
    })

    it('gives an order no second payment when it came to hold another one meanwhile', async () => {
      const t = await unansweredRenewal()
      const payment = t.shop.paid('4900.00', t.metadata)
      const prisma = beforeAttaching(() =>
        db.order.update({ where: { id: t.orderId }, data: { yookassaPaymentId: 'another' } }),
      )

      expect(
        await settleOrderByPaymentId({ ...t.deps, prisma }, { paymentId: payment.id }),
      ).toEqual({ state: 'unknown' })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'pending',
        yookassaPaymentId: 'another',
      })
      expect(state.audit).toEqual([])
    })
  })

  describe('that is not the payment of an order of ours', () => {
    it('is unknown, and nothing is attached or written', async () => {
      const t = await unansweredRenewal()
      const other = await customer()
      const stranger = await fixtures.order({
        workspaceId: other.workspaceId,
        planId: other.plan.id,
        status: 'pending',
      })
      const reads = t.shop.reads.length
      const strangers = [
        // Another amount than the order asked for: a kopeck less, a kopeck more, a ruble.
        t.shop.paid('4899.99', t.metadata),
        t.shop.paid('4900.01', t.metadata),
        t.shop.paid('1.00', t.metadata),
        // The workspace in the metadata is not the order's.
        t.shop.paid('4900.00', { ...t.metadata, workspace_id: other.workspaceId }),
        // No metadata of ours, an order id that is none, an order nobody has.
        t.shop.paid('4900.00'),
        t.shop.paid('4900.00', { workspace_id: t.workspaceId }),
        t.shop.paid('4900.00', { order_id: 'order', workspace_id: t.workspaceId }),
        t.shop.paid('4900.00', { order_id: randomUUID(), workspace_id: t.workspaceId }),
        // The order of another workspace, named with this one.
        t.shop.paid('4900.00', { order_id: stranger.id, workspace_id: t.workspaceId }),
      ]

      for (const payment of strangers) {
        expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
          state: 'unknown',
        })
      }

      // Each was read back once, and that is all.
      expect(t.shop.reads.slice(reads)).toEqual(strangers.map((payment) => payment.id))
      for (const workspace of [t, other]) {
        const state = await written(workspace)
        expect(state.orders.map((order) => order.yookassaPaymentId)).toEqual([null])
        expect(state.orders.map((order) => order.status)).toEqual(['pending'])
        expect(state.audit).toEqual([])
      }
    })

    it('is unknown when the shop does not know the id: a forged notification costs one read', async () => {
      const t = await unansweredRenewal()
      const forged = randomUUID()

      expect(await settleOrderByPaymentId(t.deps, { paymentId: forged })).toEqual({
        state: 'unknown',
      })

      expect(t.shop.reads).toEqual([forged])
      expect((await written(t)).audit).toEqual([])
    })

    it('is not taken on an answer about another payment', async () => {
      const t = await unansweredRenewal()
      const payment = t.shop.paid('4900.00', t.metadata)
      const getPayment = t.deps.yookassa.getPayment
      t.deps.yookassa.getPayment = async (id) => ({ ...(await getPayment(id)), id: `${id}-x` })

      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
        state: 'unknown',
      })

      expect((await written(t)).order(t.orderId).yookassaPaymentId).toBeNull()
    })

    it('is never given to an order that already holds a payment', async () => {
      const t = await unansweredRenewal()
      const own = t.shop.paid('4900.00', t.metadata)
      t.shop.patch(own.id, { status: 'pending', paid: false })
      await db.order.update({ where: { id: t.orderId }, data: { yookassaPaymentId: own.id } })
      const second = t.shop.paid('4900.00', t.metadata)

      expect(await settleOrderByPaymentId(t.deps, { paymentId: second.id })).toEqual({
        state: 'unknown',
      })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({ status: 'pending', yookassaPaymentId: own.id })
      expect(state.audit).toEqual([])
    })

    it('is not attached to an order that is paid or refunded', async () => {
      const t = await customer()
      for (const status of ['paid', 'refunded'] as const) {
        const order = await fixtures.order({
          workspaceId: t.workspaceId,
          planId: t.plan.id,
          status,
        })
        const payment = t.shop.paid('4900.00', {
          order_id: order.id,
          workspace_id: t.workspaceId,
        })

        expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
          state: 'unknown',
        })
      }

      const state = await written(t)
      expect(state.orders.map((order) => order.yookassaPaymentId)).toEqual([null, null])
      expect(state.audit).toEqual([])
    })

    it('lets every failure of the shop but «not found» through: the notification is repeated', async () => {
      const t = await unansweredRenewal()
      const payment = t.shop.paid('4900.00', t.metadata)
      for (const failure of [
        new YookassaError('YooKassa request timed out', { retryable: true }),
        new YookassaApiError('internal_server_error', 500, undefined, {}),
        new YookassaApiError('invalid_credentials', 401, 'invalid_credentials', {}),
        new Error('socket hang up'),
      ]) {
        t.shop.failRead(failure)
        await expect(settleOrderByPaymentId(t.deps, { paymentId: payment.id })).rejects.toBe(
          failure,
        )
      }
      expect((await written(t)).order(t.orderId)).toMatchObject({
        status: 'pending',
        yookassaPaymentId: null,
      })

      // The repeat of the notification finds the shop again.
      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toMatchObject({
        state: 'paid',
      })
    })
  })

  describe('of a checkout that broke off before the payment was stored', () => {
    it('closes a first tariff order when its page expired unpaid', async () => {
      const t = await customer()
      const order = await fixtures.order({
        workspaceId: t.workspaceId,
        planId: t.plan.id,
        userId: t.userId,
        status: 'pending',
        createdAt: TEST_NOW,
      })
      // Nobody was given the page of this payment, so nobody paid: ЮKassa cancels it in an hour.
      const payment = t.shop.paid('4900.00', {
        order_id: order.id,
        workspace_id: t.workspaceId,
      })
      t.shop.cancel(payment.id, 'expired_on_confirmation')

      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
        state: 'failed',
        orderId: order.id,
        refundNeeded: false,
      })

      const state = await written(t)
      expect(state.order(order.id)).toMatchObject({
        status: 'failed',
        failureReason: 'expired_on_confirmation',
        yookassaPaymentId: payment.id,
      })
      expect(state.subscriptions).toEqual([])
      expect(state.entries(paymentAttached)).toMatchObject([
        { targetId: order.id, meta: { paymentStatus: 'canceled' } },
      ])
      // The pass that cancels abandoned checkouts finds nothing left to do.
      const pass = await settleStuckOrders(passes(t.deps.yookassa, ABANDONED_CHECKOUT_AFTER_MS))
      expect(pass.counts.cancelled).toBe(0)
    })

    it('starts the tariff when a first payment came for it all the same', async () => {
      const t = await customer()
      const order = await fixtures.order({
        workspaceId: t.workspaceId,
        planId: t.plan.id,
        userId: t.userId,
        status: 'pending',
      })
      const payment = t.shop.paid('4900.00', {
        order_id: order.id,
        workspace_id: t.workspaceId,
      })

      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
        state: 'paid',
        orderId: order.id,
        refundNeeded: false,
      })

      const state = await written(t)
      expect(state.subscriptions).toMatchObject([{ status: 'active', planId: t.plan.id }])
      expect(state.balances.tariff.balance).toBe(30)
      expect(state.order(order.id)).toMatchObject({
        status: 'paid',
        yookassaPaymentId: payment.id,
        subscriptionId: state.subscriptions[0]?.id,
      })
    })

    it('asks for the money back when the checkout was already closed as failed', async () => {
      // `requestPayment` closes an order whose request failed twice; the shop had served it.
      const t = await customer()
      const order = await fixtures.order({
        workspaceId: t.workspaceId,
        planId: t.plan.id,
        userId: t.userId,
        status: 'failed',
        failureReason: orderFailureReasons.checkoutUnavailable,
      })
      const payment = t.shop.paid('4900.00', {
        order_id: order.id,
        workspace_id: t.workspaceId,
      })

      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
        state: 'failed',
        orderId: order.id,
        refundNeeded: true,
      })

      expect((await written(t)).subscriptions).toEqual([])
      expect(await toReturn(t)).toMatchObject([
        { orderId: order.id, paymentId: payment.id, reason: refundReasons.orderClosed },
      ])
      // The order's own page tells the same from now on.
      expect(await settleOrder(t.deps, { orderId: order.id })).toMatchObject({
        state: 'failed',
        refundNeeded: true,
      })
    })

    /** The pack the seeds put on sale, and a tariff that takes tasks. */
    async function packOrder(status: 'pending' | 'cancelled' = 'pending') {
      const t = await customer()
      const pack = await db.plan.findFirst({
        where: { kind: 'pack', isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
      })
      if (pack === null || pack.packCredits === null) {
        throw new Error('No credit pack is on sale in this database: apply the seeds')
      }
      await fixtures.subscription({ workspaceId: t.workspaceId, planId: t.plan.id })
      const order = await fixtures.order({
        workspaceId: t.workspaceId,
        planId: pack.id,
        userId: t.userId,
        kind: 'pack',
        amount: pack.price,
        status,
        createdAt: TEST_NOW,
      })
      const payment = t.shop.paid(pack.price.toFixed(2), {
        order_id: order.id,
        workspace_id: t.workspaceId,
      })
      return { ...t, orderId: order.id, payment, credits: pack.packCredits }
    }

    it('closes a pack order when its page expired unpaid', async () => {
      const t = await packOrder()
      t.shop.cancel(t.payment.id, 'expired_on_confirmation')

      expect(await settleOrderByPaymentId(t.deps, { paymentId: t.payment.id })).toEqual({
        state: 'failed',
        orderId: t.orderId,
        refundNeeded: false,
      })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'failed',
        failureReason: 'expired_on_confirmation',
        yookassaPaymentId: t.payment.id,
      })
      expect(state.balances.pack.balance).toBe(0)
    })

    it('grants a pack whose payment came all the same, once', async () => {
      const t = await packOrder()

      const results = await Promise.all([
        settleOrderByPaymentId(t.deps, { paymentId: t.payment.id }),
        settleOrderByPaymentId(t.deps, { paymentId: t.payment.id }),
      ])

      for (const result of results) {
        expect(result).toEqual({ state: 'paid', orderId: t.orderId, refundNeeded: false })
      }
      const state = await written(t)
      expect(state.balances.pack.balance).toBe(t.credits)
      expect(state.entries(paymentAttached)).toHaveLength(1)
    })

    it('asks for the money of a pack back when its order was cancelled as abandoned', async () => {
      const t = await packOrder('cancelled')

      expect(await settleOrderByPaymentId(t.deps, { paymentId: t.payment.id })).toEqual({
        state: 'cancelled',
        orderId: t.orderId,
        refundNeeded: true,
      })

      expect((await written(t)).balances.pack.balance).toBe(0)
      expect(await toReturn(t)).toMatchObject([
        { orderId: t.orderId, kind: 'pack', reason: refundReasons.orderClosed, byCommand: false },
      ])
    })
  })

  // The order `startPastDuePayment` makes: a subscription order of the subscription whose key
  // is not `renew.…`. Its checkout may break off like any other; the pass of stuck orders
  // cancels it after an hour.
  describe('of a payment by hand for an overdue tariff', () => {
    const PAST_DUE_SINCE = new Date('2026-10-04T09:05:00.000Z')

    async function overdue() {
      const c = await customer()
      const subscription = await fixtures.subscription({
        workspaceId: c.workspaceId,
        planId: c.plan.id,
        status: 'past_due',
        currentPeriodStart: START,
        currentPeriodEnd: END,
        periodAnchor: START,
        pastDueSince: PAST_DUE_SINCE,
        paymentMethodId: 'pm-declined',
        paymentMethodType: 'bank_card',
      })
      const first = await fixtures.order({
        workspaceId: c.workspaceId,
        planId: c.plan.id,
        userId: c.userId,
        subscriptionId: subscription.id,
        periodStart: START,
        periodEnd: END,
        paidAt: START,
      })
      await db.$transaction((tx) =>
        grantTariffCredits(tx, { workspaceId: c.workspaceId, orderId: first.id, credits: 7 }),
      )
      // «Оплатить сейчас» at noon; the process died before the id of the payment was stored.
      const order = await fixtures.order({
        workspaceId: c.workspaceId,
        planId: c.plan.id,
        userId: c.userId,
        subscriptionId: subscription.id,
        status: 'pending',
        savePaymentMethod: true,
        createdAt: TEST_NOW,
      })
      const payment = c.shop.paid('4900.00', {
        order_id: order.id,
        workspace_id: c.workspaceId,
      })
      return { ...c, subscriptionId: subscription.id, orderId: order.id, payment }
    }

    it('makes the tariff active again for a month from the payment when the money came', async () => {
      const t = await overdue()
      t.shop.patch(t.payment.id, { captured_at: '2026-10-04T12:20:00.000Z' })

      expect(await settleOrderByPaymentId(t.deps, { paymentId: t.payment.id })).toEqual({
        state: 'paid',
        orderId: t.orderId,
        refundNeeded: false,
      })

      const paidAt = new Date('2026-10-04T12:20:00.000Z')
      const state = await written(t)
      expect(state.subscriptions).toMatchObject([
        {
          status: 'active',
          currentPeriodStart: paidAt,
          currentPeriodEnd: new Date('2026-11-04T12:20:00.000Z'),
          periodAnchor: paidAt,
          pastDueSince: null,
        },
      ])
      // What was left of the old quota expired; the quota of the paid month is granted.
      expect(state.balances.tariff.balance).toBe(30)
      expect(state.entries(paymentAttached)).toHaveLength(1)
      expect(state.entries(settlementAuditActions.pastDuePayment)).toHaveLength(1)
      expect(await toReturn(t)).toEqual([])
    })

    it('fails the order when the page expired unpaid, and the tariff stays overdue', async () => {
      const t = await overdue()
      t.shop.cancel(t.payment.id, 'expired_on_confirmation')

      expect(await settleOrderByPaymentId(t.deps, { paymentId: t.payment.id })).toEqual({
        state: 'failed',
        orderId: t.orderId,
        refundNeeded: false,
      })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'failed',
        failureReason: 'expired_on_confirmation',
      })
      expect(state.subscriptions).toMatchObject([
        { status: 'past_due', currentPeriodEnd: END, pastDueSince: PAST_DUE_SINCE },
      ])
      expect(state.balances.tariff.balance).toBe(7)
    })

    it('asks for the money back when the notification comes after the order was cancelled as abandoned', async () => {
      const t = await overdue()
      // An hour later nobody holds a page to pay the order on: the pass cancels it.
      const pass = passes(t.deps.yookassa, ABANDONED_CHECKOUT_AFTER_MS + 60_000)
      expect((await settleStuckOrders(pass)).counts.cancelled).toBe(1)
      expect((await written(t)).order(t.orderId)).toMatchObject({
        status: 'cancelled',
        yookassaPaymentId: null,
      })

      expect(await settleOrderByPaymentId(t.deps, { paymentId: t.payment.id })).toEqual({
        state: 'cancelled',
        orderId: t.orderId,
        refundNeeded: true,
      })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'cancelled',
        yookassaPaymentId: t.payment.id,
      })
      // Nothing is applied for a cancelled order: the tariff still waits for a payment the
      // customer makes on a page, and this money goes back.
      expect(state.subscriptions).toMatchObject([
        { status: 'past_due', currentPeriodEnd: END, pastDueSince: PAST_DUE_SINCE },
      ])
      expect(state.balances.tariff.balance).toBe(7)
      expect(state.entries(settlementAuditActions.pastDuePayment)).toEqual([])
      expect(await toReturn(t)).toMatchObject([
        {
          orderId: t.orderId,
          orderStatus: 'cancelled',
          paymentId: t.payment.id,
          reason: refundReasons.orderClosed,
          toReturn: '4900.00',
          byCommand: false,
        },
      ])
      // Neither pass touches the order again, and the cancelled payment of another such order
      // would owe nothing.
      expect((await settleStuckOrders(pass)).counts).toMatchObject({ cancelled: 0, paid: 0 })
    })

    it('holds the end of the grace while an attached payment has no outcome yet', async () => {
      const t = await overdue()
      t.shop.patch(t.payment.id, { status: 'pending', paid: false })

      expect(await settleOrderByPaymentId(t.deps, { paymentId: t.payment.id })).toMatchObject({
        state: 'pending',
      })

      // Eight days later the grace is over, but the payment decides: the order is not cancelled
      // as abandoned any more, and the tariff is not expired past it.
      const late = passes(t.deps.yookassa, 8 * 24 * 60 * 60_000)
      expect((await settleStuckOrders(late)).counts).toMatchObject({ pending: 1, cancelled: 0 })
      expect((await endPeriods(late)).counts.expired).toBe(0)
      t.shop.cancel(t.payment.id, 'expired_on_confirmation')
      expect((await settleStuckOrders(late)).counts.failed).toBe(1)
      expect((await endPeriods(late)).counts.expired).toBe(1)
    })
  })
})
