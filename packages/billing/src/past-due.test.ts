import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import { billingPeriod, nextBillingPeriod } from '@repo/domain'
import {
  YookassaApiError,
  YookassaError,
  type ChargeSavedInput,
  type Payment,
} from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import { startCheckout, startPastDuePayment, syncOrder } from './checkout.ts'
import type { BillingDeps } from './deps.ts'
import { orderFailureReasons } from './failure-text.ts'
import { grantTariffCredits, ledgerKeys } from './ledger.ts'
import { getCreditBalances, getPlanOverview } from './read-models.ts'
import {
  chargeRenewals,
  endPeriods,
  sendRenewalNotices,
  settleStuckOrders,
  STUCK_ORDER_AFTER_MS,
  type RenewalDeps,
} from './renewal.ts'
import { isRenewalOrder, renewalKey } from './renewal-order.ts'
import {
  paymentLetterKey,
  refundReasons,
  renewalAuditActions,
  settleOrder,
  settleOrderByPaymentId,
  settlementAuditActions,
} from './settlement.ts'
import { cancelAutoRenew, cancelPlanChange, schedulePlanChange } from './subscription-changes.ts'
import { billingFixtures, billingTestDeps, TEST_APP_URL, TEST_NOW } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const USER = '0199a000-0000-7000-8000-0000000000c3'
const NBSP = String.fromCharCode(0xa0)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const timeout = () => new YookassaError('YooKassa request timed out', { retryable: true })
const badRequest = () => new YookassaApiError('invalid_request', 400, 'invalid_request', {})

