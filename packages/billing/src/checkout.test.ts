import { randomUUID } from 'node:crypto'

import { createPrismaClient, findPersonalWorkspace, type PrismaClient } from '@repo/db'
import { YookassaApiError, YookassaError } from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { checkoutReturnUrl, startCheckout, syncOrder } from './checkout.ts'
import type { BillingDeps } from './deps.ts'
import { giftAuditActions, ledgerKeys } from './ledger.ts'
import { getCreditBalances } from './read-models.ts'
import { settleOrder, settlementAuditActions } from './settlement.ts'
import { billingFixtures, billingTestDeps, GIFT_ONLY, NO_GIFT, TEST_APP_URL } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const USER = '0199a000-0000-7000-8000-0000000000d4'
const ORDER = '0199a000-0000-7000-8000-0000000000b2'

describe('checkout input', () => {
  // Reaching the database or the shop with a refused input would throw on the missing client.
  const deps = {} as BillingDeps

  it('refuses a broken user, plan or consent before any query', async () => {
    const input = { userId: USER, planSlug: 'business', autoRenew: false }
    await expect(startCheckout(deps, { ...input, userId: 'user' })).rejects.toThrow()
    await expect(startCheckout(deps, { ...input, planSlug: '' })).rejects.toThrow()
    await expect(startCheckout(deps, { ...input, planSlug: 's'.repeat(51) })).rejects.toThrow()
    // The consent is never guessed: no value, no checkout.
    await expect(
      startCheckout(deps, { userId: USER, planSlug: 'business' } as typeof input),
    ).rejects.toThrow()
    await expect(
      startCheckout(deps, { ...input, autoRenew: 'yes' } as unknown as typeof input),
    ).rejects.toThrow()
    await expect(
      startCheckout(deps, { ...input, amount: '1.00' } as unknown as typeof input),
    ).rejects.toThrow()
  })

  it('refuses a broken order id before any query', async () => {
    await expect(syncOrder(deps, { userId: USER, orderId: 'order' })).rejects.toThrow()
    await expect(syncOrder(deps, { userId: 'user', orderId: ORDER })).rejects.toThrow()
  })

  it('sends the customer back to the return page of the order', () => {
    expect(checkoutReturnUrl('https://raditi.ru', ORDER)).toBe(
      `https://raditi.ru/settings/billing/return?order=${ORDER}`,
    )
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL checkout', () => {
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
    const { userId } = await fixtures.user()
    const plan = await fixtures.plan({ isActive: true, ...planData })
    return { ...billingTestDeps(db), userId, plan }
  }

  async function ordersOf(userId: string) {
    const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
    if (workspace === null) return []
    return db.order.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
  }

  const known = (workspaceId: string | undefined): string => {
    if (workspaceId === undefined) throw new Error('The checkout left no workspace')
    return workspaceId
  }

  /** The audit of a workspace, as the names of its entries in alphabetical order. */
  async function actionsOf(workspaceId: string | undefined) {
    const audit = await db.auditLog.findMany({ where: { workspaceId: known(workspaceId) } })
    return audit.map((entry) => entry.action).sort()
  }

  const creditsOf = (workspaceId: string | undefined) => getCreditBalances(db, known(workspaceId))

  /** The journal rows under the key of the user's gift, on whichever account they stand. */
  const giftRows = (userId: string) =>
    db.creditLedger.findMany({ where: { idempotencyKey: ledgerKeys.signupGift(userId) } })

  describe('a new order', () => {
    it('is created pending with its payment and the page to pay on', async () => {
      const { shop, deps, userId, plan } = await setup()

      const checkout = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })

      const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
      // A workspace made for a user outside production holds synthetic data, as their sites do.
      expect(await db.workspace.findUnique({ where: { id: workspace?.id } })).toMatchObject({
        createdById: userId,
        dataClass: 'synthetic',
      })
      const orders = await ordersOf(userId)
      expect(orders).toHaveLength(1)
      const [order] = orders
      const payment = shop.only()
      expect(order).toMatchObject({
        id: checkout.orderId,
        workspaceId: workspace?.id,
        userId,
        kind: 'subscription',
        planId: plan.id,
        subscriptionId: null,
        status: 'pending',
        yookassaPaymentId: payment.id,
        savePaymentMethod: true,
        periodStart: null,
        periodEnd: null,
        failureReason: null,
        paidAt: null,
      })
      expect(order?.amount.toFixed(2)).toBe('4900.00')
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
            // Money goes to the shop as a string with two decimals.
            amount: { value: '4900.00', currency: 'RUB' },
            capture: true,
            save_payment_method: true,
            confirmation: {
              type: 'redirect',
              return_url: `${TEST_APP_URL}/settings/billing/return?order=${order?.id}`,
            },
            description: 'Радити: тариф «Проверочный» на месяц',
            metadata: { order_id: order?.id, workspace_id: workspace?.id },
          },
        },
      ])
      // Nothing of the tariff is applied before the payment. What the workspace has is the gift
      // of the registration, granted in the transaction that made it.
      expect(await db.subscription.count({ where: { workspaceId: workspace?.id } })).toBe(0)
      expect(await creditsOf(workspace?.id)).toEqual(GIFT_ONLY)
      expect(await actionsOf(workspace?.id)).toEqual([giftAuditActions.grant])
    })

    it('keeps the description within what the shop takes, whatever the name', async () => {
      const { shop, deps, userId, plan } = await setup({ name: 'Я'.repeat(100) })
      await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })
      const description = shop.created[0]?.input.description ?? ''
      expect(description.length).toBeLessThanOrEqual(128)
      expect(description).toContain('Я'.repeat(100))
    })

    it.each([
      ['an unknown slug', {}, () => `missing-${randomUUID()}`],
      ['a tariff that is not on sale', { isActive: false }, undefined],
      [
        'a pack',
        {
          kind: 'pack' as const,
          packCredits: 10,
          creditsPerMonth: null,
          creditsPerDay: null,
          maxSites: null,
        },
        undefined,
      ],
      ['pay-per-action', { kind: 'payg' as const, price: '0.00' }, undefined],
      ['a tariff that costs nothing', { price: '0.00' }, undefined],
    ])('refuses %s as «plan not found» and creates nothing', async (_name, planData, slug) => {
      const { shop, deps, userId, plan } = await setup(planData)
      await expect(
        startCheckout(deps, { userId, planSlug: slug?.() ?? plan.slug, autoRenew: false }),
      ).rejects.toMatchObject({ code: 'BILLING_PLAN_NOT_FOUND', httpStatus: 404 })
      expect(shop.created).toEqual([])
      // Not even the workspace.
      expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toBeNull()
    })

    it('refuses a user who no longer exists', async () => {
      const { shop, deps, plan } = await setup()
      await expect(
        startCheckout(deps, { userId: USER, planSlug: plan.slug, autoRenew: false }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(shop.created).toEqual([])
    })
  })

  describe('the gift of the registration', () => {
    it('is granted with the workspace a checkout makes, before anything is paid', async () => {
      const { deps, userId, plan } = await setup()
      expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toBeNull()

      await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })

      const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
      expect(await creditsOf(workspace?.id)).toEqual(GIFT_ONLY)
      const rows = await giftRows(userId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ kind: 'grant', unit: 'credit_gift', orderId: null })
      expect(rows[0]?.amount.toFixed(2)).toBe('35.00')
      const account = await db.billingAccount.findUniqueOrThrow({
        where: { id: rows[0]?.accountId },
      })
      expect(account.workspaceId).toBe(workspace?.id)
    })

    it('is granted once, however many checkouts the user starts', async () => {
      const { shop, deps, userId, plan } = await setup()
      const other = await fixtures.plan({ isActive: true, name: 'Другой', price: '12900.00' })

      // The same choice again, another tariff, and the first one after a cancelled payment.
      const first = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })
      await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })
      await startCheckout(deps, { userId, planSlug: other.slug, autoRenew: false })
      for (const payment of shop.payments.values()) shop.cancel(payment.id)
      await settleOrder(deps, { orderId: first.orderId })
      await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })

      const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
      expect(await db.workspace.count({ where: { createdById: userId } })).toBe(1)
      expect(await giftRows(userId)).toHaveLength(1)
      expect(await creditsOf(workspace?.id)).toEqual(GIFT_ONLY)
      expect(await actionsOf(workspace?.id)).toEqual([giftAuditActions.grant])
    })

    it('reaches a workspace that was made without it at its next checkout', async () => {
      const { deps } = billingTestDeps(db)
      const plan = await fixtures.plan({ isActive: true })
      // A workspace of before the gift: nothing was granted with it.
      const { userId, workspaceId } = await fixtures.workspace()
      expect(await giftRows(userId)).toEqual([])

      await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })

      expect(await creditsOf(workspaceId)).toEqual(GIFT_ONLY)
      expect(await giftRows(userId)).toHaveLength(1)
    })

    it('is taken back with a checkout that is refused, and granted by the next one that goes through', async () => {
      const { shop, deps } = billingTestDeps(db)
      const plan = await fixtures.plan({ isActive: true })
      const { userId, workspaceId } = await fixtures.workspace()
      const subscription = await fixtures.subscription({ workspaceId, planId: plan.id })

      await expect(
        startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false }),
      ).rejects.toMatchObject({ code: 'BILLING_SUBSCRIPTION_EXISTS' })

      // The refusal rolled its transaction back, the gift and its accounts with it.
      expect(await giftRows(userId)).toEqual([])
      expect((await creditsOf(workspaceId)).gift).toEqual(NO_GIFT)
      expect(await db.billingAccount.count({ where: { workspaceId } })).toBe(0)
      expect(await actionsOf(workspaceId)).toEqual([])
      expect(shop.created).toEqual([])

      await db.subscription.update({ where: { id: subscription.id }, data: { status: 'expired' } })
      await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })

      expect(await creditsOf(workspaceId)).toEqual(GIFT_ONLY)
      expect(await giftRows(userId)).toHaveLength(1)
    })

    it('stays when the payment is declined, and is not granted again by the checkout after it', async () => {
      const { shop, deps, userId, plan } = await setup()
      const choice = { userId, planSlug: plan.slug, autoRenew: false }
      const first = await startCheckout(deps, choice)
      shop.cancel(shop.only().id, 'insufficient_funds')
      expect(await settleOrder(deps, { orderId: first.orderId })).toMatchObject({ state: 'failed' })

      const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
      expect(await creditsOf(workspace?.id)).toEqual(GIFT_ONLY)

      await startCheckout(deps, choice)
      expect(await giftRows(userId)).toHaveLength(1)
      expect(await creditsOf(workspace?.id)).toEqual(GIFT_ONLY)
    })
  })

  describe('a workspace that cannot buy the tariff', () => {
    it('is refused while it has a live subscription', async () => {
      const { shop, deps } = billingTestDeps(db)
      const plan = await fixtures.plan({ isActive: true })
      for (const status of ['active', 'past_due', 'trial'] as const) {
        const { userId, workspaceId } = await fixtures.workspace()
        await fixtures.subscription({ workspaceId, planId: plan.id, status })
        await expect(
          startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true }),
        ).rejects.toMatchObject({ code: 'BILLING_SUBSCRIPTION_EXISTS', httpStatus: 409 })
        expect(await db.order.count({ where: { workspaceId } })).toBe(0)
      }
      expect(shop.created).toEqual([])
    })

    it('may buy again after its subscription ended', async () => {
      const { deps } = billingTestDeps(db)
      const plan = await fixtures.plan({ isActive: true })
      for (const status of ['cancelled', 'expired'] as const) {
        const { userId, workspaceId } = await fixtures.workspace()
        await fixtures.subscription({ workspaceId, planId: plan.id, status })
        const { orderId } = await startCheckout(deps, {
          userId,
          planSlug: plan.slug,
          autoRenew: false,
        })
        expect(await db.order.findUnique({ where: { id: orderId } })).toMatchObject({
          workspaceId,
          status: 'pending',
        })
      }
    })

    it('is refused when it has more sites than the plan allows', async () => {
      const { shop, deps } = billingTestDeps(db)
      const { userId, workspaceId } = await fixtures.workspace()
      const site = (name: string) =>
        db.site.create({
          data: {
            workspaceId,
            name,
            url: `https://${randomUUID()}.example.ru`,
            stack: 'wordpress',
          },
        })
      await site('Кофейня')
      await site('Пекарня')
      const one = await fixtures.plan({ isActive: true, maxSites: 1 })
      const two = await fixtures.plan({ isActive: true, maxSites: 2 })

      await expect(
        startCheckout(deps, { userId, planSlug: one.slug, autoRenew: false }),
      ).rejects.toMatchObject({ code: 'BILLING_PLAN_SITE_LIMIT', httpStatus: 409 })
      expect(await db.order.count({ where: { workspaceId } })).toBe(0)
      expect(shop.created).toEqual([])

      // As many sites as the plan allows is fine.
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: two.slug,
        autoRenew: false,
      })
      expect(await db.order.findUnique({ where: { id: orderId } })).toMatchObject({
        planId: two.id,
        status: 'pending',
      })
    })
  })

  describe('an unfinished order', () => {
    it('gives the same order and page to the same choice, without a second payment', async () => {
      const { shop, deps, userId, plan } = await setup()
      const choice = { userId, planSlug: plan.slug, autoRenew: true }
      const first = await startCheckout(deps, choice)

      const again = await startCheckout(deps, choice)

      expect(again).toEqual(first)
      expect(shop.created).toHaveLength(1)
      // The page comes from the payment read back, not from a copy of ours.
      expect(shop.reads).toEqual([shop.only().id])
      const orders = await ordersOf(userId)
      expect(orders).toHaveLength(1)
      expect(orders[0]).toMatchObject({ status: 'pending' })
    })

    it('gives one order to checkouts of the same choice that race', async () => {
      const { shop, deps, userId, plan } = await setup()
      const choice = { userId, planSlug: plan.slug, autoRenew: false }

      const results = await Promise.all(
        Array.from({ length: 5 }, () => startCheckout(deps, choice)),
      )

      expect(new Set(results.map((result) => result.orderId)).size).toBe(1)
      expect(new Set(results.map((result) => result.confirmationUrl)).size).toBe(1)
      expect(await ordersOf(userId)).toHaveLength(1)
      // However the requests interleave, the shop made one payment.
      expect(shop.payments.size).toBe(1)
      expect(new Set(shop.created.map((request) => request.idempotenceKey)).size).toBe(1)
      // And the workspace they made together got the gift of the registration once.
      const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
      expect(await db.workspace.count({ where: { createdById: userId } })).toBe(1)
      expect(await giftRows(userId)).toHaveLength(1)
      expect(await creditsOf(workspace?.id)).toEqual(GIFT_ONLY)
      expect(await actionsOf(workspace?.id)).toEqual([giftAuditActions.grant])
    })

    it('is cancelled by another plan, and a new order is made', async () => {
      const { shop, deps, userId, plan } = await setup()
      const other = await fixtures.plan({ isActive: true, name: 'Другой', price: '12900.00' })
      const first = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })

      const second = await startCheckout(deps, { userId, planSlug: other.slug, autoRenew: true })

      expect(second.orderId).not.toBe(first.orderId)
      expect(second.confirmationUrl).not.toBe(first.confirmationUrl)
      const orders = await ordersOf(userId)
      expect(orders.map((order) => [order.id, order.status, order.planId])).toEqual([
        [first.orderId, 'cancelled', plan.id],
        [second.orderId, 'pending', other.id],
      ])
      expect(orders[1]?.amount.toFixed(2)).toBe('12900.00')
      expect(shop.created).toHaveLength(2)
      expect(shop.created[1]?.input.amount).toEqual({ value: '12900.00', currency: 'RUB' })
    })

    it('is cancelled by another consent, so the payment asks for what was agreed', async () => {
      const { shop, deps, userId, plan } = await setup()
      const first = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })

      const second = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })

      expect(second.orderId).not.toBe(first.orderId)
      const orders = await ordersOf(userId)
      expect(orders.map((order) => [order.status, order.savePaymentMethod])).toEqual([
        ['cancelled', true],
        ['pending', false],
      ])
      expect(shop.created.map((request) => request.input.save_payment_method)).toEqual([
        true,
        false,
      ])
    })

    it('is cancelled when the price of the plan has changed since', async () => {
      const { shop, deps, userId, plan } = await setup()
      const choice = { userId, planSlug: plan.slug, autoRenew: false }
      const first = await startCheckout(deps, choice)
      await db.plan.update({ where: { id: plan.id }, data: { price: '5900.00' } })

      const second = await startCheckout(deps, choice)

      expect(second.orderId).not.toBe(first.orderId)
      const orders = await ordersOf(userId)
      expect(orders.map((order) => [order.status, order.amount.toFixed(2)])).toEqual([
        ['cancelled', '4900.00'],
        ['pending', '5900.00'],
      ])
      expect(shop.created[1]?.input.amount.value).toBe('5900.00')
    })

    it('that turns out paid switches the tariff on and refuses the checkout', async () => {
      const { shop, deps, userId, plan } = await setup()
      const choice = { userId, planSlug: plan.slug, autoRenew: true }
      const first = await startCheckout(deps, choice)
      // Paid, and neither the notification nor the return page has come yet.
      shop.succeed(shop.only().id, { saved: true })

      await expect(startCheckout(deps, choice)).rejects.toMatchObject({
        code: 'BILLING_SUBSCRIPTION_EXISTS',
      })

      const orders = await ordersOf(userId)
      expect(orders).toHaveLength(1)
      expect(orders[0]).toMatchObject({ id: first.orderId, status: 'paid' })
      expect(await db.subscription.count({ where: { workspaceId: orders[0]?.workspaceId } })).toBe(
        1,
      )
      expect(shop.created).toHaveLength(1)
    })

    it('that turns out failed gives way to a new order', async () => {
      const { shop, deps, userId, plan } = await setup()
      const choice = { userId, planSlug: plan.slug, autoRenew: true }
      const first = await startCheckout(deps, choice)
      shop.cancel(shop.only().id, 'expired_on_confirmation')

      const second = await startCheckout(deps, choice)

      expect(second.orderId).not.toBe(first.orderId)
      const orders = await ordersOf(userId)
      expect(orders.map((order) => [order.status, order.failureReason])).toEqual([
        ['failed', 'expired_on_confirmation'],
        ['pending', null],
      ])
    })

    it('whose payment was paid and returned meanwhile gives way to a new order', async () => {
      const { shop, deps, userId, plan } = await setup()
      const choice = { userId, planSlug: plan.slug, autoRenew: true }
      const first = await startCheckout(deps, choice)
      const paymentId = shop.only().id
      // Paid, the notification was lost, an operator returned the money in the ЮKassa cabinet
      // and asked the customer to pay again: the payment stays `succeeded`.
      shop.succeed(paymentId, { saved: true })
      shop.patch(paymentId, {
        refunded_amount: { value: '4900.00', currency: 'RUB' },
        refundable: false,
      })

      const second = await startCheckout(deps, choice)

      expect(second.orderId).not.toBe(first.orderId)
      const orders = await ordersOf(userId)
      expect(orders.map((order) => [order.id, order.status, order.failureReason])).toEqual([
        [first.orderId, 'failed', 'payment_refunded'],
        [second.orderId, 'pending', null],
      ])
      // No free month and no card to charge at a renewal: the workspace has the gift of the
      // registration and nothing of the tariff.
      const workspaceId = orders[0]?.workspaceId
      expect(await db.subscription.count({ where: { workspaceId } })).toBe(0)
      expect(await creditsOf(workspaceId)).toEqual(GIFT_ONLY)
      expect(await actionsOf(workspaceId)).toEqual([giftAuditActions.grant])
      expect(shop.payments.size).toBe(2)
    })

    it.each(['order', 'subscription'] as const)(
      'that is settled while the checkout reads the %s is not followed by a second payment',
      async (read) => {
        const { shop, deps, userId, plan } = await setup()
        const choice = { userId, planSlug: plan.slug, autoRenew: false }
        const first = await startCheckout(deps, choice)
        shop.succeed(shop.only().id)
        // The notification of the first payment is settled on another connection right after
        // the checkout made this read: neither of its two reads may miss the tariff.
        let settled = false
        const settleAfter = async <T>(result: Promise<T>): Promise<T> => {
          const rows = await result
          if (!settled) {
            settled = true
            await settleOrder(deps, { orderId: first.orderId })
          }
          return rows
        }
        const hooked = db.$extends({
          query: {
            order: {
              findFirst: ({ args, query }) =>
                read === 'order' ? settleAfter(query(args)) : query(args),
            },
            subscription: {
              findFirst: ({ args, query }) =>
                read === 'subscription' ? settleAfter(query(args)) : query(args),
            },
          },
        }) as unknown as PrismaClient

        await expect(startCheckout({ ...deps, prisma: hooked }, choice)).rejects.toMatchObject({
          code: 'BILLING_SUBSCRIPTION_EXISTS',
        })

        expect(settled).toBe(true)
        const orders = await ordersOf(userId)
        expect(orders).toHaveLength(1)
        expect(orders[0]).toMatchObject({ id: first.orderId, status: 'paid' })
        expect(
          await db.subscription.count({ where: { workspaceId: orders[0]?.workspaceId } }),
        ).toBe(1)
        expect(shop.payments.size).toBe(1)
        expect(shop.created).toHaveLength(1)
      },
    )

    it('whose payment has no page left is not paid for twice', async () => {
      const { shop, deps, userId, plan } = await setup()
      const choice = { userId, planSlug: plan.slug, autoRenew: true }
      await startCheckout(deps, choice)
      // The customer confirmed, the bank has not answered yet.
      shop.patch(shop.only().id, { confirmation: undefined })

      await expect(startCheckout(deps, choice)).rejects.toMatchObject({
        code: 'BILLING_PAYMENT_IN_PROGRESS',
        httpStatus: 409,
      })

      expect(shop.created).toHaveLength(1)
      const orders = await ordersOf(userId)
      expect(orders).toHaveLength(1)
      expect(orders[0]).toMatchObject({ status: 'pending' })
    })

    it('whose payment the shop does not know is cancelled and replaced', async () => {
      const { shop, deps, userId, plan } = await setup()
      const choice = { userId, planSlug: plan.slug, autoRenew: true }
      const first = await startCheckout(deps, choice)
      // Another shop, or a fake that was restarted: GET /payments/{id} answers 404.
      shop.payments.clear()

      const second = await startCheckout(deps, choice)

      expect(second.orderId).not.toBe(first.orderId)
      const orders = await ordersOf(userId)
      expect(orders.map((order) => [order.id, order.status])).toEqual([
        [first.orderId, 'cancelled'],
        [second.orderId, 'pending'],
      ])
      expect(shop.created[1]?.idempotenceKey).not.toBe(shop.created[0]?.idempotenceKey)
    })

    it('stays as it is while the shop cannot be asked about it', async () => {
      const { shop, deps, userId, plan } = await setup()
      const choice = { userId, planSlug: plan.slug, autoRenew: true }
      const first = await startCheckout(deps, choice)
      const outage = new YookassaError('YooKassa request timed out', { retryable: true })
      shop.failRead(outage)

      await expect(startCheckout(deps, choice)).rejects.toMatchObject({
        code: 'BILLING_PAYMENTS_NOT_CONFIGURED',
        httpStatus: 503,
        cause: outage,
      })

      const orders = await ordersOf(userId)
      expect(orders).toHaveLength(1)
      expect(orders[0]).toMatchObject({ id: first.orderId, status: 'pending' })
      expect(shop.created).toHaveLength(1)
      // Once the shop answers, the same choice gets its page again.
      expect(await startCheckout(deps, choice)).toEqual(first)
    })

    it('that never got a payment is finished with its own key by the same choice', async () => {
      const { shop, deps } = billingTestDeps(db)
      const { userId, workspaceId } = await fixtures.workspace()
      const plan = await fixtures.plan({ isActive: true })
      // The checkout stopped between the order and the payment.
      const interrupted = await fixtures.order({
        workspaceId,
        planId: plan.id,
        status: 'pending',
        userId,
        savePaymentMethod: true,
      })

      const checkout = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })

      expect(checkout.orderId).toBe(interrupted.id)
      expect(shop.created).toHaveLength(1)
      expect(shop.created[0]?.idempotenceKey).toBe(interrupted.idempotenceKey)
      expect(shop.reads).toEqual([])
      const orders = await ordersOf(userId)
      expect(orders).toHaveLength(1)
      expect(orders[0]).toMatchObject({ status: 'pending', yookassaPaymentId: shop.only().id })
    })

    it('that never got a payment is cancelled by another choice', async () => {
      const { shop, deps } = billingTestDeps(db)
      const { userId, workspaceId } = await fixtures.workspace()
      const plan = await fixtures.plan({ isActive: true })
      const interrupted = await fixtures.order({
        workspaceId,
        planId: plan.id,
        status: 'pending',
        userId,
        savePaymentMethod: true,
      })

      const checkout = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })

      expect(checkout.orderId).not.toBe(interrupted.id)
      const orders = await ordersOf(userId)
      expect(orders.map((order) => [order.id, order.status])).toEqual([
        [interrupted.id, 'cancelled'],
        [checkout.orderId, 'pending'],
      ])
      expect(shop.created).toHaveLength(1)
      expect(shop.created[0]?.idempotenceKey).not.toBe(interrupted.idempotenceKey)
    })
  })

  describe('a shop that fails', () => {
    const unavailable = () => new YookassaError('YooKassa request timed out', { retryable: true })

    it('is asked once more with the same key after a failure with an unknown outcome', async () => {
      const { shop, deps, userId, plan } = await setup()
      // The payment was made; only the answer was lost.
      shop.failCreate(unavailable(), { processed: true })

      const checkout = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true })

      expect(shop.created).toHaveLength(2)
      expect(shop.created[1]).toEqual(shop.created[0])
      // One payment, not two.
      const payment = shop.only()
      expect(checkout.confirmationUrl).toBe(payment.confirmation?.confirmation_url)
      expect((await ordersOf(userId))[0]).toMatchObject({
        status: 'pending',
        yookassaPaymentId: payment.id,
      })
    })

    it.each([
      [
        'does not answer twice',
        () => [unavailable(), new YookassaApiError('internal_server_error', 500, undefined, {})],
        2,
        'checkout_unavailable',
      ],
      [
        'refuses the request',
        () => [
          new YookassaApiError(
            'invalid_request: Сумма платежа слишком мала',
            400,
            'invalid_request',
            {
              description: 'Сумма платежа слишком мала',
            },
          ),
        ],
        1,
        'checkout_rejected',
      ],
      [
        'breaks in an unexpected way',
        () => [new TypeError('fetch is broken')],
        1,
        'checkout_rejected',
      ],
    ])(
      'that %s fails the order and tells the customer nothing of its own',
      async (_name, errors, calls, reason) => {
        const { shop, deps, userId, plan } = await setup()
        const failures = errors()
        for (const error of failures) shop.failCreate(error)
        const choice = { userId, planSlug: plan.slug, autoRenew: true }

        const failure = await startCheckout(deps, choice).catch((error: unknown) => error)

        expect(failure).toMatchObject({
          name: 'DomainError',
          code: 'BILLING_PAYMENTS_NOT_CONFIGURED',
          httpStatus: 503,
          // The customer's text is chosen by the code; what the shop said stays in the cause.
          message: 'Payments are not configured',
          cause: failures.at(-1),
        })
        expect(shop.created).toHaveLength(calls)
        expect(new Set(shop.created.map((request) => request.idempotenceKey)).size).toBe(1)
        const orders = await ordersOf(userId)
        expect(orders).toHaveLength(1)
        expect(orders[0]).toMatchObject({
          status: 'failed',
          failureReason: reason,
          yookassaPaymentId: null,
        })
        expect(await syncOrder(deps, { userId, orderId: orders[0]?.id ?? '' })).toMatchObject({
          status: 'failed',
          failureText: 'Не удалось начать оплату. Попробуйте ещё раз позже.',
          refundNeeded: false,
        })

        // The failed order does not stand in the way of the next try, which gets a key of its own.
        const checkout = await startCheckout(deps, choice)
        expect(checkout.orderId).not.toBe(orders[0]?.id)
        expect(shop.created.at(-1)?.idempotenceKey).not.toBe(shop.created[0]?.idempotenceKey)
      },
    )

    it('does not fail an order that another request gave a payment meanwhile', async () => {
      const { shop, deps } = billingTestDeps(db)
      const { userId, workspaceId } = await fixtures.workspace()
      const plan = await fixtures.plan({ isActive: true })
      const choice = { userId, planSlug: plan.slug, autoRenew: true }
      const interrupted = await fixtures.order({
        workspaceId,
        planId: plan.id,
        status: 'pending',
        userId,
        savePaymentMethod: true,
      })
      // Two requests finish the same order with its key. The other one got the payment and
      // stored it; this one hears nothing from the shop, twice.
      const racing: BillingDeps = {
        ...deps,
        yookassa: {
          getPayment: (id) => deps.yookassa.getPayment(id),
          async createPayment(input, key) {
            const payment = await deps.yookassa.createPayment(input, key)
            await db.order.update({
              where: { id: interrupted.id },
              data: { yookassaPaymentId: payment.id },
            })
            throw unavailable()
          },
        },
      }

      await expect(startCheckout(racing, choice)).rejects.toMatchObject({
        code: 'BILLING_PAYMENTS_NOT_CONFIGURED',
      })

      // The customer of the other request holds a page to pay on: the order stays theirs.
      const payment = shop.only()
      expect(await ordersOf(userId)).toMatchObject([
        {
          id: interrupted.id,
          status: 'pending',
          failureReason: null,
          yookassaPaymentId: payment.id,
        },
      ])
      expect(await startCheckout(deps, choice)).toEqual({
        orderId: interrupted.id,
        confirmationUrl: payment.confirmation?.confirmation_url,
      })
    })

    it('does not hand out the page of an order that was closed while its payment was made', async () => {
      const { shop, deps, userId, plan } = await setup()
      // A checkout of another choice cancels the order while the shop creates its payment.
      const racing: BillingDeps = {
        ...deps,
        yookassa: {
          getPayment: (id) => deps.yookassa.getPayment(id),
          async createPayment(input, key) {
            const payment = await deps.yookassa.createPayment(input, key)
            await db.order.updateMany({
              where: { idempotenceKey: key, status: 'pending' },
              data: { status: 'cancelled' },
            })
            return payment
          },
        },
      }

      await expect(
        startCheckout(racing, { userId, planSlug: plan.slug, autoRenew: true }),
      ).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 })

      // A payment nobody waits for is not put on the closed order, and nobody is sent to pay it.
      expect(shop.payments.size).toBe(1)
      expect(await ordersOf(userId)).toMatchObject([
        { status: 'cancelled', yookassaPaymentId: null, failureReason: null },
      ])
    })

    it('that cancels the payment at once declines the checkout with the reason', async () => {
      const { shop, deps, userId, plan } = await setup()
      shop.createAs({
        status: 'canceled',
        confirmation: undefined,
        cancellation_details: { party: 'yoo_money', reason: 'fraud_suspected' },
      })

      await expect(
        startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true }),
      ).rejects.toMatchObject({ code: 'BILLING_PAYMENT_DECLINED', httpStatus: 402 })

      const orders = await ordersOf(userId)
      expect(orders).toHaveLength(1)
      expect(orders[0]).toMatchObject({
        status: 'failed',
        failureReason: 'fraud_suspected',
        yookassaPaymentId: shop.only().id,
      })
    })

    it('that takes the money at once switches the tariff on and refuses the checkout', async () => {
      const { shop, deps, userId, plan } = await setup()
      // No page to pay on, and the payment is already made.
      shop.createAs({
        status: 'succeeded',
        paid: true,
        confirmation: undefined,
        captured_at: '2026-10-04T09:30:00.000Z',
      })

      // The tariff is on: its page shows it after a refresh, there is nowhere to send the
      // customer to pay.
      await expect(
        startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false }),
      ).rejects.toMatchObject({ code: 'BILLING_SUBSCRIPTION_EXISTS', httpStatus: 409 })

      const orders = await ordersOf(userId)
      expect(orders).toMatchObject([{ status: 'paid', yookassaPaymentId: shop.only().id }])
      expect(await db.subscription.count({ where: { workspaceId: orders[0]?.workspaceId } })).toBe(
        1,
      )
    })

    it('that answers with a page outside http is not trusted with the customer', async () => {
      const { shop, deps, userId, plan } = await setup()
      shop.createAs({
        confirmation: { type: 'redirect', confirmation_url: 'javascript:alert(1)' },
      })

      await expect(
        startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true }),
      ).rejects.toMatchObject({ code: 'BILLING_PAYMENTS_NOT_CONFIGURED' })

      // The payment is stored and may still be paid: its outcome decides the order.
      expect((await ordersOf(userId))[0]).toMatchObject({
        status: 'pending',
        yookassaPaymentId: shop.only().id,
      })
    })
  })

  describe('the return page', () => {
    it('settles the order when the notification never comes', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      expect(await syncOrder(deps, { userId, orderId })).toEqual({
        orderId,
        status: 'pending',
        kind: 'subscription',
        planName: 'Проверочный',
        packCredits: null,
        amount: '4900.00',
        failureText: null,
        refundNeeded: false,
        subscription: null,
      })
      shop.succeed(shop.only().id, { saved: true, capturedAt: '2026-10-04T09:30:00.000Z' })

      const page = await syncOrder(deps, { userId, orderId })

      expect(page).toEqual({
        orderId,
        status: 'paid',
        kind: 'subscription',
        planName: 'Проверочный',
        packCredits: null,
        amount: '4900.00',
        failureText: null,
        refundNeeded: false,
        subscription: {
          id: expect.any(String),
          status: 'active',
          plan: {
            id: plan.id,
            slug: plan.slug,
            name: 'Проверочный',
            price: '4900.00',
            creditsPerMonth: 30,
            creditsPerDay: null,
            maxSites: 1,
          },
          period: {
            start: new Date('2026-10-04T09:30:00.000Z'),
            end: new Date('2026-11-04T09:30:00.000Z'),
          },
          autoRenewal: true,
          nextPlan: null,
          paymentMethod: { label: 'Карта «Мир» ••\u00a04444' },
          pastDueSince: null,
        },
      })
      const order = await db.order.findUnique({ where: { id: orderId } })
      expect(order).toMatchObject({ status: 'paid', subscriptionId: page.subscription?.id })
      expect(await actionsOf(order?.workspaceId)).toEqual([
        settlementAuditActions.autoRenewalConsent,
        giftAuditActions.grant,
        settlementAuditActions.subscriptionStart,
      ])
      // Asked again, the page shows the same and nothing is applied twice.
      expect(await syncOrder(deps, { userId, orderId })).toEqual(page)
      expect(await db.creditLedger.count({ where: { orderId } })).toBe(1)
    })

    it('shows the order as stored while the shop cannot be reached', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      shop.succeed(shop.only().id, { saved: true })
      shop.failRead(new YookassaError('YooKassa request timed out', { retryable: true }))

      expect(await syncOrder(deps, { userId, orderId })).toMatchObject({
        status: 'pending',
        subscription: null,
      })
      // The next poll reads the payment.
      expect(await syncOrder(deps, { userId, orderId })).toMatchObject({ status: 'paid' })
    })

    it('does not hide a failure that asking again will not cure', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      const refused = new YookassaApiError('invalid_credentials', 401, 'invalid_credentials', {})
      shop.failRead(refused)

      await expect(syncOrder(deps, { userId, orderId })).rejects.toBe(refused)
      expect(await db.order.findUnique({ where: { id: orderId } })).toMatchObject({
        status: 'pending',
      })
    })

    it('shows an order whose payment the shop does not know as cancelled', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      // Another shop, or a fake that was restarted: GET /payments/{id} answers 404, and nobody
      // can pay the order any more.
      shop.payments.clear()

      const page = await syncOrder(deps, { userId, orderId })

      expect(page).toEqual({
        orderId,
        status: 'cancelled',
        kind: 'subscription',
        planName: 'Проверочный',
        packCredits: null,
        amount: '4900.00',
        failureText: null,
        refundNeeded: false,
        subscription: null,
      })
      expect(await db.order.findUnique({ where: { id: orderId } })).toMatchObject({
        status: 'cancelled',
        failureReason: null,
        paidAt: null,
      })
      // The closed order is shown the same on every later poll.
      expect(await syncOrder(deps, { userId, orderId })).toEqual(page)
      expect(await db.auditLog.count({ where: { targetId: orderId } })).toBe(0)
    })

    it('does not show an order of another user', async () => {
      const { shop, deps, userId, plan } = await setup()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: true,
      })
      shop.succeed(shop.only().id, { saved: true })
      const reads = shop.reads.length
      const stranger = await fixtures.workspace()
      const newcomer = await fixtures.user()

      for (const other of [stranger.userId, newcomer.userId]) {
        await expect(syncOrder(deps, { userId: other, orderId })).rejects.toMatchObject({
          code: 'BILLING_ORDER_NOT_FOUND',
          httpStatus: 404,
        })
      }
      await expect(syncOrder(deps, { userId, orderId: ORDER })).rejects.toMatchObject({
        code: 'BILLING_ORDER_NOT_FOUND',
      })

      // A stranger's question settles nothing and asks the shop nothing.
      expect(shop.reads).toHaveLength(reads)
      expect(await db.order.findUnique({ where: { id: orderId } })).toMatchObject({
        status: 'pending',
      })
      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })
    })
  })
})
