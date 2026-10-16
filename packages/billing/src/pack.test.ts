import { randomUUID } from 'node:crypto'

import { createPrismaClient, findPersonalWorkspace, type Prisma, type PrismaClient } from '@repo/db'
import { Money, type SubscriptionStatus } from '@repo/domain'
import { YookassaApiError, YookassaError } from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

import { startPackCheckout, syncOrder } from './checkout.ts'
import type { BillingDeps } from './deps.ts'
import { expireTariffRemainder, grantTariffCredits } from './ledger.ts'
import { getCreditBalances } from './read-models.ts'
import {
  paymentLetterKey,
  settleOrder,
  settleOrderByPaymentId,
  settlementAuditActions,
} from './settlement.ts'
import { billingFixtures, billingTestDeps, NO_GIFT, TEST_APP_URL, TEST_NOW } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const USER = '0199a000-0000-7000-8000-0000000000d4'

/** The query for the pack on sale: the first active pack in the order the plans are shown. */
const PACK_ON_SALE = {
  where: { kind: 'pack', isActive: true },
  orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
} satisfies Prisma.PlanFindFirstArgs

describe('pack checkout without a database', () => {
  it('refuses a broken user and anything beside it before any query', async () => {
    // Without a client the checkout throws either way; only the schema throws a ZodError. An
    // input that got past it would reach the client and throw a TypeError instead.
    const deps = {} as BillingDeps
    await expect(startPackCheckout(deps, { userId: 'user' })).rejects.toBeInstanceOf(ZodError)
    await expect(startPackCheckout(deps, {} as { userId: string })).rejects.toBeInstanceOf(ZodError)
    for (const extra of [{ planSlug: 'pack' }, { amount: '1.00' }, { autoRenew: true }]) {
      await expect(
        startPackCheckout(deps, { userId: USER, ...extra } as { userId: string }),
      ).rejects.toBeInstanceOf(ZodError)
    }
    // The same call with an input the schema takes does reach the client.
    await expect(startPackCheckout(deps, { userId: USER })).rejects.toBeInstanceOf(TypeError)
  })

  it.each([
    ['no pack is on sale', null],
    ['the pack holds no credits', { packCredits: null, price: new Money('1990') }],
    ['the pack costs nothing', { packCredits: 10, price: new Money(0) }],
  ])('answers «plan not found» when %s, and reads nothing else', async (_case, row) => {
    const findFirst = vi.fn().mockResolvedValue(row)
    // A read of the workspace or a new order would throw on the missing table.
    const deps = { prisma: { plan: { findFirst } }, appEnv: 'test' } as unknown as BillingDeps

    await expect(startPackCheckout(deps, { userId: USER })).rejects.toMatchObject({
      code: 'BILLING_PLAN_NOT_FOUND',
      httpStatus: 404,
    })
    // The first pack in the order the page shows them, not any pack.
    expect(findFirst).toHaveBeenCalledExactlyOnceWith(PACK_ON_SALE)
  })
})