describe('the payment of an overdue tariff without a database', () => {
  it('refuses a broken user and anything beside it', async () => {
    // Reaching the database or the shop with a refused input would throw a TypeError on the
    // missing client: only the schema throws a ZodError.
    const deps = {} as BillingDeps
    await expect(startPastDuePayment(deps, { userId: 'user' })).rejects.toBeInstanceOf(ZodError)
    await expect(startPastDuePayment(deps, {} as { userId: string })).rejects.toBeInstanceOf(
      ZodError,
    )
    for (const extra of [{ planSlug: 'start' }, { autoRenew: true }, { orderId: USER }]) {
      await expect(
        startPastDuePayment(deps, { userId: USER, ...extra } as { userId: string }),
      ).rejects.toBeInstanceOf(ZodError)
    }
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL payment of an overdue tariff', () => {
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

  const PERIOD_START = new Date('2026-09-03T09:00:00.000Z')
  const PERIOD_END = new Date('2026-10-03T09:00:00.000Z')
  const PAST_DUE_SINCE = new Date('2026-10-03T09:05:00.000Z')
  /** When the customer pays: a day after the charge failed, an hour before the tests stand. */
  const PAID_AT = '2026-10-04T11:00:00.000Z'
  const CARD = {
    paymentMethodId: 'pm-old',
    paymentMethodTitle: 'Bank card *1111',
    paymentMethodType: 'bank_card',
    paymentMethodCardType: 'Visa',
    paymentMethodLast4: '1111',
  }
  const NO_CARD = {
    paymentMethodId: null,
    paymentMethodTitle: null,
    paymentMethodType: null,
    paymentMethodCardType: null,
    paymentMethodLast4: null,
  }

  /**
   * A customer whose tariff of 30 credits a month ended on 3 October 2026 and whose renewal
   * charge was declined: past due, with the card that was declined still saved, auto-renewal
   * on, 7 credits left of the quota and the failed renewal order of the period — unless told
   * otherwise.
   */
  async function overdue(patch: Partial<Prisma.SubscriptionUncheckedCreateInput> = {}) {
    const { userId, workspaceId } = await fixtures.workspace()
    const { email } = await db.user.findUniqueOrThrow({ where: { id: userId } })
    emails.push(email)
    const plan = await fixtures.plan()
    const first = await fixtures.order({
      workspaceId,
      planId: plan.id,
      userId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      paidAt: PERIOD_START,
      createdAt: PERIOD_START,
    })
    await db.$transaction((tx) =>
      grantTariffCredits(tx, { workspaceId, orderId: first.id, credits: 7 }),
    )
    const subscription = await fixtures.subscription({
      workspaceId,
      planId: plan.id,
      status: 'past_due',
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      periodAnchor: PERIOD_START,
      pastDueSince: PAST_DUE_SINCE,
      renewalNoticePeriodEnd: PERIOD_END,
      ...CARD,
      ...patch,
    })
    await fixtures.order({
      workspaceId,
      planId: plan.id,
      userId,
      subscriptionId: subscription.id,
      status: 'failed',
      failureReason: 'insufficient_funds',
      idempotenceKey: renewalKey(subscription.id, subscription.currentPeriodEnd),
      createdAt: PERIOD_END,
    })
    return {
      ...billingTestDeps(db),
      userId,
      email,
      workspaceId,
      plan,
      subscriptionId: subscription.id,
    }
  }
  type Overdue = Awaited<ReturnType<typeof overdue>>

  /** The orders the customer made by hand, oldest first: not the first one, not a renewal. */
  async function byHand({ workspaceId, subscriptionId }: Overdue) {
    const orders = await db.order.findMany({
      where: { workspaceId, subscriptionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return orders.filter((order) => !isRenewalOrder(order))
  }

  async function written({ workspaceId, subscriptionId }: Overdue) {
    const audit = await db.auditLog.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return {
      subscription: await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } }),
      audit,
      actions: audit.map((entry) => entry.action),
      entry: (action: string) => audit.filter((entry) => entry.action === action),
      ledger: await db.creditLedger.findMany({
        where: { account: { workspaceId } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    }
  }

  const lettersTo = (email: string) =>
    db.outboxEvent.findMany({
      where: { topic: 'notifications', payload: { path: ['to'], equals: email } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })

  /** «Оплатить сейчас», then the customer pays on the page of the shop. */
  async function paid(s: Overdue, options: { saved?: boolean; capturedAt?: string } = {}) {
    const checkout = await startPastDuePayment(s.deps, { userId: s.userId })
    const { yookassaPaymentId } = await db.order.findUniqueOrThrow({
      where: { id: checkout.orderId },
    })
    s.shop.succeed(yookassaPaymentId ?? '', { capturedAt: PAID_AT, ...options })
    return { ...checkout, paymentId: yookassaPaymentId ?? '' }
  }

  const { pastDuePayment, refundNeeded } = settlementAuditActions

  describe('the start of the payment', () => {
    it('makes an order of the subscription for the tariff at its price of today, with a page to pay on', async () => {
      const s = await overdue()

      const checkout = await startPastDuePayment(s.deps, { userId: s.userId })

      const [order, ...others] = await byHand(s)
      expect(others).toEqual([])
      const payment = s.shop.only()
      expect(order).toMatchObject({
        id: checkout.orderId,
        workspaceId: s.workspaceId,
        userId: s.userId,
        kind: 'subscription',
        planId: s.plan.id,
        subscriptionId: s.subscriptionId,
        status: 'pending',
        yookassaPaymentId: payment.id,
        // Auto-renewal is on: the method of this payment is saved for the charges to come.
        savePaymentMethod: true,
        periodStart: null,
        periodEnd: null,
        paidAt: null,
      })
      expect(order?.amount.toFixed(2)).toBe('4900.00')
      // A key of its own, not the key of a renewal: the period is counted from the payment.
      expect(order?.idempotenceKey).toMatch(UUID)
      expect(checkout).toEqual({
        orderId: order?.id,
        confirmationUrl: payment.confirmation?.confirmation_url,
      })
      expect(s.shop.created).toEqual([
        {
          idempotenceKey: order?.idempotenceKey,
          input: {
            amount: { value: '4900.00', currency: 'RUB' },
            capture: true,
            save_payment_method: true,
            confirmation: {
              type: 'redirect',
              return_url: `${TEST_APP_URL}/settings/billing/return?order=${order?.id}`,
            },
            description: 'Радити: тариф «Проверочный» на месяц',
            metadata: { order_id: order?.id, workspace_id: s.workspaceId },
          },
        },
      ])
      // Nothing changes until the money comes.
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'past_due',
        currentPeriodEnd: PERIOD_END,
        pastDueSince: PAST_DUE_SINCE,
      })
      expect(state.audit).toEqual([])
    })

    it('never asks to save the method when auto-renewal is off', async () => {
      const s = await overdue({ cancelAtPeriodEnd: true, cancelledAt: TEST_NOW })

      await startPastDuePayment(s.deps, { userId: s.userId })

      expect((await byHand(s))[0]).toMatchObject({ savePaymentMethod: false })
      // Said out loud: left out, the ЮKassa page offers the buyer to save the method.
      expect(s.shop.created[0]?.input.save_payment_method).toBe(false)
    })

    it('is made for the scheduled tariff at its price when a change is scheduled', async () => {
      const next = await fixtures.plan({ name: 'Больше', price: '12900.00', creditsPerMonth: 80 })
      const s = await overdue({ nextPlanId: next.id })

      await startPastDuePayment(s.deps, { userId: s.userId })

      const [order] = await byHand(s)
      expect(order).toMatchObject({ planId: next.id })
      expect(order?.amount.toFixed(2)).toBe('12900.00')
      expect(s.shop.created[0]?.input).toMatchObject({
        amount: { value: '12900.00', currency: 'RUB' },
        description: 'Радити: тариф «Больше» на месяц',
      })
    })

    it('takes the price the tariff has today, not the one the failed charge asked', async () => {
      const s = await overdue()
      await db.plan.update({ where: { id: s.plan.id }, data: { price: '5400.00' } })

      await startPastDuePayment(s.deps, { userId: s.userId })

      expect((await byHand(s))[0]?.amount.toFixed(2)).toBe('5400.00')
    })

    it.each([
      ['a user without a workspace', async () => (await fixtures.user()).userId],
      ['a workspace without a tariff', async () => (await fixtures.workspace()).userId],
      ['a tariff that has expired', async () => (await overdue({ status: 'expired' })).userId],
    ])('is refused for %s', async (_case, user) => {
      const userId = await user()
      const { deps, shop } = billingTestDeps(db)

      await expect(startPastDuePayment(deps, { userId })).rejects.toMatchObject({
        code: 'BILLING_NO_LIVE_SUBSCRIPTION',
      })
      expect(shop.created).toEqual([])
    })

    it('is refused for a tariff that is paid for: nothing is owed', async () => {
      const s = await overdue({ status: 'active', pastDueSince: null })

      await expect(startPastDuePayment(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_NOTHING_TO_CHANGE',
      })

      expect(await byHand(s)).toEqual([])
      expect(s.shop.created).toEqual([])
    })

    it.each([
      ['has lost its price', { price: '0.00' }],
      // The quota and the price are still there: it is the kind that makes a tariff.
      ['is no tariff with a quota any more', { kind: 'payg' }],
    ] as const)(
      'is refused for a tariff that cannot be charged for any more: it %s',
      async (_case, data) => {
        const s = await overdue()
        await db.plan.update({ where: { id: s.plan.id }, data })

        await expect(startPastDuePayment(s.deps, { userId: s.userId })).rejects.toMatchObject({
          code: 'BILLING_PLAN_NOT_FOUND',
        })
        expect(await byHand(s)).toEqual([])
        expect(s.shop.created).toEqual([])
      },
    )

    it('is taken for a tariff that is no longer sold: its customer still pays for it', async () => {
      const s = await overdue()
      expect(s.plan.isActive).toBe(false)

      await expect(startPastDuePayment(s.deps, { userId: s.userId })).resolves.toMatchObject({
        confirmationUrl: expect.stringMatching(/^https:/),
      })
    })

    it('gives the same order and page again, without a second payment', async () => {
      const s = await overdue()
      const first = await startPastDuePayment(s.deps, { userId: s.userId })

      const again = await startPastDuePayment(s.deps, { userId: s.userId })

      expect(again).toEqual(first)
      expect(s.shop.created).toHaveLength(1)
      expect(s.shop.reads).toEqual([s.shop.only().id])
      expect(await byHand(s)).toHaveLength(1)
    })

    it('gives one order to starts that race', async () => {
      const s = await overdue()

      const results = await Promise.all(
        Array.from({ length: 5 }, () => startPastDuePayment(s.deps, { userId: s.userId })),
      )

      expect(new Set(results.map((result) => result.orderId)).size).toBe(1)
      expect(new Set(results.map((result) => result.confirmationUrl)).size).toBe(1)
      expect(await byHand(s)).toHaveLength(1)
      expect(s.shop.payments.size).toBe(1)
    })

    it('asks the shop again with the key of an order whose payment was never stored', async () => {
      const s = await overdue()
      s.shop.failCreate(timeout(), { processed: true })
      s.shop.failCreate(timeout())
      await expect(startPastDuePayment(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_PAYMENTS_NOT_CONFIGURED',
      })
      // The request was made twice and failed twice: the order is closed, nobody holds a page.
      expect((await byHand(s)).map((order) => order.status)).toEqual(['failed'])

      // An order left pending without a payment — the process died before the answer.
      const stale = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: s.plan.id,
        userId: s.userId,
        subscriptionId: s.subscriptionId,
        status: 'pending',
        savePaymentMethod: true,
      })
      const checkout = await startPastDuePayment(s.deps, { userId: s.userId })

      expect(checkout.orderId).toBe(stale.id)
      expect(s.shop.created.at(-1)?.idempotenceKey).toBe(stale.idempotenceKey)
      expect(await db.order.findUnique({ where: { id: stale.id } })).toMatchObject({
        status: 'pending',
        yookassaPaymentId: expect.any(String),
      })
    })

    it.each([
      [
        'auto-renewal was switched off since',
        (s: Overdue) => cancelAutoRenew(s.deps, { userId: s.userId }),
        { savePaymentMethod: false },
      ],
      [
        'the price of the tariff changed since',
        (s: Overdue) => db.plan.update({ where: { id: s.plan.id }, data: { price: '5400.00' } }),
        { savePaymentMethod: true },
      ],
    ])('cancels the unfinished order and makes a new one when %s', async (_case, change, made) => {
      const s = await overdue()
      const first = await startPastDuePayment(s.deps, { userId: s.userId })
      await change(s)

      const second = await startPastDuePayment(s.deps, { userId: s.userId })

      expect(second.orderId).not.toBe(first.orderId)
      expect(second.confirmationUrl).not.toBe(first.confirmationUrl)
      expect((await byHand(s)).map((order) => [order.id, order.status])).toEqual([
        [first.orderId, 'cancelled'],
        [second.orderId, 'pending'],
      ])
      expect((await byHand(s))[1]).toMatchObject(made)
      expect(s.shop.created).toHaveLength(2)
    })

    it('makes a new order, and never asks the shop under the old key, when the price changed past an order whose payment was never stored', async () => {
      const s = await overdue()
      // The process died before the answer of the shop: an order at 4 900 ₽ without a payment.
      const stale = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: s.plan.id,
        userId: s.userId,
        subscriptionId: s.subscriptionId,
        status: 'pending',
        savePaymentMethod: true,
      })
      await db.plan.update({ where: { id: s.plan.id }, data: { price: '5400.00' } })

      const checkout = await startPastDuePayment(s.deps, { userId: s.userId })

      // A request under the old key would make a payment of the old amount.
      expect(checkout.orderId).not.toBe(stale.id)
      expect(await db.order.findUnique({ where: { id: stale.id } })).toMatchObject({
        status: 'cancelled',
        yookassaPaymentId: null,
      })
      expect(s.shop.created.map((request) => request.idempotenceKey)).not.toContain(
        stale.idempotenceKey,
      )
      expect(s.shop.only().amount.value).toBe('5400.00')
      expect(await db.order.findUnique({ where: { id: checkout.orderId } })).toMatchObject({
        status: 'pending',
        subscriptionId: s.subscriptionId,
      })
    })

    it('makes a new order when the shop does not know the payment of the unfinished one', async () => {
      const s = await overdue()
      const first = await startPastDuePayment(s.deps, { userId: s.userId })
      // Another shop, a stand that was restarted: nobody can pay that order or learn of it.
      s.shop.payments.delete(s.shop.only().id)

      const second = await startPastDuePayment(s.deps, { userId: s.userId })

      expect(second.orderId).not.toBe(first.orderId)
      expect(second.confirmationUrl).not.toBe(first.confirmationUrl)
      expect((await byHand(s)).map((order) => [order.id, order.status])).toEqual([
        [first.orderId, 'cancelled'],
        [second.orderId, 'pending'],
      ])
      expect((await written(s)).subscription.status).toBe('past_due')
    })

    it('never pays for the tariff through an unfinished order that is not of this subscription', async () => {
      const s = await overdue()
      // What no checkout leaves beside a live tariff, written past them: a first-payment order
      // of the same tariff, consent and price. Paid, it would start nothing and reactivate nothing.
      const foreign = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: s.plan.id,
        userId: s.userId,
        status: 'pending',
        savePaymentMethod: true,
      })

      const checkout = await startPastDuePayment(s.deps, { userId: s.userId })

      expect(checkout.orderId).not.toBe(foreign.id)
      expect(await db.order.findUnique({ where: { id: foreign.id } })).toMatchObject({
        status: 'cancelled',
        subscriptionId: null,
      })
      expect(await db.order.findUnique({ where: { id: checkout.orderId } })).toMatchObject({
        status: 'pending',
        subscriptionId: s.subscriptionId,
      })
      expect(s.shop.created.map((request) => request.idempotenceKey)).not.toContain(
        foreign.idempotenceKey,
      )
    })

    it('waits for the settlement that is paying the tariff, and makes no second order once it is paid', async () => {
      const s = await overdue()
      let starting: Promise<unknown> | undefined

      await db.$transaction(async (settling) => {
        // A payment made in another tab is being applied: its settlement holds the row.
        await settling.$queryRaw`
          SELECT id FROM subscriptions WHERE id = ${s.subscriptionId}::uuid FOR NO KEY UPDATE
        `
        starting = startPastDuePayment(s.deps, { userId: s.userId }).then(
          (checkout) => checkout,
          (error: unknown) => error,
        )
        const first = await Promise.race([
          starting.then(() => 'answered'),
          new Promise<string>((resolve) => setTimeout(resolve, 500, 'waiting')),
        ])
        expect(first).toBe('waiting')
        await settling.subscription.update({
          where: { id: s.subscriptionId },
          data: { status: 'active', pastDueSince: null },
        })
      })

      // Read after the settlement: nothing is owed, and nobody is sent to pay again.
      expect(await starting).toMatchObject({ code: 'BILLING_NOTHING_TO_CHANGE' })
      expect(await byHand(s)).toEqual([])
      expect(s.shop.created).toEqual([])
    })

    it('follows a change of tariff scheduled or taken back while the first page was open', async () => {
      const next = await fixtures.plan({ isActive: true, name: 'Больше', price: '12900.00' })
      const s = await overdue()
      const first = await startPastDuePayment(s.deps, { userId: s.userId })

      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug })
      const second = await startPastDuePayment(s.deps, { userId: s.userId })
      await cancelPlanChange(s.deps, { userId: s.userId })
      const third = await startPastDuePayment(s.deps, { userId: s.userId })

      const orders = await byHand(s)
      expect(orders.map((order) => [order.id, order.status, order.planId])).toEqual([
        [first.orderId, 'cancelled', s.plan.id],
        [second.orderId, 'cancelled', next.id],
        [third.orderId, 'pending', s.plan.id],
      ])
      expect(orders.map((order) => order.amount.toFixed(2))).toEqual([
        '4900.00',
        '12900.00',
        '4900.00',
      ])
    })

    it('makes a new order for another tariff even when it costs the same', async () => {
      // The same amount buys another quota: the order names the tariff it pays for.
      const next = await fixtures.plan({ isActive: true, name: 'Другой', creditsPerMonth: 60 })
      const s = await overdue()
      const first = await startPastDuePayment(s.deps, { userId: s.userId })

      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug })
      const second = await startPastDuePayment(s.deps, { userId: s.userId })

      expect(next.price.equals(s.plan.price)).toBe(true)
      expect(second.orderId).not.toBe(first.orderId)
      expect((await byHand(s)).map((order) => [order.id, order.status, order.planId])).toEqual([
        [first.orderId, 'cancelled', s.plan.id],
        [second.orderId, 'pending', next.id],
      ])
    })

    it('asks an operator to return a payment made on the page of an order that was replaced', async () => {
      const s = await overdue()
      const first = await startPastDuePayment(s.deps, { userId: s.userId })
      const firstPayment = s.shop.only().id
      await cancelAutoRenew(s.deps, { userId: s.userId })
      const second = await startPastDuePayment(s.deps, { userId: s.userId })

      // The customer pays on the page they opened first.
      s.shop.succeed(firstPayment, { saved: true, capturedAt: PAID_AT })
      const settlement = await settleOrderByPaymentId(s.deps, { paymentId: firstPayment })

      expect(settlement).toEqual({ state: 'cancelled', orderId: first.orderId, refundNeeded: true })
      const state = await written(s)
      expect(state.subscription).toMatchObject({ status: 'past_due', ...CARD })
      expect(state.entry(refundNeeded)).toMatchObject([
        { targetId: first.orderId, meta: { reason: refundReasons.orderClosed } },
      ])
      // The order that took its place is still theirs to pay.
      expect(await db.order.findUnique({ where: { id: second.orderId } })).toMatchObject({
        status: 'pending',
      })
    })

    it('sends the customer to the page of the order when it turns out to be paid', async () => {
      const s = await overdue()
      const first = await paid(s)

      const again = await startPastDuePayment(s.deps, { userId: s.userId })

      expect(again).toEqual({
        orderId: first.orderId,
        confirmationUrl: `${TEST_APP_URL}/settings/billing/return?order=${first.orderId}`,
      })
      // Settled on the way: the tariff is active.
      expect((await written(s)).subscription.status).toBe('active')
      expect(s.shop.created).toHaveLength(1)
    })

    it('goes to the page of the order when the shop takes the money without a page', async () => {
      const s = await overdue()
      s.shop.createAs({
        status: 'succeeded',
        paid: true,
        captured_at: PAID_AT,
        confirmation: undefined,
      })

      const checkout = await startPastDuePayment(s.deps, { userId: s.userId })

      expect(checkout.confirmationUrl).toBe(
        `${TEST_APP_URL}/settings/billing/return?order=${checkout.orderId}`,
      )
      expect((await written(s)).subscription.status).toBe('active')
    })

    it('makes a new order after the bank declined the payment of the one before', async () => {
      const s = await overdue()
      const first = await startPastDuePayment(s.deps, { userId: s.userId })
      s.shop.cancel(s.shop.only().id, 'insufficient_funds')

      const second = await startPastDuePayment(s.deps, { userId: s.userId })

      expect(second.orderId).not.toBe(first.orderId)
      expect((await byHand(s)).map((order) => [order.status, order.failureReason])).toEqual([
        ['failed', 'insufficient_funds'],
        ['pending', null],
      ])
      expect((await written(s)).subscription.status).toBe('past_due')
    })

    it('waits for a payment the customer has confirmed and the bank has not answered', async () => {
      const s = await overdue()
      await startPastDuePayment(s.deps, { userId: s.userId })
      s.shop.patch(s.shop.only().id, { confirmation: undefined })

      await expect(startPastDuePayment(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_PAYMENT_IN_PROGRESS',
      })
      expect(await byHand(s)).toHaveLength(1)
    })

    it('closes the order and answers that payments are unavailable when the shop refuses', async () => {
      const s = await overdue()
      s.shop.failCreate(badRequest())

      await expect(startPastDuePayment(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_PAYMENTS_NOT_CONFIGURED',
      })

      expect(await byHand(s)).toMatchObject([
        { status: 'failed', failureReason: orderFailureReasons.checkoutRejected },
      ])
      expect((await written(s)).subscription.status).toBe('past_due')
      // The next try starts anew.
      await expect(startPastDuePayment(s.deps, { userId: s.userId })).resolves.toMatchObject({
        orderId: expect.stringMatching(UUID),
      })
    })

    it('leaves a renewal charge without an outcome alone: it decides by itself', async () => {
      const s = await overdue()
      await db.order.updateMany({
        where: { subscriptionId: s.subscriptionId, status: 'failed' },
        data: { status: 'pending', failureReason: null },
      })

      await expect(startPastDuePayment(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_PAYMENT_IN_PROGRESS',
      })
      expect(await byHand(s)).toEqual([])
      expect(s.shop.created).toEqual([])
    })
  })

  describe('a paid order', () => {
    it('makes the tariff active for a month from the payment, with a new quota and a letter', async () => {
      const s = await overdue()
      const { orderId } = await paid(s)

      const settlement = await settleOrder(s.deps, { orderId })

      expect(settlement).toEqual({ state: 'paid', orderId, refundNeeded: false })
      const paidAt = new Date(PAID_AT)
      const periodEnd = new Date('2026-11-04T11:00:00.000Z')
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        planId: s.plan.id,
        nextPlanId: null,
        // A new run of periods: a month from the payment, which is its anchor.
        currentPeriodStart: paidAt,
        currentPeriodEnd: periodEnd,
        periodAnchor: paidAt,
        pastDueSince: null,
        renewalNoticePeriodEnd: null,
        cancelAtPeriodEnd: false,
      })
      expect(await db.order.findUnique({ where: { id: orderId } })).toMatchObject({
        status: 'paid',
        paidAt,
        periodStart: paidAt,
        periodEnd,
        subscriptionId: s.subscriptionId,
      })
      // The seven credits of the period that ended are gone, the quota of the tariff is granted.
      expect((await getCreditBalances(db, s.workspaceId)).tariff).toEqual({
        balance: 30,
        held: 0,
        available: 30,
      })
      expect(
        state.ledger.map((row) => [row.kind, row.amount.toNumber(), row.idempotencyKey]),
      ).toEqual([
        ['grant', 7, expect.stringMatching(/:grant$/)],
        ['expire', -7, ledgerKeys.tariffExpiry(s.subscriptionId, PERIOD_END)],
        ['grant', 30, ledgerKeys.tariffGrant(orderId)],
      ])
      expect(state.actions).toEqual([pastDuePayment])
      expect(state.audit[0]).toMatchObject({
        actorType: 'user',
        actorId: s.userId,
        workspaceId: s.workspaceId,
        targetType: 'subscription',
        targetId: s.subscriptionId,
        meta: {
          orderId,
          planSlug: s.plan.slug,
          planChanged: false,
          amount: '4900.00',
          credits: 30,
          expiredCredits: 7,
          periodStart: PAID_AT,
          periodEnd: periodEnd.toISOString(),
          overduePeriodEnd: PERIOD_END.toISOString(),
          pastDueSince: PAST_DUE_SINCE.toISOString(),
          autoRenewal: true,
          paymentMethodReplaced: false,
          notified: true,
        },
      })
      expect((await lettersTo(s.email)).map((letter) => [letter.type, letter.payload])).toEqual([
        [
          'billing.payment_succeeded',
          {
            item: 'plan',
            planName: 'Проверочный',
            amount: '4900.00',
            periodEnd: periodEnd.toISOString(),
            credits: 30,
            appUrl: TEST_APP_URL,
            to: s.email,
          },
        ],
      ])
      expect((await getPlanOverview(db, s.workspaceId)).subscription).toMatchObject({
        status: 'active',
        pastDueSince: null,
        period: { start: paidAt, end: periodEnd },
      })
    })

    it('is told to the return page of the order with the tariff active again', async () => {
      const s = await overdue()
      const { orderId } = await paid(s)

      const order = await syncOrder(s.deps, { userId: s.userId, orderId })

      expect(order).toMatchObject({
        orderId,
        status: 'paid',
        kind: 'subscription',
        planName: 'Проверочный',
        amount: '4900.00',
        refundNeeded: false,
        subscription: {
          status: 'active',
          period: { start: new Date(PAID_AT), end: new Date('2026-11-04T11:00:00.000Z') },
        },
      })
    })

    it('starts a run of periods the next renewal belongs to', async () => {
      const s = await overdue()
      const { orderId } = await paid(s, { capturedAt: '2026-10-31T20:30:00.000Z' })

      await settleOrder(s.deps, { orderId })

      const { subscription } = await written(s)
      const anchor = new Date('2026-10-31T20:30:00.000Z')
      expect(subscription.periodAnchor).toEqual(anchor)
      expect({
        start: subscription.currentPeriodStart,
        end: subscription.currentPeriodEnd,
      }).toEqual(billingPeriod(anchor, 0))
      // 31 October → 30 November → 31 December: the day comes back, by the anchor.
      expect(subscription.currentPeriodEnd).toEqual(new Date('2026-11-30T20:30:00.000Z'))
      expect(nextBillingPeriod(subscription.periodAnchor, subscription.currentPeriodEnd)).toEqual({
        start: new Date('2026-11-30T20:30:00.000Z'),
        end: new Date('2026-12-31T20:30:00.000Z'),
      })
      // The anchor of the run before it would refuse that renewal.
      expect(() => nextBillingPeriod(PERIOD_START, subscription.currentPeriodEnd)).toThrow()
    })

    it('counts the period from the clock when the shop names no moment of the payment', async () => {
      const s = await overdue()
      const { orderId, paymentId } = await paid(s)
      s.shop.patch(paymentId, { captured_at: undefined })

      await settleOrder(s.deps, { orderId })

      expect((await written(s)).subscription).toMatchObject({
        currentPeriodStart: TEST_NOW,
        periodAnchor: TEST_NOW,
      })
    })

    it('grants the quota once, however often and by whomever it is settled', async () => {
      const s = await overdue()
      const { orderId, paymentId } = await paid(s)

      const results = await Promise.all([
        settleOrder(s.deps, { orderId }),
        settleOrderByPaymentId(s.deps, { paymentId }),
        syncOrder(s.deps, { userId: s.userId, orderId }),
        settleOrder(s.deps, { orderId }),
      ])
      await settleOrder(s.deps, { orderId })

      expect(results[0]).toEqual({ state: 'paid', orderId, refundNeeded: false })
      const state = await written(s)
      expect(state.actions).toEqual([pastDuePayment])
      expect(state.ledger.filter((row) => row.kind === 'grant')).toHaveLength(2)
      expect(state.ledger.filter((row) => row.kind === 'expire')).toHaveLength(1)
      expect((await getCreditBalances(db, s.workspaceId)).tariff.available).toBe(30)
      expect(await lettersTo(s.email)).toHaveLength(1)
      expect(state.subscription.currentPeriodStart).toEqual(new Date(PAID_AT))
    })

    it('changes nothing when a settled order is settled again, by anyone and whatever the shop says by then', async () => {
      const s = await overdue()
      const { orderId, paymentId } = await paid(s, { saved: true })
      expect(await settleOrder(s.deps, { orderId })).toEqual({
        state: 'paid',
        orderId,
        refundNeeded: false,
      })
      const everything = async () => {
        const { subscription, audit, ledger } = await written(s)
        return {
          subscription,
          audit,
          ledger,
          order: await db.order.findUniqueOrThrow({ where: { id: orderId } }),
          balances: await getCreditBalances(db, s.workspaceId),
          letters: await lettersTo(s.email),
        }
      }
      const before = await everything()
      expect(before.subscription).toMatchObject({ status: 'active', paymentMethodId: paymentId })
      expect(before.ledger.map((row) => row.idempotencyKey)).toContain(
        ledgerKeys.tariffGrant(orderId),
      )
      const asked = s.shop.reads.length

      // Two weeks later: a repeated notification, the return page opened again, a pass.
      const later = { ...s.deps, now: () => new Date('2026-10-18T12:00:00.000Z') }
      s.shop.patch(paymentId, { captured_at: '2026-10-18T11:00:00.000Z' })
      const again = { state: 'paid', orderId, refundNeeded: false }
      expect(await settleOrder(later, { orderId })).toEqual(again)
      expect(await settleOrderByPaymentId(later, { paymentId })).toEqual(again)
      expect(await syncOrder(later, { userId: s.userId, orderId })).toMatchObject({
        status: 'paid',
        refundNeeded: false,
      })
      expect(
        await Promise.all([settleOrder(later, { orderId }), settleOrder(later, { orderId })]),
      ).toEqual([again, again])

      // Not a row moved: the period, the anchor, the card, the quota, the entries, the letter.
      expect(await everything()).toEqual(before)
      // A settled order is answered from the database: the shop is not asked again.
      expect(s.shop.reads).toHaveLength(asked)
    })

    it('grants the quota of one order once when exactly two settlements race', async () => {
      for (let round = 0; round < 3; round += 1) {
        const s = await overdue()
        const { orderId, paymentId } = await paid(s)

        const both = await Promise.all([
          settleOrder(s.deps, { orderId }),
          settleOrderByPaymentId(s.deps, { paymentId }),
        ])

        expect(both).toEqual([
          { state: 'paid', orderId, refundNeeded: false },
          { state: 'paid', orderId, refundNeeded: false },
        ])
        const state = await written(s)
        expect(
          state.ledger.filter((row) => row.idempotencyKey === ledgerKeys.tariffGrant(orderId)),
        ).toHaveLength(1)
        expect(state.ledger.filter((row) => row.kind === 'expire')).toHaveLength(1)
        // One reactivation, and no «return the money» for an order whose payment was applied.
        expect(state.actions).toEqual([pastDuePayment])
        expect((await getCreditBalances(db, s.workspaceId)).tariff).toEqual({
          balance: 30,
          held: 0,
          available: 30,
        })
        expect(await lettersTo(s.email)).toHaveLength(1)
      }
    })

    it('grants the tariff the order charged for, at its price, when another was chosen between the start and the payment', async () => {
      const next = await fixtures.plan({
        isActive: true,
        name: 'Больше',
        price: '12900.00',
        creditsPerMonth: 80,
      })
      const s = await overdue()
      // «Оплатить сейчас»: the page of the shop is open for the tariff the customer has.
      const checkout = await startPastDuePayment(s.deps, { userId: s.userId })
      const payment = s.shop.only()

      // In another tab the customer chooses «Больше» for the next period, then pays here.
      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug })
      s.shop.succeed(payment.id, { saved: true, capturedAt: PAID_AT })
      const settlement = await settleOrderByPaymentId(s.deps, { paymentId: payment.id })

      expect(settlement).toEqual({ state: 'paid', orderId: checkout.orderId, refundNeeded: false })
      expect(payment.amount.value).toBe('4900.00')
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        // What the money was taken for; the choice waits for the next renewal, which announces
        // and charges its own price.
        planId: s.plan.id,
        nextPlanId: next.id,
        renewalNoticePeriodEnd: null,
        currentPeriodStart: new Date(PAID_AT),
      })
      expect((await getCreditBalances(db, s.workspaceId)).tariff.available).toBe(30)
      expect(state.entry(pastDuePayment)).toMatchObject([
        {
          meta: {
            orderId: checkout.orderId,
            planSlug: s.plan.slug,
            planChanged: false,
            amount: '4900.00',
            credits: 30,
          },
        },
      ])
      expect((await lettersTo(s.email)).map((letter) => letter.payload)).toMatchObject([
        { planName: 'Проверочный', amount: '4900.00' },
      ])
      expect((await getPlanOverview(db, s.workspaceId)).subscription).toMatchObject({
        plan: { slug: s.plan.slug, price: '4900.00' },
        nextPlan: { slug: next.slug, price: '12900.00' },
      })
    })

    it('grants the scheduled tariff the order charged for, at its price, when the change was taken back between the start and the payment', async () => {
      const next = await fixtures.plan({ name: 'Больше', price: '12900.00', creditsPerMonth: 80 })
      const s = await overdue({ nextPlanId: next.id })
      // The page of the shop is open for «Больше», 12 900 ₽.
      const checkout = await startPastDuePayment(s.deps, { userId: s.userId })
      const payment = s.shop.only()
      expect(payment.amount.value).toBe('12900.00')

      // In another tab the customer takes the change back, then pays on the page that is open.
      await cancelPlanChange(s.deps, { userId: s.userId })
      s.shop.succeed(payment.id, { saved: true, capturedAt: PAID_AT })
      const settlement = await settleOrder(s.deps, { orderId: checkout.orderId })

      expect(settlement).toEqual({ state: 'paid', orderId: checkout.orderId, refundNeeded: false })
      const state = await written(s)
      // 12 900 ₽ were taken for «Больше»: that is the tariff, and nothing is scheduled after it.
      expect(state.subscription).toMatchObject({
        status: 'active',
        planId: next.id,
        nextPlanId: null,
        currentPeriodStart: new Date(PAID_AT),
      })
      expect((await getCreditBalances(db, s.workspaceId)).tariff.available).toBe(80)
      expect(state.entry(pastDuePayment)).toMatchObject([
        { meta: { planSlug: next.slug, planChanged: true, amount: '12900.00', credits: 80 } },
      ])
      expect(state.entry(refundNeeded)).toEqual([])
      expect((await lettersTo(s.email)).map((letter) => letter.payload)).toMatchObject([
        { planName: 'Больше', amount: '12900.00' },
      ])
    })

    it('expires only the credits no task holds, and keeps the purchased ones', async () => {
      const s = await overdue()
      await fixtures.hold(s.workspaceId, 'tariff', 3)
      const pack = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: s.plan.id,
        kind: 'pack',
      })
      await db.billingAccount.updateMany({
        where: { workspaceId: s.workspaceId, unit: 'credit_pack' },
        data: { balance: 10 },
      })
      const { orderId } = await paid(s)

      await settleOrder(s.deps, { orderId })

      const balances = await getCreditBalances(db, s.workspaceId)
      // 7 of the old period: 3 held stay with their tasks, 4 expire; 30 are granted.
      expect(balances.tariff).toEqual({ balance: 33, held: 3, available: 30 })
      expect(balances.pack.balance).toBe(10)
      expect((await written(s)).audit[0]?.meta).toMatchObject({ expiredCredits: 4, credits: 30 })
      expect(pack.kind).toBe('pack')
    })

    it('applies the scheduled tariff the order paid for and clears the schedule', async () => {
      const next = await fixtures.plan({ name: 'Больше', price: '12900.00', creditsPerMonth: 80 })
      const s = await overdue({ nextPlanId: next.id })
      const { orderId } = await paid(s)

      await settleOrder(s.deps, { orderId })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        planId: next.id,
        nextPlanId: null,
      })
      expect((await getCreditBalances(db, s.workspaceId)).tariff.available).toBe(80)
      expect(state.audit[0]?.meta).toMatchObject({
        planSlug: next.slug,
        planChanged: true,
        amount: '12900.00',
        credits: 80,
      })
      expect((await lettersTo(s.email))[0]?.payload).toMatchObject({
        planName: 'Больше',
        amount: '12900.00',
      })
    })

    it('grants the tariff the money was taken for when another was scheduled past the order', async () => {
      const next = await fixtures.plan({ name: 'Больше', price: '12900.00', creditsPerMonth: 80 })
      const s = await overdue()
      const { orderId } = await paid(s)
      // Scheduled after the page was opened; the order was made for the tariff the customer has.
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { nextPlanId: next.id },
      })

      await settleOrder(s.deps, { orderId })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        planId: s.plan.id,
        // It waits for the next renewal, which announces and charges its price.
        nextPlanId: next.id,
      })
      expect((await getCreditBalances(db, s.workspaceId)).tariff.available).toBe(30)
      expect(state.audit[0]?.meta).toMatchObject({ planSlug: s.plan.slug, amount: '4900.00' })
    })

    it('replaces the saved card with the one of the payment when ЮKassa saved it', async () => {
      const s = await overdue()
      const { orderId, paymentId } = await paid(s, { saved: true })

      await settleOrder(s.deps, { orderId })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: paymentId,
        paymentMethodTitle: 'Bank card *4444',
        paymentMethodType: 'bank_card',
        paymentMethodCardType: 'Mir',
        paymentMethodLast4: '4444',
        cancelAtPeriodEnd: false,
      })
      expect(state.audit[0]?.meta).toMatchObject({
        paymentMethodReplaced: true,
        autoRenewal: true,
      })
      expect((await getPlanOverview(db, s.workspaceId)).subscription).toMatchObject({
        autoRenewal: true,
        paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` },
      })
    })

    it('keeps the card it had when ЮKassa did not save the one of the payment', async () => {
      const s = await overdue()
      const { orderId } = await paid(s, { saved: false })

      await settleOrder(s.deps, { orderId })

      const state = await written(s)
      expect(state.subscription).toMatchObject({ ...CARD, cancelAtPeriodEnd: false })
      expect(state.audit[0]?.meta).toMatchObject({
        paymentMethodReplaced: false,
        autoRenewal: true,
      })
    })

    it('never keeps a card the buyer saved on the page of a payment made without the consent', async () => {
      const s = await overdue({ ...NO_CARD, cancelAtPeriodEnd: true, cancelledAt: TEST_NOW })
      const { orderId } = await paid(s, { saved: true })

      await settleOrder(s.deps, { orderId })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        ...NO_CARD,
        cancelAtPeriodEnd: true,
        cancelledAt: TEST_NOW,
      })
      expect(state.audit[0]?.meta).toMatchObject({
        paymentMethodReplaced: false,
        autoRenewal: false,
      })
    })

    it('keeps what it had when auto-renewal was switched off after the order was made', async () => {
      const s = await overdue()
      const { orderId } = await paid(s, { saved: true })
      await cancelAutoRenew(s.deps, { userId: s.userId })

      await settleOrder(s.deps, { orderId })

      const state = await written(s)
      // The consent the order was made with is withdrawn: its card is not kept.
      expect(state.subscription).toMatchObject({
        status: 'active',
        ...CARD,
        cancelAtPeriodEnd: true,
      })
      expect(state.entry(pastDuePayment)[0]?.meta).toMatchObject({
        paymentMethodReplaced: false,
        autoRenewal: false,
      })
    })

    it('is applied to the tariff when the money comes by a notification alone', async () => {
      const s = await overdue()
      const { orderId, paymentId } = await paid(s)

      const settlement = await settleOrderByPaymentId(s.deps, { paymentId })

      expect(settlement).toEqual({ state: 'paid', orderId, refundNeeded: false })
      expect((await written(s)).subscription.status).toBe('active')
    })
  })

  describe('a payment that does not bring the tariff back', () => {
    it('leaves the tariff past due when the bank declines, and tells why on the page of the order', async () => {
      const s = await overdue()
      const checkout = await startPastDuePayment(s.deps, { userId: s.userId })
      s.shop.cancel(s.shop.only().id, 'insufficient_funds')

      const order = await syncOrder(s.deps, { userId: s.userId, orderId: checkout.orderId })

      expect(order).toMatchObject({
        status: 'failed',
        refundNeeded: false,
        subscription: null,
        failureText: expect.stringMatching(/средств/i),
      })
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'past_due',
        pastDueSince: PAST_DUE_SINCE,
        currentPeriodEnd: PERIOD_END,
        ...CARD,
      })
      expect(state.audit).toEqual([])
      expect((await getCreditBalances(db, s.workspaceId)).tariff.available).toBe(7)
      expect(await lettersTo(s.email)).toEqual([])
    })

    it.each([
      ['has expired', 'expired'],
      ['was ended by an operator', 'cancelled'],
      ['was paid for by other means', 'active'],
    ] as const)(
      'asks an operator to return the money when the tariff %s meanwhile',
      async (_case, status) => {
        const s = await overdue()
        const { orderId } = await paid(s, { saved: true })
        await db.subscription.update({ where: { id: s.subscriptionId }, data: { status } })

        const settlement = await settleOrder(s.deps, { orderId })

        expect(settlement).toEqual({ state: 'paid', orderId, refundNeeded: true })
        const state = await written(s)
        // Nothing of the subscription moves: not its period, its card or its quota.
        expect(state.subscription).toMatchObject({
          status,
          currentPeriodEnd: PERIOD_END,
          periodAnchor: PERIOD_START,
          ...CARD,
        })
        expect(state.actions).toEqual([refundNeeded])
        expect(state.audit[0]).toMatchObject({
          targetType: 'order',
          targetId: orderId,
          meta: {
            reason: refundReasons.notPastDue,
            orderStatus: 'paid',
            orderAmount: '4900.00',
            paidAmount: '4900.00',
          },
        })
        expect((await getCreditBalances(db, s.workspaceId)).tariff.available).toBe(7)
        expect(await lettersTo(s.email)).toEqual([])
        // Settled again: still one entry.
        await settleOrder(s.deps, { orderId })
        expect((await written(s)).actions).toEqual([refundNeeded])
      },
    )

    it('waits for whoever is ending the tariff, and applies nothing once it is over', async () => {
      const s = await overdue()
      const { orderId } = await paid(s)
      let settling: ReturnType<typeof settleOrder> | undefined

      await db.$transaction(async (ending) => {
        // The end of the grace, not committed yet: it holds the row of the subscription.
        await ending.$queryRaw`
          SELECT id FROM subscriptions WHERE id = ${s.subscriptionId}::uuid FOR UPDATE
        `
        await ending.subscription.update({
          where: { id: s.subscriptionId },
          data: { status: 'expired' },
        })
        settling = settleOrder(s.deps, { orderId })
        const first = await Promise.race([
          settling.then(() => 'settled'),
          new Promise<string>((resolve) => setTimeout(resolve, 500, 'waiting')),
        ])
        // The settlement stands at the row: it decides by what the end leaves.
        expect(first).toBe('waiting')
      })

      expect(await settling).toEqual({ state: 'paid', orderId, refundNeeded: true })
      const state = await written(s)
      // A tariff that was ended is not brought back by a payment that read it a moment before.
      expect(state.subscription).toMatchObject({
        status: 'expired',
        currentPeriodEnd: PERIOD_END,
        periodAnchor: PERIOD_START,
      })
      expect(state.actions).toEqual([refundNeeded])
      expect((await getCreditBalances(db, s.workspaceId)).tariff.available).toBe(7)
      expect(await lettersTo(s.email)).toEqual([])
    })

    it('fails an order paid with another amount and asks for the money back', async () => {
      const s = await overdue()
      const { orderId, paymentId } = await paid(s)
      s.shop.patch(paymentId, { amount: { value: '49.00', currency: 'RUB' } })

      const settlement = await settleOrder(s.deps, { orderId })

      expect(settlement).toEqual({ state: 'failed', orderId, refundNeeded: true })
      expect((await written(s)).subscription.status).toBe('past_due')
    })

    it('does not let a first checkout pay the order of a tariff that is over', async () => {
      const s = await overdue()
      await db.plan.update({ where: { id: s.plan.id }, data: { isActive: true } })
      // «Оплатить сейчас» broke off before a payment was stored, and the grace ran out.
      const stale = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: s.plan.id,
        userId: s.userId,
        subscriptionId: s.subscriptionId,
        status: 'pending',
        savePaymentMethod: true,
      })
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { status: 'expired' },
      })

      // The same tariff, the same consent, the same amount: still not that order.
      const checkout = await startCheckout(s.deps, {
        userId: s.userId,
        planSlug: s.plan.slug,
        autoRenew: true,
      })

      expect(checkout.orderId).not.toBe(stale.id)
      expect(await db.order.findUnique({ where: { id: stale.id } })).toMatchObject({
        status: 'cancelled',
        yookassaPaymentId: null,
      })
      expect(await db.order.findUnique({ where: { id: checkout.orderId } })).toMatchObject({
        status: 'pending',
        subscriptionId: null,
      })
      expect(s.shop.created.map((request) => request.idempotenceKey)).not.toContain(
        stale.idempotenceKey,
      )
    })
  })

  describe('a first checkout after a payment by hand that came too late', () => {
    it('starts at the first try: a paid order of a tariff that is over is no tariff', async () => {
      const s = await overdue()
      await db.plan.update({ where: { id: s.plan.id }, data: { isActive: true } })
      // The customer paid on the page of «Оплатить сейчас»; before anybody read the payment
      // back, the tariff was ended.
      const late = await paid(s)
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { status: 'cancelled' },
      })

      // «Выбрать тариф» on «Тарифы».
      const checkout = await startCheckout(s.deps, {
        userId: s.userId,
        planSlug: s.plan.slug,
        autoRenew: false,
      })

      expect(checkout.orderId).not.toBe(late.orderId)
      expect(checkout.confirmationUrl).toMatch(/^https:\/\/yookassa\.example\/pay\//)
      // The late payment was settled on the way: paid, not applied, to be returned.
      expect(await db.order.findUnique({ where: { id: late.orderId } })).toMatchObject({
        status: 'paid',
        subscriptionId: s.subscriptionId,
      })
      const state = await written(s)
      expect(state.entry(refundNeeded)).toMatchObject([
        { targetId: late.orderId, meta: { reason: refundReasons.notPastDue } },
      ])
      expect(state.subscription.status).toBe('cancelled')
      // The new order is a first payment of its own, with its own page.
      expect(await db.order.findUnique({ where: { id: checkout.orderId } })).toMatchObject({
        status: 'pending',
        subscriptionId: null,
        planId: s.plan.id,
      })
      expect(s.shop.created).toHaveLength(2)

      // Paid, it starts a new tariff: the customer is not left with the refusal of the old one.
      const { yookassaPaymentId } = await db.order.findUniqueOrThrow({
        where: { id: checkout.orderId },
      })
      s.shop.succeed(yookassaPaymentId ?? '', { capturedAt: PAID_AT })
      expect(await settleOrder(s.deps, { orderId: checkout.orderId })).toEqual({
        state: 'paid',
        orderId: checkout.orderId,
        refundNeeded: false,
      })
      expect((await getPlanOverview(db, s.workspaceId)).subscription).toMatchObject({
        status: 'active',
        plan: { slug: s.plan.slug },
      })
    })

    it('still refuses while the tariff the payment by hand pays for is live, and leaves that payment alone', async () => {
      const s = await overdue()
      await db.plan.update({ where: { id: s.plan.id }, data: { isActive: true } })
      // Paid and not read back yet: the tariff still waits for it.
      const byHandOrder = await paid(s)
      const choose = () =>
        startCheckout(s.deps, { userId: s.userId, planSlug: s.plan.slug, autoRenew: false })

      // An overdue tariff is a tariff: it is paid for, not bought again.
      await expect(choose()).rejects.toMatchObject({ code: 'BILLING_SUBSCRIPTION_EXISTS' })
      expect(await db.order.findUnique({ where: { id: byHandOrder.orderId } })).toMatchObject({
        status: 'pending',
      })

      await settleOrder(s.deps, { orderId: byHandOrder.orderId })
      await expect(choose()).rejects.toMatchObject({ code: 'BILLING_SUBSCRIPTION_EXISTS' })
      expect((await written(s)).subscription.status).toBe('active')
      expect(await byHand(s)).toHaveLength(1)
      expect(s.shop.created).toHaveLength(1)
    })
  })

  // The passes look at every due row of the database. These tests stand in 2015, where nothing
  // another suite writes to a shared database is due.
  describe('the scheduler and a tariff that is paid by hand', () => {
    const START = new Date('2015-03-10T09:00:00.000Z')
    const END = new Date('2015-04-10T09:00:00.000Z')
    const SINCE = new Date('2015-04-10T09:05:00.000Z')

    function scheduler(at: string, shop: Overdue['shop']) {
      const clock = { now: new Date(at) }
      const charges: ChargeSavedInput[] = []
      const client: NonNullable<RenewalDeps['yookassa']> = {
        ...shop.client,
        async chargeWithSavedMethod(input, idempotenceKey) {
          charges.push(structuredClone(input))
          const { id } = await shop.client.createPayment(
            { ...input, capture: true },
            idempotenceKey,
          )
          shop.succeed(id, { saved: true, capturedAt: clock.now.toISOString() })
          return structuredClone(shop.payments.get(id)) as Payment
        },
      }
      const deps: RenewalDeps = {
        prisma: db,
        yookassa: client,
        appUrl: TEST_APP_URL,
        now: () => clock.now,
        settings: { noticeDays: 3, pastDueDays: 7 },
      }
      return { deps, clock, charges }
    }

    const in2015 = () =>
      overdue({
        currentPeriodStart: START,
        currentPeriodEnd: END,
        periodAnchor: START,
        pastDueSince: SINCE,
        renewalNoticePeriodEnd: END,
      })

    it('is not expired while its payment is on the page of the shop, and is once the page is abandoned', async () => {
      const s = await in2015()
      const pass = scheduler('2015-04-17T09:00:00.000Z', s.shop)
      const deps = { ...s.deps, now: () => pass.clock.now }
      const checkout = await startPastDuePayment(deps, { userId: s.userId })
      await db.order.update({
        where: { id: checkout.orderId },
        data: { createdAt: pass.clock.now },
      })

      // The grace of seven days is over, and the customer is paying.
      pass.clock.now = new Date('2015-04-17T09:10:00.000Z')
      expect((await endPeriods(pass.deps)).counts).toMatchObject({ expired: 0, skipped: 0 })
      expect((await settleStuckOrders(pass.deps)).counts.pending).toBe(1)
      expect((await written(s)).subscription.status).toBe('past_due')

      // The page expired unpaid: ЮKassa cancels the payment, and the tariff ends.
      const [order] = await byHand(s)
      s.shop.cancel(order?.yookassaPaymentId ?? '', 'expired_on_confirmation')
      pass.clock.now = new Date(pass.clock.now.getTime() + STUCK_ORDER_AFTER_MS)
      expect((await settleStuckOrders(pass.deps)).counts.failed).toBe(1)
      expect((await endPeriods(pass.deps)).counts.expired).toBe(1)
      expect((await written(s)).subscription.status).toBe('expired')
    })

    it('is not applied by a payment that arrives after the grace ended it, and the money is asked back', async () => {
      // The grace runs out at the very moment the customer presses «Оплатить сейчас»: the
      // order is made, and the tariff is ended before the shop has answered with a payment.
      const s = await in2015()
      const pass = scheduler('2015-04-17T09:10:00.000Z', s.shop)
      let reached!: () => void
      let answer!: () => void
      const asked = new Promise<void>((resolve) => (reached = resolve))
      const held = new Promise<void>((resolve) => (answer = resolve))
      const deps: BillingDeps = {
        ...s.deps,
        now: () => pass.clock.now,
        yookassa: {
          ...s.shop.client,
          async createPayment(input, idempotenceKey) {
            reached()
            await held
            return s.shop.client.createPayment(input, idempotenceKey)
          },
        },
      }

      const starting = startPastDuePayment(deps, { userId: s.userId })
      await asked
      // An order without a payment holds nothing up: nobody can pay it yet.
      expect((await endPeriods(pass.deps)).counts.expired).toBe(1)
      answer()
      const checkout = await starting
      const payment = s.shop.only()
      s.shop.succeed(payment.id, { saved: true, capturedAt: '2015-04-17T09:12:00.000Z' })

      const settlement = await settleOrderByPaymentId(deps, { paymentId: payment.id })

      expect(settlement).toEqual({ state: 'paid', orderId: checkout.orderId, refundNeeded: true })
      const state = await written(s)
      // The tariff stays over: its period, its card and its credits are what the end left.
      expect(state.subscription).toMatchObject({
        status: 'expired',
        currentPeriodEnd: END,
        periodAnchor: START,
        ...CARD,
      })
      expect(state.entry(refundNeeded)).toMatchObject([
        {
          targetType: 'order',
          targetId: checkout.orderId,
          meta: {
            reason: refundReasons.notPastDue,
            orderStatus: 'paid',
            orderAmount: '4900.00',
            paidAmount: '4900.00',
          },
        },
      ])
      expect(state.entry(pastDuePayment)).toEqual([])
      expect(state.ledger.map((row) => row.idempotencyKey)).not.toContain(
        ledgerKeys.tariffGrant(checkout.orderId),
      )
      expect((await getCreditBalances(db, s.workspaceId)).tariff.available).toBe(0)
      // The customer was told that the tariff ended, never that this payment went through.
      expect((await lettersTo(s.email)).map((letter) => letter.type)).toEqual([
        'billing.subscription_ended',
      ])
      // The return page of the order says so, and no tariff is shown as live.
      expect(await syncOrder(deps, { userId: s.userId, orderId: checkout.orderId })).toMatchObject({
        status: 'paid',
        refundNeeded: true,
        subscription: null,
      })
      // Seen again — a repeated notification, a pass — it is still one entry.
      await settleOrderByPaymentId(deps, { paymentId: payment.id })
      await settleStuckOrders(pass.deps)
      expect((await written(s)).entry(refundNeeded)).toHaveLength(1)
    })

    it('is renewed a month after the payment by hand, by the anchor of that payment', async () => {
      const s = await in2015()
      const paidAt = new Date('2015-04-12T15:30:00.000Z')
      const pass = scheduler(paidAt.toISOString(), s.shop)
      const deps = { ...s.deps, now: () => pass.clock.now }
      const checkout = await startPastDuePayment(deps, { userId: s.userId })
      const { yookassaPaymentId } = await db.order.findUniqueOrThrow({
        where: { id: checkout.orderId },
      })
      s.shop.succeed(yookassaPaymentId ?? '', { saved: true, capturedAt: paidAt.toISOString() })
      await settleOrder(deps, { orderId: checkout.orderId })
      const periodEnd = new Date('2015-05-12T15:30:00.000Z')
      expect((await written(s)).subscription).toMatchObject({
        status: 'active',
        currentPeriodEnd: periodEnd,
        periodAnchor: paidAt,
        paymentMethodId: yookassaPaymentId,
      })

      // The old end of the period means nothing any more: nothing is due before the new one.
      pass.clock.now = new Date('2015-05-01T09:00:00.000Z')
      expect((await sendRenewalNotices(pass.deps)).counts.notified).toBe(0)
      expect((await chargeRenewals(pass.deps)).counts.renewed).toBe(0)

      pass.clock.now = new Date('2015-05-10T09:00:00.000Z')
      expect((await sendRenewalNotices(pass.deps)).counts.notified).toBe(1)
      pass.clock.now = new Date('2015-05-12T15:31:00.000Z')
      expect((await chargeRenewals(pass.deps)).counts).toMatchObject({ renewed: 1, failed: 0 })

      expect(pass.charges).toMatchObject([{ payment_method_id: yookassaPaymentId }])
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: periodEnd,
        currentPeriodEnd: new Date('2015-06-12T15:30:00.000Z'),
        // The run of the payment by hand goes on: nothing was re-anchored.
        periodAnchor: paidAt,
      })
      expect(state.entry(renewalAuditActions.renewed)[0]?.meta).toMatchObject({
        reanchored: false,
      })
      const letterKeys = (await lettersTo(s.email)).map((letter) => letter.dedupeKey)
      expect(letterKeys).toContain(paymentLetterKey(checkout.orderId))
    })

    it('ends with the month it paid for when auto-renewal is off', async () => {
      const s = await overdue({
        currentPeriodStart: START,
        currentPeriodEnd: END,
        periodAnchor: START,
        pastDueSince: SINCE,
        renewalNoticePeriodEnd: END,
        cancelAtPeriodEnd: true,
        cancelledAt: SINCE,
      })
      const paidAt = new Date('2015-04-12T15:30:00.000Z')
      const pass = scheduler(paidAt.toISOString(), s.shop)
      const deps = { ...s.deps, now: () => pass.clock.now }
      const checkout = await startPastDuePayment(deps, { userId: s.userId })
      const { yookassaPaymentId } = await db.order.findUniqueOrThrow({
        where: { id: checkout.orderId },
      })
      s.shop.succeed(yookassaPaymentId ?? '', { saved: true, capturedAt: paidAt.toISOString() })
      await settleOrder(deps, { orderId: checkout.orderId })

      pass.clock.now = new Date('2015-05-12T15:31:00.000Z')
      expect((await sendRenewalNotices(pass.deps)).counts.notified).toBe(0)
      expect((await chargeRenewals(pass.deps)).counts.renewed).toBe(0)
      expect(pass.charges).toEqual([])
      expect((await endPeriods(pass.deps)).counts.cancelled).toBe(1)
      expect((await written(s)).subscription).toMatchObject({
        status: 'cancelled',
        currentPeriodEnd: new Date('2015-05-12T15:30:00.000Z'),
      })
    })
  })
})
