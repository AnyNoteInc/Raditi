import { createPrismaClient, findPersonalWorkspace, type Prisma, type PrismaClient } from '@repo/db'
import type { ChargeSavedInput } from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { startCheckout, startPackCheckout, startPastDuePayment } from './checkout.ts'
import type { BillingDeps } from './deps.ts'
import { grantTariffCredits } from './ledger.ts'
import { startPaymentMethodChange, type PaymentMethodDeps } from './payment-method.ts'
import { getPlanOverview } from './read-models.ts'
import { chargeRenewals, endPeriods, sendRenewalNotices, type RenewalDeps } from './renewal.ts'
import { isRenewalOrder, renewalKey } from './renewal-order.ts'
import { settleOrder, settlementAuditActions } from './settlement.ts'
import { resumeAutoRenew } from './subscription-changes.ts'
import {
  billingFixtures,
  billingTestDeps,
  paymentMethodTestDeps,
  TEST_APP_URL,
  TEST_NOW,
} from './testing.ts'

// The switch of autopayments (YOOKASSA_AUTOPAYMENTS, `BillingDeps.autopayments`). Off, the shop
// takes one-time payments only: ЮKassa answers 403 to a payment that asks to save its method
// until its manager approves autopayments for the shop (seen on a real shop, AnyNote
// 13.05.2026). So nothing asks for it: every payment with a page leaves `save_payment_method`
// out, and whatever would need a saved method is refused before the shop is asked. On — the
// state every other test of the package stands in — the field is sent explicitly, `true` or
// `false`: checkout.test.ts, pack.test.ts and past-due.test.ts hold those requests.

const databaseUrl = process.env.DATABASE_URL
const USER = '0199a000-0000-7000-8000-0000000000f6'

const UNAVAILABLE = { code: 'BILLING_AUTO_RENEWAL_UNAVAILABLE', httpStatus: 409 }

