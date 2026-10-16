import { randomUUID } from 'node:crypto'

import {
  createPrismaClient,
  ensurePersonalWorkspace,
  findPersonalWorkspace,
  type PrismaClient,
} from '@repo/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { startCheckout, syncOrder } from './checkout.ts'
import type { BillingDeps } from './deps.ts'
import { giftAuditActions, ledgerKeys } from './ledger.ts'
import { getCreditBalances, getPlanOverview } from './read-models.ts'
import {
  paymentLetterKey,
  settleOrder,
  settleOrderByPaymentId,
  settlementAuditActions,
} from './settlement.ts'
import {
  billingFixtures,
  billingTestDeps,
  GIFT_GRANTED,
  GIFT_ONLY,
  TEST_APP_URL,
  TEST_NOW,
} from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const ORDER = '0199a000-0000-7000-8000-0000000000b2'

describe('settlement input', () => {
  // Reaching the database or the shop with a refused input would throw on the missing client.
  const deps = {} as BillingDeps

  it('refuses an order id that is not a UUID and an unknown field before any query', async () => {
    await expect(settleOrder(deps, { orderId: 'order' })).rejects.toThrow()
    await expect(
      settleOrder(deps, { orderId: ORDER, force: true } as { orderId: string }),
    ).rejects.toThrow()
    await expect(settleOrderByPaymentId(deps, { paymentId: '' })).rejects.toThrow()
  })

  it('knows no order for a payment id longer than the column holds, without a query', async () => {
    expect(await settleOrderByPaymentId(deps, { paymentId: 'p'.repeat(65) })).toEqual({
      state: 'unknown',
    })
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL settlement', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(() => fixtures.cleanup())
  afterAll(async () => {
    await db.$disconnect()
  })

  /** A user without a workspace, a tariff of their own on sale and the scripted shop. */
  async function setup(planData: Parameters<typeof fixtures.plan>[0] = {}) {
    const { userId, email } = await fixtures.user()
    const plan = await fixtures.plan({ isActive: true, ...planData })
    return { ...billingTestDeps(db), userId, email, plan }
  }

  /**
   * Everything the payment of the user's workspace may have written. The gift of the
   * registration is not the payment's: the checkout that made the workspace granted it. Its
   * journal row and its audit entry are kept apart, in `gift`; the balances show it.
   */
  async function written(userId: string) {
    const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
    if (workspace === null) throw new Error('The user has no personal workspace')
    const workspaceId = workspace.id
    const orders = await db.order.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const giftKey = ledgerKeys.signupGift(userId)
    const journal = await db.creditLedger.findMany({ where: { account: { workspaceId } } })
    const entries = await db.auditLog.findMany({ where: { workspaceId } })
    const audit = entries.filter((entry) => entry.action !== giftAuditActions.grant)
    return {
      workspaceId,
      orders,
      subscriptions: await db.subscription.findMany({ where: { workspaceId } }),
      balances: await getCreditBalances(db, workspaceId),
      ledger: journal.filter((entry) => entry.idempotencyKey !== giftKey),
      gift: {
        ledger: journal.filter((entry) => entry.idempotencyKey === giftKey),
        audit: entries.filter((entry) => entry.action === giftAuditActions.grant),
      },
      audit,
      actions: audit.map((entry) => entry.action).sort(),
      refundEntries: audit.filter((entry) => entry.action === settlementAuditActions.refundNeeded),
      letters: await db.outboxEvent.findMany({
        where: { dedupeKey: { in: orders.map((order) => paymentLetterKey(order.id)) } },
      }),
    }
  }

  const EMPTY = { balance: 0, held: 0, available: 0 }

  /** The gift of the registration stands once, as the checkout granted it. */
  const giftStands = (state: Awaited<ReturnType<typeof written>>) => {
    expect(state.gift.ledger).toHaveLength(1)
    expect(state.gift.ledger[0]).toMatchObject({
      kind: 'grant',
      unit: 'credit_gift',
      orderId: null,
    })
    expect(state.gift.ledger[0]?.amount.toFixed(2)).toBe('35.00')
    expect(state.gift.audit).toHaveLength(1)
    expect(state.balances.gift).toEqual(GIFT_GRANTED)
  }

  const nothingApplied = (state: Awaited<ReturnType<typeof written>>) => {
    expect(state.subscriptions).toEqual([])
    expect(state.ledger).toEqual([])
    // All the workspace has is the gift its checkout granted: the payment added nothing.
    expect(state.balances).toEqual(GIFT_ONLY)
    giftStands(state)
    expect(state.letters).toEqual([])
  }

  describe('a first payment', () => {
    it('with consent starts the subscription, grants the quota once and keeps the method', async () => {
      const { shop, deps, userId, email, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      const paymentId = shop.only().id
      shop.succeed(paymentId, { saved: true, capturedAt: '2026-10-04T09:30:00.000Z' })

      expect(await settleOrder(deps, { orderId })).toEqual({
        state: 'paid',
        orderId,
        refundNeeded: false,
      })

      const state = await written(userId)
      const paidAt = new Date('2026-10-04T09:30:00.000Z')
      const periodEnd = new Date('2026-11-04T09:30:00.000Z')
      expect(state.subscriptions).toHaveLength(1)
      const [subscription] = state.subscriptions
      expect(subscription).toMatchObject({
        workspaceId: state.workspaceId,
        planId: plan.id,
        nextPlanId: null,
        status: 'active',
        // The period is counted from the payment, not from the moment we learnt of it.
        currentPeriodStart: paidAt,
        currentPeriodEnd: periodEnd,
        periodAnchor: paidAt,
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        pastDueSince: null,
        paymentMethodId: paymentId,
        paymentMethodTitle: 'Bank card *4444',
        paymentMethodType: 'bank_card',
        paymentMethodCardType: 'Mir',
        paymentMethodLast4: '4444',
        pendingPaymentMethodId: null,
      })
      expect(state.orders).toHaveLength(1)
      expect(state.orders[0]).toMatchObject({
        id: orderId,
        status: 'paid',
        paidAt,
        subscriptionId: subscription?.id,
        periodStart: paidAt,
        periodEnd,
        failureReason: null,
      })

      // The quota of the tariff beside the gift the checkout granted with the workspace.
      expect(state.balances).toEqual({
        tariff: { balance: 30, held: 0, available: 30 },
        gift: GIFT_GRANTED,
        pack: EMPTY,
        totalAvailable: 65,
      })
      giftStands(state)
      expect(state.ledger).toHaveLength(1)
      expect(state.ledger[0]).toMatchObject({
        kind: 'grant',
        unit: 'credit_tariff',
        orderId,
        idempotencyKey: `order:${orderId}:grant`,
      })
      expect(state.ledger[0]?.amount.toFixed(2)).toBe('30.00')

      expect(state.letters).toHaveLength(1)
      expect(state.letters[0]).toMatchObject({
        topic: 'notifications',
        type: 'billing.payment_succeeded',
        status: 'pending',
        payload: {
          item: 'plan',
          planName: 'Проверочный',
          amount: '4900.00',
          periodEnd: '2026-11-04T09:30:00.000Z',
          // What the period was granted: the monthly credits of the tariff of the fixture.
          credits: 30,
          appUrl: TEST_APP_URL,
          to: email,
        },
      })

      expect(state.actions).toEqual([
        settlementAuditActions.autoRenewalConsent,
        settlementAuditActions.subscriptionStart,
      ])
      const order = state.orders[0]
      for (const entry of state.audit) {
        // Who: the customer who paid.
        expect(entry).toMatchObject({
          actorType: 'user',
          actorId: userId,
          targetType: 'subscription',
          targetId: subscription?.id,
        })
      }
      const meta = (action: string) => state.audit.find((entry) => entry.action === action)?.meta
      expect(meta(settlementAuditActions.subscriptionStart)).toEqual({
        orderId,
        planSlug: plan.slug,
        amount: '4900.00',
        credits: 30,
        periodStart: '2026-10-04T09:30:00.000Z',
        periodEnd: '2026-11-04T09:30:00.000Z',
        autoRenewal: true,
        notified: true,
      })
      // Who, when, which plan and the amount as a string.
      expect(meta(settlementAuditActions.autoRenewalConsent)).toEqual({
        orderId,
        planSlug: plan.slug,
        amount: '4900.00',
        consentedAt: order?.createdAt.toISOString(),
        paymentMethodSaved: true,
      })

      expect((await getPlanOverview(db, state.workspaceId)).subscription).toMatchObject({
        status: 'active',
        autoRenewal: true,
        plan: { slug: plan.slug },
      })
    })

    it('settled again changes nothing and does not ask the shop', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      const paymentId = shop.only().id
      shop.succeed(paymentId, { saved: true })
      await settleOrder(deps, { orderId })
      const before = await written(userId)
      const reads = shop.reads.length

      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })
      expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual({
        state: 'paid',
        orderId,
        refundNeeded: false,
      })

      expect(shop.reads).toHaveLength(reads)
      expect(await written(userId)).toEqual(before)
    })

    it('without consent keeps no payment method and ends with the period', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      // Said out loud: left out, the payment page offers the buyer to save the method.
      expect(shop.created[0]?.input).toHaveProperty('save_payment_method', false)
      shop.succeed(shop.only().id, { saved: false })

      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })

      const state = await written(userId)
      expect(state.subscriptions).toHaveLength(1)
      expect(state.subscriptions[0]).toMatchObject({
        status: 'active',
        cancelAtPeriodEnd: true,
        // Auto-renewal was never switched off: it was never on.
        cancelledAt: null,
        paymentMethodId: null,
        paymentMethodTitle: null,
        paymentMethodType: null,
        paymentMethodCardType: null,
        paymentMethodLast4: null,
      })
      expect(state.actions).toEqual([settlementAuditActions.subscriptionStart])
      expect(state.audit[0]?.meta).toMatchObject({ autoRenewal: false })
      expect(state.balances.tariff.available).toBe(30)
      expect((await getPlanOverview(db, state.workspaceId)).subscription).toMatchObject({
        autoRenewal: false,
        paymentMethod: null,
      })
    })

    it('without consent keeps no method even when the shop says it was saved', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      // The buyer ticked «save» on the payment page themselves.
      shop.succeed(shop.only().id, { saved: true })

      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })

      const state = await written(userId)
      expect(state.subscriptions[0]).toMatchObject({
        cancelAtPeriodEnd: true,
        paymentMethodId: null,
        paymentMethodTitle: null,
        paymentMethodType: null,
        paymentMethodCardType: null,
        paymentMethodLast4: null,
      })
      expect(state.actions).toEqual([settlementAuditActions.subscriptionStart])
    })

    it('with consent but no saved method renews nothing', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      expect(shop.created[0]?.input).toHaveProperty('save_payment_method', true)
      shop.succeed(shop.only().id, { saved: false })

      await settleOrder(deps, { orderId })

      const state = await written(userId)
      expect(state.subscriptions[0]).toMatchObject({
        cancelAtPeriodEnd: true,
        paymentMethodId: null,
        paymentMethodLast4: null,
      })
      // The consent was given all the same, and the entry says the method was not saved.
      const consent = state.audit.find(
        (entry) => entry.action === settlementAuditActions.autoRenewalConsent,
      )
      expect(consent?.meta).toMatchObject({ paymentMethodSaved: false })
    })

    it('counts the period from the clock when the shop sends no capture moment', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      const paymentId = shop.only().id
      shop.succeed(paymentId)
      shop.patch(paymentId, { captured_at: undefined })

      await settleOrder(deps, { orderId })

      const state = await written(userId)
      expect(state.orders[0]?.paidAt).toEqual(TEST_NOW)
      expect(state.subscriptions[0]).toMatchObject({
        currentPeriodStart: TEST_NOW,
        currentPeriodEnd: new Date('2026-11-04T12:00:00.000Z'),
        periodAnchor: TEST_NOW,
      })
    })

    it('is applied even when its letter cannot be written', async () => {
      // A name that does not fit a line of a letter: the money still counts.
      const { shop, deps, userId, plan } = await setup({ name: 'Проверочный\nвторой строкой' })
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      shop.succeed(shop.only().id)

      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })

      const state = await written(userId)
      expect(state.subscriptions).toHaveLength(1)
      expect(state.balances.tariff.available).toBe(30)
      expect(state.letters).toEqual([])
      expect(state.audit[0]?.meta).toMatchObject({ notified: false })
    })
  })

  describe('exactly once', () => {
    it('gives one subscription, one grant and one letter to settlements that race', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      const paymentId = shop.only().id
      shop.succeed(paymentId, { saved: true })

      // The return page and the notification, several of each at once.
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          i % 2 === 0
            ? settleOrder(deps, { orderId })
            : settleOrderByPaymentId(deps, { paymentId }),
        ),
      )

      for (const result of results) {
        expect(result).toEqual({ state: 'paid', orderId, refundNeeded: false })
      }
      const state = await written(userId)
      expect(state.subscriptions).toHaveLength(1)
      expect(state.ledger).toHaveLength(1)
      expect(state.balances.tariff).toEqual({ balance: 30, held: 0, available: 30 })
      giftStands(state)
      expect(state.letters).toHaveLength(1)
      expect(state.actions).toEqual([
        settlementAuditActions.autoRenewalConsent,
        settlementAuditActions.subscriptionStart,
      ])
    })

    it('gives the same to the return page that races the notification', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      const paymentId = shop.only().id
      shop.succeed(paymentId)

      const [page, notification] = await Promise.all([
        syncOrder(deps, { userId, orderId }),
        settleOrderByPaymentId(deps, { paymentId }),
      ])

      expect(page).toMatchObject({ status: 'paid', refundNeeded: false })
      expect(notification).toMatchObject({ state: 'paid' })
      const state = await written(userId)
      expect(state.subscriptions).toHaveLength(1)
      expect(state.ledger).toHaveLength(1)
      giftStands(state)
      expect(state.letters).toHaveLength(1)
    })
  })

  describe('a payment without an outcome', () => {
    it('leaves the order pending while the payment is pending or waits for capture', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      const paymentId = shop.only().id

      for (const status of ['pending', 'waiting_for_capture'] as const) {
        shop.patch(paymentId, { status })
        expect(await settleOrder(deps, { orderId })).toEqual({
          state: 'pending',
          orderId,
          refundNeeded: false,
        })
      }

      const state = await written(userId)
      expect(state.orders).toHaveLength(1)
      expect(state.orders[0]).toMatchObject({ status: 'pending', paidAt: null })
      nothingApplied(state)
      expect(state.audit).toEqual([])
    })

    it('does not know a payment that neither an order nor the shop holds, and asks the shop once', async () => {
      const { shop, deps } = billingTestDeps(db)
      const paymentId = randomUUID()
      expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual({ state: 'unknown' })
      // The payment of an order that never stored it is found by this read
      // (unattached-payment.test.ts); a payment the shop does not know is nobody's.
      expect(shop.reads).toEqual([paymentId])
    })

    it('refuses an order that does not exist', async () => {
      const { deps } = billingTestDeps(db)
      await expect(settleOrder(deps, { orderId: ORDER })).rejects.toMatchObject({
        code: 'BILLING_ORDER_NOT_FOUND',
      })
    })

    it('lets a failure of the shop through and leaves the order as it is', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      shop.succeed(shop.only().id, { saved: true })
      shop.failRead(new Error('socket hang up'))

      // The notification route answers 500 to this, and ЮKassa sends it again.
      await expect(settleOrder(deps, { orderId })).rejects.toThrow('socket hang up')
      expect((await written(userId)).orders[0]).toMatchObject({ status: 'pending' })

      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })
    })
  })

  describe('a cancelled payment', () => {
    it('fails the order with the reason and applies nothing; a new checkout works', async () => {
      const { shop, deps, userId, plan } = await setup()
      const first = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })
      const paymentId = shop.only().id
      shop.cancel(paymentId, 'insufficient_funds')

      expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual({
        state: 'failed',
        orderId: first.orderId,
        refundNeeded: false,
      })

      const state = await written(userId)
      expect(state.orders).toHaveLength(1)
      expect(state.orders[0]).toMatchObject({
        status: 'failed',
        failureReason: 'insufficient_funds',
        paidAt: null,
        subscriptionId: null,
      })
      nothingApplied(state)
      expect(state.audit).toEqual([])
      expect(await syncOrder(deps, { userId, orderId: first.orderId })).toMatchObject({
        status: 'failed',
        failureText: 'Недостаточно средств. Пополните счёт или выберите другой способ оплаты.',
        refundNeeded: false,
        subscription: null,
      })

      const second = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })
      expect(second.orderId).not.toBe(first.orderId)
      expect(second.confirmationUrl).not.toBe(first.confirmationUrl)
      expect(shop.created).toHaveLength(2)
      expect(shop.created[1]?.idempotenceKey).not.toBe(shop.created[0]?.idempotenceKey)
      const orders = (await written(userId)).orders
      expect(orders.map((order) => order.status)).toEqual(['failed', 'pending'])
    })

    it('keeps a reason of any length within the column', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      const paymentId = shop.only().id
      shop.cancel(paymentId, 'r'.repeat(200))

      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'failed' })
      expect((await written(userId)).orders[0]?.failureReason).toBe('r'.repeat(64))
    })
  })

  describe('a payment that is not the order’s', () => {
    it.each([
      [
        'another amount',
        (orderId: string) => ({
          amount: { value: '49.00', currency: 'RUB' } as const,
          metadata: { order_id: orderId },
        }),
      ],
      ['another order in its metadata', () => ({ metadata: { order_id: randomUUID() } })],
    ])('applies nothing for %s and asks an operator to look', async (_name, forged) => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      const paymentId = shop.only().id
      shop.succeed(paymentId, { saved: true })
      shop.patch(paymentId, forged(orderId))

      const outcome = { state: 'failed', orderId, refundNeeded: true }
      expect(await settleOrder(deps, { orderId })).toEqual(outcome)
      // Repeats and a notification find the entry and add nothing.
      const reads = shop.reads.length
      expect(await settleOrder(deps, { orderId })).toEqual(outcome)
      expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual(outcome)
      expect(shop.reads).toHaveLength(reads)

      const state = await written(userId)
      expect(state.orders[0]).toMatchObject({
        status: 'failed',
        failureReason: 'amount_mismatch',
        paidAt: null,
        subscriptionId: null,
      })
      nothingApplied(state)
      expect(state.audit).toHaveLength(1)
      const paid = shop.only()
      expect(state.audit[0]).toMatchObject({
        action: settlementAuditActions.refundNeeded,
        actorType: 'system',
        actorId: 'billing',
        targetType: 'order',
        targetId: orderId,
        meta: {
          reason: 'amount_mismatch',
          orderStatus: 'failed',
          paymentId,
          orderAmount: '4900.00',
          paidAmount: paid.amount.value,
          paidCurrency: 'RUB',
          refundedAmount: null,
          metadataOrderId: paid.metadata?.order_id,
        },
      })
      expect(await syncOrder(deps, { userId, orderId })).toMatchObject({
        status: 'failed',
        failureText: 'Платёж не удалось зачислить. Напишите нам — мы разберёмся.',
        refundNeeded: true,
      })
    })

    it('accepts a payment that carries no order in its metadata', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      const paymentId = shop.only().id
      shop.succeed(paymentId)
      shop.patch(paymentId, { metadata: undefined })

      expect(await settleOrder(deps, { orderId })).toMatchObject({
        state: 'paid',
        refundNeeded: false,
      })
    })
  })

  describe('a payment that was already returned', () => {
    // ЮKassa keeps a payment `succeeded` after a refund: only `refunded_amount` tells.
    const returned = (value: string) => ({
      refunded_amount: { value, currency: 'RUB' } as const,
      refundable: value !== '4900.00',
    })

    it('applies nothing when it went back in full, and owes nothing', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      const paymentId = shop.only().id
      // Paid, the notification was lost, and an operator returned the money in the ЮKassa
      // cabinet before anybody looked at the order.
      shop.succeed(paymentId, { saved: true })
      shop.patch(paymentId, returned('4900.00'))

      const outcome = { state: 'failed', orderId, refundNeeded: false }
      expect(await settleOrder(deps, { orderId })).toEqual(outcome)
      // The closed order is no news for a notification or a poll either.
      expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual(outcome)
      expect(await settleOrder(deps, { orderId })).toEqual(outcome)

      const state = await written(userId)
      expect(state.orders).toHaveLength(1)
      expect(state.orders[0]).toMatchObject({
        status: 'failed',
        failureReason: 'payment_refunded',
        paidAt: null,
        subscriptionId: null,
      })
      nothingApplied(state)
      expect(state.audit).toEqual([])
      expect(await syncOrder(deps, { userId, orderId })).toMatchObject({
        status: 'failed',
        failureText: 'Платёж возвращён. Оформите оплату заново.',
        refundNeeded: false,
        subscription: null,
      })
    })

    it('applies nothing when part of it went back, and asks an operator to return the rest', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      const paymentId = shop.only().id
      shop.succeed(paymentId, { saved: true })
      shop.patch(paymentId, returned('1900.00'))

      const outcome = { state: 'failed', orderId, refundNeeded: true }
      expect(await settleOrder(deps, { orderId })).toEqual(outcome)
      const reads = shop.reads.length
      expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual(outcome)
      expect(shop.reads).toHaveLength(reads)

      const state = await written(userId)
      expect(state.orders[0]).toMatchObject({
        status: 'failed',
        // What is left of the payment is not the amount of the order.
        failureReason: 'amount_mismatch',
        paidAt: null,
        subscriptionId: null,
      })
      nothingApplied(state)
      expect(state.audit).toHaveLength(1)
      expect(state.audit[0]).toMatchObject({
        action: settlementAuditActions.refundNeeded,
        actorType: 'system',
        targetType: 'order',
        targetId: orderId,
        meta: {
          reason: 'partly_refunded',
          orderStatus: 'failed',
          paymentId,
          orderAmount: '4900.00',
          paidAmount: '4900.00',
          refundedAmount: '1900.00',
        },
      })
      // The rest of the money is still with us: the customer is told to write, not to pay again.
      expect(await syncOrder(deps, { userId, orderId })).toMatchObject({
        status: 'failed',
        failureText: 'Платёж не удалось зачислить. Напишите нам — мы разберёмся.',
        refundNeeded: true,
      })
    })

    it.each([
      ['in full', '4900.00', false],
      ['in part', '1900.00', true],
    ])(
      'late for a cancelled order and returned %s: a refund is asked for only while money is left',
      async (_name, value, refundNeeded) => {
        const { shop, deps, userId, plan } = await setup()
        const other = await fixtures.plan({ isActive: true, name: 'Другой', price: '12900.00' })
        const first = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })
        const firstPayment = shop.only().id
        await startCheckout(deps, { userId, planSlug: other.slug, autoRenew: false })
        shop.succeed(firstPayment)
        shop.patch(firstPayment, returned(value))

        const outcome = { state: 'cancelled', orderId: first.orderId, refundNeeded }
        expect(await settleOrderByPaymentId(deps, { paymentId: firstPayment })).toEqual(outcome)
        expect(await settleOrder(deps, { orderId: first.orderId })).toEqual(outcome)

        const state = await written(userId)
        nothingApplied(state)
        expect(state.refundEntries.map((entry) => entry.meta)).toEqual(
          refundNeeded
            ? [
                expect.objectContaining({
                  reason: 'order_closed',
                  orderStatus: 'cancelled',
                  paidAmount: '4900.00',
                  refundedAmount: value,
                }),
              ]
            : [],
        )
      },
    )
  })

  describe('two paid orders of one workspace', () => {
    it('keeps the second paid, applies nothing for it and asks for a refund', async () => {
      const { shop, deps, userId, plan } = await setup()
      const first = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })
      shop.succeed(shop.only().id, { saved: true })
      await settleOrder(deps, { orderId: first.orderId })
      const { workspaceId, subscriptions } = await written(userId)

      // A second order of the workspace whose payment went through as well.
      const second = await fixtures.order({ workspaceId, planId: plan.id, status: 'pending' })
      const payment = await shop.client.createPayment(
        {
          amount: { value: '4900.00', currency: 'RUB' },
          capture: true,
          metadata: { order_id: second.id },
        },
        second.idempotenceKey,
      )
      await db.order.update({ where: { id: second.id }, data: { yookassaPaymentId: payment.id } })
      shop.succeed(payment.id, { saved: true, capturedAt: '2026-10-04T10:00:00.000Z' })

      const outcome = { state: 'paid', orderId: second.id, refundNeeded: true }
      const results = await Promise.all([
        settleOrder(deps, { orderId: second.id }),
        settleOrderByPaymentId(deps, { paymentId: payment.id }),
        settleOrder(deps, { orderId: second.id }),
      ])
      for (const result of results) expect(result).toEqual(outcome)
      expect(await settleOrder(deps, { orderId: second.id })).toEqual(outcome)

      const state = await written(userId)
      expect(state.subscriptions).toEqual(subscriptions)
      expect(state.orders.map((order) => order.status)).toEqual(['paid', 'paid'])
      expect(state.orders[1]).toMatchObject({
        id: second.id,
        paidAt: new Date('2026-10-04T10:00:00.000Z'),
        subscriptionId: null,
        periodStart: null,
        periodEnd: null,
      })
      expect(state.ledger).toHaveLength(1)
      expect(state.balances.tariff).toEqual({ balance: 30, held: 0, available: 30 })
      expect(state.letters).toHaveLength(1)
      expect(state.refundEntries).toHaveLength(1)
      expect(state.refundEntries[0]).toMatchObject({
        actorType: 'system',
        targetType: 'order',
        targetId: second.id,
        meta: { reason: 'live_subscription', orderStatus: 'paid', paidAmount: '4900.00' },
      })
      expect(await syncOrder(deps, { userId, orderId: second.id })).toMatchObject({
        status: 'paid',
        refundNeeded: true,
        // The tariff that is on is the one of the first order.
        subscription: { id: subscriptions[0]?.id },
      })
    })
  })

  describe('a late payment of a closed order', () => {
    it('applies nothing for a cancelled order and writes one entry, however often it is seen', async () => {
      const { shop, deps, userId, plan } = await setup()
      const other = await fixtures.plan({ isActive: true, name: 'Другой', price: '12900.00' })
      const first = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })
      const firstPayment = shop.only().id
      // The customer changes their mind: the first order is cancelled, its page stays open.
      const second = await startCheckout(deps, { userId, planSlug: other.slug, autoRenew: false })
      shop.succeed(firstPayment)

      const outcome = { state: 'cancelled', orderId: first.orderId, refundNeeded: true }
      const results = await Promise.all([
        settleOrderByPaymentId(deps, { paymentId: firstPayment }),
        settleOrder(deps, { orderId: first.orderId }),
        settleOrderByPaymentId(deps, { paymentId: firstPayment }),
        settleOrder(deps, { orderId: first.orderId }),
      ])
      for (const result of results) expect(result).toEqual(outcome)
      const reads = shop.reads.length
      expect(await settleOrder(deps, { orderId: first.orderId })).toEqual(outcome)
      // Once the entry stands, the shop is not asked again.
      expect(shop.reads).toHaveLength(reads)

      let state = await written(userId)
      expect(state.orders.map((order) => order.status)).toEqual(['cancelled', 'pending'])
      nothingApplied(state)
      expect(state.audit).toHaveLength(1)
      expect(state.audit[0]).toMatchObject({
        action: settlementAuditActions.refundNeeded,
        actorType: 'system',
        targetType: 'order',
        targetId: first.orderId,
        meta: {
          reason: 'order_closed',
          orderStatus: 'cancelled',
          paymentId: firstPayment,
          orderAmount: '4900.00',
          paidAmount: '4900.00',
        },
      })
      expect(await syncOrder(deps, { userId, orderId: first.orderId })).toMatchObject({
        status: 'cancelled',
        failureText: null,
        refundNeeded: true,
        subscription: null,
      })

      // The order that replaced it is paid as usual.
      const secondPayment = state.orders[1]?.yookassaPaymentId
      if (!secondPayment) throw new Error('The second order has no payment')
      expect(secondPayment).not.toBe(firstPayment)
      shop.succeed(secondPayment)
      expect(await settleOrder(deps, { orderId: second.orderId })).toEqual({
        state: 'paid',
        orderId: second.orderId,
        refundNeeded: false,
      })
      state = await written(userId)
      expect(state.subscriptions).toHaveLength(1)
      expect(state.subscriptions[0]).toMatchObject({ planId: other.id, status: 'active' })
      expect(state.refundEntries).toHaveLength(1)
    })

    it('does the same for a failed order', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      const paymentId = shop.only().id
      shop.cancel(paymentId, 'expired_on_confirmation')
      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'failed' })
      // A cancelled payment asked about again is no news.
      expect(await settleOrder(deps, { orderId })).toEqual({
        state: 'failed',
        orderId,
        refundNeeded: false,
      })
      expect((await written(userId)).audit).toEqual([])

      shop.succeed(paymentId)
      const outcome = { state: 'failed', orderId, refundNeeded: true }
      expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual(outcome)
      expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual(outcome)

      const state = await written(userId)
      expect(state.orders[0]).toMatchObject({
        status: 'failed',
        failureReason: 'expired_on_confirmation',
      })
      nothingApplied(state)
      expect(state.refundEntries).toHaveLength(1)
      expect(state.refundEntries[0]?.meta).toMatchObject({
        reason: 'order_closed',
        orderStatus: 'failed',
      })
    })

    it('is recorded when the order is closed while the shop is being asked about it', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      const paymentId = shop.only().id
      shop.succeed(paymentId)
      // A checkout of another choice read the payment as pending a moment ago and cancels the
      // order now, between this notification's read of the order and the answer of the shop.
      const racing: BillingDeps = {
        ...deps,
        yookassa: {
          createPayment: (input, key) => deps.yookassa.createPayment(input, key),
          async getPayment(id) {
            const payment = await deps.yookassa.getPayment(id)
            await db.order.updateMany({
              where: { id: orderId, status: 'pending' },
              data: { status: 'cancelled' },
            })
            return payment
          },
        },
      }

      // ЮKassa does not repeat a notification that was answered 200: this call has to tell.
      const outcome = { state: 'cancelled', orderId, refundNeeded: true }
      expect(await settleOrderByPaymentId(racing, { paymentId })).toEqual(outcome)

      let state = await written(userId)
      nothingApplied(state)
      expect(state.audit).toHaveLength(1)
      expect(state.audit[0]).toMatchObject({
        action: settlementAuditActions.refundNeeded,
        targetType: 'order',
        targetId: orderId,
        meta: { reason: 'order_closed', orderStatus: 'cancelled', paymentId },
      })
      // A later look adds nothing.
      expect(await settleOrder(deps, { orderId })).toEqual(outcome)
      state = await written(userId)
      expect(state.audit).toHaveLength(1)
    })
  })

  describe('the workspace of the payment', () => {
    it('is the one the first site lands in when the payment comes before the site', async () => {
      const { shop, deps, userId, plan } = await setup()
      expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toBeNull()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      shop.succeed(shop.only().id)
      await settleOrder(deps, { orderId })
      const [subscription] = (await written(userId)).subscriptions

      // What project.create does for the user's first site.
      const site = await db.$transaction(async (tx) => {
        const workspace = await ensurePersonalWorkspace(tx, { userId, appEnv: 'test' })
        return tx.site.create({
          data: {
            workspaceId: workspace.id,
            name: 'Кофейня',
            url: `https://${randomUUID()}.example.ru`,
            stack: 'wordpress',
          },
        })
      })

      expect(site.workspaceId).toBe(subscription?.workspaceId)
      expect(await db.workspace.count({ where: { createdById: userId } })).toBe(1)
    })
  })

  describe('an order this slice does not settle', () => {
    it('refuses to apply the payment of a top-up order and leaves it pending', async () => {
      const { shop, deps } = billingTestDeps(db)
      const { workspaceId } = await fixtures.workspace()
      const order = await fixtures.order({
        workspaceId,
        planId: null,
        kind: 'topup',
        amount: '1990.00',
        status: 'pending',
      })
      const payment = await shop.client.createPayment(
        { amount: { value: '1990.00', currency: 'RUB' }, capture: true },
        order.idempotenceKey,
      )
      await db.order.update({ where: { id: order.id }, data: { yookassaPaymentId: payment.id } })
      shop.succeed(payment.id)

      await expect(settleOrder(deps, { orderId: order.id })).rejects.toMatchObject({
        code: 'NOT_IMPLEMENTED',
      })
      expect(await db.order.findUnique({ where: { id: order.id } })).toMatchObject({
        status: 'pending',
        paidAt: null,
      })
      expect(await db.billingAccount.count({ where: { workspaceId } })).toBe(0)
    })
  })
})
