import { createPrismaClient, findPersonalWorkspace, type Prisma, type PrismaClient } from '@repo/db'
import { YookassaApiError, YookassaError } from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import { startCheckout, startPackCheckout, syncOrder } from './checkout.ts'
import { releaseTask, settleTaskCharge } from './holds.ts'
import { grantSignupGift, grantTariffCredits, ledgerKeys } from './ledger.ts'
import { getCreditBalances, getPlanOverview, listPayments } from './read-models.ts'
import {
  closeUnknownCharge,
  listRefundsNeeded,
  orderOfRefundDescription,
  REFUND_END_REASON,
  refundAuditActions,
  refundDescription,
  refundKey,
  refundOrder,
  refundRefusals,
  settleRefund,
  type RefundDeps,
  type RefundOrderInput,
} from './refund.ts'
import {
  RENEWAL_GIVE_UP_MARGIN_MS,
  RENEWAL_RETRY_WINDOW_MS,
  renewalJobAuditActions,
  settleStuckOrders,
} from './renewal.ts'
import { renewalKey } from './renewal-order.ts'
import {
  paymentLetterKey,
  refundReasons,
  renewalAuditActions,
  settleOrder,
  settleOrderByPaymentId,
  settlementAuditActions,
} from './settlement.ts'
import { billingFixtures, refundTestDeps, TEST_APP_URL, TEST_NOW } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const ORDER = '0199a000-0000-7000-8000-0000000000b2'
const WHO = { operator: 'operator-test', reason: 'Письмо клиента от 4 октября' }
const DAY_MS = 24 * 60 * 60_000

const timeout = () => new YookassaError('YooKassa request timed out', { retryable: true })
const badRequest = () => new YookassaApiError('invalid_request', 400, 'invalid_request', {})