describe('a shop without autopayments, without a database', () => {
  // Nothing but the switch: reaching the database or the shop would throw a TypeError on the
  // missing client.
  const deps = { autopayments: false } as BillingDeps & PaymentMethodDeps

  it('refuses the consent to auto-renewal at checkout before anything is read', async () => {
    await expect(
      startCheckout(deps, { userId: USER, planSlug: 'start', autoRenew: true }),
    ).rejects.toMatchObject(UNAVAILABLE)
  })

  it('refuses to bind a card before anything is read', async () => {
    await expect(startPaymentMethodChange(deps, { userId: USER })).rejects.toMatchObject(
      UNAVAILABLE,
    )
  })

  it('refuses to switch auto-renewal on before anything is read', async () => {
    await expect(resumeAutoRenew(deps, { userId: USER })).rejects.toMatchObject(UNAVAILABLE)
  })

  it('lets a checkout without the consent through to the database', async () => {
    await expect(
      startCheckout(deps, { userId: USER, planSlug: 'start', autoRenew: false }),
    ).rejects.toBeInstanceOf(TypeError)
  })

  it('refuses nothing while autopayments are on', async () => {
    const on = { autopayments: true } as BillingDeps & PaymentMethodDeps
    await expect(
      startCheckout(on, { userId: USER, planSlug: 'start', autoRenew: true }),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(startPaymentMethodChange(on, { userId: USER })).rejects.toBeInstanceOf(TypeError)
    await expect(resumeAutoRenew(on, { userId: USER })).rejects.toBeInstanceOf(TypeError)
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL: a shop without autopayments', () => {
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

  const CARD = {
    paymentMethodId: 'pm-saved-before',
    paymentMethodTitle: 'Bank card *1111',
    paymentMethodType: 'bank_card',
    paymentMethodCardType: 'Visa',
    paymentMethodLast4: '1111',
  }
  const SWITCHED_OFF = { cancelAtPeriodEnd: true, cancelledAt: TEST_NOW }

  /** The scripted shop of a payment with a page, with the switch off. */
  function off() {
    const { shop, deps } = billingTestDeps(db)
    return { shop, deps: { ...deps, autopayments: false } satisfies BillingDeps }
  }

  /** A user without a workspace and a tariff of their own on sale. */
  async function newcomer() {
    const { userId, email } = await fixtures.user()
    emails.push(email)
    const plan = await fixtures.plan({ isActive: true })
    return { userId, plan }
  }

  /** A customer on a tariff of their own, with the quota of its period granted. */
  async function subscribed(patch: Partial<Prisma.SubscriptionUncheckedCreateInput> = {}) {
    const { userId, workspaceId } = await fixtures.workspace()
    const { email } = await db.user.findUniqueOrThrow({ where: { id: userId } })
    emails.push(email)
    const plan = await fixtures.plan()
    const subscription = await fixtures.subscription({ workspaceId, planId: plan.id, ...patch })
    const first = await fixtures.order({
      workspaceId,
      planId: plan.id,
      userId,
      subscriptionId: subscription.id,
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
    })
    await db.$transaction((tx) =>
      grantTariffCredits(tx, { workspaceId, orderId: first.id, credits: 30 }),
    )
    return { userId, workspaceId, plan, subscriptionId: subscription.id }
  }

  const subscriptionOf = (subscriptionId: string) =>
    db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })

  describe('what a payment with a page asks of the shop', () => {
    it('leaves save_payment_method out of the first payment of a tariff', async () => {
      const { userId, plan } = await newcomer()
      const { shop, deps } = off()

      const checkout = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })

      const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
      const order = await db.order.findUniqueOrThrow({ where: { id: checkout.orderId } })
      expect(order).toMatchObject({ status: 'pending', savePaymentMethod: false })
      const [request, ...others] = shop.created
      expect(others).toEqual([])
      // Not `false`: the field is not there at all, the form a real shop without the approval
      // took. Strictly: an `undefined` in its place would be told from an absent key too.
      expect(request?.input).not.toHaveProperty('save_payment_method')
      expect(request).toStrictEqual({
        idempotenceKey: order.idempotenceKey,
        input: {
          amount: { value: '4900.00', currency: 'RUB' },
          capture: true,
          confirmation: {
            type: 'redirect',
            return_url: `${TEST_APP_URL}/settings/billing/return?order=${order.id}`,
          },
          description: 'Радити: тариф «Проверочный» на месяц',
          metadata: { order_id: order.id, workspace_id: workspace?.id },
        },
      })
      expect(checkout.confirmationUrl).toBe(shop.only().confirmation?.confirmation_url)
    })

    it('leaves it out of a pack', async () => {
      const s = await subscribed()
      const { shop, deps } = off()

      const checkout = await startPackCheckout(deps, { userId: s.userId })

      const order = await db.order.findUniqueOrThrow({ where: { id: checkout.orderId } })
      expect(order).toMatchObject({ kind: 'pack', status: 'pending', savePaymentMethod: false })
      expect(shop.created).toHaveLength(1)
      expect(shop.created[0]?.input).not.toHaveProperty('save_payment_method')
      expect(shop.created[0]?.input).toMatchObject({
        capture: true,
        metadata: { order_id: order.id, workspace_id: s.workspaceId },
      })
    })

    it.each([
      ['auto-renewal is on and a card is saved', CARD],
      ['auto-renewal is off', { ...CARD, ...SWITCHED_OFF }],
      ['no card was ever saved', SWITCHED_OFF],
    ])(
      'leaves it out of the payment by hand of an overdue tariff when %s',
      async (_case, patch) => {
        const s = await subscribed({ status: 'past_due', pastDueSince: TEST_NOW, ...patch })
        const { shop, deps } = off()

        const checkout = await startPastDuePayment(deps, { userId: s.userId })

        // The order records that nothing of this payment is kept, whatever the consent says:
        // a method the buyer saves on the page of the shop is then never stored.
        expect(await db.order.findUniqueOrThrow({ where: { id: checkout.orderId } })).toMatchObject(
          { subscriptionId: s.subscriptionId, status: 'pending', savePaymentMethod: false },
        )
        expect(shop.created).toHaveLength(1)
        expect(shop.created[0]?.input).not.toHaveProperty('save_payment_method')
      },
    )

    it('gives the same page again without the field when the checkout is repeated', async () => {
      const { userId, plan } = await newcomer()
      const { shop, deps } = off()
      const input = { userId, planSlug: plan.slug, autoRenew: false }

      const first = await startCheckout(deps, input)
      const second = await startCheckout(deps, input)

      expect(second).toEqual(first)
      expect(shop.created).toHaveLength(1)
    })
  })

  describe('what needs a saved method is refused, and the shop is not asked', () => {
    it('refuses the consent at checkout: no workspace, no order, no request', async () => {
      const { userId, plan } = await newcomer()
      const { shop, deps } = off()

      await expect(
        startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true }),
      ).rejects.toMatchObject(UNAVAILABLE)

      expect(shop.created).toEqual([])
      expect(shop.reads).toEqual([])
      expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toBeNull()
      expect(await db.order.count({ where: { userId } })).toBe(0)
    })

    it('refuses it whatever else is wrong with the checkout', async () => {
      const { userId } = await newcomer()
      const { shop, deps } = off()

      // No such tariff: the customer is told of the consent first, which no tariff would take.
      await expect(
        startCheckout(deps, { userId, planSlug: 'no-such-plan', autoRenew: true }),
      ).rejects.toMatchObject(UNAVAILABLE)
      expect(shop.created).toEqual([])
    })

    it('then sells the same tariff without the consent', async () => {
      const { userId, plan } = await newcomer()
      const { shop, deps } = off()
      await expect(
        startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: true }),
      ).rejects.toMatchObject(UNAVAILABLE)

      const checkout = await startCheckout(deps, { userId, planSlug: plan.slug, autoRenew: false })

      expect(shop.created).toHaveLength(1)
      expect(await db.order.findMany({ where: { userId } })).toMatchObject([
        { id: checkout.orderId, status: 'pending', savePaymentMethod: false },
      ])
    })

    it.each([
      ['a tariff without a saved card', SWITCHED_OFF],
      ['a tariff with a saved card', CARD],
    ])('refuses to bind a card to %s', async (_case, patch) => {
      const s = await subscribed(patch)
      const { shop, deps } = paymentMethodTestDeps(db)
      const before = await subscriptionOf(s.subscriptionId)

      await expect(
        startPaymentMethodChange({ ...deps, autopayments: false }, { userId: s.userId }),
      ).rejects.toMatchObject(UNAVAILABLE)

      expect(shop.created).toEqual([])
      expect(await subscriptionOf(s.subscriptionId)).toEqual(before)
      expect(await db.auditLog.count({ where: { workspaceId: s.workspaceId } })).toBe(0)
    })

    it.each([
      // With a saved card nothing would be asked of the shop today — but the charge at the end
      // of the period would be, and a shop without autopayments refuses it.
      ['with the saved card', { ...CARD, ...SWITCHED_OFF }],
      ['through the binding of a card', SWITCHED_OFF],
    ])('refuses to switch auto-renewal on %s', async (_case, patch) => {
      const s = await subscribed(patch)
      const { shop, deps } = paymentMethodTestDeps(db)
      const before = await subscriptionOf(s.subscriptionId)

      await expect(
        resumeAutoRenew({ ...deps, autopayments: false }, { userId: s.userId }),
      ).rejects.toMatchObject(UNAVAILABLE)

      expect(shop.created).toEqual([])
      expect(await subscriptionOf(s.subscriptionId)).toEqual(before)
      expect(before).toMatchObject({ cancelAtPeriodEnd: true })
      expect(await db.auditLog.count({ where: { workspaceId: s.workspaceId } })).toBe(0)
    })

    it('refuses to switch it on for an overdue tariff and for a user without one as well', async () => {
      const overdue = await subscribed({ status: 'past_due', pastDueSince: TEST_NOW, ...CARD })
      const { userId: stranger } = await fixtures.user()
      const { deps } = paymentMethodTestDeps(db)

      // The switch is told first: what the page behind the request shows is out of date anyway.
      for (const userId of [overdue.userId, stranger]) {
        await expect(
          resumeAutoRenew({ ...deps, autopayments: false }, { userId }),
        ).rejects.toMatchObject(UNAVAILABLE)
        await expect(
          startPaymentMethodChange({ ...deps, autopayments: false }, { userId }),
        ).rejects.toMatchObject(UNAVAILABLE)
      }
    })
  })

  // The passes look at every due row of the database: these tests stand in 2018, where nothing
  // another suite writes to a shared database is due.
  describe('the tariff after its payment', () => {
    const PAID_AT = '2018-03-10T09:00:00.000Z'
    const PERIOD_END = new Date('2018-04-10T09:00:00.000Z')

    /** The scheduler of core at a moment, with a shop that records every charge it is asked for. */
    function scheduler(at: string, shop: ReturnType<typeof billingTestDeps>['shop']) {
      const charges: ChargeSavedInput[] = []
      const deps: RenewalDeps = {
        prisma: db,
        yookassa: {
          ...shop.client,
          chargeWithSavedMethod(input) {
            charges.push(structuredClone(input))
            return Promise.reject(new Error('No charge is expected in this test'))
          },
        },
        appUrl: TEST_APP_URL,
        now: () => new Date(at),
        settings: { noticeDays: 3, pastDueDays: 7 },
      }
      return { deps, charges }
    }

    it('bought without auto-renewal, ends with its period: nothing is saved, nothing is charged', async () => {
      const { userId, plan } = await newcomer()
      const { shop, deps } = off()
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      // The field was left out, so the page of ЮKassa may have offered the buyer to save the
      // card, and the buyer may have agreed: the shop reports a saved method nobody asked for.
      shop.succeed(shop.only().id, { saved: true, capturedAt: PAID_AT })

      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })

      const workspace = await findPersonalWorkspace(db, { userId, appEnv: 'test' })
      const workspaceId = workspace?.id ?? ''
      const [subscription, ...others] = await db.subscription.findMany({ where: { workspaceId } })
      expect(others).toEqual([])
      expect(subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: new Date(PAID_AT),
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: true,
        paymentMethodId: null,
        paymentMethodTitle: null,
        paymentMethodType: null,
        paymentMethodCardType: null,
        paymentMethodLast4: null,
        pendingPaymentMethodId: null,
      })
      expect((await getPlanOverview(db, workspaceId)).subscription).toMatchObject({
        autoRenewal: false,
        paymentMethod: null,
      })
      // No consent was given, so none is recorded.
      const actions = (await db.auditLog.findMany({ where: { workspaceId } })).map(
        (entry) => entry.action,
      )
      expect(actions).toContain(settlementAuditActions.subscriptionStart)
      expect(actions).not.toContain(settlementAuditActions.autoRenewalConsent)

      // Three days before the end, at the end and after it: no notice of a charge, no charge.
      for (const at of ['2018-04-07T09:01:00.000Z', '2018-04-10T08:59:00.000Z']) {
        const before = scheduler(at, shop)
        expect((await sendRenewalNotices(before.deps)).counts.notified).toBe(0)
        expect((await chargeRenewals(before.deps)).counts.renewed).toBe(0)
        expect((await endPeriods(before.deps)).counts.cancelled).toBe(0)
        expect(before.charges).toEqual([])
      }
      const after = scheduler('2018-04-10T09:01:00.000Z', shop)
      await sendRenewalNotices(after.deps)
      await chargeRenewals(after.deps)
      expect((await endPeriods(after.deps)).counts.cancelled).toBe(1)

      expect(after.charges).toEqual([])
      expect(await subscriptionOf(subscription?.id ?? '')).toMatchObject({ status: 'cancelled' })
      const orders = await db.order.findMany({ where: { workspaceId } })
      expect(orders.filter(isRenewalOrder)).toEqual([])
      expect(orders).toMatchObject([{ id: orderId, status: 'paid' }])
    })

    it('paid by hand while overdue, keeps the method saved before and takes no new one', async () => {
      // The switch was turned off after this card had been saved; its charge then failed.
      const START = new Date('2018-02-10T09:00:00.000Z')
      const END = new Date('2018-03-10T09:00:00.000Z')
      const s = await subscribed({
        status: 'past_due',
        currentPeriodStart: START,
        currentPeriodEnd: END,
        periodAnchor: START,
        pastDueSince: new Date('2018-03-10T09:05:00.000Z'),
        renewalNoticePeriodEnd: END,
        ...CARD,
      })
      await fixtures.order({
        workspaceId: s.workspaceId,
        planId: s.plan.id,
        userId: s.userId,
        subscriptionId: s.subscriptionId,
        status: 'failed',
        failureReason: 'insufficient_funds',
        idempotenceKey: renewalKey(s.subscriptionId, END),
        createdAt: END,
      })
      const { shop, deps } = off()

      const { orderId } = await startPastDuePayment(deps, { userId: s.userId })
      // The buyer saved the new card on the page of the shop, unasked.
      shop.succeed(shop.only().id, { saved: true, capturedAt: PAID_AT })
      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })

      // Paid for a month from the payment. Auto-renewal stays as the customer left it, with
      // the card it had: the renewal passes do not read the switch.
      expect(await subscriptionOf(s.subscriptionId)).toMatchObject({
        status: 'active',
        currentPeriodStart: new Date(PAID_AT),
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: false,
        ...CARD,
      })
      const [entry] = await db.auditLog.findMany({
        where: { workspaceId: s.workspaceId, action: settlementAuditActions.pastDuePayment },
      })
      expect(entry?.meta).toMatchObject({ autoRenewal: true, paymentMethodReplaced: false })
    })
  })
})