// The PostgreSQL tests buy the pack the seeds put on sale (`pnpm db:seed`). They put no pack of
// their own there: a pack checkout has no choice of a pack, so one on sale for the length of a
// test would be bought by whoever else pays for a pack in the same database meanwhile.
describe.skipIf(!databaseUrl)('PostgreSQL pack', () => {
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

  async function packOnSale() {
    const pack = await db.plan.findFirst(PACK_ON_SALE)
    if (pack === null || pack.packCredits === null) {
      throw new Error('No credit pack is on sale in this database: apply the seeds')
    }
    return {
      id: pack.id,
      slug: pack.slug,
      name: pack.name,
      credits: pack.packCredits,
      price: pack.price,
    }
  }

  const TARIFF_CREDITS = 30

  /**
   * A customer on a tariff of their own with its quota granted, the pack on sale and the
   * scripted shop. `status`: where the subscription stands; null — no subscription at all.
   */
  async function setup(status: SubscriptionStatus | null = 'active') {
    const pack = await packOnSale()
    const { userId, workspaceId } = await fixtures.workspace()
    const { email } = await db.user.findUniqueOrThrow({ where: { id: userId } })
    const tariff = await fixtures.plan({ creditsPerMonth: TARIFF_CREDITS })
    const subscription =
      status === null
        ? null
        : await fixtures.subscription({ workspaceId, planId: tariff.id, status })
    if (subscription !== null) {
      const tariffOrder = await fixtures.order({
        workspaceId,
        planId: tariff.id,
        subscriptionId: subscription.id,
      })
      await db.$transaction((tx) =>
        grantTariffCredits(tx, { workspaceId, orderId: tariffOrder.id, credits: TARIFF_CREDITS }),
      )
    }
    return { ...billingTestDeps(db), userId, email, workspaceId, pack, subscription }
  }

  /** Everything the pack orders of the workspace may have written. */
  async function written(workspaceId: string) {
    const orders = await db.order.findMany({
      where: { workspaceId, kind: 'pack' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const orderIds = orders.map((order) => order.id)
    const audit = await db.auditLog.findMany({ where: { workspaceId } })
    return {
      orders,
      balances: await getCreditBalances(db, workspaceId),
      ledger: await db.creditLedger.findMany({ where: { orderId: { in: orderIds } } }),
      audit,
      purchases: audit.filter((entry) => entry.action === settlementAuditActions.packPurchase),
      refundEntries: audit.filter((entry) => entry.action === settlementAuditActions.refundNeeded),
      letters: await db.outboxEvent.findMany({
        where: { dedupeKey: { in: orderIds.map(paymentLetterKey) } },
      }),
    }
  }

  const tariffOnly = {
    tariff: { balance: TARIFF_CREDITS, held: 0, available: TARIFF_CREDITS },
    gift: NO_GIFT,
    pack: { balance: 0, held: 0, available: 0 },
    totalAvailable: TARIFF_CREDITS,
  }

  const nothingApplied = (state: Awaited<ReturnType<typeof written>>) => {
    expect(state.balances).toEqual(tariffOnly)
    expect(state.ledger).toEqual([])
    expect(state.purchases).toEqual([])
    expect(state.letters).toEqual([])
  }

  describe('a pack checkout', () => {
    it('makes a pending pack order with its payment and the page to pay on', async () => {
      const { shop, deps, userId, workspaceId, pack } = await setup()

      const checkout = await startPackCheckout(deps, { userId })

      const state = await written(workspaceId)
      expect(state.orders).toHaveLength(1)
      const [order] = state.orders
      const payment = shop.only()
      expect(order).toMatchObject({
        id: checkout.orderId,
        workspaceId,
        userId,
        kind: 'pack',
        planId: pack.id,
        // A pack belongs to the workspace, not to the tariff it was bought under.
        subscriptionId: null,
        status: 'pending',
        yookassaPaymentId: payment.id,
        savePaymentMethod: false,
        periodStart: null,
        periodEnd: null,
        failureReason: null,
        paidAt: null,
      })
      expect(order?.amount.equals(pack.price)).toBe(true)
      expect(order?.idempotenceKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      expect(checkout).toEqual({
        orderId: order?.id,
        confirmationUrl: payment.confirmation?.confirmation_url,
      })
      expect(shop.created).toEqual([
        {
          idempotenceKey: order?.idempotenceKey,
          input: {
            amount: { value: pack.price.toFixed(2), currency: 'RUB' },
            capture: true,
            // Said out loud: left out, the payment page offers the buyer to save the method.
            save_payment_method: false,
            confirmation: {
              type: 'redirect',
              return_url: `${TEST_APP_URL}/settings/billing/return?order=${order?.id}`,
            },
            description: `Радити: «${pack.name}»`,
            metadata: { order_id: order?.id, workspace_id: workspaceId },
          },
        },
      ])
      expect(shop.created[0]?.input.description?.length).toBeLessThanOrEqual(128)
      // Nothing is applied before the payment.
      nothingApplied(state)
      expect(state.audit).toEqual([])
      expect(await syncOrder(deps, { userId, orderId: checkout.orderId })).toEqual({
        orderId: checkout.orderId,
        status: 'pending',
        kind: 'pack',
        planName: pack.name,
        packCredits: pack.credits,
        amount: pack.price.toFixed(2),
        failureText: null,
        refundNeeded: false,
        subscription: null,
      })
    })

    it('is refused for a user who has no workspace, and makes none', async () => {
      const { shop, deps } = billingTestDeps(db)
      await packOnSale()
      const { userId } = await fixtures.user()

      await expect(startPackCheckout(deps, { userId })).rejects.toMatchObject({
        code: 'BILLING_PACK_NEEDS_SUBSCRIPTION',
        httpStatus: 409,
      })

      expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toBeNull()
      expect(shop.created).toEqual([])
    })

    it.each([
      ['has never had a tariff', null],
      ['is overdue', 'past_due'],
      ['is on a trial, which takes no tasks', 'trial'],
      ['had its tariff end with the period', 'cancelled'],
      ['had its tariff end unpaid', 'expired'],
    ] as const)('is refused for a workspace that %s', async (_case, status) => {
      const { shop, deps, userId, workspaceId } = await setup(status)

      await expect(startPackCheckout(deps, { userId })).rejects.toMatchObject({
        code: 'BILLING_PACK_NEEDS_SUBSCRIPTION',
        httpStatus: 409,
      })

      expect(await db.order.count({ where: { workspaceId, kind: 'pack' } })).toBe(0)
      expect(shop.created).toEqual([])
    })

    it('gives every call an order and a payment of its own, and leaves the earlier ones alone', async () => {
      const { shop, deps, userId, workspaceId, pack } = await setup()

      const first = await startPackCheckout(deps, { userId })
      const second = await startPackCheckout(deps, { userId })

      expect(second.orderId).not.toBe(first.orderId)
      expect(second.confirmationUrl).not.toBe(first.confirmationUrl)
      expect(shop.payments.size).toBe(2)
      expect(new Set(shop.created.map((request) => request.idempotenceKey)).size).toBe(2)
      // The shop was not asked about the first order, which is neither given out nor cancelled.
      expect(shop.reads).toEqual([])
      let state = await written(workspaceId)
      expect(state.orders.map((order) => [order.id, order.status])).toEqual([
        [first.orderId, 'pending'],
        [second.orderId, 'pending'],
      ])

      // The page of the first order is still good: paid there, it is applied.
      const firstPayment = state.orders[0]?.yookassaPaymentId ?? ''
      shop.succeed(firstPayment)
      expect(await settleOrder(deps, { orderId: first.orderId })).toMatchObject({ state: 'paid' })
      state = await written(workspaceId)
      expect(state.orders.map((order) => order.status)).toEqual(['paid', 'pending'])
      expect(state.balances.pack.available).toBe(pack.credits)
    })

    it('does not stand in the way of an unfinished tariff order, nor the other way round', async () => {
      const { deps, userId, workspaceId } = await setup()
      // Left from before the tariff was on; nobody can pay it.
      const { planId } = await db.subscription.findFirstOrThrow({ where: { workspaceId } })
      const stale = await fixtures.order({ workspaceId, planId, status: 'pending', userId })

      const checkout = await startPackCheckout(deps, { userId })

      expect(checkout.orderId).not.toBe(stale.id)
      expect(await db.order.findUnique({ where: { id: stale.id } })).toMatchObject({
        status: 'pending',
        yookassaPaymentId: null,
      })
    })

    describe('with a shop that fails', () => {
      const unavailable = () => new YookassaError('YooKassa request timed out', { retryable: true })

      it('asks once more with the same key after a failure with an unknown outcome', async () => {
        const { shop, deps, userId, workspaceId } = await setup()
        // The payment was made; only the answer was lost.
        shop.failCreate(unavailable(), { processed: true })

        const checkout = await startPackCheckout(deps, { userId })

        expect(shop.created).toHaveLength(2)
        expect(shop.created[1]).toEqual(shop.created[0])
        const payment = shop.only()
        expect(checkout.confirmationUrl).toBe(payment.confirmation?.confirmation_url)
        expect((await written(workspaceId)).orders).toMatchObject([
          { status: 'pending', yookassaPaymentId: payment.id },
        ])
      })

      it.each([
        ['does not answer twice', () => [unavailable(), unavailable()], 'checkout_unavailable'],
        [
          'refuses the request',
          () => [new YookassaApiError('invalid_request', 400, 'invalid_request', {})],
          'checkout_rejected',
        ],
      ])('fails the order when the shop %s', async (_case, errors, reason) => {
        const { shop, deps, userId, workspaceId } = await setup()
        const failures = errors()
        for (const error of failures) shop.failCreate(error)

        await expect(startPackCheckout(deps, { userId })).rejects.toMatchObject({
          code: 'BILLING_PAYMENTS_NOT_CONFIGURED',
          httpStatus: 503,
          // What the shop said stays in the cause, for the logs.
          cause: failures.at(-1),
        })

        const state = await written(workspaceId)
        expect(state.orders).toMatchObject([
          { status: 'failed', failureReason: reason, yookassaPaymentId: null },
        ])
        nothingApplied(state)
        // The failed order does not stand in the way of the next try.
        const again = await startPackCheckout(deps, { userId })
        expect(again.orderId).not.toBe(state.orders[0]?.id)
      })

      it('declines the checkout when the shop cancels the payment at once', async () => {
        const { shop, deps, userId, workspaceId } = await setup()
        shop.createAs({
          status: 'canceled',
          confirmation: undefined,
          cancellation_details: { party: 'yoo_money', reason: 'fraud_suspected' },
        })

        await expect(startPackCheckout(deps, { userId })).rejects.toMatchObject({
          code: 'BILLING_PAYMENT_DECLINED',
          httpStatus: 402,
        })

        const state = await written(workspaceId)
        expect(state.orders).toMatchObject([
          { status: 'failed', failureReason: 'fraud_suspected', yookassaPaymentId: shop.only().id },
        ])
        nothingApplied(state)
      })

      it('sends the customer to the page of the order when the payment succeeds at once', async () => {
        const { shop, deps, userId, workspaceId, pack } = await setup()
        // No page to pay on, and the money is already taken.
        shop.createAs({
          status: 'succeeded',
          paid: true,
          confirmation: undefined,
          captured_at: '2026-10-04T09:30:00.000Z',
        })

        const checkout = await startPackCheckout(deps, { userId })

        // Not the tariff's «already on», and not a failure: the pack is paid and granted.
        expect(checkout).toEqual({
          orderId: expect.any(String),
          confirmationUrl: `${TEST_APP_URL}/settings/billing/return?order=${checkout.orderId}`,
        })
        const state = await written(workspaceId)
        expect(state.orders).toMatchObject([{ id: checkout.orderId, status: 'paid' }])
        expect(state.balances.pack.available).toBe(pack.credits)
      })
    })
  })

  describe('a paid pack', () => {
    it('adds its credits to the pack account once, leaves the tariff alone and tells the owner', async () => {
      const { shop, deps, userId, email, workspaceId, pack, subscription } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      const paymentId = shop.only().id
      // The buyer ticked «save» on the payment page themselves: a pack keeps no method.
      shop.succeed(paymentId, { saved: true, capturedAt: '2026-10-04T09:30:00.000Z' })

      expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual({
        state: 'paid',
        orderId,
        refundNeeded: false,
      })

      const state = await written(workspaceId)
      expect(state.orders).toHaveLength(1)
      expect(state.orders[0]).toMatchObject({
        id: orderId,
        status: 'paid',
        paidAt: new Date('2026-10-04T09:30:00.000Z'),
        subscriptionId: null,
        periodStart: null,
        periodEnd: null,
        failureReason: null,
      })
      expect(state.balances).toEqual({
        tariff: tariffOnly.tariff,
        gift: NO_GIFT,
        pack: { balance: pack.credits, held: 0, available: pack.credits },
        totalAvailable: TARIFF_CREDITS + pack.credits,
      })
      expect(state.ledger).toHaveLength(1)
      expect(state.ledger[0]).toMatchObject({
        kind: 'grant',
        unit: 'credit_pack',
        orderId,
        taskId: null,
        idempotencyKey: `order:${orderId}:pack`,
      })
      expect(state.ledger[0]?.amount.toNumber()).toBe(pack.credits)
      expect(state.ledger[0]?.balanceAfter.toNumber()).toBe(pack.credits)
      // The tariff account has the one row of its own quota, as before.
      expect(
        await db.creditLedger.count({ where: { account: { workspaceId, unit: 'credit_tariff' } } }),
      ).toBe(1)

      expect(state.letters).toHaveLength(1)
      expect(state.letters[0]).toMatchObject({
        topic: 'notifications',
        type: 'billing.payment_succeeded',
        status: 'pending',
        payload: {
          item: 'pack',
          packCredits: pack.credits,
          amount: pack.price.toFixed(2),
          appUrl: TEST_APP_URL,
          to: email,
        },
      })

      expect(state.audit).toHaveLength(1)
      expect(state.audit[0]).toMatchObject({
        action: 'billing.pack.purchase',
        actorType: 'user',
        actorId: userId,
        targetType: 'order',
        targetId: orderId,
      })
      // Money as a string, credits as a whole number.
      expect(state.audit[0]?.meta).toEqual({
        planSlug: pack.slug,
        amount: pack.price.toFixed(2),
        credits: pack.credits,
        notified: true,
      })

      // The tariff is as it was: its plan, its period, and still no payment method.
      expect(await db.subscription.findMany({ where: { workspaceId } })).toEqual([subscription])
      expect(await syncOrder(deps, { userId, orderId })).toMatchObject({
        orderId,
        status: 'paid',
        kind: 'pack',
        planName: pack.name,
        packCredits: pack.credits,
        amount: pack.price.toFixed(2),
        failureText: null,
        refundNeeded: false,
      })
    })

    it('settled again changes nothing and does not ask the shop', async () => {
      const { shop, deps, userId, workspaceId } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      const paymentId = shop.only().id
      shop.succeed(paymentId)
      await settleOrder(deps, { orderId })
      const before = await written(workspaceId)
      const reads = shop.reads.length

      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })
      expect(await settleOrderByPaymentId(deps, { paymentId })).toMatchObject({ state: 'paid' })
      expect(await syncOrder(deps, { userId, orderId })).toMatchObject({ status: 'paid' })

      expect(shop.reads).toHaveLength(reads)
      expect(await written(workspaceId)).toEqual(before)
    })

    it('is granted once to settlements that race', async () => {
      const { shop, deps, userId, workspaceId, pack } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      const paymentId = shop.only().id
      shop.succeed(paymentId)

      // The notification, the return page and a retry, several of each at once.
      const results = await Promise.all(
        Array.from({ length: 9 }, (_, index) =>
          index % 3 === 0
            ? settleOrder(deps, { orderId })
            : index % 3 === 1
              ? settleOrderByPaymentId(deps, { paymentId })
              : syncOrder(deps, { userId, orderId }).then(({ status, refundNeeded }) => ({
                  state: status,
                  orderId,
                  refundNeeded,
                })),
        ),
      )

      for (const result of results) {
        expect(result).toEqual({ state: 'paid', orderId, refundNeeded: false })
      }
      const state = await written(workspaceId)
      expect(state.ledger).toHaveLength(1)
      expect(state.balances.pack).toEqual({
        balance: pack.credits,
        held: 0,
        available: pack.credits,
      })
      expect(state.balances.tariff).toEqual(tariffOnly.tariff)
      expect(state.letters).toHaveLength(1)
      expect(state.purchases).toHaveLength(1)
    })

    it('bought twice adds its credits twice', async () => {
      const { shop, deps, userId, workspaceId, pack } = await setup()
      const first = await startPackCheckout(deps, { userId })
      const second = await startPackCheckout(deps, { userId })
      for (const paymentId of shop.payments.keys()) shop.succeed(paymentId)

      expect(await settleOrder(deps, { orderId: first.orderId })).toMatchObject({ state: 'paid' })
      expect(await settleOrder(deps, { orderId: second.orderId })).toMatchObject({ state: 'paid' })

      const state = await written(workspaceId)
      expect(state.orders.map((order) => order.status)).toEqual(['paid', 'paid'])
      expect(state.balances.pack).toEqual({
        balance: 2 * pack.credits,
        held: 0,
        available: 2 * pack.credits,
      })
      expect(state.balances.tariff).toEqual(tariffOnly.tariff)
      // A row, a letter and an entry per order.
      expect(state.ledger.map((entry) => entry.idempotencyKey).sort()).toEqual(
        [`order:${first.orderId}:pack`, `order:${second.orderId}:pack`].sort(),
      )
      expect(
        state.ledger.map((entry) => entry.balanceAfter.toNumber()).sort((a, b) => a - b),
      ).toEqual([pack.credits, 2 * pack.credits])
      expect(state.letters).toHaveLength(2)
      expect(state.purchases.map((entry) => entry.targetId).sort()).toEqual(
        [first.orderId, second.orderId].sort(),
      )
    })

    it('outlives the tariff: the remainder of the quota expires with the period, the pack stays', async () => {
      const { shop, deps, userId, workspaceId, pack, subscription } = await setup()
      if (subscription === null) throw new Error('The customer has a tariff')
      const { orderId } = await startPackCheckout(deps, { userId })
      shop.succeed(shop.only().id)
      await settleOrder(deps, { orderId })

      const expired = await db.$transaction((tx) =>
        expireTariffRemainder(tx, {
          workspaceId,
          subscriptionId: subscription.id,
          periodEnd: subscription.currentPeriodEnd,
        }),
      )

      expect(expired?.applied).toBe(true)
      expect(expired?.entry.amount.toNumber()).toBe(-TARIFF_CREDITS)
      expect(await getCreditBalances(db, workspaceId)).toEqual({
        tariff: { balance: 0, held: 0, available: 0 },
        gift: NO_GIFT,
        pack: { balance: pack.credits, held: 0, available: pack.credits },
        totalAvailable: pack.credits,
      })
      // Nothing was written against the pack account besides its grant.
      expect(
        await db.creditLedger.findMany({
          where: { account: { workspaceId, unit: 'credit_pack' } },
          select: { kind: true, orderId: true },
        }),
      ).toEqual([{ kind: 'grant', orderId }])
    })

    it.each(['cancelled', 'expired', 'past_due'] as const)(
      'is applied even when the tariff became %s between the checkout and the payment',
      async (status) => {
        const { shop, deps, userId, workspaceId, pack, subscription } = await setup()
        const { orderId } = await startPackCheckout(deps, { userId })
        await db.subscription.update({ where: { id: subscription?.id }, data: { status } })
        shop.succeed(shop.only().id)

        // The customer paid: the credits are theirs, and wait for the next tariff.
        expect(await settleOrder(deps, { orderId })).toEqual({
          state: 'paid',
          orderId,
          refundNeeded: false,
        })

        const state = await written(workspaceId)
        expect(state.balances.pack.available).toBe(pack.credits)
        expect(state.refundEntries).toEqual([])
        expect(state.letters).toHaveLength(1)
        // A new pack is not sold until the tariff is paid again.
        await expect(startPackCheckout(deps, { userId })).rejects.toMatchObject({
          code: 'BILLING_PACK_NEEDS_SUBSCRIPTION',
        })
      },
    )

    it('is applied to a workspace that has no credit account yet', async () => {
      const { shop, deps } = billingTestDeps(db)
      const pack = await packOnSale()
      const { userId, workspaceId } = await fixtures.workspace()
      const tariff = await fixtures.plan()
      // A tariff whose quota was never granted: no account of any kind.
      await fixtures.subscription({ workspaceId, planId: tariff.id })
      const { orderId } = await startPackCheckout(deps, { userId })
      shop.succeed(shop.only().id)

      await settleOrder(deps, { orderId })

      expect(await getCreditBalances(db, workspaceId)).toEqual({
        tariff: { balance: 0, held: 0, available: 0 },
        gift: NO_GIFT,
        pack: { balance: pack.credits, held: 0, available: pack.credits },
        totalAvailable: pack.credits,
      })
      // The three credit accounts are created together, the gift's empty.
      expect(await db.billingAccount.count({ where: { workspaceId } })).toBe(3)
    })

    it('counts the payment from the clock when the shop sends no capture moment', async () => {
      const { shop, deps, userId, workspaceId } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      shop.succeed(shop.only().id)
      shop.patch(shop.only().id, { captured_at: undefined })

      await settleOrder(deps, { orderId })

      expect((await written(workspaceId)).orders[0]).toMatchObject({ paidAt: TEST_NOW })
    })

    it('is applied in the name of the platform when the user who ordered it is gone', async () => {
      const { shop, deps, userId, workspaceId, pack } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      shop.succeed(shop.only().id)
      // What deleting the user leaves in the order.
      await db.order.update({ where: { id: orderId }, data: { userId: null } })

      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })

      const state = await written(workspaceId)
      expect(state.balances.pack.available).toBe(pack.credits)
      expect(state.purchases).toMatchObject([
        { actorType: 'system', actorId: 'billing', targetType: 'order', targetId: orderId },
      ])
    })

    it('is applied without a letter when the workspace has no owner to write to', async () => {
      const { shop, deps, userId, workspaceId, pack } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      shop.succeed(shop.only().id)
      await db.member.deleteMany({ where: { workspaceId } })

      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })

      const state = await written(workspaceId)
      expect(state.balances.pack.available).toBe(pack.credits)
      expect(state.letters).toEqual([])
      expect(state.purchases[0]?.meta).toMatchObject({ notified: false })
    })
  })

  describe('a pack payment that brings nothing', () => {
    it('leaves the order pending while the payment has no outcome', async () => {
      const { shop, deps, userId, workspaceId } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })

      for (const status of ['pending', 'waiting_for_capture'] as const) {
        shop.patch(shop.only().id, { status })
        expect(await settleOrder(deps, { orderId })).toEqual({
          state: 'pending',
          orderId,
          refundNeeded: false,
        })
      }

      const state = await written(workspaceId)
      expect(state.orders).toMatchObject([{ status: 'pending', paidAt: null }])
      nothingApplied(state)
    })

    it('fails the order of a cancelled payment with the reason and applies nothing', async () => {
      const { shop, deps, userId, workspaceId } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      const paymentId = shop.only().id
      shop.cancel(paymentId, 'insufficient_funds')

      expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual({
        state: 'failed',
        orderId,
        refundNeeded: false,
      })

      const state = await written(workspaceId)
      expect(state.orders).toMatchObject([
        { status: 'failed', failureReason: 'insufficient_funds', paidAt: null },
      ])
      nothingApplied(state)
      expect(state.audit).toEqual([])
      expect(await syncOrder(deps, { userId, orderId })).toMatchObject({
        status: 'failed',
        kind: 'pack',
        failureText: 'Недостаточно средств. Пополните счёт или выберите другой способ оплаты.',
        refundNeeded: false,
      })
      // The customer may try again at once.
      const again = await startPackCheckout(deps, { userId })
      expect(again.orderId).not.toBe(orderId)
    })

    it.each([
      [
        'another amount',
        (orderId: string) => ({
          amount: { value: '19.90', currency: 'RUB' } as const,
          metadata: { order_id: orderId },
        }),
      ],
      [
        'another currency',
        (orderId: string) => ({
          amount: { value: '1990.00', currency: 'USD' } as unknown as {
            value: string
            currency: 'RUB'
          },
          metadata: { order_id: orderId },
        }),
      ],
      ['another order in its metadata', () => ({ metadata: { order_id: randomUUID() } })],
    ])(
      'applies nothing for a payment with %s and asks an operator to look',
      async (_case, forged) => {
        const { shop, deps, userId, workspaceId, pack } = await setup()
        const { orderId } = await startPackCheckout(deps, { userId })
        const paymentId = shop.only().id
        shop.succeed(paymentId)
        shop.patch(paymentId, forged(orderId))

        const outcome = { state: 'failed', orderId, refundNeeded: true }
        expect(await settleOrder(deps, { orderId })).toEqual(outcome)
        // A repeat finds the entry and adds nothing.
        expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual(outcome)

        const state = await written(workspaceId)
        expect(state.orders).toMatchObject([
          { status: 'failed', failureReason: 'amount_mismatch', paidAt: null },
        ])
        nothingApplied(state)
        expect(state.refundEntries).toHaveLength(1)
        expect(state.refundEntries[0]).toMatchObject({
          actorType: 'system',
          targetType: 'order',
          targetId: orderId,
          meta: {
            reason: 'amount_mismatch',
            orderStatus: 'failed',
            paymentId,
            orderAmount: pack.price.toFixed(2),
          },
        })
        expect(await syncOrder(deps, { userId, orderId })).toMatchObject({
          status: 'failed',
          failureText: 'Платёж не удалось зачислить. Напишите нам — мы разберёмся.',
          refundNeeded: true,
        })
      },
    )

    it('applies nothing for a payment that went back before anybody settled the order', async () => {
      const { shop, deps, userId, workspaceId, pack } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      const paymentId = shop.only().id
      // ЮKassa keeps a payment `succeeded` after a refund: only `refunded_amount` tells.
      shop.succeed(paymentId)
      shop.patch(paymentId, {
        refunded_amount: { value: pack.price.toFixed(2), currency: 'RUB' },
        refundable: false,
      })

      expect(await settleOrder(deps, { orderId })).toEqual({
        state: 'failed',
        orderId,
        refundNeeded: false,
      })

      const state = await written(workspaceId)
      expect(state.orders).toMatchObject([{ status: 'failed', failureReason: 'payment_refunded' }])
      nothingApplied(state)
      expect(state.audit).toEqual([])
    })

    it('applies nothing for a pack order that was closed, and asks for the money to go back', async () => {
      const { shop, deps, userId, workspaceId } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      const paymentId = shop.only().id
      // Closed by us; its payment page stayed open, and the customer paid there after all.
      await db.order.update({ where: { id: orderId }, data: { status: 'cancelled' } })
      shop.succeed(paymentId)

      const outcome = { state: 'cancelled', orderId, refundNeeded: true }
      expect(await settleOrderByPaymentId(deps, { paymentId })).toEqual(outcome)
      expect(await settleOrder(deps, { orderId })).toEqual(outcome)

      const state = await written(workspaceId)
      nothingApplied(state)
      expect(state.refundEntries).toHaveLength(1)
      expect(state.refundEntries[0]?.meta).toMatchObject({ reason: 'order_closed' })
    })

    it('leaves the order pending when its plan is not a pack, and applies nothing', async () => {
      const { shop, deps, workspaceId } = await setup()
      // Not what a checkout makes: a pack order that points at a tariff, whatever the row of
      // the tariff holds in the column of a pack.
      const tariff = await fixtures.plan({ packCredits: 5 })
      const order = await fixtures.order({
        workspaceId,
        planId: tariff.id,
        kind: 'pack',
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
        code: 'CONFLICT',
      })

      // The whole transaction went back: the order is not paid without its credits.
      expect(await db.order.findUnique({ where: { id: order.id } })).toMatchObject({
        status: 'pending',
        paidAt: null,
      })
      nothingApplied(await written(workspaceId))
    })

    it('lets a failure of the shop through and leaves the order as it is', async () => {
      const { shop, deps, userId, workspaceId } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      shop.succeed(shop.only().id)
      const outage = new YookassaError('YooKassa request timed out', { retryable: true })
      shop.failRead(outage)

      await expect(settleOrder(deps, { orderId })).rejects.toBe(outage)

      nothingApplied(await written(workspaceId))
      // The return page shows the stored state meanwhile, and the next look applies its payment.
      shop.failRead(outage)
      expect(await syncOrder(deps, { userId, orderId })).toMatchObject({ status: 'pending' })
      expect(await syncOrder(deps, { userId, orderId })).toMatchObject({ status: 'paid' })
    })
  })

  describe('the return page of a pack order', () => {
    it('names the size of a pack for a pack order only', async () => {
      const { shop, deps, userId, workspaceId, pack } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      // A tariff order of the same workspace, whose plan row holds a number in the pack column.
      const tariff = await fixtures.plan({ packCredits: 5 })
      const tariffOrder = await fixtures.order({ workspaceId, planId: tariff.id })

      expect(await syncOrder(deps, { userId, orderId })).toMatchObject({
        kind: 'pack',
        packCredits: pack.credits,
      })
      expect(await syncOrder(deps, { userId, orderId: tariffOrder.id })).toMatchObject({
        kind: 'subscription',
        packCredits: null,
      })
      expect(shop.reads).toHaveLength(1)
    })

    it('does not show the order to another user', async () => {
      const { shop, deps, userId } = await setup()
      const { orderId } = await startPackCheckout(deps, { userId })
      shop.succeed(shop.only().id)
      const stranger = await fixtures.workspace()

      await expect(syncOrder(deps, { userId: stranger.userId, orderId })).rejects.toMatchObject({
        code: 'BILLING_ORDER_NOT_FOUND',
        httpStatus: 404,
      })

      // A stranger's question settles nothing and asks the shop nothing.
      expect(shop.reads).toEqual([])
      expect(await db.order.findUnique({ where: { id: orderId } })).toMatchObject({
        status: 'pending',
      })
    })
  })
})