describe('a refund without a database', () => {
  // Reaching the database or the shop with a refused input would throw a TypeError on the
  // missing client: only the schema throws a ZodError.
  const deps = {} as RefundDeps

  it.each([
    ['an order id that is not a UUID', { orderId: 'order' }],
    ['no operator', { operator: '' }],
    ['an operator of spaces', { operator: '   ' }],
    ['an operator longer than the column', { operator: 'o'.repeat(129) }],
    ['no reason', { reason: '' }],
    ['a reason longer than the ledger note', { reason: 'r'.repeat(501) }],
    ['a reason of two lines', { reason: 'first\nsecond' }],
    ['an operator with an escape sequence', { operator: 'op\u001b[2J' }],
    ['an option that is not a boolean', { endSubscription: 'yes' }],
    ['a cabinet mark that is not a boolean', { refundedInCabinet: 'yes' }],
    ['a field it does not know', { amount: '1.00' }],
  ])('refuses %s before any query', async (_case, patch) => {
    const input = { orderId: ORDER, ...WHO, ...patch } as RefundOrderInput
    await expect(refundOrder(deps, input)).rejects.toBeInstanceOf(ZodError)
  })

  it('reaches the database with an input the schema takes', async () => {
    await expect(refundOrder(deps, { orderId: ORDER, ...WHO })).rejects.toBeInstanceOf(TypeError)
  })

  it('asks ЮKassa under one key per order, of the characters its keys are kept to', () => {
    expect(refundKey(ORDER)).toBe(`refund.${ORDER}`)
    expect(refundKey(ORDER)).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
  })

  it('numbers the key of a request that follows cancelled refunds', () => {
    expect(refundKey(ORDER, 0)).toBe(`refund.${ORDER}`)
    expect(refundKey(ORDER, 1)).toBe(`refund.${ORDER}.1`)
    expect(refundKey(ORDER, 12)).toBe(`refund.${ORDER}.12`)
    // More cancellations than an order will ever see still fit a key of ЮKassa.
    expect(refundKey(ORDER, 99_999_999)).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
  })

  it('marks its refunds by a description that names the order, and reads nothing else as one', () => {
    expect(refundDescription(ORDER)).toBe(`Возврат по заказу ${ORDER}`)
    // ЮKassa takes a description of a refund up to 250 characters.
    expect(refundDescription(ORDER).length).toBeLessThanOrEqual(250)
    expect(orderOfRefundDescription(refundDescription(ORDER))).toBe(ORDER)
    for (const description of [
      undefined,
      '',
      ORDER,
      `Возврат по заказу ${ORDER} `,
      ` Возврат по заказу ${ORDER}`,
      `Возврат по заказу ${ORDER}\nВозврат по заказу ${ORDER}`,
      `возврат по заказу ${ORDER}`,
      `Возврат по заказу ${ORDER.toUpperCase()}`,
      `Возврат по заказу ${ORDER.slice(0, 35)}`,
      'Возврат по заказу 00000000-0000-0000-0000-00000000000g',
      // The shape of an id, but not a UUID.
      `Возврат по заказу ${'-'.repeat(36)}`,
      'Возврат по письму клиента',
    ]) {
      expect(orderOfRefundDescription(description)).toBeNull()
    }
  })

  it('refuses to close a charge without an order, an operator or a reason, before any query', async () => {
    for (const input of [
      { orderId: 'order', ...WHO },
      { orderId: ORDER, ...WHO, operator: '' },
      { orderId: ORDER, ...WHO, reason: 'one\ntwo' },
      { orderId: ORDER, ...WHO, found: false },
    ]) {
      await expect(closeUnknownCharge(deps, input)).rejects.toBeInstanceOf(ZodError)
    }
  })

  it('refuses a notification that names no refund or anything beside it', async () => {
    await expect(settleRefund(deps, { refundId: '' })).rejects.toBeInstanceOf(ZodError)
    await expect(
      settleRefund(deps, { refundId: 'r-1', orderId: ORDER } as { refundId: string }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('takes an id that is too long for a refund of ours as unknown, without a request', async () => {
    expect(await settleRefund(deps, { refundId: 'r'.repeat(65) })).toEqual({ state: 'unknown' })
  })

  it('refuses a listing of a size it does not serve', async () => {
    for (const limit of [0, 501, 1.5]) {
      await expect(listRefundsNeeded(deps, { limit })).rejects.toBeInstanceOf(ZodError)
    }
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL refund', () => {
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

  const PAID_AT = new Date('2026-10-04T09:00:00.000Z')
  const PERIOD_END = new Date('2026-11-04T09:00:00.000Z')
  const TARIFF_CREDITS = 30
  const { refund: refundAction, refundSettled, refundOutside } = refundAuditActions

  /**
   * A customer who paid for a tariff of their own through checkout and settlement: the order
   * is paid at 09:00 on 4 October, the tariff is active until 4 November, its 30 credits are
   * granted. The clock of the tests stands at noon of that day.
   */
  async function paidTariff({
    autoRenew = false,
    plan: planData = {},
  }: { autoRenew?: boolean; plan?: Partial<Prisma.PlanUncheckedCreateInput> } = {}) {
    const { userId, email } = await fixtures.user()
    emails.push(email)
    const plan = await fixtures.plan({ isActive: true, tasksPerDay: null, ...planData })
    const { shop, deps } = refundTestDeps(db)
    const { orderId } = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew })
    const paymentId = shop.only().id
    shop.succeed(paymentId, { saved: autoRenew })
    await settleOrder(deps, { orderId })
    const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
    if (workspace === null) throw new Error('The user has no personal workspace')
    const subscription = await db.subscription.findFirstOrThrow({
      where: { workspaceId: workspace.id },
    })
    return {
      shop,
      deps,
      userId,
      workspaceId: workspace.id,
      plan,
      orderId,
      paymentId,
      subscriptionId: subscription.id,
    }
  }
  type Paid = Awaited<ReturnType<typeof paidTariff>>

  /** The customer buys the pack on sale (the seeds put one there) and it is granted. */
  async function boughtPack(t: Paid) {
    const before = new Set(t.shop.payments.keys())
    const { orderId } = await startPackCheckout(t.deps, { userId: t.userId })
    const [paymentId, ...others] = [...t.shop.payments.keys()].filter((id) => !before.has(id))
    if (paymentId === undefined || others.length > 0) throw new Error('No one pack payment')
    t.shop.succeed(paymentId)
    await settleOrder(t.deps, { orderId })
    const granted = await db.creditLedger.findUniqueOrThrow({
      where: { idempotencyKey: ledgerKeys.packGrant(orderId) },
    })
    return { orderId, paymentId, credits: granted.amount.toNumber() }
  }

  /**
   * A tariff written directly, for the states checkout does not lead to: the subscription as
   * given, a paid order of its period with a payment the shop holds, and the quota granted.
   */
  async function writtenTariff(
    subscriptionData: Partial<Prisma.SubscriptionUncheckedCreateInput> = {},
    orderData: Partial<Prisma.OrderUncheckedCreateInput> = {},
  ) {
    const { userId, workspaceId } = await fixtures.workspace()
    const plan = await fixtures.plan()
    const { shop, deps } = refundTestDeps(db)
    const subscription = await fixtures.subscription({
      workspaceId,
      planId: plan.id,
      ...subscriptionData,
    })
    const payment = shop.paid('4900.00')
    const order = await fixtures.order({
      workspaceId,
      planId: plan.id,
      userId,
      subscriptionId: subscription.id,
      yookassaPaymentId: payment.id,
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      paidAt: subscription.currentPeriodStart,
      ...orderData,
    })
    await db.$transaction((tx) =>
      grantTariffCredits(tx, { workspaceId, orderId: order.id, credits: TARIFF_CREDITS }),
    )
    return {
      shop,
      deps,
      userId,
      workspaceId,
      plan,
      orderId: order.id,
      paymentId: payment.id,
      subscriptionId: subscription.id,
    }
  }

  /** Everything a refund may have touched in the workspace. */
  async function written({ workspaceId }: { workspaceId: string }) {
    const audit = await db.auditLog.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const orders = await db.order.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const subscriptions = await db.subscription.findMany({ where: { workspaceId } })
    return {
      orders,
      order: (id: string) => {
        const order = orders.find((row) => row.id === id)
        if (order === undefined) throw new Error(`The workspace has no order ${id}`)
        return order
      },
      subscriptions,
      subscription: subscriptions[0],
      balances: await getCreditBalances(db, workspaceId),
      ledger: await db.creditLedger.findMany({
        where: { account: { workspaceId } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      holds: await db.creditHold.findMany({ where: { account: { workspaceId } } }),
      audit,
      entries: (action: string) => audit.filter((entry) => entry.action === action),
    }
  }

  const refund = (
    t: { deps: RefundDeps; orderId: string },
    options: Partial<RefundOrderInput> = {},
  ) => refundOrder(t.deps, { orderId: t.orderId, ...WHO, ...options })

  /** The gift account of the workspace with its journal and its reserves, row for row. */
  const giftRows = (workspaceId: string) =>
    db.billingAccount.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId, unit: 'credit_gift' } },
      include: { entries: { orderBy: { id: 'asc' } }, holds: { orderBy: { id: 'asc' } } },
    })

  /**
   * Grants the gift of the registration to the customer and reserves 5 of its 35 credits for a
   * task; the gift account as it then is.
   */
  async function gifted(t: { userId: string; workspaceId: string }) {
    await db.$transaction((tx) => grantSignupGift(tx, t))
    await fixtures.hold(t.workspaceId, 'gift', 5)
    return giftRows(t.workspaceId)
  }

  /** What only a refund writes: the rows a refusal must leave as they were. */
  async function untouched(t: Paid | Awaited<ReturnType<typeof writtenTariff>>) {
    const state = await written(t)
    expect(state.order(t.orderId)).toMatchObject({
      status: 'paid',
      yookassaRefundId: null,
      refundedAt: null,
      refundedAmount: null,
    })
    expect(state.entries(refundAction)).toEqual([])
    expect(state.entries(refundSettled)).toEqual([])
    expect(state.entries(renewalJobAuditActions.subscriptionEnd)).toEqual([])
    expect(state.ledger.map((row) => row.kind)).not.toContain('adjust')
    expect(state.ledger.map((row) => row.kind)).not.toContain('expire')
    return state
  }

  describe('of a paid order', () => {
    it('returns the whole amount once and makes the order refunded', async () => {
      const t = await paidTariff({ autoRenew: true })

      const result = await refund(t)

      const made = t.shop.onlyRefund()
      expect(result).toEqual({
        orderId: t.orderId,
        state: 'refunded',
        refundId: made.id,
        amount: '4900.00',
        requested: true,
        settled: true,
        cabinet: false,
        cancellation: null,
        tariff: null,
        credits: null,
      })
      // The payment is read back first, then one request for all of it, under the order's key.
      // The mark of the platform's refund is its description; no metadata is sent, and neither
      // is the operator's reason.
      expect(t.shop.reads.at(-1)).toBe(t.paymentId)
      expect(t.shop.refundRequests).toEqual([
        {
          idempotenceKey: `refund.${t.orderId}`,
          input: {
            payment_id: t.paymentId,
            amount: { value: '4900.00', currency: 'RUB' },
            description: `Возврат по заказу ${t.orderId}`,
          },
        },
      ])
      expect(made.description).toBe(`Возврат по заказу ${t.orderId}`)
      expect(t.shop.refundReads).toEqual([])

      const state = await written(t)
      const order = state.order(t.orderId)
      expect(order).toMatchObject({
        status: 'refunded',
        yookassaRefundId: made.id,
        refundedAt: TEST_NOW,
        paidAt: PAID_AT,
      })
      expect(order.refundedAmount?.toFixed(2)).toBe('4900.00')
      expect(state.entries(refundAction)).toHaveLength(1)
      expect(state.entries(refundAction)[0]).toMatchObject({
        actorType: 'operator',
        actorId: WHO.operator,
        targetType: 'order',
        targetId: t.orderId,
        meta: {
          reason: WHO.reason,
          refundId: made.id,
          paymentId: t.paymentId,
          amount: '4900.00',
          refundStatus: 'succeeded',
          orderStatus: 'refunded',
          requested: true,
          settled: true,
          cabinet: false,
          endSubscription: false,
          takeCredits: false,
          moneyOnly: true,
          tariff: null,
          expiredCredits: 0,
          credits: null,
          takenCredits: 0,
        },
      })
      expect(state.entries(refundSettled)).toEqual([])
    })

    it('moves only the money unless told otherwise: the tariff and its credits stay', async () => {
      const t = await paidTariff({ autoRenew: true })
      const before = await written(t)

      await refund(t)

      const state = await written(t)
      expect(state.subscriptions).toEqual(before.subscriptions)
      expect(state.subscription).toMatchObject({
        status: 'active',
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: false,
        paymentMethodId: t.paymentId,
      })
      expect(state.balances).toEqual(before.balances)
      expect(state.ledger).toEqual(before.ledger)
      expect(state.entries(renewalJobAuditActions.subscriptionEnd)).toEqual([])
      expect((await getPlanOverview(db, t.workspaceId)).subscription?.status).toBe('active')
    })

    it('shows in the payment history as returned, with the day and the amount', async () => {
      const t = await paidTariff()
      await refund(t)

      const { items } = await listPayments(db, t.workspaceId)

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        id: t.orderId,
        status: 'refunded',
        amount: '4900.00',
        refundedAmount: '4900.00',
        refundedAt: TEST_NOW,
        paidAt: PAID_AT,
        failureText: null,
      })
      // The return page of the order no longer asks the shop about it, and owes nothing.
      const reads = t.shop.reads.length
      expect(await syncOrder(t.deps, { userId: t.userId, orderId: t.orderId })).toMatchObject({
        status: 'refunded',
        refundNeeded: false,
      })
      expect(t.shop.reads).toHaveLength(reads)
    })

    it('leaves the order paid while the refund is pending, and changes no rights', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })

      const result = await refund(t, { endSubscription: true })

      const made = t.shop.onlyRefund()
      expect(result).toMatchObject({
        state: 'pending',
        refundId: made.id,
        requested: true,
        settled: false,
        cancellation: null,
        tariff: null,
        credits: null,
      })
      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'paid',
        yookassaRefundId: made.id,
        refundedAt: null,
        refundedAmount: null,
      })
      // The money has not gone back: the tariff is not ended on a promise.
      expect(state.subscription).toMatchObject({ status: 'active', currentPeriodEnd: PERIOD_END })
      expect(state.balances.tariff).toEqual({ balance: 30, held: 0, available: 30 })
      expect(state.entries(refundAction)).toHaveLength(1)
      expect(state.entries(refundAction)[0]?.meta).toMatchObject({
        refundId: made.id,
        refundStatus: 'pending',
        orderStatus: 'paid',
        requested: true,
        settled: false,
        endSubscription: true,
        moneyOnly: false,
        tariff: null,
      })
    })

    it('is settled by the next call once the pending refund has gone through', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })
      await refund(t, { endSubscription: true })
      const made = t.shop.onlyRefund()

      // Asked again while ЮKassa still works on it: the refund is read back, nothing changes.
      expect(await refund(t, { endSubscription: true })).toMatchObject({
        state: 'pending',
        refundId: made.id,
        requested: false,
        settled: false,
      })
      expect(t.shop.refundReads).toEqual([made.id])
      expect((await written(t)).entries(refundAction)).toHaveLength(1)

      t.shop.succeedRefund(made.id)
      const result = await refund(t, { endSubscription: true })

      expect(result).toMatchObject({
        state: 'refunded',
        refundId: made.id,
        requested: false,
        settled: true,
        tariff: { outcome: 'ended', subscriptionId: t.subscriptionId, expiredCredits: 30 },
      })
      // One request for a refund in all three calls.
      expect(t.shop.refundRequests).toHaveLength(1)
      expect(t.shop.refunds.size).toBe(1)
      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({ status: 'refunded', refundedAt: TEST_NOW })
      expect(state.subscription?.status).toBe('cancelled')
      expect(state.entries(refundAction).map((entry) => entry.meta)).toMatchObject([
        { refundStatus: 'pending', requested: true, settled: false },
        { refundStatus: 'succeeded', requested: false, settled: true, tariff: 'ended' },
      ])
    })

    it('reports why ЮKassa cancelled the refund and leaves the order paid', async () => {
      const t = await paidTariff()
      t.shop.refundAs({
        status: 'canceled',
        cancellation_details: { party: 'yoo_money', reason: 'insufficient_funds' },
      })

      const result = await refund(t, { endSubscription: true })

      const made = t.shop.onlyRefund()
      expect(result).toEqual({
        orderId: t.orderId,
        state: 'canceled',
        refundId: made.id,
        amount: '4900.00',
        requested: true,
        settled: false,
        cabinet: false,
        cancellation: { party: 'yoo_money', reason: 'insufficient_funds' },
        tariff: null,
        credits: null,
      })
      const state = await written(t)
      // A refund that will never move money is not kept on the order.
      expect(state.order(t.orderId)).toMatchObject({ status: 'paid', yookassaRefundId: null })
      expect(state.subscription?.status).toBe('active')
      expect(state.entries(refundAction)).toHaveLength(1)
      expect(state.entries(refundAction)[0]?.meta).toMatchObject({
        refundId: made.id,
        refundStatus: 'canceled',
        orderStatus: 'paid',
        cancellationParty: 'yoo_money',
        cancellationReason: 'insufficient_funds',
      })
    })

    it('asks anew right after a cancellation, under the next key, and the money goes back', async () => {
      const t = await paidTariff()
      t.shop.refundAs({
        status: 'canceled',
        cancellation_details: { party: 'yoo_money', reason: 'insufficient_funds' },
      })
      const cancelled = await refund(t, { endSubscription: true })
      expect(cancelled.state).toBe('canceled')

      // The shop balance was topped up ten minutes later: nothing waits for ЮKassa to let go of
      // the first key, under which it would answer with the cancelled refund for a day.
      const again = await refund(t, { endSubscription: true })

      expect(again).toMatchObject({
        state: 'refunded',
        requested: true,
        settled: true,
        // Not the cancellation of the first refund, shown once more as if it were news.
        cancellation: null,
        tariff: { outcome: 'ended' },
      })
      expect(again.refundId).not.toBe(cancelled.refundId)
      expect(t.shop.refundRequests.map((request) => request.idempotenceKey)).toEqual([
        `refund.${t.orderId}`,
        `refund.${t.orderId}.1`,
      ])
      expect(t.shop.refunds.size).toBe(2)
      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'refunded',
        yookassaRefundId: again.refundId,
      })
      expect(state.entries(refundAction).map((entry) => entry.meta)).toMatchObject([
        { refundId: cancelled.refundId, refundStatus: 'canceled' },
        { refundId: again.refundId, refundStatus: 'succeeded', tariff: 'ended' },
      ])
      // The money went back once.
      expect(t.shop.payments.get(t.paymentId)?.refunded_amount?.value).toBe('4900.00')
    })

    it('leaves an entry for every refund the shop made for the order, each under its own key', async () => {
      const t = await paidTariff()
      const refused = { party: 'yoo_money', reason: 'insufficient_funds' }
      t.shop.refundAs({ status: 'canceled', cancellation_details: refused })
      const first = await refund(t)
      t.shop.refundAs({ status: 'canceled', cancellation_details: refused })

      const second = await refund(t)

      // A new refusal of a new refund, not the first one read again.
      expect(second).toMatchObject({ state: 'canceled', requested: true, cancellation: refused })
      expect(second.refundId).not.toBe(first.refundId)
      let state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({ status: 'paid', yookassaRefundId: null })
      expect(state.entries(refundAction).map((entry) => entry.meta)).toMatchObject([
        { refundId: first.refundId, refundStatus: 'canceled' },
        { refundId: second.refundId, refundStatus: 'canceled' },
      ])

      expect(await refund(t)).toMatchObject({ state: 'refunded', settled: true })
      expect(t.shop.refundRequests.map((request) => request.idempotenceKey)).toEqual([
        `refund.${t.orderId}`,
        `refund.${t.orderId}.1`,
        `refund.${t.orderId}.2`,
      ])
      state = await written(t)
      expect(state.entries(refundAction)).toHaveLength(3)
    })

    it('counts a cancelled refund once, however often its key answers with it', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'canceled' })
      const first = await refund(t)
      // The entry of the cancellation was not written (the database failed after the answer):
      // the next run meets the same refund under the same key, and only then moves on.
      await db.auditLog.deleteMany({ where: { workspaceId: t.workspaceId, action: refundAction } })

      expect(await refund(t)).toMatchObject({
        state: 'canceled',
        refundId: first.refundId,
        requested: true,
      })
      expect(t.shop.refunds.size).toBe(1)

      expect(await refund(t)).toMatchObject({ state: 'refunded', settled: true })
      expect(t.shop.refundRequests.map((request) => request.idempotenceKey)).toEqual([
        `refund.${t.orderId}`,
        `refund.${t.orderId}`,
        `refund.${t.orderId}.1`,
      ])
    })

    it('forgets a pending refund that was cancelled, and asks again with the next call', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })
      await refund(t)
      const first = t.shop.onlyRefund()
      t.shop.cancelRefund(first.id, 'rejected_by_payee')

      expect(await refund(t)).toMatchObject({
        state: 'canceled',
        refundId: first.id,
        requested: false,
        cancellation: { party: 'yoo_money', reason: 'rejected_by_payee' },
      })
      let state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({ status: 'paid', yookassaRefundId: null })
      expect(state.entries(refundAction).map((entry) => entry.meta)).toMatchObject([
        { refundStatus: 'pending' },
        { refundStatus: 'canceled', cancellationReason: 'rejected_by_payee' },
      ])

      // No day of waiting for the first key: the order is asked for anew, and it goes back.
      const again = await refund(t)

      expect(again).toMatchObject({ state: 'refunded', requested: true, settled: true })
      expect(again.refundId).not.toBe(first.id)
      expect(t.shop.refundRequests.at(-1)?.idempotenceKey).toBe(`refund.${t.orderId}.1`)
      expect(t.shop.refunds.size).toBe(2)
      state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'refunded',
        yookassaRefundId: again.refundId,
      })
    })
  })

  describe('never made twice', () => {
    it('finds the order refunded on a second call and asks nobody', async () => {
      const t = await paidTariff()
      const first = await refund(t)
      const before = await written(t)
      const reads = t.shop.reads.length

      const second = await refund(t)

      expect(second).toEqual({ ...first, requested: false, settled: false })
      expect(t.shop.refundRequests).toHaveLength(1)
      expect(t.shop.refundReads).toEqual([])
      expect(t.shop.reads).toHaveLength(reads)
      expect(t.shop.refunds.size).toBe(1)
      // A repeat that found nothing to do writes nothing at all.
      expect(await written(t)).toMatchObject({
        orders: before.orders,
        audit: before.audit,
        ledger: before.ledger,
      })
    })

    it('gives calls that race one refund, one refunded order and one ended tariff', async () => {
      const t = await paidTariff()
      // All three have read the payment before the shop makes the refund of the first.
      const waiting: (() => void)[] = []
      const createRefund = t.deps.yookassa.createRefund
      t.deps.yookassa.createRefund = async (input, key) => {
        await new Promise<void>((resolve) => {
          waiting.push(resolve)
          if (waiting.length === 3) for (const go of waiting) go()
        })
        return createRefund(input, key)
      }

      const results = await Promise.all([
        refund(t, { endSubscription: true }),
        refund(t, { endSubscription: true }),
        refund(t, { endSubscription: true }),
      ])

      expect(t.shop.refunds.size).toBe(1)
      const made = t.shop.onlyRefund()
      expect(new Set(t.shop.refundRequests.map((request) => request.idempotenceKey))).toEqual(
        new Set([`refund.${t.orderId}`]),
      )
      for (const result of results) {
        expect(result).toMatchObject({ state: 'refunded', refundId: made.id, requested: true })
      }
      expect(results.filter((result) => result.settled)).toHaveLength(1)
      expect(results.map((result) => result.tariff?.outcome).sort()).toEqual([
        'already_ended',
        'already_ended',
        'ended',
      ])
      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({ status: 'refunded', refundedAt: TEST_NOW })
      expect(state.entries(refundAction)).toHaveLength(1)
      expect(state.entries(renewalJobAuditActions.subscriptionEnd)).toHaveLength(1)
      expect(state.ledger.filter((row) => row.kind === 'expire')).toHaveLength(1)
      expect(state.balances.tariff).toEqual({ balance: 0, held: 0, available: 0 })
    })

    it('repeats the request once under the same key when the answer was lost', async () => {
      const t = await paidTariff()
      t.shop.failRefund(timeout(), { processed: true })

      const result = await refund(t)

      expect(result).toMatchObject({ state: 'refunded', requested: true, settled: true })
      expect(t.shop.refundRequests.map((request) => request.idempotenceKey)).toEqual([
        `refund.${t.orderId}`,
        `refund.${t.orderId}`,
      ])
      expect(t.shop.refunds.size).toBe(1)
      expect((await written(t)).order(t.orderId).yookassaRefundId).toBe(t.shop.onlyRefund().id)
    })

    it('lets a second lost answer through; the notification then settles the order', async () => {
      const t = await paidTariff()
      t.shop.failRefund(timeout(), { processed: true })
      t.shop.failRefund(timeout())

      await expect(refund(t, { endSubscription: true })).rejects.toBeInstanceOf(YookassaError)

      // The shop made the refund; the platform knows nothing of it yet.
      const made = t.shop.onlyRefund()
      await untouched(t)

      // The description of the refund names the order: its notification is known to be ours.
      expect(await settleRefund(t.deps, { refundId: made.id })).toEqual({
        state: 'refunded',
        orderId: t.orderId,
      })
      let state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'refunded',
        yookassaRefundId: made.id,
        refundedAt: TEST_NOW,
      })
      expect(state.entries(refundSettled)).toHaveLength(1)
      expect(state.entries(refundSettled)[0]).toMatchObject({
        actorType: 'system',
        targetId: t.orderId,
        meta: { refundId: made.id, paymentId: t.paymentId, amount: '4900.00', adopted: true },
      })
      expect(state.entries(refundOutside)).toEqual([])
      // The notification moves nothing but the order.
      expect(state.subscription?.status).toBe('active')

      // The operator's command, run again, ends the tariff and leaves its own entry.
      expect(await refund(t, { endSubscription: true })).toMatchObject({
        state: 'refunded',
        refundId: made.id,
        requested: false,
        settled: false,
        tariff: { outcome: 'ended' },
      })
      state = await written(t)
      expect(state.subscription?.status).toBe('cancelled')
      expect(state.entries(refundAction)).toHaveLength(1)
      expect(state.entries(refundAction)[0]?.meta).toMatchObject({
        reason: WHO.reason,
        refundId: made.id,
        requested: false,
        settled: false,
        tariff: 'ended',
      })
      expect(t.shop.refunds.size).toBe(1)
    })

    it('finishes a refund whose answer was lost twice when the notification never comes', async () => {
      const t = await paidTariff()
      t.shop.failRefund(timeout(), { processed: true })
      t.shop.failRefund(timeout())
      await expect(refund(t, { endSubscription: true })).rejects.toBeInstanceOf(YookassaError)
      const made = t.shop.onlyRefund()
      await untouched(t)

      // web was down for the day ЮKassa repeats a notification. The command, run again, reads
      // the whole payment as returned, repeats its own request once and gets its own refund.
      const result = await refund(t, { endSubscription: true })

      expect(result).toMatchObject({
        state: 'refunded',
        refundId: made.id,
        // An earlier run had asked for it.
        requested: false,
        settled: true,
        cabinet: false,
        tariff: { outcome: 'ended', expiredCredits: 30 },
      })
      expect(t.shop.refundRequests.map((request) => request.idempotenceKey)).toEqual([
        `refund.${t.orderId}`,
        `refund.${t.orderId}`,
        `refund.${t.orderId}`,
      ])
      // Still the one refund, and the money went back once.
      expect(t.shop.refunds.size).toBe(1)
      expect(t.shop.payments.get(t.paymentId)?.refunded_amount?.value).toBe('4900.00')
      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'refunded',
        yookassaRefundId: made.id,
        refundedAt: TEST_NOW,
      })
      expect(state.subscription?.status).toBe('cancelled')
      expect(state.entries(refundAction)).toHaveLength(1)
      expect(state.entries(refundAction)[0]?.meta).toMatchObject({
        refundId: made.id,
        refundStatus: 'succeeded',
        requested: false,
        settled: true,
        tariff: 'ended',
      })
      expect(state.entries(refundOutside)).toEqual([])

      // The late notification finds nothing left to do.
      expect(await settleRefund(t.deps, { refundId: made.id })).toEqual({
        state: 'refunded',
        orderId: t.orderId,
      })
      expect((await written(t)).audit).toEqual(state.audit)
    })

    it('finds a lost refund that is still pending under the same key', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })
      t.shop.failRefund(timeout(), { processed: true })
      t.shop.failRefund(timeout())
      await expect(refund(t)).rejects.toBeInstanceOf(YookassaError)
      const made = t.shop.onlyRefund()

      // No money has left the payment yet: the request is simply made again, with its key.
      expect(await refund(t)).toMatchObject({
        state: 'pending',
        refundId: made.id,
        requested: true,
        settled: false,
      })
      expect(t.shop.refunds.size).toBe(1)
      expect((await written(t)).order(t.orderId)).toMatchObject({
        status: 'paid',
        yookassaRefundId: made.id,
      })
    })

    it('repeats a lost request under the numbered key of its attempt', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'canceled' })
      const cancelled = await refund(t)
      t.shop.failRefund(timeout(), { processed: true })
      t.shop.failRefund(timeout())
      await expect(refund(t)).rejects.toBeInstanceOf(YookassaError)

      const result = await refund(t)

      expect(result).toMatchObject({ state: 'refunded', requested: false, settled: true })
      expect(result.refundId).not.toBe(cancelled.refundId)
      expect(t.shop.refundRequests.map((request) => request.idempotenceKey)).toEqual([
        `refund.${t.orderId}`,
        `refund.${t.orderId}.1`,
        `refund.${t.orderId}.1`,
        `refund.${t.orderId}.1`,
      ])
      expect(t.shop.refunds.size).toBe(2)
    })

    it('lets the failure through when the repeat for a returned payment gets no answer', async () => {
      const t = await paidTariff()
      t.shop.failRefund(timeout(), { processed: true })
      t.shop.failRefund(timeout())
      await expect(refund(t)).rejects.toBeInstanceOf(YookassaError)
      t.shop.failRefund(timeout())

      // Nobody can tell whose refund it was: nothing is decided, and nothing is written.
      await expect(refund(t)).rejects.toBeInstanceOf(YookassaError)

      await untouched(t)
      expect(t.shop.refunds.size).toBe(1)
      expect(await refund(t)).toMatchObject({ state: 'refunded', settled: true })
    })

    it('settles once when the notification outruns the command that asked', async () => {
      const t = await paidTariff()
      const createRefund = t.deps.yookassa.createRefund
      t.deps.yookassa.createRefund = async (input, key) => {
        const made = await createRefund(input, key)
        // ЮKassa notifies before its answer has been stored.
        expect(await settleRefund(t.deps, { refundId: made.id })).toEqual({
          state: 'refunded',
          orderId: t.orderId,
        })
        return made
      }

      const result = await refund(t, { endSubscription: true })

      const made = t.shop.onlyRefund()
      expect(result).toMatchObject({
        state: 'refunded',
        refundId: made.id,
        requested: true,
        // The notification had done it.
        settled: false,
        tariff: { outcome: 'ended', expiredCredits: 30 },
      })
      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'refunded',
        yookassaRefundId: made.id,
      })
      expect(state.entries(refundSettled)).toHaveLength(1)
      expect(state.entries(refundSettled)[0]?.meta).toMatchObject({ adopted: true })
      expect(state.entries(refundAction)).toHaveLength(1)
      // Never taken for a refund somebody made in the cabinet.
      expect(state.entries(refundOutside)).toEqual([])
      expect(state.subscription?.status).toBe('cancelled')
    })

    it('changes nothing when ЮKassa refuses the request', async () => {
      const t = await paidTariff()
      t.shop.failRefund(badRequest())

      await expect(refund(t, { endSubscription: true })).rejects.toBeInstanceOf(YookassaApiError)

      // A refusal is not repeated.
      expect(t.shop.refundRequests).toHaveLength(1)
      expect(t.shop.refunds.size).toBe(0)
      const state = await untouched(t)
      expect(state.subscription?.status).toBe('active')
    })

    it('changes nothing when the payment cannot be read back', async () => {
      const t = await paidTariff()
      t.shop.failRead(timeout())

      await expect(refund(t)).rejects.toBeInstanceOf(YookassaError)

      expect(t.shop.refundRequests).toEqual([])
      await untouched(t)
    })
  })

  describe('a payment returned in the cabinet', () => {
    it('is not returned again: the operator is told to reconcile by hand', async () => {
      const t = await paidTariff()
      const cabinet = t.shop.cabinetRefund(t.paymentId)

      await expect(refund(t, { endSubscription: true })).rejects.toMatchObject({
        name: 'DomainError',
        code: 'CONFLICT',
        message: refundRefusals.refundedElsewhere,
      })

      // The whole payment has gone back, so the shop was asked once whether the refund is the
      // order's own whose answer was lost. It holds none under the order's key and refused to
      // make one: nothing is left to return.
      expect(t.shop.refundRequests.map((request) => request.idempotenceKey)).toEqual([
        `refund.${t.orderId}`,
      ])
      expect([...t.shop.refunds.keys()]).toEqual([cabinet.id])
      expect(t.shop.payments.get(t.paymentId)?.refunded_amount?.value).toBe('4900.00')
      const state = await untouched(t)
      expect(state.subscription?.status).toBe('active')
    })

    it('is not taken for the order’s own when the shop answers the repeat with another refund', async () => {
      const t = await paidTariff()
      const cabinet = t.shop.cabinetRefund(t.paymentId)
      const createRefund = t.deps.yookassa.createRefund
      for (const patch of [
        // No mark of ours.
        {},
        // The mark of another order.
        { description: refundDescription(ORDER) },
        // `metadata` is not what a refund of ours is known by.
        { metadata: { order_id: t.orderId } },
        // Ours by its mark, but it moved no money: somebody else returned the payment.
        { description: refundDescription(t.orderId), status: 'canceled' as const },
        { description: refundDescription(t.orderId), status: 'pending' as const },
        // Another payment, another amount.
        { description: refundDescription(t.orderId), payment_id: 'another-payment' },
        {
          description: refundDescription(t.orderId),
          amount: { value: '4899.99', currency: 'RUB' as const },
        },
      ]) {
        t.deps.yookassa.createRefund = () => Promise.resolve({ ...cabinet, ...patch })
        await expect(refund(t)).rejects.toMatchObject({
          code: 'CONFLICT',
          message: refundRefusals.refundedElsewhere,
        })
      }
      t.deps.yookassa.createRefund = createRefund

      await untouched(t)
    })

    it('is not asked for again when only a part went back', async () => {
      const t = await paidTariff()
      t.shop.cabinetRefund(t.paymentId, '100.00')

      await expect(refund(t)).rejects.toMatchObject({ message: refundRefusals.refundedElsewhere })

      expect(t.shop.refundRequests).toEqual([])
      await untouched(t)
    })

    it('leaves one audit entry with the amounts when its notification comes, however often', async () => {
      const t = await paidTariff()
      const made = t.shop.cabinetRefund(t.paymentId, '1000.00')
      const outcome = { state: 'outside', orderId: t.orderId }

      const results = await Promise.all([
        settleRefund(t.deps, { refundId: made.id }),
        settleRefund(t.deps, { refundId: made.id }),
        settleRefund(t.deps, { refundId: made.id }),
      ])
      for (const result of results) expect(result).toEqual(outcome)
      expect(await settleRefund(t.deps, { refundId: made.id })).toEqual(outcome)

      const state = await untouched(t)
      expect(state.entries(refundOutside)).toHaveLength(1)
      expect(state.entries(refundOutside)[0]).toMatchObject({
        actorType: 'system',
        actorId: 'billing',
        targetType: 'order',
        targetId: t.orderId,
        meta: {
          refundId: made.id,
          paymentId: t.paymentId,
          refundAmount: '1000.00',
          refundCurrency: 'RUB',
          orderAmount: '4900.00',
          orderStatus: 'paid',
          ownRefundId: null,
        },
      })
      expect(state.subscription?.status).toBe('active')
      expect(state.balances.tariff.balance).toBe(30)
    })

    it('gets an entry of its own for every refund', async () => {
      const t = await paidTariff()
      const first = t.shop.cabinetRefund(t.paymentId, '1000.00')
      const second = t.shop.cabinetRefund(t.paymentId, '3900.00')

      await settleRefund(t.deps, { refundId: first.id })
      await settleRefund(t.deps, { refundId: second.id })
      await settleRefund(t.deps, { refundId: first.id })

      const state = await untouched(t)
      expect(state.entries(refundOutside).map((entry) => entry.meta)).toMatchObject([
        { refundId: first.id, refundAmount: '1000.00' },
        { refundId: second.id, refundAmount: '3900.00' },
      ])
    })

    it('is told from the platform’s own refund that is still pending', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })
      await refund(t)
      const own = t.shop.onlyRefund()
      // The pending refund of ours has moved nothing yet: the cabinet returns it all meanwhile.
      const foreign = t.shop.cabinetRefund(t.paymentId)

      expect(await settleRefund(t.deps, { refundId: foreign.id })).toEqual({
        state: 'outside',
        orderId: t.orderId,
      })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({ status: 'paid', yookassaRefundId: own.id })
      expect(state.entries(refundOutside)[0]?.meta).toMatchObject({
        refundId: foreign.id,
        ownRefundId: own.id,
      })
    })

    it('is not taken for ours when it names another order', async () => {
      const t = await paidTariff()
      const made = t.shop.cabinetRefund(t.paymentId, undefined, {
        description: refundDescription(ORDER),
      })

      expect(await settleRefund(t.deps, { refundId: made.id })).toEqual({
        state: 'outside',
        orderId: t.orderId,
      })

      expect((await untouched(t)).entries(refundOutside)).toHaveLength(1)
    })

    it('is not taken for ours by metadata: only the description marks a refund of the platform', async () => {
      const t = await paidTariff()
      const made = t.shop.cabinetRefund(t.paymentId, undefined, {
        description: 'Возврат по письму клиента',
        metadata: { order_id: t.orderId },
      })

      expect(await settleRefund(t.deps, { refundId: made.id })).toEqual({
        state: 'outside',
        orderId: t.orderId,
      })

      expect((await untouched(t)).entries(refundOutside)).toHaveLength(1)
    })

    it('is not taken for ours when it returns another amount than the order', async () => {
      const t = await paidTariff()
      const made = t.shop.cabinetRefund(t.paymentId, '4899.99', {
        description: refundDescription(t.orderId),
      })

      expect(await settleRefund(t.deps, { refundId: made.id })).toEqual({
        state: 'outside',
        orderId: t.orderId,
      })

      expect((await untouched(t)).entries(refundOutside)).toHaveLength(1)
    })

    it('is not taken for ours when the order is not a paid one', async () => {
      const t = await writtenTariff({}, { status: 'failed', paidAt: null })
      const made = t.shop.cabinetRefund(t.paymentId, undefined, {
        description: refundDescription(t.orderId),
      })

      expect(await settleRefund(t.deps, { refundId: made.id })).toEqual({
        state: 'outside',
        orderId: t.orderId,
      })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({ status: 'failed', yookassaRefundId: null })
      expect(state.entries(refundOutside)[0]?.meta).toMatchObject({ orderStatus: 'failed' })
      expect(state.entries(refundSettled)).toEqual([])
    })
  })

  describe('a payment returned in the cabinet, marked on the operator’s word', () => {
    it('makes the order refunded without a refund of its own once the shop reports all of it returned', async () => {
      const t = await paidTariff({ autoRenew: true })
      const cabinet = t.shop.cabinetRefund(t.paymentId)
      await settleRefund(t.deps, { refundId: cabinet.id })
      const before = await written(t)

      const result = await refund(t, { refundedInCabinet: true })

      expect(result).toEqual({
        orderId: t.orderId,
        state: 'refunded',
        refundId: null,
        amount: '4900.00',
        requested: false,
        settled: true,
        cabinet: true,
        cancellation: null,
        tariff: null,
        credits: null,
      })
      // The shop was asked for nothing but the payment.
      expect(t.shop.reads.at(-1)).toBe(t.paymentId)
      expect(t.shop.refundRequests).toEqual([])
      expect(t.shop.refunds.size).toBe(1)
      const state = await written(t)
      const order = state.order(t.orderId)
      expect(order).toMatchObject({
        status: 'refunded',
        yookassaRefundId: null,
        refundedAt: TEST_NOW,
      })
      expect(order.refundedAmount?.toFixed(2)).toBe('4900.00')
      expect(state.entries(refundAction)).toHaveLength(1)
      expect(state.entries(refundAction)[0]).toMatchObject({
        actorType: 'operator',
        actorId: WHO.operator,
        targetId: t.orderId,
        meta: {
          reason: WHO.reason,
          refundId: null,
          paymentId: t.paymentId,
          amount: '4900.00',
          refundStatus: 'succeeded',
          orderStatus: 'refunded',
          requested: false,
          settled: true,
          cabinet: true,
          moneyOnly: true,
          tariff: null,
          credits: null,
        },
      })
      // Without an option only the order changes.
      expect(state.subscriptions).toEqual(before.subscriptions)
      expect(state.balances).toEqual(before.balances)
      // The customer sees the order as returned.
      expect((await listPayments(db, t.workspaceId)).items[0]).toMatchObject({
        id: t.orderId,
        status: 'refunded',
        refundedAmount: '4900.00',
        refundedAt: TEST_NOW,
      })

      // Run again: nothing to do, nothing written, the shop not asked.
      const reads = t.shop.reads.length
      expect(await refund(t, { refundedInCabinet: true })).toEqual({
        ...result,
        settled: false,
        cabinet: false,
      })
      expect(t.shop.reads).toHaveLength(reads)
      expect((await written(t)).audit).toEqual(state.audit)
    })

    it('ends the tariff in the same call when asked to, and in a later one as well', async () => {
      const t = await paidTariff()
      t.shop.cabinetRefund(t.paymentId)

      expect(await refund(t, { refundedInCabinet: true, endSubscription: true })).toMatchObject({
        state: 'refunded',
        settled: true,
        cabinet: true,
        tariff: { outcome: 'ended', subscriptionId: t.subscriptionId, expiredCredits: 30 },
      })

      let state = await written(t)
      expect(state.subscription).toMatchObject({ status: 'cancelled', currentPeriodEnd: TEST_NOW })
      expect(state.balances.tariff.balance).toBe(0)
      expect(state.entries(refundAction)[0]?.meta).toMatchObject({
        cabinet: true,
        endSubscription: true,
        tariff: 'ended',
      })

      // The other order of events: the mark first, the option in a call of its own.
      const later = await paidTariff()
      later.shop.cabinetRefund(later.paymentId)
      await refund(later, { refundedInCabinet: true })
      expect(await refund(later, { endSubscription: true })).toMatchObject({
        state: 'refunded',
        settled: false,
        cabinet: false,
        tariff: { outcome: 'ended' },
      })
      state = await written(later)
      expect(state.subscription?.status).toBe('cancelled')
      expect(later.shop.refundRequests).toEqual([])
    })

    it('takes the credits of a pack that was returned in the cabinet', async () => {
      const t = await paidTariff()
      const pack = await boughtPack(t)
      t.shop.cabinetRefund(pack.paymentId)

      const result = await refund(
        { ...t, orderId: pack.orderId },
        { refundedInCabinet: true, takeCredits: true },
      )

      expect(result).toMatchObject({
        state: 'refunded',
        cabinet: true,
        credits: { outcome: 'taken', credits: pack.credits },
      })
      const state = await written(t)
      expect(state.order(pack.orderId)).toMatchObject({
        status: 'refunded',
        yookassaRefundId: null,
      })
      expect(state.balances.pack.balance).toBe(0)
      expect(state.balances.tariff.balance).toBe(30)
    })

    it('is refused while the shop does not report the whole payment as returned', async () => {
      const t = await paidTariff()
      const refused = { code: 'CONFLICT', message: refundRefusals.cabinetNotFull }

      // Nothing has gone back.
      await expect(
        refund(t, { refundedInCabinet: true, endSubscription: true }),
      ).rejects.toMatchObject(refused)
      // A part has.
      t.shop.cabinetRefund(t.paymentId, '4899.99')
      await expect(refund(t, { refundedInCabinet: true })).rejects.toMatchObject(refused)

      expect(t.shop.refundRequests).toEqual([])
      const state = await untouched(t)
      expect(state.subscription?.status).toBe('active')
    })

    it('is refused when the payment the shop reports is not the order’s', async () => {
      const t = await paidTariff()
      t.shop.cabinetRefund(t.paymentId)
      t.shop.patch(t.paymentId, { amount: { value: '4899.00', currency: 'RUB' } })

      await expect(refund(t, { refundedInCabinet: true })).rejects.toMatchObject({
        message: refundRefusals.paymentMismatch,
      })

      await untouched(t)
    })

    it('is refused for an order that keeps a refund of its own', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })
      await refund(t)
      const own = t.shop.onlyRefund()
      const reads = t.shop.reads.length

      await expect(refund(t, { refundedInCabinet: true })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: refundRefusals.cabinetOwnRefund,
      })

      // Refused before the shop was asked.
      expect(t.shop.reads).toHaveLength(reads)
      expect((await written(t)).order(t.orderId)).toMatchObject({
        status: 'paid',
        yookassaRefundId: own.id,
      })
    })

    it('does not mark an order that came to keep a refund while the shop was asked', async () => {
      const t = await paidTariff()
      t.shop.cabinetRefund(t.paymentId)
      const getPayment = t.deps.yookassa.getPayment
      t.deps.yookassa.getPayment = async (id) => {
        const payment = await getPayment(id)
        // Another run asked for a refund of its own and stored it meanwhile.
        await db.order.update({
          where: { id: t.orderId },
          data: { yookassaRefundId: 'refund-of-another-run' },
        })
        return payment
      }

      await expect(
        refund(t, { refundedInCabinet: true, endSubscription: true }),
      ).rejects.toMatchObject({ message: refundRefusals.cabinetOwnRefund })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'paid',
        yookassaRefundId: 'refund-of-another-run',
        refundedAt: null,
      })
      expect(state.entries(refundAction)).toEqual([])
      expect(state.subscription?.status).toBe('active')
    })

    it('marks an order of a period the tariff has left behind, and leaves that tariff alone', async () => {
      const t = await paidTariff()
      t.shop.cabinetRefund(t.paymentId)
      const next = new Date('2026-12-04T09:00:00Z')
      await db.subscription.update({
        where: { id: t.subscriptionId },
        data: { currentPeriodStart: PERIOD_END, currentPeriodEnd: next },
      })

      // The money has gone back already: nothing is refused as «not returned».
      expect(await refund(t, { refundedInCabinet: true, endSubscription: true })).toMatchObject({
        state: 'refunded',
        cabinet: true,
        tariff: { outcome: 'not_current', subscriptionId: t.subscriptionId },
      })

      const state = await written(t)
      expect(state.order(t.orderId).status).toBe('refunded')
      expect(state.subscription).toMatchObject({ status: 'active', currentPeriodEnd: next })
    })

    it('does not refuse the option for a marked order whose tariff has renewed since', async () => {
      const t = await paidTariff()
      t.shop.cabinetRefund(t.paymentId)
      await refund(t, { refundedInCabinet: true })
      const next = new Date('2026-12-04T09:00:00Z')
      await db.subscription.update({
        where: { id: t.subscriptionId },
        data: { currentPeriodStart: PERIOD_END, currentPeriodEnd: next },
      })

      // The order is refunded and keeps no refund id: its money is not «not returned».
      expect(await refund(t, { endSubscription: true })).toMatchObject({
        state: 'refunded',
        refundId: null,
        tariff: { outcome: 'not_current', subscriptionId: t.subscriptionId },
      })

      expect((await written(t)).subscription).toMatchObject({
        status: 'active',
        currentPeriodEnd: next,
      })
    })

    it('closes the entry that asked for the money of the order to be returned', async () => {
      const t = await paidTariff()
      // A second paid order while the tariff is on, returned in the cabinet in two parts whose
      // notifications never came.
      const payment = await t.deps.yookassa.createPayment(
        { amount: { value: '4900.00', currency: 'RUB' }, capture: true },
        'second-order-of-the-test',
      )
      const extra = await fixtures.order({
        workspaceId: t.workspaceId,
        planId: t.plan.id,
        userId: t.userId,
        status: 'pending',
        yookassaPaymentId: payment.id,
      })
      t.shop.succeed(payment.id)
      await settleOrder(t.deps, { orderId: extra.id })
      const mine = async () =>
        (await listRefundsNeeded(t.deps)).items.filter((item) => item.workspaceId === t.workspaceId)
      expect(await mine()).toMatchObject([{ orderId: extra.id, toReturn: '4900.00' }])
      t.shop.cabinetRefund(payment.id, '900.00')
      t.shop.cabinetRefund(payment.id, '4000.00')

      await refund({ ...t, orderId: extra.id }, { refundedInCabinet: true })

      expect(await mine()).toEqual([])
      expect((await written(t)).subscription?.status).toBe('active')
    })

    it('keeps the entry of the cabinet refund when its notification comes afterwards', async () => {
      const t = await paidTariff()
      const cabinet = t.shop.cabinetRefund(t.paymentId)
      await refund(t, { refundedInCabinet: true })

      expect(await settleRefund(t.deps, { refundId: cabinet.id })).toEqual({
        state: 'outside',
        orderId: t.orderId,
      })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({ status: 'refunded', yookassaRefundId: null })
      expect(state.entries(refundOutside)).toMatchObject([
        { meta: { refundId: cabinet.id, refundAmount: '4900.00', orderStatus: 'refunded' } },
      ])
      expect(state.entries(refundSettled)).toEqual([])
    })
  })

  describe('a notification', () => {
    it('makes the order refunded when its pending refund has gone through, and nothing else', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })
      await refund(t, { endSubscription: true })
      const made = t.shop.onlyRefund()
      t.shop.succeedRefund(made.id)
      const outcome = { state: 'refunded', orderId: t.orderId }

      const results = await Promise.all([
        settleRefund(t.deps, { refundId: made.id }),
        settleRefund(t.deps, { refundId: made.id }),
        settleRefund(t.deps, { refundId: made.id }),
      ])
      for (const result of results) expect(result).toEqual(outcome)
      expect(await settleRefund(t.deps, { refundId: made.id })).toEqual(outcome)

      const state = await written(t)
      const order = state.order(t.orderId)
      expect(order).toMatchObject({
        status: 'refunded',
        yookassaRefundId: made.id,
        refundedAt: TEST_NOW,
      })
      expect(order.refundedAmount?.toFixed(2)).toBe('4900.00')
      expect(state.entries(refundSettled)).toHaveLength(1)
      expect(state.entries(refundSettled)[0]?.meta).toMatchObject({
        refundId: made.id,
        adopted: false,
      })
      // What the operator asked for besides the money waits for the operator's own call.
      expect(state.subscription).toMatchObject({ status: 'active', currentPeriodEnd: PERIOD_END })
      expect(state.balances.tariff.balance).toBe(30)
      expect(state.entries(renewalJobAuditActions.subscriptionEnd)).toEqual([])

      expect(await refund(t, { endSubscription: true })).toMatchObject({
        state: 'refunded',
        requested: false,
        settled: false,
        tariff: { outcome: 'ended', expiredCredits: 30 },
      })
    })

    it.each(['pending', 'canceled'] as const)(
      'changes nothing while the refund is %s',
      async (status) => {
        const t = await paidTariff()
        t.shop.refundAs({ status: 'pending' })
        await refund(t)
        const made = t.shop.onlyRefund()
        if (status === 'canceled') t.shop.cancelRefund(made.id)
        const before = await written(t)

        expect(await settleRefund(t.deps, { refundId: made.id })).toEqual({
          state: status,
          orderId: t.orderId,
        })

        expect(await written(t)).toMatchObject({ orders: before.orders, audit: before.audit })
      },
    )

    it('about a refund already settled by the command changes nothing', async () => {
      const t = await paidTariff()
      await refund(t)
      const before = await written(t)

      expect(await settleRefund(t.deps, { refundId: t.shop.onlyRefund().id })).toEqual({
        state: 'refunded',
        orderId: t.orderId,
      })

      expect(await written(t)).toMatchObject({ orders: before.orders, audit: before.audit })
    })

    it('knows no refund the shop does not know, and none of a payment no order holds', async () => {
      const t = await paidTariff()
      expect(await settleRefund(t.deps, { refundId: 'no-such-refund' })).toEqual({
        state: 'unknown',
      })
      const stray = t.shop.cabinetRefund(t.shop.paid('100.00').id)
      expect(await settleRefund(t.deps, { refundId: stray.id })).toEqual({ state: 'unknown' })
      await untouched(t)
    })

    it('does not act on an answer about another refund', async () => {
      const t = await paidTariff()
      const made = t.shop.cabinetRefund(t.paymentId)
      const getRefund = t.deps.yookassa.getRefund
      t.deps.yookassa.getRefund = async (id) => ({ ...(await getRefund(made.id)), id: `${id}-x` })

      expect(await settleRefund(t.deps, { refundId: made.id })).toEqual({ state: 'unknown' })

      expect((await untouched(t)).entries(refundOutside)).toEqual([])
    })

    it('lets a failure of the shop through and leaves the order as it is', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })
      await refund(t)
      const made = t.shop.onlyRefund()
      t.shop.succeedRefund(made.id)
      t.shop.failRefundRead(timeout())

      await expect(settleRefund(t.deps, { refundId: made.id })).rejects.toBeInstanceOf(
        YookassaError,
      )

      expect((await written(t)).order(t.orderId).status).toBe('paid')
      // The repeat of the notification settles it.
      expect(await settleRefund(t.deps, { refundId: made.id })).toMatchObject({ state: 'refunded' })
    })
  })

  describe('refusals', () => {
    it('refuses an order that does not exist', async () => {
      const { deps } = refundTestDeps(db)
      await expect(refundOrder(deps, { orderId: ORDER, ...WHO })).rejects.toMatchObject({
        code: 'BILLING_ORDER_NOT_FOUND',
        httpStatus: 404,
      })
    })

    it.each(['pending', 'failed', 'cancelled'] as const)(
      'refuses a %s order and asks the shop nothing',
      async (status) => {
        const t = await writtenTariff({}, { status, paidAt: null })

        await expect(refund(t)).rejects.toMatchObject({
          name: 'DomainError',
          code: 'CONFLICT',
          httpStatus: 409,
          message: refundRefusals.notPaid,
        })

        expect(t.shop.reads).toEqual([])
        expect(t.shop.refundRequests).toEqual([])
        const state = await written(t)
        expect(state.order(t.orderId)).toMatchObject({ status, yookassaRefundId: null })
        expect(state.entries(refundAction)).toEqual([])
      },
    )

    it('refuses a paid order that holds no payment', async () => {
      const t = await writtenTariff({}, { yookassaPaymentId: null })

      await expect(refund(t)).rejects.toMatchObject({ message: refundRefusals.noPayment })

      expect(t.shop.reads).toEqual([])
      await untouched(t)
    })

    it.each([
      ['is of another amount', { amount: { value: '4899.00', currency: 'RUB' as const } }],
      ['was cancelled', { status: 'canceled' as const, paid: false }],
      ['is still pending', { status: 'pending' as const, paid: false }],
    ])('refuses when the payment the shop reports %s', async (_case, patch) => {
      const t = await writtenTariff()
      t.shop.patch(t.paymentId, patch)

      await expect(refund(t)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: refundRefusals.paymentMismatch,
      })

      expect(t.shop.refundRequests).toEqual([])
      await untouched(t)
    })

    it('refuses an answer of the shop about another payment or amount, and stores nothing', async () => {
      const t = await writtenTariff()
      const other = t.shop.paid('4900.00')
      t.shop.refundAs({ payment_id: other.id })

      await expect(refund(t)).rejects.toMatchObject({ message: refundRefusals.refundMismatch })

      await untouched(t)
    })

    it('does not settle the order with a refund other than the one it came to keep meanwhile', async () => {
      const t = await writtenTariff()
      const createRefund = t.deps.yookassa.createRefund
      t.deps.yookassa.createRefund = async (input, key) => {
        // Another run stored a refund of its own while this one was asking the shop.
        await db.order.update({
          where: { id: t.orderId },
          data: { yookassaRefundId: 'refund-of-another-run' },
        })
        return createRefund(input, key)
      }

      await expect(refund(t, { endSubscription: true })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: refundRefusals.refundMismatch,
      })

      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({
        status: 'paid',
        yookassaRefundId: 'refund-of-another-run',
        refundedAt: null,
      })
      expect(state.entries(refundAction)).toEqual([])
      expect(state.subscription?.status).toBe('active')
    })

    it('refuses a stored refund the shop reports as another one', async () => {
      const t = await writtenTariff()
      t.shop.refundAs({ status: 'pending' })
      await refund(t)
      const made = t.shop.onlyRefund()
      t.shop.succeedRefund(made.id)
      made.amount = { value: '100.00', currency: 'RUB' }

      await expect(refund(t)).rejects.toMatchObject({ message: refundRefusals.refundMismatch })

      expect((await written(t)).order(t.orderId)).toMatchObject({
        status: 'paid',
        yookassaRefundId: made.id,
      })
    })
  })

  describe('ending the tariff', () => {
    const { subscriptionEnd } = renewalJobAuditActions

    it('ends it now, expires what is left of the quota and switches auto-renewal off', async () => {
      const t = await paidTariff({ autoRenew: true })
      await db.subscription.update({
        where: { id: t.subscriptionId },
        data: { renewalNoticePeriodEnd: PERIOD_END },
      })

      const result = await refund(t, { endSubscription: true })

      expect(result).toMatchObject({
        state: 'refunded',
        settled: true,
        tariff: {
          outcome: 'ended',
          subscriptionId: t.subscriptionId,
          expiredCredits: 30,
          endedAt: TEST_NOW,
        },
        credits: null,
      })
      const state = await written(t)
      expect(state.subscription).toMatchObject({
        id: t.subscriptionId,
        status: 'cancelled',
        currentPeriodStart: PAID_AT,
        // The period is cut to the moment of the end.
        currentPeriodEnd: TEST_NOW,
        periodAnchor: PAID_AT,
        cancelAtPeriodEnd: true,
        cancelledAt: TEST_NOW,
        renewalNoticePeriodEnd: null,
        // The saved method is not ours to forget here: nothing charges an ended tariff.
        paymentMethodId: t.paymentId,
      })
      expect(state.balances.tariff).toEqual({ balance: 0, held: 0, available: 0 })
      const expiry = state.ledger.filter((row) => row.kind === 'expire')
      expect(expiry).toHaveLength(1)
      expect(expiry[0]).toMatchObject({
        // The key of the period that was paid for, as every other end of a period.
        idempotencyKey: ledgerKeys.tariffExpiry(t.subscriptionId, PERIOD_END),
        orderId: null,
      })
      expect(expiry[0]?.amount.toFixed(2)).toBe('-30.00')
      expect(state.entries(subscriptionEnd)).toHaveLength(1)
      expect(state.entries(subscriptionEnd)[0]).toMatchObject({
        actorType: 'operator',
        actorId: WHO.operator,
        targetType: 'subscription',
        targetId: t.subscriptionId,
        meta: {
          status: 'cancelled',
          reason: REFUND_END_REASON,
          orderId: t.orderId,
          periodEnd: PERIOD_END.toISOString(),
          endedAt: TEST_NOW.toISOString(),
          expiredCredits: 30,
          packCreditsLeft: 0,
          notified: false,
        },
      })
      expect(state.entries(refundAction)[0]?.meta).toMatchObject({
        endSubscription: true,
        moneyOnly: false,
        tariff: 'ended',
        expiredCredits: 30,
      })
      // No letter of its own: the operator answers the customer.
      const user = await db.user.findUniqueOrThrow({ where: { id: t.userId } })
      const letters = await db.outboxEvent.findMany({
        where: { topic: 'notifications', payload: { path: ['to'], equals: user.email } },
      })
      expect(letters.map((letter) => letter.dedupeKey)).toEqual([paymentLetterKey(t.orderId)])

      // The customer has no tariff any more and may buy one again.
      expect(await getPlanOverview(db, t.workspaceId)).toEqual({ subscription: null })
      await expect(
        startCheckout(t.deps, { userId: t.userId, planSlug: t.plan.slug, autoRenew: false }),
      ).resolves.toMatchObject({ confirmationUrl: expect.stringContaining('https://') })
    })

    it('leaves the gift where it is: only what is left of the quota expires', async () => {
      const t = await paidTariff()
      const gift = await gifted({ userId: t.userId, workspaceId: t.workspaceId })

      const result = await refund(t, { endSubscription: true })

      expect(result.tariff).toMatchObject({ outcome: 'ended', expiredCredits: 30 })
      const state = await written(t)
      expect(state.subscription?.status).toBe('cancelled')
      // The customer has no tariff any more, and the gift is theirs to spend all the same.
      expect(state.balances).toEqual({
        tariff: { balance: 0, held: 0, available: 0 },
        gift: { balance: 35, held: 5, available: 30, granted: true },
        pack: { balance: 0, held: 0, available: 0 },
        totalAvailable: 30,
      })
      expect(state.ledger.filter((row) => row.kind === 'expire')).toMatchObject([
        { unit: 'credit_tariff' },
      ])
      // Not a column of the account, of its journal or of its reserve moved.
      expect(await giftRows(t.workspaceId)).toEqual(gift)
    })

    it('never touches credits a task holds or has spent, nor the purchased credits', async () => {
      const t = await paidTariff({ plan: { creditsPerMonth: 100 } })
      const pack = await boughtPack(t)
      const [spent, held] = await Promise.all([
        fixtures.task(t.workspaceId),
        fixtures.task(t.workspaceId),
      ])
      // Each task sets its step of 45 credits aside on the tariff.
      for (const { taskId } of [spent, held]) {
        await fixtures.reserve({
          workspaceId: t.workspaceId,
          taskId,
          attempt: 1,
          now: TEST_NOW,
          expiresAt: new Date(TEST_NOW.getTime() + DAY_MS),
        })
      }
      await db.$transaction((tx) =>
        settleTaskCharge(tx, { taskId: spent.taskId, credits: 17, now: TEST_NOW }),
      )

      const result = await refund(t, { endSubscription: true })

      // 100 granted, 17 spent, 45 held: 38 were available.
      expect(result.tariff).toMatchObject({ outcome: 'ended', expiredCredits: 38 })
      let state = await written(t)
      expect(state.balances.tariff).toEqual({ balance: 45, held: 45, available: 0 })
      expect(state.balances.pack).toEqual({
        balance: pack.credits,
        held: 0,
        available: pack.credits,
      })
      expect(state.holds.filter((row) => row.status === 'active')).toHaveLength(1)
      expect(state.entries(subscriptionEnd)[0]?.meta).toMatchObject({
        expiredCredits: 38,
        packCreditsLeft: pack.credits,
      })
      expect(state.order(pack.orderId).status).toBe('paid')

      // The task is cancelled later: its credits are of a tariff that is over, and are not
      // given back.
      await db.$transaction((tx) => releaseTask(tx, { taskId: held.taskId, now: TEST_NOW }))
      state = await written(t)
      expect(state.balances.tariff).toEqual({ balance: 0, held: 0, available: 0 })
      expect(state.balances.pack.balance).toBe(pack.credits)
    })

    it('ends an overdue tariff as cancelled and leaves its paid period as it was', async () => {
      const start = new Date('2026-08-18T09:00:00Z')
      const end = new Date('2026-09-18T09:00:00Z')
      const t = await writtenTariff({
        status: 'past_due',
        currentPeriodStart: start,
        currentPeriodEnd: end,
        periodAnchor: start,
        pastDueSince: end,
        cancelledAt: null,
      })

      const result = await refund(t, { endSubscription: true })

      expect(result.tariff).toMatchObject({ outcome: 'ended', expiredCredits: 30, endedAt: end })
      const state = await written(t)
      expect(state.subscription).toMatchObject({
        status: 'cancelled',
        currentPeriodStart: start,
        currentPeriodEnd: end,
        cancelAtPeriodEnd: true,
        cancelledAt: TEST_NOW,
      })
      expect(state.entries(subscriptionEnd)[0]?.meta).toMatchObject({
        status: 'cancelled',
        reason: 'refund',
        periodEnd: end.toISOString(),
        endedAt: end.toISOString(),
      })
    })

    it('keeps the moment auto-renewal was switched off before', async () => {
      const off = new Date('2026-09-20T10:00:00Z')
      const t = await writtenTariff({ cancelAtPeriodEnd: true, cancelledAt: off })

      await refund(t, { endSubscription: true })

      expect((await written(t)).subscription).toMatchObject({
        status: 'cancelled',
        cancelledAt: off,
        currentPeriodEnd: TEST_NOW,
      })
    })

    it('never cuts the period to its start or before it', async () => {
      // ЮKassa's clock is ahead: the period starts a minute after the platform's noon.
      const start = new Date(TEST_NOW.getTime() + 60_000)
      const t = await writtenTariff({
        currentPeriodStart: start,
        currentPeriodEnd: new Date('2026-11-04T12:01:00Z'),
        periodAnchor: start,
      })

      const result = await refund(t, { endSubscription: true })

      const endedAt = new Date(start.getTime() + 1)
      expect(result.tariff).toMatchObject({ outcome: 'ended', endedAt })
      expect((await written(t)).subscription).toMatchObject({
        status: 'cancelled',
        currentPeriodStart: start,
        currentPeriodEnd: endedAt,
      })
    })

    it('can be asked for after the money has gone back, in a call of its own', async () => {
      const t = await paidTariff()
      await refund(t)
      expect((await written(t)).subscription?.status).toBe('active')

      const result = await refund(t, {
        endSubscription: true,
        reason: 'Клиент попросил закрыть тариф',
      })

      expect(result).toMatchObject({
        state: 'refunded',
        requested: false,
        settled: false,
        tariff: { outcome: 'ended', expiredCredits: 30 },
      })
      expect(t.shop.refunds.size).toBe(1)
      const state = await written(t)
      expect(state.subscription?.status).toBe('cancelled')
      expect(state.entries(refundAction).map((entry) => entry.meta)).toMatchObject([
        { reason: WHO.reason, moneyOnly: true, settled: true, tariff: null },
        {
          reason: 'Клиент попросил закрыть тариф',
          moneyOnly: false,
          requested: false,
          settled: false,
          tariff: 'ended',
        },
      ])
    })

    it('ends it once: a repeat finds it ended and writes nothing', async () => {
      const t = await paidTariff()
      await refund(t, { endSubscription: true })
      const before = await written(t)

      const again = await refund(t, { endSubscription: true })

      expect(again.tariff).toEqual({ outcome: 'already_ended', subscriptionId: t.subscriptionId })
      expect(await written(t)).toMatchObject({
        subscriptions: before.subscriptions,
        ledger: before.ledger,
        audit: before.audit,
      })
    })

    it('has nothing to end when the tariff ended by itself, and still returns the money', async () => {
      const start = new Date('2026-08-18T09:00:00Z')
      const end = new Date('2026-09-18T09:00:00Z')
      const t = await writtenTariff({
        status: 'cancelled',
        currentPeriodStart: start,
        currentPeriodEnd: end,
        periodAnchor: start,
        cancelAtPeriodEnd: true,
      })
      const before = await written(t)

      const result = await refund(t, { endSubscription: true })

      expect(result).toMatchObject({
        state: 'refunded',
        settled: true,
        tariff: { outcome: 'already_ended', subscriptionId: t.subscriptionId },
      })
      const state = await written(t)
      expect(state.subscriptions).toEqual(before.subscriptions)
      expect(state.ledger).toEqual(before.ledger)
      expect(state.entries(subscriptionEnd)).toEqual([])
      expect(state.entries(refundAction)[0]?.meta).toMatchObject({
        tariff: 'already_ended',
        expiredCredits: 0,
      })
    })

    it('is refused for an order of a period the tariff has renewed past, before any money moves', async () => {
      const t = await paidTariff()
      // A renewal moved the tariff to its next month.
      await db.subscription.update({
        where: { id: t.subscriptionId },
        data: {
          currentPeriodStart: PERIOD_END,
          currentPeriodEnd: new Date('2026-12-04T09:00:00Z'),
        },
      })

      await expect(refund(t, { endSubscription: true })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: refundRefusals.notCurrentPeriod,
      })

      expect(t.shop.refundRequests).toEqual([])
      const state = await untouched(t)
      expect(state.subscription?.status).toBe('active')
      // Without the option the old order is refunded and the tariff goes on.
      expect(await refund(t)).toMatchObject({ state: 'refunded', tariff: null })
      expect((await written(t)).subscription).toMatchObject({
        status: 'active',
        currentPeriodEnd: new Date('2026-12-04T09:00:00Z'),
      })
    })

    it('is an outcome, not a refusal, for an order already refunded whose tariff has renewed', async () => {
      const t = await paidTariff()
      await refund(t)
      const next = new Date('2026-12-04T09:00:00Z')
      await db.subscription.update({
        where: { id: t.subscriptionId },
        data: { currentPeriodStart: PERIOD_END, currentPeriodEnd: next },
      })
      const before = await written(t)

      // «No money was returned» would be untrue of this order: it went back with the first call.
      const result = await refund(t, { endSubscription: true })

      expect(result).toMatchObject({
        state: 'refunded',
        requested: false,
        settled: false,
        tariff: { outcome: 'not_current', subscriptionId: t.subscriptionId },
      })
      const state = await written(t)
      expect(state.subscriptions).toEqual(before.subscriptions)
      expect(state.balances).toEqual(before.balances)
      expect(state.entries(subscriptionEnd)).toEqual([])
      expect(t.shop.refunds.size).toBe(1)
    })

    it('settles a pending refund of its own although the tariff has renewed meanwhile', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })
      await refund(t, { endSubscription: true })
      const made = t.shop.onlyRefund()
      const next = new Date('2026-12-04T09:00:00Z')
      await db.subscription.update({
        where: { id: t.subscriptionId },
        data: { currentPeriodStart: PERIOD_END, currentPeriodEnd: next },
      })
      t.shop.succeedRefund(made.id)

      // The money was asked for long ago: the run reads the refund back and settles the order.
      const result = await refund(t, { endSubscription: true })

      expect(result).toMatchObject({
        state: 'refunded',
        refundId: made.id,
        settled: true,
        tariff: { outcome: 'not_current' },
      })
      const state = await written(t)
      expect(state.order(t.orderId)).toMatchObject({ status: 'refunded', refundedAt: TEST_NOW })
      expect(state.subscription).toMatchObject({ status: 'active', currentPeriodEnd: next })
      expect(state.entries(subscriptionEnd)).toEqual([])
    })

    it('still ends a tariff whose dates were moved back by hand', async () => {
      const t = await paidTariff()
      // What a stand does to bring the end of a period closer: the order keeps its dates.
      const end = new Date(TEST_NOW.getTime() + 60_000)
      await db.subscription.update({
        where: { id: t.subscriptionId },
        data: { currentPeriodStart: new Date('2026-09-04T09:00:00Z'), currentPeriodEnd: end },
      })

      const result = await refund(t, { endSubscription: true })

      expect(result.tariff).toMatchObject({ outcome: 'ended', endedAt: TEST_NOW })
      expect((await written(t)).ledger.find((row) => row.kind === 'expire')).toMatchObject({
        idempotencyKey: ledgerKeys.tariffExpiry(t.subscriptionId, end),
      })
    })

    it('leaves the tariff alone when it renews while the refund is on its way', async () => {
      const t = await paidTariff()
      const next = new Date('2026-12-04T09:00:00Z')
      const createRefund = t.deps.yookassa.createRefund
      t.deps.yookassa.createRefund = async (input, key) => {
        await db.subscription.update({
          where: { id: t.subscriptionId },
          data: { currentPeriodStart: PERIOD_END, currentPeriodEnd: next },
        })
        return createRefund(input, key)
      }

      const result = await refund(t, { endSubscription: true })

      // The money has gone back; the month another order paid for is not taken away.
      expect(result).toMatchObject({
        state: 'refunded',
        settled: true,
        tariff: { outcome: 'not_current', subscriptionId: t.subscriptionId },
      })
      const state = await written(t)
      expect(state.subscription).toMatchObject({ status: 'active', currentPeriodEnd: next })
      expect(state.balances.tariff.balance).toBe(30)
      expect(state.entries(subscriptionEnd)).toEqual([])
      expect(state.entries(refundAction)[0]?.meta).toMatchObject({
        tariff: 'not_current',
        expiredCredits: 0,
      })
    })

    it('is refused for an order that paid for no tariff', async () => {
      const t = await paidTariff()
      const pack = await boughtPack(t)
      // A second paid tariff order of the workspace: the tariff was already on.
      const payment = t.shop.paid('4900.00')
      const extra = await fixtures.order({
        workspaceId: t.workspaceId,
        planId: t.plan.id,
        userId: t.userId,
        yookassaPaymentId: payment.id,
      })

      for (const orderId of [pack.orderId, extra.id]) {
        await expect(refund({ ...t, orderId }, { endSubscription: true })).rejects.toMatchObject({
          code: 'CONFLICT',
          message: refundRefusals.noTariff,
        })
      }

      expect(t.shop.refundRequests).toEqual([])
      expect((await written(t)).subscription?.status).toBe('active')
    })

    it('is refused for a renewal the tariff did not wait for, which paid for no period', async () => {
      const t = await paidTariff()
      const payment = t.shop.paid('4900.00')
      const stale = await fixtures.order({
        workspaceId: t.workspaceId,
        planId: t.plan.id,
        subscriptionId: t.subscriptionId,
        yookassaPaymentId: payment.id,
        idempotenceKey: renewalKey(t.subscriptionId, new Date('2026-09-04T09:00:00Z')),
      })

      await expect(
        refund({ ...t, orderId: stale.id }, { endSubscription: true }),
      ).rejects.toMatchObject({ message: refundRefusals.notCurrentPeriod })

      expect(t.shop.refundRequests).toEqual([])
      // Its money alone goes back.
      expect(await refund({ ...t, orderId: stale.id })).toMatchObject({ state: 'refunded' })
      expect((await written(t)).subscription?.status).toBe('active')
    })
  })

  describe('taking the credits of a pack', () => {
    it('takes every credit of the pack that is still available, with the reason in the ledger', async () => {
      const t = await paidTariff()
      const pack = await boughtPack(t)

      const result = await refund({ ...t, orderId: pack.orderId }, { takeCredits: true })

      expect(result).toMatchObject({
        state: 'refunded',
        settled: true,
        tariff: null,
        credits: { outcome: 'taken', credits: pack.credits },
      })
      const state = await written(t)
      expect(state.balances.pack).toEqual({ balance: 0, held: 0, available: 0 })
      // The tariff and its credits are another order's.
      expect(state.balances.tariff).toEqual({ balance: 30, held: 0, available: 30 })
      expect(state.subscription?.status).toBe('active')
      const adjust = state.ledger.filter((row) => row.kind === 'adjust')
      expect(adjust).toHaveLength(1)
      expect(adjust[0]).toMatchObject({
        unit: 'credit_pack',
        orderId: pack.orderId,
        idempotencyKey: `order:${pack.orderId}:refund:adjust`,
        note: WHO.reason,
      })
      expect(adjust[0]?.amount.toFixed(2)).toBe(`-${pack.credits}.00`)
      expect(adjust[0]?.balanceAfter.toFixed(2)).toBe('0.00')
      expect(state.entries(refundAction)[0]?.meta).toMatchObject({
        takeCredits: true,
        endSubscription: false,
        moneyOnly: false,
        credits: 'taken',
        takenCredits: pack.credits,
      })
    })

    it('takes credits of the pack only, never of the gift', async () => {
      const t = await paidTariff()
      const pack = await boughtPack(t)
      const gift = await gifted({ userId: t.userId, workspaceId: t.workspaceId })
      // A task holds three credits of the pack: the pack has fewer to give back than it
      // granted, and the gift beside it has more than enough to make up for them.
      await fixtures.hold(t.workspaceId, 'pack', 3)

      const result = await refund({ ...t, orderId: pack.orderId }, { takeCredits: true })

      expect(result.credits).toEqual({ outcome: 'taken', credits: pack.credits - 3 })
      const state = await written(t)
      expect(state.balances).toEqual({
        tariff: { balance: 30, held: 0, available: 30 },
        gift: { balance: 35, held: 5, available: 30, granted: true },
        pack: { balance: 3, held: 3, available: 0 },
        totalAvailable: 60,
      })
      expect(state.ledger.filter((row) => row.kind === 'adjust').map((row) => row.unit)).toEqual([
        'credit_pack',
      ])
      expect(await giftRows(t.workspaceId)).toEqual(gift)

      // Nor later, when the option is asked for again and the pack has nothing more to give.
      const again = await refund({ ...t, orderId: pack.orderId }, { takeCredits: true })
      expect(again.credits).toEqual({ outcome: 'already_taken', credits: pack.credits - 3 })
      expect(await giftRows(t.workspaceId)).toEqual(gift)
    })

    it('leaves the credits where they are without the option', async () => {
      const t = await paidTariff()
      const pack = await boughtPack(t)

      const result = await refund({ ...t, orderId: pack.orderId })

      expect(result).toMatchObject({ state: 'refunded', credits: null })
      const state = await written(t)
      expect(state.balances.pack.balance).toBe(pack.credits)
      expect(state.ledger.map((row) => row.kind)).not.toContain('adjust')
      expect(state.entries(refundAction)[0]?.meta).toMatchObject({ moneyOnly: true, credits: null })
    })

    it('never touches credits a task holds or has spent, and never goes below zero', async () => {
      // A tariff of five credits and the gift of the registration: the first task takes them
      // and five credits of the pack, the second and the third stand on the pack alone.
      const t = await paidTariff({ plan: { creditsPerMonth: 5 } })
      const pack = await boughtPack(t)
      const tasks = await Promise.all([1, 2, 3].map(() => fixtures.task(t.workspaceId)))
      for (const { taskId } of tasks) {
        await fixtures.reserve({
          workspaceId: t.workspaceId,
          taskId,
          attempt: 1,
          now: TEST_NOW,
          expiresAt: new Date(TEST_NOW.getTime() + DAY_MS),
        })
      }
      const [, spent, held] = tasks
      if (spent === undefined || held === undefined) throw new Error('No three tasks')
      await db.$transaction((tx) =>
        settleTaskCharge(tx, { taskId: spent.taskId, credits: 17, now: TEST_NOW }),
      )
      // 17 spent; 5 and 45 are held by the two tasks still in work.
      expect((await written(t)).balances.pack).toEqual({
        balance: pack.credits - 17,
        held: 50,
        available: pack.credits - 67,
      })

      const result = await refund({ ...t, orderId: pack.orderId }, { takeCredits: true })

      expect(result.credits).toEqual({ outcome: 'taken', credits: pack.credits - 67 })
      let state = await written(t)
      expect(state.balances.pack).toEqual({ balance: 50, held: 50, available: 0 })
      expect(
        state.holds.filter((row) => row.status === 'active' && row.unit === 'credit_pack'),
      ).toHaveLength(2)

      // Held credits come back later: what was taken for the order was taken once.
      await db.$transaction((tx) => releaseTask(tx, { taskId: held.taskId, now: TEST_NOW }))
      const again = await refund({ ...t, orderId: pack.orderId }, { takeCredits: true })
      expect(again.credits).toEqual({ outcome: 'already_taken', credits: pack.credits - 67 })
      state = await written(t)
      expect(state.balances.pack).toEqual({ balance: 50, held: 5, available: 45 })
      expect(state.ledger.filter((row) => row.kind === 'adjust')).toHaveLength(1)
    })

    it('takes nothing while the refund is pending: the money has not gone back', async () => {
      const t = await paidTariff()
      const pack = await boughtPack(t)
      const order = { ...t, orderId: pack.orderId }
      t.shop.refundAs({ status: 'pending' })

      const result = await refund(order, { takeCredits: true })

      expect(result).toMatchObject({ state: 'pending', credits: null })
      let state = await written(t)
      expect(state.balances.pack.balance).toBe(pack.credits)
      expect(state.ledger.map((row) => row.kind)).not.toContain('adjust')

      // The same command, once the refund has gone through, takes them.
      t.shop.succeedRefund(result.refundId ?? '')
      expect(await refund(order, { takeCredits: true })).toMatchObject({
        state: 'refunded',
        settled: true,
        credits: { outcome: 'taken', credits: pack.credits },
      })
      state = await written(t)
      expect(state.balances.pack.balance).toBe(0)
    })

    it('takes nothing when every credit is held, and writes no ledger row', async () => {
      const t = await paidTariff()
      const pack = await boughtPack(t)
      await fixtures.hold(t.workspaceId, 'pack', pack.credits)

      const result = await refund({ ...t, orderId: pack.orderId }, { takeCredits: true })

      expect(result).toMatchObject({ state: 'refunded', credits: { outcome: 'nothing_available' } })
      const state = await written(t)
      expect(state.balances.pack).toEqual({
        balance: pack.credits,
        held: pack.credits,
        available: 0,
      })
      expect(state.ledger.map((row) => row.kind)).not.toContain('adjust')
      expect(state.entries(refundAction)[0]?.meta).toMatchObject({
        credits: 'nothing_available',
        takenCredits: 0,
      })
    })

    it('takes the credits of the refunded pack only when two were bought', async () => {
      const t = await paidTariff()
      const first = await boughtPack(t)
      const second = await boughtPack(t)

      const result = await refund({ ...t, orderId: second.orderId }, { takeCredits: true })

      expect(result.credits).toEqual({ outcome: 'taken', credits: second.credits })
      const state = await written(t)
      expect(state.balances.pack.balance).toBe(first.credits)
      expect(state.order(first.orderId).status).toBe('paid')
      expect(state.order(second.orderId).status).toBe('refunded')
    })

    it('can be asked for after the money has gone back, once', async () => {
      const t = await paidTariff()
      const pack = await boughtPack(t)
      const order = { ...t, orderId: pack.orderId }
      await refund(order)

      expect((await refund(order, { takeCredits: true })).credits).toEqual({
        outcome: 'taken',
        credits: pack.credits,
      })
      const before = await written(t)
      expect((await refund(order, { takeCredits: true })).credits).toEqual({
        outcome: 'already_taken',
        credits: pack.credits,
      })

      const state = await written(t)
      expect(state).toMatchObject({ ledger: before.ledger, audit: before.audit })
      expect(state.balances.pack.balance).toBe(0)
      expect(state.entries(refundAction)).toHaveLength(2)
      expect(t.shop.refunds.size).toBe(1)
    })

    it('is refused for an order of a tariff, before any money moves', async () => {
      const t = await paidTariff()

      await expect(refund(t, { takeCredits: true })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: refundRefusals.notPack,
      })

      expect(t.shop.refundRequests).toEqual([])
      await untouched(t)
    })
  })

  describe('while a renewal is on its way', () => {
    it('ends the tariff; the charge that then succeeds is not applied and waits to be returned', async () => {
      // The paid period has just ended and the saved card is being charged for the next one.
      const start = new Date('2026-09-04T09:00:00Z')
      const end = new Date('2026-10-04T09:00:00Z')
      const t = await writtenTariff({
        currentPeriodStart: start,
        currentPeriodEnd: end,
        periodAnchor: start,
        paymentMethodId: 'pm-saved',
        paymentMethodType: 'bank_card',
        renewalNoticePeriodEnd: end,
      })
      const charge = await t.deps.yookassa.createPayment(
        { amount: { value: '4900.00', currency: 'RUB' }, capture: true },
        'charge-of-the-test',
      )
      const renewal = await fixtures.order({
        workspaceId: t.workspaceId,
        planId: t.plan.id,
        userId: t.userId,
        subscriptionId: t.subscriptionId,
        status: 'pending',
        idempotenceKey: renewalKey(t.subscriptionId, end),
        yookassaPaymentId: charge.id,
      })

      const result = await refund(t, { endSubscription: true })

      expect(result).toMatchObject({
        state: 'refunded',
        tariff: { outcome: 'ended', expiredCredits: 30, endedAt: end },
      })
      let state = await written(t)
      expect(state.subscription).toMatchObject({ status: 'cancelled', currentPeriodEnd: end })
      // The order of the charge is not the refund's to touch.
      expect(state.order(renewal.id)).toMatchObject({ status: 'pending', yookassaRefundId: null })

      // The bank answers: the money came for a tariff that is over.
      t.shop.succeed(charge.id)
      expect(await settleOrder(t.deps, { orderId: renewal.id })).toEqual({
        state: 'paid',
        orderId: renewal.id,
        refundNeeded: true,
      })
      state = await written(t)
      expect(state.subscription?.status).toBe('cancelled')
      expect(state.balances.tariff.balance).toBe(0)
      expect(state.entries(settlementAuditActions.refundNeeded)[0]?.meta).toMatchObject({
        reason: refundReasons.staleRenewal,
      })

      // The operator sees it in the list and returns it by the same command.
      const mine = async () =>
        (await listRefundsNeeded(t.deps)).items.filter((item) => item.workspaceId === t.workspaceId)
      expect(await mine()).toMatchObject([
        {
          orderId: renewal.id,
          reason: refundReasons.staleRenewal,
          paymentId: charge.id,
          toReturn: '4900.00',
          byCommand: true,
        },
      ])
      expect(await refund({ ...t, orderId: renewal.id })).toMatchObject({
        state: 'refunded',
        settled: true,
      })
      expect(await mine()).toEqual([])
      expect(t.shop.refunds.size).toBe(2)
    })

    it('without the option leaves the tariff to its renewal', async () => {
      const start = new Date('2026-09-04T09:00:00Z')
      const end = new Date('2026-10-04T09:00:00Z')
      const t = await writtenTariff({
        currentPeriodStart: start,
        currentPeriodEnd: end,
        periodAnchor: start,
        paymentMethodId: 'pm-saved',
        paymentMethodType: 'bank_card',
        renewalNoticePeriodEnd: end,
      })
      const user = await db.user.findUniqueOrThrow({ where: { id: t.userId } })
      emails.push(user.email)
      const charge = await t.deps.yookassa.createPayment(
        { amount: { value: '4900.00', currency: 'RUB' }, capture: true },
        'charge-of-the-test',
      )
      const renewal = await fixtures.order({
        workspaceId: t.workspaceId,
        planId: t.plan.id,
        userId: t.userId,
        subscriptionId: t.subscriptionId,
        status: 'pending',
        idempotenceKey: renewalKey(t.subscriptionId, end),
        yookassaPaymentId: charge.id,
      })

      expect(await refund(t)).toMatchObject({ state: 'refunded', tariff: null })
      t.shop.succeed(charge.id, { capturedAt: '2026-10-04T09:05:00.000Z' })

      expect(await settleOrder(t.deps, { orderId: renewal.id })).toEqual({
        state: 'paid',
        orderId: renewal.id,
        refundNeeded: false,
      })
      const state = await written(t)
      expect(state.subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: end,
        currentPeriodEnd: new Date('2026-11-04T09:00:00Z'),
      })
      // The old quota expired with its period and the new one is granted.
      expect(state.balances.tariff).toEqual({ balance: 30, held: 0, available: 30 })
      expect(state.order(t.orderId).status).toBe('refunded')
    })
  })

  describe('money that waits to be returned', () => {
    const mine = async (t: { deps: RefundDeps; workspaceId: string }) =>
      (await listRefundsNeeded(t.deps)).items.filter((item) => item.workspaceId === t.workspaceId)

    /** A second paid tariff order while the tariff is on: settlement asks for its refund. */
    async function paidTwice(t: Paid) {
      const order = await fixtures.order({
        workspaceId: t.workspaceId,
        planId: t.plan.id,
        userId: t.userId,
        status: 'pending',
      })
      const payment = await t.deps.yookassa.createPayment(
        {
          amount: { value: '4900.00', currency: 'RUB' },
          capture: true,
          metadata: { order_id: order.id },
        },
        order.idempotenceKey,
      )
      await db.order.update({ where: { id: order.id }, data: { yookassaPaymentId: payment.id } })
      t.shop.succeed(payment.id)
      expect(await settleOrder(t.deps, { orderId: order.id })).toMatchObject({
        state: 'paid',
        refundNeeded: true,
      })
      return { orderId: order.id, paymentId: payment.id }
    }

    /** An order the customer abandoned for another, whose payment went through all the same. */
    async function paidLate() {
      const { userId, email } = await fixtures.user()
      emails.push(email)
      const plan = await fixtures.plan({ isActive: true })
      const other = await fixtures.plan({ isActive: true, price: '12900.00' })
      const { shop, deps } = refundTestDeps(db)
      const first = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })
      const paymentId = shop.only().id
      await startCheckout(deps, { userId, planSlug: other.slug, autoRenew: false })
      shop.succeed(paymentId)
      expect(await settleOrder(deps, { orderId: first.orderId })).toMatchObject({
        state: 'cancelled',
        refundNeeded: true,
      })
      const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
      if (workspace === null) throw new Error('The user has no personal workspace')
      return { shop, deps, userId, workspaceId: workspace.id, orderId: first.orderId, paymentId }
    }

    it('lists a paid order that was not applied, and drops it once the command returned it', async () => {
      const t = await paidTariff()
      expect(await mine(t)).toEqual([])
      const extra = await paidTwice(t)

      const [item, ...others] = await mine(t)

      expect(others).toEqual([])
      expect(item).toEqual({
        orderId: extra.orderId,
        workspaceId: t.workspaceId,
        orderStatus: 'paid',
        kind: 'subscription',
        reason: refundReasons.liveSubscription,
        paymentId: extra.paymentId,
        orderAmount: '4900.00',
        paidAmount: '4900.00',
        refundedBefore: '0.00',
        refundedOutside: '0.00',
        returned: '0.00',
        toReturn: '4900.00',
        byCommand: true,
        flaggedAt: expect.any(Date),
      })

      await refund({ ...t, orderId: extra.orderId })

      expect(await mine(t)).toEqual([])
      // The tariff the first order pays for is untouched.
      expect((await written(t)).subscription?.status).toBe('active')
    })

    it('lists a closed order whose money came late as one for the cabinet', async () => {
      const t = await paidLate()

      expect(await mine(t)).toMatchObject([
        {
          orderId: t.orderId,
          orderStatus: 'cancelled',
          reason: refundReasons.orderClosed,
          paymentId: t.paymentId,
          toReturn: '4900.00',
          byCommand: false,
        },
      ])
      // The command does not take it: there is no paid order to make refunded.
      await expect(refund(t)).rejects.toMatchObject({ message: refundRefusals.notPaid })
      expect(t.shop.refundRequests).toEqual([])
    })

    it('counts what the cabinet has returned, and drops the entry when all of it went back', async () => {
      const t = await paidLate()
      const part = t.shop.cabinetRefund(t.paymentId, '1000.00')
      expect(await settleRefund(t.deps, { refundId: part.id })).toMatchObject({ state: 'outside' })

      expect(await mine(t)).toMatchObject([
        {
          orderId: t.orderId,
          refundedBefore: '0.00',
          refundedOutside: '1000.00',
          returned: '1000.00',
          toReturn: '3900.00',
          byCommand: false,
        },
      ])

      const rest = t.shop.cabinetRefund(t.paymentId, '3900.00')
      await settleRefund(t.deps, { refundId: rest.id })
      // A repeated notification is not counted twice.
      await settleRefund(t.deps, { refundId: part.id })

      expect(await mine(t)).toEqual([])
      expect((await written(t)).order(t.orderId).status).toBe('cancelled')
    })

    it('counts what had gone back before the entry was written', async () => {
      const { userId, email } = await fixtures.user()
      emails.push(email)
      const plan = await fixtures.plan({ isActive: true })
      const { shop, deps } = refundTestDeps(db)
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      const paymentId = shop.only().id
      shop.succeed(paymentId)
      // A part of the payment was returned before anybody settled the order.
      shop.cabinetRefund(paymentId, '900.00')
      expect(await settleOrder(deps, { orderId })).toMatchObject({
        state: 'failed',
        refundNeeded: true,
      })
      const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
      if (workspace === null) throw new Error('The user has no personal workspace')

      expect(await mine({ deps, workspaceId: workspace.id })).toMatchObject([
        {
          orderId,
          orderStatus: 'failed',
          reason: refundReasons.partlyRefunded,
          paidAmount: '4900.00',
          refundedBefore: '900.00',
          refundedOutside: '0.00',
          returned: '900.00',
          toReturn: '4000.00',
          byCommand: false,
        },
      ])
    })

    // One refund made in the cabinet before the order was settled is in both numbers of the
    // entry once its notification was processed: at the moment of settlement, and as a refund
    // made outside. Added up, they would ask for less than is owed and close the entry early.
    it.each(['notification first', 'settlement first', 'notification lost'] as const)(
      'counts a cabinet refund made before settlement once (%s)',
      async (order) => {
        const { userId, email } = await fixtures.user()
        emails.push(email)
        const plan = await fixtures.plan({ isActive: true })
        const { shop, deps } = refundTestDeps(db)
        const { orderId } = await startCheckout(deps, {
          userId,
          planSlug: plan.slug,
          autoRenew: false,
        })
        const paymentId = shop.only().id
        shop.succeed(paymentId)
        // 900 of 4900 went back in the cabinet before anybody settled the order.
        const early = shop.cabinetRefund(paymentId, '900.00')
        if (order === 'notification first') {
          expect(await settleRefund(deps, { refundId: early.id })).toMatchObject({
            state: 'outside',
          })
        }
        expect(await settleOrder(deps, { orderId })).toMatchObject({
          state: 'failed',
          refundNeeded: true,
        })
        if (order === 'settlement first') {
          expect(await settleRefund(deps, { refundId: early.id })).toMatchObject({
            state: 'outside',
          })
        }
        const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
        if (workspace === null) throw new Error('The user has no personal workspace')
        const t = { deps, workspaceId: workspace.id }
        const lost = order === 'notification lost'

        // 4900 paid, 900 returned: 4000 is owed, whichever way the 900 became known.
        expect(await mine(t)).toMatchObject([
          {
            orderId,
            refundedBefore: '900.00',
            refundedOutside: lost ? '0.00' : '900.00',
            returned: '900.00',
            toReturn: '4000.00',
          },
        ])

        // A part of the rest goes back: the entry stays open for what is left. When the first
        // notification was lost, the records know less than went back and ask for more than is
        // owed — never for less.
        const more = shop.cabinetRefund(paymentId, '3100.00')
        await settleRefund(deps, { refundId: more.id })
        expect(await mine(t)).toMatchObject([
          {
            orderId,
            returned: lost ? '3100.00' : '4000.00',
            toReturn: lost ? '1800.00' : '900.00',
          },
        ])
        expect(shop.payments.get(paymentId)?.refunded_amount?.value).toBe('4000.00')

        const rest = shop.cabinetRefund(paymentId, '900.00')
        await settleRefund(deps, { refundId: rest.id })
        if (lost) expect(await mine(t)).toMatchObject([{ orderId, toReturn: '900.00' }])
        else expect(await mine(t)).toEqual([])
      },
    )

    it('says a paid order is for the cabinet once a part of it went back there', async () => {
      const t = await paidTariff()
      const extra = await paidTwice(t)
      const part = t.shop.cabinetRefund(extra.paymentId, '900.00')
      await settleRefund(t.deps, { refundId: part.id })

      expect(await mine(t)).toMatchObject([
        { orderId: extra.orderId, orderStatus: 'paid', toReturn: '4000.00', byCommand: false },
      ])
      await expect(refund({ ...t, orderId: extra.orderId })).rejects.toMatchObject({
        message: refundRefusals.refundedElsewhere,
      })
    })

    it('lists the oldest first and says when there is more than it was asked for', async () => {
      const t = await paidTariff()
      const first = await paidTwice(t)
      const second = await paidTwice(t)

      expect((await mine(t)).map((item) => item.orderId)).toEqual([first.orderId, second.orderId])
      const page = await listRefundsNeeded(t.deps, { limit: 1 })
      expect(page.items).toHaveLength(1)
      expect(page.more).toBe(true)
    })
  })

  describe('an option asked for while the refund was pending', () => {
    const open = async (t: { deps: RefundDeps; workspaceId: string }) =>
      (await listRefundsNeeded(t.deps)).unappliedOptions.filter(
        (item) => item.workspaceId === t.workspaceId,
      )

    it('is listed once the notification has settled the refund, until the command is run again', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })
      await refund(t, { endSubscription: true })
      const made = t.shop.onlyRefund()
      // Not while the money has not gone back: the order is not refunded yet.
      expect(await open(t)).toEqual([])
      t.shop.succeedRefund(made.id)
      await settleRefund(t.deps, { refundId: made.id })

      // The notification moved the order only; the tariff the operator wanted ended goes on.
      expect((await written(t)).subscription?.status).toBe('active')
      expect(await open(t)).toEqual([
        {
          orderId: t.orderId,
          workspaceId: t.workspaceId,
          kind: 'subscription',
          endSubscription: true,
          takeCredits: false,
          refundedAt: TEST_NOW,
          askedAt: expect.any(Date),
        },
      ])

      expect(await refund(t, { endSubscription: true })).toMatchObject({
        state: 'refunded',
        tariff: { outcome: 'ended' },
      })

      expect(await open(t)).toEqual([])
      expect((await written(t)).subscription?.status).toBe('cancelled')
    })

    it('is closed by a run without the option as well: the operator changed their mind', async () => {
      const t = await paidTariff()
      const pack = await boughtPack(t)
      const order = { ...t, orderId: pack.orderId }
      t.shop.refundAs({ status: 'pending' })
      const pending = await refund(order, { takeCredits: true })
      t.shop.succeedRefund(pending.refundId ?? '')
      await settleRefund(t.deps, { refundId: pending.refundId ?? '' })
      expect(await open(t)).toMatchObject([
        { orderId: pack.orderId, kind: 'pack', endSubscription: false, takeCredits: true },
      ])

      expect(await refund(order, { reason: 'Кредиты оставляем клиенту' })).toMatchObject({
        state: 'refunded',
        settled: false,
        credits: null,
      })

      expect(await open(t)).toEqual([])
      let state = await written(t)
      expect(state.balances.pack.balance).toBe(pack.credits)
      // The newest entry says what the operator asked for last.
      const entries = state.audit.filter(
        (entry) => entry.action === refundAction && entry.targetId === pack.orderId,
      )
      expect(entries.map((entry) => entry.meta)).toMatchObject([
        { takeCredits: true, credits: null, refundStatus: 'pending' },
        { takeCredits: false, moneyOnly: true, reason: 'Кредиты оставляем клиенту' },
      ])
      // Nothing is left open: one more run writes nothing.
      await refund(order)
      state = await written(t)
      expect(
        state.audit.filter(
          (entry) => entry.action === refundAction && entry.targetId === pack.orderId,
        ),
      ).toHaveLength(2)
    })

    it('is closed when the option turns out to have nothing left to do', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })
      await refund(t, { endSubscription: true })
      const made = t.shop.onlyRefund()
      t.shop.succeedRefund(made.id)
      await settleRefund(t.deps, { refundId: made.id })
      // The tariff renewed before the operator came back.
      await db.subscription.update({
        where: { id: t.subscriptionId },
        data: {
          currentPeriodStart: PERIOD_END,
          currentPeriodEnd: new Date('2026-12-04T09:00:00Z'),
        },
      })
      expect(await open(t)).toHaveLength(1)

      expect((await refund(t, { endSubscription: true })).tariff).toMatchObject({
        outcome: 'not_current',
      })

      expect(await open(t)).toEqual([])
      const state = await written(t)
      expect(state.entries(refundAction).map((entry) => entry.meta)).toMatchObject([
        { endSubscription: true, tariff: null },
        { endSubscription: true, tariff: 'not_current' },
      ])
      await refund(t, { endSubscription: true })
      expect((await written(t)).entries(refundAction)).toHaveLength(2)
    })

    it('is not listed for a refund ЮKassa cancelled: the order is still paid', async () => {
      const t = await paidTariff()
      t.shop.refundAs({ status: 'pending' })
      await refund(t, { endSubscription: true })
      t.shop.cancelRefund(t.shop.onlyRefund().id)
      expect((await refund(t, { endSubscription: true })).state).toBe('canceled')

      expect(await open(t)).toEqual([])
    })

    it('lists the oldest request first and says when there are more than it was asked for', async () => {
      const asked: string[] = []
      for (let n = 0; n < 2; n += 1) {
        const t = await paidTariff()
        t.shop.refundAs({ status: 'pending' })
        await refund(t, { endSubscription: true })
        const made = t.shop.onlyRefund()
        t.shop.succeedRefund(made.id)
        await settleRefund(t.deps, { refundId: made.id })
        asked.push(t.orderId)
      }
      const { deps } = refundTestDeps(db)

      const all = await listRefundsNeeded(deps)
      expect(
        all.unappliedOptions.map((item) => item.orderId).filter((id) => asked.includes(id)),
      ).toEqual(asked)
      const page = await listRefundsNeeded(deps, { limit: 1 })
      expect(page.unappliedOptions).toHaveLength(1)
      expect(page.moreUnappliedOptions).toBe(true)
    })
  })

  describe('a renewal charge that was given up without an answer', () => {
    const START = new Date('2026-09-04T09:00:00.000Z')
    const END = new Date('2026-10-04T09:00:00.000Z')
    const { unknownResult, unknownResultChecked } = renewalAuditActions

    /**
     * A renewal order whose charge request got no answer — pending, without a payment — of a
     * tariff whose auto-renewal was switched off since: the request is not repeated.
     */
    async function unanswered() {
      const { userId, workspaceId } = await fixtures.workspace()
      const owner = await db.user.findUniqueOrThrow({ where: { id: userId } })
      emails.push(owner.email)
      const plan = await fixtures.plan()
      const { shop, deps } = refundTestDeps(db)
      const subscription = await fixtures.subscription({
        workspaceId,
        planId: plan.id,
        currentPeriodStart: START,
        currentPeriodEnd: END,
        periodAnchor: START,
        cancelAtPeriodEnd: true,
        cancelledAt: TEST_NOW,
      })
      const order = await fixtures.order({
        workspaceId,
        planId: plan.id,
        userId,
        subscriptionId: subscription.id,
        status: 'pending',
        idempotenceKey: renewalKey(subscription.id, END),
        createdAt: TEST_NOW,
      })
      return {
        shop,
        deps,
        userId,
        workspaceId,
        subscriptionId: subscription.id,
        orderId: order.id,
        metadata: { order_id: order.id, workspace_id: workspaceId },
      }
    }
    type Unanswered = Awaited<ReturnType<typeof unanswered>>

    /** Twelve hours and six minutes later the pass of stuck orders gives the charge up. */
    async function giveUp(t: Unanswered) {
      const later = new Date(
        TEST_NOW.getTime() + RENEWAL_RETRY_WINDOW_MS + RENEWAL_GIVE_UP_MARGIN_MS + 60_000,
      )
      const pass = await settleStuckOrders({
        prisma: db,
        yookassa: {
          getPayment: (id) => t.deps.yookassa.getPayment(id),
          chargeWithSavedMethod: () => Promise.reject(new Error('Nobody may be charged here')),
        },
        appUrl: TEST_APP_URL,
        now: () => later,
        settings: { noticeDays: 3, pastDueDays: 7 },
      })
      expect(pass.counts.gave_up).toBeGreaterThanOrEqual(1)
      expect(await db.order.findUniqueOrThrow({ where: { id: t.orderId } })).toMatchObject({
        status: 'failed',
        failureReason: 'unknown_result',
        yookassaPaymentId: null,
      })
    }

    const waiting = async (t: Unanswered) => {
      const listed = await listRefundsNeeded(t.deps)
      return {
        charges: listed.unknownCharges.filter((item) => item.workspaceId === t.workspaceId),
        refunds: listed.items.filter((item) => item.workspaceId === t.workspaceId),
      }
    }

    it('is listed for an operator, with what to look the payment up by', async () => {
      const t = await unanswered()
      // Not while the charge may still get its answer.
      expect((await waiting(t)).charges).toEqual([])

      await giveUp(t)

      expect(await waiting(t)).toEqual({
        charges: [
          {
            orderId: t.orderId,
            workspaceId: t.workspaceId,
            subscriptionId: t.subscriptionId,
            amount: '4900.00',
            idempotenceKey: `renew.${t.subscriptionId}.${END.getTime()}`,
            orderCreatedAt: TEST_NOW,
            flaggedAt: expect.any(Date),
          },
        ],
        // Nobody knows of any money yet: nothing is asked to be returned.
        refunds: [],
      })
    })

    it('is closed by its payment once that is found: money that came moves to the refund list', async () => {
      const t = await unanswered()
      const payment = t.shop.paid('4900.00', t.metadata)
      await giveUp(t)
      expect((await waiting(t)).charges).toHaveLength(1)

      // The late notification, or the operator's `billing:settle-payment` with the id from the
      // cabinet.
      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
        state: 'failed',
        orderId: t.orderId,
        refundNeeded: true,
      })

      expect(await waiting(t)).toMatchObject({
        charges: [],
        refunds: [
          {
            orderId: t.orderId,
            orderStatus: 'failed',
            paymentId: payment.id,
            reason: refundReasons.orderClosed,
            toReturn: '4900.00',
            byCommand: false,
          },
        ],
      })
    })

    it('is closed by a payment that was cancelled: nothing is owed', async () => {
      const t = await unanswered()
      const payment = t.shop.paid('4900.00', t.metadata)
      t.shop.cancel(payment.id, 'insufficient_funds')
      await giveUp(t)

      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toEqual({
        state: 'failed',
        orderId: t.orderId,
        refundNeeded: false,
      })

      expect(await waiting(t)).toEqual({ charges: [], refunds: [] })
    })

    it('is closed by an operator’s word that the shop holds no payment, once', async () => {
      const t = await unanswered()
      await giveUp(t)

      expect(await closeUnknownCharge(t.deps, { orderId: t.orderId, ...WHO })).toEqual({
        orderId: t.orderId,
        recorded: true,
      })

      expect((await waiting(t)).charges).toEqual([])
      const audit = await db.auditLog.findMany({ where: { workspaceId: t.workspaceId } })
      const closed = audit.filter((entry) => entry.action === unknownResultChecked)
      expect(closed).toHaveLength(1)
      expect(closed[0]).toMatchObject({
        actorType: 'operator',
        actorId: WHO.operator,
        targetType: 'order',
        targetId: t.orderId,
        meta: {
          reason: WHO.reason,
          found: false,
          subscriptionId: t.subscriptionId,
          amount: '4900.00',
          idempotenceKey: `renew.${t.subscriptionId}.${END.getTime()}`,
        },
      })
      // The order and the entry that asked are left as they are.
      expect(audit.filter((entry) => entry.action === unknownResult)).toHaveLength(1)
      expect(await db.order.findUniqueOrThrow({ where: { id: t.orderId } })).toMatchObject({
        status: 'failed',
        failureReason: 'unknown_result',
      })

      const [again, atOnce] = await Promise.all([
        closeUnknownCharge(t.deps, { orderId: t.orderId, ...WHO }),
        closeUnknownCharge(t.deps, { orderId: t.orderId, ...WHO }),
      ])
      expect([again.recorded, atOnce.recorded]).toEqual([false, false])
      expect(
        await db.auditLog.count({
          where: { workspaceId: t.workspaceId, action: unknownResultChecked },
        }),
      ).toBe(1)
    })

    it('still shows money that turns up after the operator found none', async () => {
      const t = await unanswered()
      await giveUp(t)
      await closeUnknownCharge(t.deps, { orderId: t.orderId, ...WHO })
      // The operator looked too early, or in the wrong place.
      const payment = t.shop.paid('4900.00', t.metadata)

      expect(await settleOrderByPaymentId(t.deps, { paymentId: payment.id })).toMatchObject({
        state: 'failed',
        refundNeeded: true,
      })

      expect(await waiting(t)).toMatchObject({
        charges: [],
        refunds: [{ orderId: t.orderId, paymentId: payment.id, toReturn: '4900.00' }],
      })
    })

    it('refuses to close anything that is not such a charge', async () => {
      const refused = { code: 'CONFLICT', message: refundRefusals.notUnknownCharge }
      const { deps } = refundTestDeps(db)
      await expect(closeUnknownCharge(deps, { orderId: ORDER, ...WHO })).rejects.toMatchObject({
        code: 'BILLING_ORDER_NOT_FOUND',
      })

      // A paid order, and a charge that still waits for its answer.
      const paid = await paidTariff()
      await expect(
        closeUnknownCharge(paid.deps, { orderId: paid.orderId, ...WHO }),
      ).rejects.toMatchObject(refused)
      const t = await unanswered()
      await expect(
        closeUnknownCharge(t.deps, { orderId: t.orderId, ...WHO }),
      ).rejects.toMatchObject(refused)

      // A charge whose payment has been found: the payment tells what is owed.
      const payment = t.shop.paid('4900.00', t.metadata)
      await giveUp(t)
      await settleOrderByPaymentId(t.deps, { paymentId: payment.id })
      await expect(
        closeUnknownCharge(t.deps, { orderId: t.orderId, ...WHO }),
      ).rejects.toMatchObject(refused)

      expect(
        await db.auditLog.count({
          where: { workspaceId: t.workspaceId, action: unknownResultChecked },
        }),
      ).toBe(0)
    })

    it('lists the oldest first and says when there are more than it was asked for', async () => {
      const first = await unanswered()
      await giveUp(first)
      const second = await unanswered()
      await giveUp(second)
      const mine = [first.orderId, second.orderId]

      const all = await listRefundsNeeded(first.deps)
      expect(
        all.unknownCharges.map((item) => item.orderId).filter((id) => mine.includes(id)),
      ).toEqual(mine)
      const page = await listRefundsNeeded(first.deps, { limit: 1 })
      expect(page.unknownCharges).toHaveLength(1)
      expect(page.moreUnknownCharges).toBe(true)
    })
  })
})
