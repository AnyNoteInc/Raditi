import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import type { SubscriptionStatus } from '@repo/domain'
import type { ChargeSavedInput } from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import { writeBillingAudit } from './audit.ts'
import { autoRenewalAuditActions, stopAutoRenewalByOperator } from './auto-renewal.ts'
import { grantTariffCredits } from './ledger.ts'
import {
  AUTO_RENEWAL_RESUME_ACTION,
  paymentMethodAuditActions,
  settlePaymentMethod,
  startPaymentMethodChange,
  syncPaymentMethod,
  unlinkPaymentMethod,
  type PaymentMethodDeps,
} from './payment-method.ts'
import { getCreditBalances, getEndedSubscription, getPlanOverview } from './read-models.ts'
import { REFUND_END_REASON } from './refund.ts'
import {
  chargeRenewals,
  endPeriods,
  renewalJobAuditActions,
  sendRenewalNotices,
  type RenewalDeps,
} from './renewal.ts'
import { renewalKey } from './renewal-order.ts'
import { renewalAuditActions, settleOrder } from './settlement.ts'
import {
  cancelAutoRenew,
  cancelPlanChange,
  resumeAutoRenew,
  schedulePlanChange,
  subscriptionChangeAuditActions,
} from './subscription-changes.ts'
import {
  billingFixtures,
  paymentMethodTestDeps,
  TEST_APP_URL,
  TEST_NOW,
  yookassaStub,
} from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const USER = '0199a000-0000-7000-8000-0000000000c2'
const NBSP = String.fromCharCode(0xa0)

describe('the changes of a tariff without a database', () => {
  // Reaching the database or the shop with a refused input would throw a TypeError on the
  // missing client: only the schema throws a ZodError.
  const deps = {} as PaymentMethodDeps

  it.each([
    ['switching auto-renewal off', cancelAutoRenew],
    ['switching auto-renewal on', resumeAutoRenew],
    ['taking a scheduled change back', cancelPlanChange],
  ] as const)('refuses %s for a broken user and anything beside it', async (_case, call) => {
    await expect(call(deps, { userId: 'user' })).rejects.toBeInstanceOf(ZodError)
    await expect(call(deps, {} as { userId: string })).rejects.toBeInstanceOf(ZodError)
    for (const extra of [{ workspaceId: USER }, { subscriptionId: USER }, { planSlug: 'start' }]) {
      await expect(
        call(deps, { userId: USER, ...extra } as { userId: string }),
      ).rejects.toBeInstanceOf(ZodError)
    }
  })

  it('refuses a change of tariff that names no tariff, a broken one or anything beside it', async () => {
    const call = (input: object) =>
      schedulePlanChange(deps, input as { userId: string; planSlug: string })
    for (const input of [
      { userId: USER },
      { userId: USER, planSlug: '' },
      { userId: USER, planSlug: 'p'.repeat(51) },
      { userId: 'user', planSlug: 'start' },
      { userId: USER, planSlug: 'start', planId: USER },
      { userId: USER, planSlug: 'start', autoRenew: true },
    ]) {
      await expect(call(input)).rejects.toBeInstanceOf(ZodError)
    }
  })

  it('names the four changes in the billing namespace, the resume as the binding writes it', () => {
    expect(subscriptionChangeAuditActions).toEqual({
      autoRenewalCancel: 'billing.auto_renewal.cancel',
      autoRenewalResume: 'billing.auto_renewal.resume',
      planChangeSchedule: 'billing.plan_change.schedule',
      planChangeCancel: 'billing.plan_change.cancel',
    })
    expect(subscriptionChangeAuditActions.autoRenewalResume).toBe(AUTO_RENEWAL_RESUME_ACTION)
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL changes of a tariff', () => {
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

  const PERIOD_END = new Date('2026-10-18T09:00:00Z')
  const CARD = {
    paymentMethodId: 'pm-old',
    paymentMethodTitle: 'Bank card *4444',
    paymentMethodType: 'bank_card',
    paymentMethodCardType: 'Mir',
    paymentMethodLast4: '4444',
  }
  const NO_CARD = {
    paymentMethodId: null,
    paymentMethodTitle: null,
    paymentMethodType: null,
    paymentMethodCardType: null,
    paymentMethodLast4: null,
  }
  /** Auto-renewal switched off a day before the tests stand, the card kept. */
  const SWITCHED_OFF = {
    cancelAtPeriodEnd: true,
    cancelledAt: new Date('2026-10-03T12:00:00.000Z'),
  }

  /**
   * A customer on a tariff of their own for September–October 2026 with a saved «Мир» card,
   * auto-renewal on and the notice of the period recorded, unless told otherwise.
   */
  async function subscribed(
    patch: Partial<Prisma.SubscriptionUncheckedCreateInput> = {},
    status: SubscriptionStatus = 'active',
  ) {
    const { userId, workspaceId } = await fixtures.workspace()
    const plan = await fixtures.plan()
    const subscription = await fixtures.subscription({
      workspaceId,
      planId: plan.id,
      status,
      ...CARD,
      renewalNoticePeriodEnd: PERIOD_END,
      ...(status === 'past_due' ? { pastDueSince: new Date('2026-10-18T09:05:00Z') } : {}),
      ...patch,
    })
    return {
      ...paymentMethodTestDeps(db),
      userId,
      workspaceId,
      plan,
      subscriptionId: subscription.id,
      periodEnd: subscription.currentPeriodEnd,
    }
  }
  type Subscribed = Awaited<ReturnType<typeof subscribed>>

  async function written({ workspaceId, subscriptionId }: Subscribed) {
    const audit = await db.auditLog.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return {
      subscription: await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } }),
      audit,
      actions: audit.map((entry) => entry.action),
      entry: (action: string) => audit.filter((entry) => entry.action === action),
    }
  }

  /**
   * The renewal charge of the period, started by the scheduler and without an outcome: its
   * order is pending, with a payment (`at_bank`) or without one (`unanswered`).
   */
  function chargeUnderWay(
    s: Subscribed,
    state: 'at_bank' | 'unanswered',
    data: Partial<Prisma.OrderUncheckedCreateInput> = {},
  ) {
    return fixtures.order({
      workspaceId: s.workspaceId,
      planId: s.plan.id,
      subscriptionId: s.subscriptionId,
      status: 'pending',
      idempotenceKey: renewalKey(s.subscriptionId, s.periodEnd),
      yookassaPaymentId: state === 'at_bank' ? `pay-${s.subscriptionId}` : null,
      ...data,
    })
  }

  const { autoRenewalCancel, autoRenewalResume, planChangeSchedule, planChangeCancel } =
    subscriptionChangeAuditActions
  const { bindStart, bound } = paymentMethodAuditActions

  describe('switching auto-renewal off', () => {
    it('ends the tariff with its period and keeps the saved card', async () => {
      const s = await subscribed()

      const answer = await cancelAutoRenew(s.deps, { userId: s.userId })

      expect(answer).toEqual({ renewalCharge: 'none', periodEnd: PERIOD_END })
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        cancelAtPeriodEnd: true,
        cancelledAt: TEST_NOW,
        // The card stays: with it auto-renewal can be switched back on.
        ...CARD,
        // A tariff that does not renew is neither announced nor charged: the mark is not read.
        renewalNoticePeriodEnd: PERIOD_END,
        currentPeriodEnd: PERIOD_END,
        nextPlanId: null,
      })
      expect((await getPlanOverview(db, s.workspaceId)).subscription).toMatchObject({
        autoRenewal: false,
        paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` },
      })
      expect(state.actions).toEqual([autoRenewalCancel])
      expect(state.audit[0]).toMatchObject({
        actorType: 'user',
        actorId: s.userId,
        workspaceId: s.workspaceId,
        targetType: 'subscription',
        targetId: s.subscriptionId,
        meta: {
          status: 'active',
          periodEnd: PERIOD_END.toISOString(),
          paymentMethodSaved: true,
          renewalCharge: 'none',
        },
      })
    })

    it('needs no shop: the clock and the database are all it is given', async () => {
      const s = await subscribed()

      await cancelAutoRenew({ prisma: db, appEnv: 'test' }, { userId: s.userId })

      const { subscription } = await written(s)
      expect(subscription.cancelAtPeriodEnd).toBe(true)
      expect(Date.now() - (subscription.cancelledAt?.getTime() ?? 0)).toBeLessThan(60_000)
    })

    it('is refused when it is off already, and nothing is written', async () => {
      const s = await subscribed(SWITCHED_OFF)

      await expect(cancelAutoRenew(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_NOTHING_TO_CHANGE',
      })

      const state = await written(s)
      expect(state.subscription.cancelledAt).toEqual(SWITCHED_OFF.cancelledAt)
      expect(state.audit).toEqual([])
    })

    it('is refused a second time: the moment of the first switch stays', async () => {
      const s = await subscribed()
      await cancelAutoRenew(s.deps, { userId: s.userId })

      await expect(
        cancelAutoRenew(
          { ...s.deps, now: () => new Date('2026-10-05T00:00:00Z') },
          { userId: s.userId },
        ),
      ).rejects.toMatchObject({ code: 'BILLING_NOTHING_TO_CHANGE' })

      const state = await written(s)
      expect(state.subscription.cancelledAt).toEqual(TEST_NOW)
      expect(state.actions).toEqual([autoRenewalCancel])
    })

    it('switches off once when two requests race', async () => {
      const s = await subscribed()

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => cancelAutoRenew(s.deps, { userId: s.userId })),
      )

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({ code: 'BILLING_NOTHING_TO_CHANGE' })
        }
      }
      expect((await written(s)).actions).toEqual([autoRenewalCancel])
    })

    it.each([
      ['a user without a workspace', async () => (await fixtures.user()).userId],
      ['a workspace without a tariff', async () => (await fixtures.workspace()).userId],
      ['a tariff that has ended', async () => (await subscribed({}, 'cancelled')).userId],
      ['a tariff that has expired', async () => (await subscribed({}, 'expired')).userId],
    ])('is refused for %s', async (_case, user) => {
      const userId = await user()

      await expect(
        cancelAutoRenew({ prisma: db, appEnv: 'test' }, { userId }),
      ).rejects.toMatchObject({ code: 'BILLING_NO_LIVE_SUBSCRIPTION' })
    })

    it('works for a tariff that waits for its payment: that payment then saves no card', async () => {
      const s = await subscribed({}, 'past_due')

      const answer = await cancelAutoRenew(s.deps, { userId: s.userId })

      expect(answer).toEqual({ renewalCharge: 'none', periodEnd: PERIOD_END })
      const state = await written(s)
      expect(state.subscription).toMatchObject({ status: 'past_due', cancelAtPeriodEnd: true })
      expect(state.audit[0]?.meta).toMatchObject({ status: 'past_due' })
    })

    it('changes the tariff of the customer alone', async () => {
      const s = await subscribed()
      const other = await subscribed()

      await cancelAutoRenew(s.deps, { userId: s.userId })

      expect((await written(other)).subscription.cancelAtPeriodEnd).toBe(false)
      expect((await written(other)).audit).toEqual([])
    })

    it.each(['at_bank', 'unanswered'] as const)(
      'does not stop a renewal charge that is under way (%s) and says where it stands',
      async (charge) => {
        const s = await subscribed()
        await chargeUnderWay(s, charge)

        const answer = await cancelAutoRenew(s.deps, { userId: s.userId })

        expect(answer).toEqual({ renewalCharge: charge, periodEnd: PERIOD_END })
        const state = await written(s)
        expect(state.subscription.cancelAtPeriodEnd).toBe(true)
        expect(state.entry(autoRenewalCancel)[0]?.meta).toMatchObject({ renewalCharge: charge })
        // The order of the charge is not touched.
        expect(await db.order.findMany({ where: { workspaceId: s.workspaceId } })).toMatchObject([
          { status: 'pending' },
        ])
      },
    )

    it('tells of no charge whose order is closed, or which renews another period', async () => {
      const s = await subscribed()
      await chargeUnderWay(s, 'at_bank', { status: 'failed' })
      await chargeUnderWay(s, 'at_bank', {
        idempotenceKey: renewalKey(s.subscriptionId, new Date('2026-09-18T09:00:00Z')),
        yookassaPaymentId: 'pay-of-the-period-before',
        status: 'cancelled',
      })

      expect(await cancelAutoRenew(s.deps, { userId: s.userId })).toMatchObject({
        renewalCharge: 'none',
      })
    })

    it('lets a charge that was at the bank renew the tariff once more, and no further', async () => {
      const s = await subscribed({
        currentPeriodStart: new Date('2017-03-10T09:00:00.000Z'),
        currentPeriodEnd: new Date('2017-04-10T09:00:00.000Z'),
        periodAnchor: new Date('2017-03-10T09:00:00.000Z'),
        renewalNoticePeriodEnd: new Date('2017-04-10T09:00:00.000Z'),
      })
      // The letter about the end of the tariff is removed with the test.
      emails.push((await db.user.findUniqueOrThrow({ where: { id: s.userId } })).email)
      const shop = yookassaStub()
      const order = await chargeUnderWay(s, 'unanswered')
      const payment = await shop.client.createPayment(
        { amount: { value: '4900.00', currency: 'RUB' }, capture: true },
        order.idempotenceKey,
      )
      await db.order.update({ where: { id: order.id }, data: { yookassaPaymentId: payment.id } })

      const answer = await cancelAutoRenew(s.deps, { userId: s.userId })
      shop.succeed(payment.id, { saved: true, capturedAt: '2017-04-10T09:01:00.000Z' })
      await settleOrder({ ...s.deps, yookassa: shop.client }, { orderId: order.id })

      expect(answer.renewalCharge).toBe('at_bank')
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: new Date('2017-04-10T09:00:00.000Z'),
        currentPeriodEnd: new Date('2017-05-10T09:00:00.000Z'),
        cancelAtPeriodEnd: true,
      })
      expect(state.actions).toEqual([autoRenewalCancel, renewalAuditActions.renewed])
      // «Других списаний не будет»: the month that was paid for is the last one.
      const passes: RenewalDeps = {
        prisma: db,
        yookassa: { ...shop.client, chargeWithSavedMethod: () => Promise.reject(new Error('x')) },
        appUrl: TEST_APP_URL,
        now: () => new Date('2017-05-10T09:01:00.000Z'),
        settings: { noticeDays: 3, pastDueDays: 7 },
      }
      expect((await sendRenewalNotices(passes)).counts.notified).toBe(0)
      expect((await chargeRenewals(passes)).counts).toMatchObject({ renewed: 0, failed: 0 })
      expect((await endPeriods(passes)).counts.cancelled).toBe(1)
    })
  })

  describe('switching auto-renewal on with a saved card', () => {
    it('renews the tariff again and has the coming charge announced anew', async () => {
      const s = await subscribed(SWITCHED_OFF)

      const answer = await resumeAutoRenew(s.deps, { userId: s.userId })

      expect(answer).toEqual({ needsPaymentMethod: false, renewalCharge: 'none' })
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        ...CARD,
        pendingPaymentMethodId: null,
        // A charge is made only after a letter that names it: the letter is written again.
        renewalNoticePeriodEnd: null,
      })
      expect((await getPlanOverview(db, s.workspaceId)).subscription?.autoRenewal).toBe(true)
      // Nothing was asked of the shop: the card is there.
      expect(s.shop.created).toEqual([])
      expect(s.shop.reads).toEqual([])
      expect(state.actions).toEqual([autoRenewalResume])
      expect(state.audit[0]).toMatchObject({
        actorType: 'user',
        actorId: s.userId,
        targetType: 'subscription',
        targetId: s.subscriptionId,
        meta: {
          via: 'saved_method',
          paymentMethodId: CARD.paymentMethodId,
          planSlug: s.plan.slug,
          amount: '4900.00',
          periodEnd: PERIOD_END.toISOString(),
          renewalCharge: 'none',
        },
      })
    })

    it('records the tariff and the amount of the coming period when a change is scheduled', async () => {
      const next = await fixtures.plan({ name: 'Больше', price: '12900.00' })
      const s = await subscribed({ ...SWITCHED_OFF, nextPlanId: next.id })

      await resumeAutoRenew(s.deps, { userId: s.userId })

      expect((await written(s)).audit[0]?.meta).toMatchObject({
        planSlug: next.slug,
        amount: '12900.00',
      })
    })

    it('keeps the notice mark while the charge of the period is at the bank: nothing more is charged for it', async () => {
      const s = await subscribed(SWITCHED_OFF)
      await chargeUnderWay(s, 'at_bank')

      const answer = await resumeAutoRenew(s.deps, { userId: s.userId })

      expect(answer).toEqual({ needsPaymentMethod: false, renewalCharge: 'at_bank' })
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        cancelAtPeriodEnd: false,
        renewalNoticePeriodEnd: PERIOD_END,
      })
      expect(state.audit[0]?.meta).toMatchObject({ renewalCharge: 'at_bank' })
    })

    it('clears the mark for a charge without an answer: its repeat is announced again', async () => {
      const s = await subscribed(SWITCHED_OFF)
      await chargeUnderWay(s, 'unanswered')

      const answer = await resumeAutoRenew(s.deps, { userId: s.userId })

      expect(answer).toEqual({ needsPaymentMethod: false, renewalCharge: 'unanswered' })
      expect((await written(s)).subscription).toMatchObject({
        cancelAtPeriodEnd: false,
        renewalNoticePeriodEnd: null,
      })
    })

    it('is refused when auto-renewal is on, and nothing is written', async () => {
      const s = await subscribed()

      await expect(resumeAutoRenew(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_NOTHING_TO_CHANGE',
      })

      const state = await written(s)
      expect(state.subscription.renewalNoticePeriodEnd).toEqual(PERIOD_END)
      expect(state.audit).toEqual([])
    })

    it.each([
      ['with a card', { ...SWITCHED_OFF }],
      ['without one', { ...SWITCHED_OFF, ...NO_CARD }],
    ])('is refused for a tariff that waits for its payment, %s', async (_case, patch) => {
      const s = await subscribed(patch, 'past_due')

      await expect(resumeAutoRenew(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_SUBSCRIPTION_PAST_DUE',
      })

      const state = await written(s)
      expect(state.subscription).toMatchObject({ cancelAtPeriodEnd: true, status: 'past_due' })
      expect(state.audit).toEqual([])
      expect(s.shop.created).toEqual([])
    })

    it.each([
      ['a user without a workspace', async () => (await fixtures.user()).userId],
      ['a workspace without a tariff', async () => (await fixtures.workspace()).userId],
      ['a tariff that has ended', async () => (await subscribed(SWITCHED_OFF, 'cancelled')).userId],
    ])('is refused for %s', async (_case, user) => {
      const userId = await user()
      const { deps, shop } = paymentMethodTestDeps(db)

      await expect(resumeAutoRenew(deps, { userId })).rejects.toMatchObject({
        code: 'BILLING_NO_LIVE_SUBSCRIPTION',
      })
      expect(shop.created).toEqual([])
    })

    it.each([
      ['the card was unlinked', NO_CARD, { code: 'CONFLICT' }],
      [
        'the charge of the tariff was declined',
        { status: 'past_due', pastDueSince: TEST_NOW },
        { code: 'BILLING_SUBSCRIPTION_PAST_DUE' },
      ],
    ] as const)(
      'is refused when %s while the request was on its way, and nothing is switched on',
      async (_case, change, refusal) => {
        const s = await subscribed(SWITCHED_OFF)
        let resuming: Promise<unknown> | undefined

        await db.$transaction(async (other) => {
          // Another request holds the row of the subscription: an unlink, a pass.
          await other.$queryRaw`
            SELECT id FROM subscriptions WHERE id = ${s.subscriptionId}::uuid FOR UPDATE
          `
          resuming = resumeAutoRenew(s.deps, { userId: s.userId }).then(
            () => 'resumed',
            (error: unknown) => error,
          )
          // It has read the tariff as it was — paid for, with a card — and stands at the row.
          const first = await Promise.race([
            resuming,
            new Promise<string>((resolve) => setTimeout(resolve, 500, 'waiting')),
          ])
          expect(first).toBe('waiting')
          await other.subscription.update({ where: { id: s.subscriptionId }, data: change })
        })

        // What it decides by is the row as the other request left it.
        expect(await resuming).toMatchObject(refusal)
        const state = await written(s)
        expect(state.subscription).toMatchObject({
          cancelAtPeriodEnd: true,
          cancelledAt: SWITCHED_OFF.cancelledAt,
        })
        expect(state.entry(autoRenewalResume)).toEqual([])
      },
    )

    it('switches on once when two requests race', async () => {
      const s = await subscribed(SWITCHED_OFF)

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => resumeAutoRenew(s.deps, { userId: s.userId })),
      )

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect((await written(s)).actions).toEqual([autoRenewalResume])
    })

    it('can be switched off and on again, each time with its own entry', async () => {
      const s = await subscribed()

      await cancelAutoRenew(s.deps, { userId: s.userId })
      await resumeAutoRenew(s.deps, { userId: s.userId })
      await cancelAutoRenew(s.deps, { userId: s.userId })

      const state = await written(s)
      expect(state.actions).toEqual([autoRenewalCancel, autoRenewalResume, autoRenewalCancel])
      expect(state.subscription).toMatchObject({ cancelAtPeriodEnd: true, cancelledAt: TEST_NOW })
    })

    it('switches on what an operator switched off at the customer`s request', async () => {
      const s = await subscribed()
      await stopAutoRenewalByOperator(s.deps, {
        workspaceId: s.workspaceId,
        operator: 'ops',
        reason: 'Письмо клиента',
      })

      await resumeAutoRenew(s.deps, { userId: s.userId })

      const state = await written(s)
      expect(state.actions).toEqual([autoRenewalAuditActions.operatorStop, autoRenewalResume])
      expect(state.subscription).toMatchObject({ cancelAtPeriodEnd: false, cancelledAt: null })
    })
  })

  describe('switching auto-renewal on without a saved card', () => {
    /** A tariff bought without the consent: no card, and it does not renew. */
    const withoutCard = { ...NO_CARD, ...SWITCHED_OFF, renewalNoticePeriodEnd: null }

    /** «Включить автопродление»: the id of the method the shop made for the binding. */
    async function resumed(s: Subscribed): Promise<string> {
      const before = new Set(s.shop.methods.keys())
      const answer = await resumeAutoRenew(s.deps, { userId: s.userId })
      const [id, ...others] = [...s.shop.methods.keys()].filter((key) => !before.has(key))
      if (id === undefined || others.length > 0) throw new Error('The resume made no one binding')
      expect(answer).toEqual({
        needsPaymentMethod: true,
        confirmationUrl: s.shop.methods.get(id)?.confirmation?.confirmation_url,
      })
      return id
    }

    it('starts the binding of a card and switches nothing on yet', async () => {
      const s = await subscribed(withoutCard)

      const methodId = await resumed(s)

      expect(s.shop.created).toMatchObject([
        {
          input: {
            type: 'bank_card',
            confirmation: {
              type: 'redirect',
              return_url: `${TEST_APP_URL}/settings/billing/return?method=1`,
            },
            metadata: { subscription_id: s.subscriptionId },
          },
        },
      ])
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        ...NO_CARD,
        cancelAtPeriodEnd: true,
        cancelledAt: SWITCHED_OFF.cancelledAt,
        pendingPaymentMethodId: methodId,
      })
      expect((await getPlanOverview(db, s.workspaceId)).subscription?.autoRenewal).toBe(false)
      // The consent is kept with the binding it was given for.
      expect(state.actions).toEqual([bindStart])
      expect(state.audit[0]).toMatchObject({
        actorType: 'user',
        actorId: s.userId,
        meta: { paymentMethodId: methodId, replaces: false, resumeAutoRenewal: true },
      })
    })

    it('is on when that binding is read back as saved, on a notification', async () => {
      const s = await subscribed(withoutCard)
      const methodId = await resumed(s)
      s.shop.confirm(methodId, { card_type: 'Visa', last4: '1234' })

      const settlement = await settlePaymentMethod(s.deps, { paymentMethodId: methodId })

      expect(settlement).toEqual({
        state: 'active',
        subscriptionId: s.subscriptionId,
        renewalCharge: 'none',
      })
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: methodId,
        paymentMethodCardType: 'Visa',
        paymentMethodLast4: '1234',
        pendingPaymentMethodId: null,
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        renewalNoticePeriodEnd: null,
      })
      expect((await getPlanOverview(db, s.workspaceId)).subscription).toMatchObject({
        autoRenewal: true,
        paymentMethod: { label: `Карта Visa ••${NBSP}1234` },
      })
      expect(state.actions).toEqual([bindStart, bound, autoRenewalResume])
      expect(state.entry(bound)[0]?.meta).toMatchObject({ autoRenewal: true, replaced: false })
      // The notification settled it, and the entry still names the customer who asked.
      expect(state.entry(autoRenewalResume)[0]).toMatchObject({
        actorType: 'user',
        actorId: s.userId,
        targetType: 'subscription',
        targetId: s.subscriptionId,
        meta: {
          via: 'binding',
          paymentMethodId: methodId,
          planSlug: s.plan.slug,
          amount: '4900.00',
          periodEnd: PERIOD_END.toISOString(),
          renewalCharge: 'none',
        },
      })
    })

    it('is on when the return page reads the binding back, and once whoever reads it', async () => {
      const s = await subscribed(withoutCard)
      const methodId = await resumed(s)
      s.shop.confirm(methodId)

      const looks = await Promise.all([
        syncPaymentMethod(s.deps, { userId: s.userId }),
        settlePaymentMethod(s.deps, { paymentMethodId: methodId }),
        syncPaymentMethod(s.deps, { userId: s.userId }),
      ])

      expect(looks[0]).toMatchObject({ state: 'active', subscription: { autoRenewal: true } })
      const state = await written(s)
      expect(state.subscription).toMatchObject({ cancelAtPeriodEnd: false, cancelledAt: null })
      expect(state.entry(bound)).toHaveLength(1)
      expect(state.entry(autoRenewalResume)).toHaveLength(1)
      // Read back again later: nothing more is written.
      await settlePaymentMethod(s.deps, { paymentMethodId: methodId })
      await syncPaymentMethod(s.deps, { userId: s.userId })
      expect((await written(s)).actions).toHaveLength(3)
    })

    it('stays off while the card is not confirmed, and when the customer refuses it', async () => {
      const s = await subscribed(withoutCard)
      const methodId = await resumed(s)

      expect(await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).toMatchObject({
        state: 'pending',
      })
      expect((await written(s)).subscription.cancelAtPeriodEnd).toBe(true)

      s.shop.refuse(methodId)
      expect(await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).toMatchObject({
        state: 'inactive',
      })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        ...NO_CARD,
        cancelAtPeriodEnd: true,
        cancelledAt: SWITCHED_OFF.cancelledAt,
        pendingPaymentMethodId: null,
      })
      expect(state.entry(autoRenewalResume)).toEqual([])
    })

    it('is not switched on by a card that is active and not saved', async () => {
      const s = await subscribed(withoutCard)
      const methodId = await resumed(s)
      s.shop.patch(methodId, { status: 'active', saved: false })

      await settlePaymentMethod(s.deps, { paymentMethodId: methodId })

      expect((await written(s)).subscription).toMatchObject({
        ...NO_CARD,
        cancelAtPeriodEnd: true,
        pendingPaymentMethodId: methodId,
      })
    })

    it('is not switched on by another binding started in its place on «Оплата»', async () => {
      const s = await subscribed(withoutCard)
      const asked = await resumed(s)
      // The customer left the page of that binding and bound a card on «Оплата», which says
      // that a card alone switches nothing on.
      await startPaymentMethodChange(s.deps, { userId: s.userId })
      const plain = [...s.shop.methods.keys()].find((id) => id !== asked) ?? ''
      s.shop.confirm(asked)
      s.shop.confirm(plain, { last4: '1234' })

      expect(await settlePaymentMethod(s.deps, { paymentMethodId: asked })).toEqual({
        state: 'unknown',
      })
      expect(await settlePaymentMethod(s.deps, { paymentMethodId: plain })).toMatchObject({
        state: 'active',
      })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: plain,
        cancelAtPeriodEnd: true,
        cancelledAt: SWITCHED_OFF.cancelledAt,
      })
      expect(state.entry(bound)[0]?.meta).toMatchObject({ autoRenewal: false })
      expect(state.entry(autoRenewalResume)).toEqual([])
      // With the card saved the next «Включить автопродление» needs no page.
      expect(await resumeAutoRenew(s.deps, { userId: s.userId })).toEqual({
        needsPaymentMethod: false,
        renewalCharge: 'none',
      })
    })

    it('is asked of the binding of the very method that is stored, whichever start is recorded last', async () => {
      // Two starts that raced: the entry of one is the newest, the subscription waits for the
      // method of the other. The consent belongs to the method, not to the newest entry.
      const asked = await subscribed(withoutCard)
      const withConsent = await resumed(asked)
      await startPaymentMethodChange(asked.deps, { userId: asked.userId })
      await db.subscription.update({
        where: { id: asked.subscriptionId },
        data: { pendingPaymentMethodId: withConsent },
      })
      asked.shop.confirm(withConsent)

      await settlePaymentMethod(asked.deps, { paymentMethodId: withConsent })

      expect((await written(asked)).subscription).toMatchObject({
        paymentMethodId: withConsent,
        cancelAtPeriodEnd: false,
      })

      const plain = await subscribed(withoutCard)
      await startPaymentMethodChange(plain.deps, { userId: plain.userId })
      const [cardAlone] = [...plain.shop.methods.keys()]
      await resumed(plain)
      await db.subscription.update({
        where: { id: plain.subscriptionId },
        data: { pendingPaymentMethodId: cardAlone },
      })
      plain.shop.confirm(cardAlone ?? '')

      await settlePaymentMethod(plain.deps, { paymentMethodId: cardAlone ?? '' })

      const state = await written(plain)
      expect(state.subscription).toMatchObject({
        paymentMethodId: cardAlone,
        cancelAtPeriodEnd: true,
      })
      expect(state.entry(autoRenewalResume)).toEqual([])
    })

    it('is switched on by the latest of two bindings asked for it', async () => {
      const s = await subscribed(withoutCard)
      const first = await resumed(s)
      const second = await resumed(s)
      s.shop.confirm(first)
      s.shop.confirm(second)

      expect(await settlePaymentMethod(s.deps, { paymentMethodId: first })).toEqual({
        state: 'unknown',
      })
      await settlePaymentMethod(s.deps, { paymentMethodId: second })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: second,
        cancelAtPeriodEnd: false,
      })
      expect(state.entry(autoRenewalResume)).toHaveLength(1)
    })

    it('is forgotten with the binding when the customer unlinks, and by a tariff that ended', async () => {
      const s = await subscribed({ ...withoutCard, ...CARD })
      // A card is there, so the unlink has something to remove; the binding was asked before.
      await db.subscription.update({ where: { id: s.subscriptionId }, data: NO_CARD })
      const methodId = await resumed(s)
      await db.subscription.update({ where: { id: s.subscriptionId }, data: CARD })
      await unlinkPaymentMethod(s.deps, { userId: s.userId })
      s.shop.confirm(methodId)

      expect(await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).toEqual({
        state: 'unknown',
      })
      expect((await written(s)).subscription).toMatchObject({ ...NO_CARD, cancelAtPeriodEnd: true })

      const ended = await subscribed(withoutCard)
      const late = await resumed(ended)
      await db.subscription.update({
        where: { id: ended.subscriptionId },
        data: { status: 'cancelled' },
      })
      ended.shop.confirm(late)
      expect(await settlePaymentMethod(ended.deps, { paymentMethodId: late })).toEqual({
        state: 'unknown',
      })
      expect((await written(ended)).subscription).toMatchObject({
        ...NO_CARD,
        cancelAtPeriodEnd: true,
      })
    })

    it('stays off when the binding that switched it on is read back again after the customer switched it off', async () => {
      const s = await subscribed(withoutCard)
      const methodId = await resumed(s)
      s.shop.confirm(methodId)
      await settlePaymentMethod(s.deps, { paymentMethodId: methodId })
      expect((await written(s)).subscription.cancelAtPeriodEnd).toBe(false)

      // «Отключить автопродление»: the customer changed their mind, the card stays.
      await cancelAutoRenew(s.deps, { userId: s.userId })

      // The notification of the card is delivered again, and the return page is opened again.
      expect(await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).toEqual({
        state: 'unknown',
      })
      expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
        subscription: { autoRenewal: false },
      })
      await Promise.all([
        settlePaymentMethod(s.deps, { paymentMethodId: methodId }),
        syncPaymentMethod(s.deps, { userId: s.userId }),
      ])

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: methodId,
        pendingPaymentMethodId: null,
        cancelAtPeriodEnd: true,
        cancelledAt: TEST_NOW,
      })
      // The consent was used once, by the settlement that stored the card.
      expect(state.actions).toEqual([bindStart, bound, autoRenewalResume, autoRenewalCancel])
      expect((await getPlanOverview(db, s.workspaceId)).subscription?.autoRenewal).toBe(false)
    })

    it('is not switched on by a card bound for it that is confirmed after the customer got and gave up auto-renewal another way', async () => {
      const s = await subscribed(withoutCard)
      // «Включить автопродление» → the page of the card, which the customer leaves open.
      const asked = await resumed(s)
      // A card bound on «Оплата» instead, auto-renewal switched on with it — and off again.
      await startPaymentMethodChange(s.deps, { userId: s.userId })
      const plain = [...s.shop.methods.keys()].find((id) => id !== asked) ?? ''
      s.shop.confirm(plain, { last4: '1234' })
      await settlePaymentMethod(s.deps, { paymentMethodId: plain })
      await resumeAutoRenew(s.deps, { userId: s.userId })
      await cancelAutoRenew(s.deps, { userId: s.userId })

      // Now the customer confirms the card on the page they had left open.
      s.shop.confirm(asked)
      expect(await settlePaymentMethod(s.deps, { paymentMethodId: asked })).toEqual({
        state: 'unknown',
      })
      await syncPaymentMethod(s.deps, { userId: s.userId })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: plain,
        cancelAtPeriodEnd: true,
        cancelledAt: TEST_NOW,
      })
      // One resume — the customer's own, with the saved card — and nothing after the switch off.
      expect(state.entry(autoRenewalResume)).toMatchObject([{ meta: { via: 'saved_method' } }])
      expect(state.actions.at(-1)).toBe(autoRenewalCancel)
    })

    it('is switched on by nothing once the tariff has ended with its period: the card is not stored either', async () => {
      // The passes look at every due row of the database: this one stands in 2016.
      const START = new Date('2016-06-10T09:00:00.000Z')
      const END = new Date('2016-07-10T09:00:00.000Z')
      const s = await subscribed({
        ...withoutCard,
        currentPeriodStart: START,
        currentPeriodEnd: END,
        periodAnchor: START,
      })
      const { email } = await db.user.findUniqueOrThrow({ where: { id: s.userId } })
      emails.push(email)
      const clock = { now: new Date('2016-07-10T08:55:00.000Z') }
      const deps = { ...s.deps, now: () => clock.now }
      const passes: RenewalDeps = {
        prisma: db,
        yookassa: {
          ...yookassaStub().client,
          chargeWithSavedMethod: () =>
            Promise.reject(new Error('A tariff without a saved card is not charged')),
        },
        appUrl: TEST_APP_URL,
        now: () => clock.now,
        settings: { noticeDays: 3, pastDueDays: 7 },
      }

      // Five minutes before the end: «Включить автопродление», and the page of the card.
      const methodId = await resumed({ ...s, deps })
      expect((await endPeriods(passes)).counts.cancelled).toBe(0)

      // The period ends while the customer is on that page: nothing renews, the tariff is over.
      clock.now = new Date('2016-07-10T09:01:00.000Z')
      expect((await sendRenewalNotices(passes)).counts.notified).toBe(0)
      expect((await chargeRenewals(passes)).counts.renewed).toBe(0)
      expect((await endPeriods(passes)).counts.cancelled).toBe(1)

      s.shop.confirm(methodId)
      expect(await settlePaymentMethod(deps, { paymentMethodId: methodId })).toEqual({
        state: 'unknown',
      })
      await syncPaymentMethod(deps, { userId: s.userId })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'cancelled',
        ...NO_CARD,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: END,
      })
      expect(state.entry(autoRenewalResume)).toEqual([])
      expect(state.entry(bound)).toEqual([])
      expect(await getPlanOverview(db, s.workspaceId)).toEqual({ subscription: null })
      expect(await getEndedSubscription(db, s.workspaceId)).toMatchObject({
        reason: 'not_renewed',
        endedAt: END,
      })
      // The letter names the end of the paid period as well, not the minute the pass ran.
      const letters = await db.outboxEvent.findMany({
        where: { topic: 'notifications', payload: { path: ['to'], equals: email } },
      })
      expect(letters.map((letter) => [letter.type, letter.payload])).toMatchObject([
        ['billing.subscription_ended', { endedAt: END.toISOString() }],
      ])
      // A pass later charges nobody.
      clock.now = new Date('2016-07-11T09:00:00.000Z')
      expect((await chargeRenewals(passes)).counts.renewed).toBe(0)
    })

    it('saves the card and leaves auto-renewal off for a tariff that became overdue meanwhile', async () => {
      const s = await subscribed(withoutCard)
      const methodId = await resumed(s)
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { status: 'past_due', pastDueSince: TEST_NOW },
      })
      s.shop.confirm(methodId)

      await settlePaymentMethod(s.deps, { paymentMethodId: methodId })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: methodId,
        cancelAtPeriodEnd: true,
        status: 'past_due',
      })
      expect(state.entry(autoRenewalResume)).toEqual([])
    })

    it('answers that payments are unavailable when the shop gives no page, and stays off', async () => {
      const s = await subscribed(withoutCard)
      s.shop.createAs({ status: 'inactive' })

      await expect(resumeAutoRenew(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_PAYMENTS_NOT_CONFIGURED',
      })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        cancelAtPeriodEnd: true,
        pendingPaymentMethodId: null,
      })
      expect(state.audit).toEqual([])
    })

    it('is charged at the end of the period only after the binding settled and its notice went out', async () => {
      const START = new Date('2017-03-10T09:00:00.000Z')
      const END = new Date('2017-04-10T09:00:00.000Z')
      const s = await subscribed({
        ...withoutCard,
        currentPeriodStart: START,
        currentPeriodEnd: END,
        periodAnchor: START,
      })
      const { email } = await db.user.findUniqueOrThrow({ where: { id: s.userId } })
      emails.push(email)
      const shop = yookassaStub()
      const charges: ChargeSavedInput[] = []
      const clock = { now: new Date('2017-04-08T09:00:00.000Z') }
      const passes: RenewalDeps = {
        prisma: db,
        yookassa: {
          ...shop.client,
          async chargeWithSavedMethod(input, idempotenceKey) {
            charges.push(structuredClone(input))
            const { id } = await shop.client.createPayment(
              { ...input, capture: true },
              idempotenceKey,
            )
            shop.succeed(id, { saved: true, capturedAt: END.toISOString() })
            return shop.client.getPayment(id)
          },
        },
        appUrl: TEST_APP_URL,
        now: () => clock.now,
        settings: { noticeDays: 3, pastDueDays: 7 },
      }
      const deps = { ...s.deps, now: () => clock.now }

      // Asked for, the card not yet confirmed: nobody is told of a charge.
      const methodId = await resumed({ ...s, deps })
      expect((await sendRenewalNotices(passes)).counts.notified).toBe(0)

      s.shop.confirm(methodId, { card_type: 'Visa', last4: '1234' })
      await settlePaymentMethod(deps, { paymentMethodId: methodId })
      expect((await sendRenewalNotices(passes)).counts.notified).toBe(1)
      const letters = await db.outboxEvent.findMany({
        where: { topic: 'notifications', payload: { path: ['to'], equals: email } },
      })
      expect(letters.map((letter) => [letter.type, letter.payload])).toMatchObject([
        [
          'billing.renewal_notice',
          { amount: '4900.00', paymentMethod: `Карта Visa ••${NBSP}1234` },
        ],
      ])

      clock.now = new Date('2017-04-10T09:01:00.000Z')
      expect((await chargeRenewals(passes)).counts.renewed).toBe(1)
      expect(charges).toMatchObject([{ payment_method_id: methodId }])
      expect((await written(s)).subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: END,
        cancelAtPeriodEnd: false,
      })
    })
  })

  describe('a change of tariff scheduled for the next period', () => {
    /** Another tariff on sale: bigger and dearer than the customer's, for three sites. */
    const bigger = (data: Parameters<typeof fixtures.plan>[0] = {}) =>
      fixtures.plan({
        isActive: true,
        name: 'Больше',
        price: '12900.00',
        creditsPerMonth: 80,
        tasksPerDay: 10,
        maxSites: 3,
        ...data,
      })

    it('is recorded for the next period, changes nothing today and asks for a new notice', async () => {
      const s = await subscribed()
      const next = await bigger()

      const subscription = await schedulePlanChange(s.deps, {
        userId: s.userId,
        planSlug: next.slug,
      })

      expect(subscription).toMatchObject({
        id: s.subscriptionId,
        status: 'active',
        plan: { id: s.plan.id },
        nextPlan: { id: next.id, slug: next.slug, price: '12900.00', creditsPerMonth: 80 },
        period: { end: PERIOD_END },
        autoRenewal: true,
      })
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        planId: s.plan.id,
        nextPlanId: next.id,
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: false,
        ...CARD,
        // The letter before the charge has to name the new amount.
        renewalNoticePeriodEnd: null,
      })
      expect(state.actions).toEqual([planChangeSchedule])
      expect(state.audit[0]).toMatchObject({
        actorType: 'user',
        actorId: s.userId,
        workspaceId: s.workspaceId,
        targetType: 'subscription',
        targetId: s.subscriptionId,
        meta: {
          fromPlanSlug: s.plan.slug,
          toPlanSlug: next.slug,
          replacedPlanSlug: null,
          amount: '12900.00',
          status: 'active',
          periodEnd: PERIOD_END.toISOString(),
          autoRenewal: true,
        },
      })
      // Nothing is recalculated: no order, no credits.
      expect(await db.order.count({ where: { workspaceId: s.workspaceId } })).toBe(0)
      expect((await getCreditBalances(db, s.workspaceId)).totalAvailable).toBe(0)
    })

    it('works with auto-renewal off: the change waits for a renewal', async () => {
      const s = await subscribed({ ...SWITCHED_OFF, renewalNoticePeriodEnd: null })
      const next = await bigger()

      const subscription = await schedulePlanChange(s.deps, {
        userId: s.userId,
        planSlug: next.slug,
      })

      expect(subscription).toMatchObject({ autoRenewal: false, nextPlan: { id: next.id } })
      const state = await written(s)
      expect(state.subscription).toMatchObject({ nextPlanId: next.id, cancelAtPeriodEnd: true })
      expect(state.audit[0]?.meta).toMatchObject({ autoRenewal: false })
    })

    it('works for a tariff that waits for its payment: the payment is then made for the new tariff', async () => {
      const s = await subscribed({}, 'past_due')
      const next = await bigger()

      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug })

      const state = await written(s)
      expect(state.subscription).toMatchObject({ status: 'past_due', nextPlanId: next.id })
      expect(state.audit[0]?.meta).toMatchObject({ status: 'past_due' })
    })

    it('is replaced by a second choice', async () => {
      const s = await subscribed()
      const first = await bigger()
      const second = await bigger({ name: 'Ещё больше', price: '39900.00' })
      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: first.slug })

      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: second.slug })

      const state = await written(s)
      expect(state.subscription.nextPlanId).toBe(second.id)
      expect(state.actions).toEqual([planChangeSchedule, planChangeSchedule])
      expect(state.audit[1]?.meta).toMatchObject({
        fromPlanSlug: s.plan.slug,
        toPlanSlug: second.slug,
        replacedPlanSlug: first.slug,
        amount: '39900.00',
      })
    })

    it.each([
      ['a tariff nobody sells', () => 'no-such-tariff'],
      ['a tariff taken off sale', async () => (await bigger({ isActive: false })).slug],
      [
        'a pack of credits',
        async () =>
          (
            await fixtures.plan({
              // Not on sale as a pack: a pack checkout elsewhere must never pick it. The
              // refusal is by the kind, which is read before anything else.
              kind: 'pack',
              creditsPerMonth: null,
              tasksPerDay: null,
              maxSites: null,
              packCredits: 10,
              isActive: false,
            })
          ).slug,
      ],
      [
        // On sale, with a quota, a site limit and a price of its own: only its kind says that
        // it is no tariff. Nothing else lists or sells a pay-per-action plan.
        'a plan that is not a tariff with a quota',
        async () => (await bigger({ kind: 'payg' })).slug,
      ],
      // A tariff without a quota or a site limit is not a row the database takes.
      ['a tariff without a price', async () => (await bigger({ price: '0.00' })).slug],
    ])('is refused for %s', async (_case, slug) => {
      const s = await subscribed()

      await expect(
        schedulePlanChange(s.deps, { userId: s.userId, planSlug: await slug() }),
      ).rejects.toMatchObject({ code: 'BILLING_PLAN_NOT_FOUND' })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        nextPlanId: null,
        renewalNoticePeriodEnd: PERIOD_END,
      })
      expect(state.audit).toEqual([])
    })

    it('is refused for the tariff the customer has, and for the one already scheduled', async () => {
      const s = await subscribed()
      await db.plan.update({ where: { id: s.plan.id }, data: { isActive: true } })
      const next = await bigger()

      await expect(
        schedulePlanChange(s.deps, { userId: s.userId, planSlug: s.plan.slug }),
      ).rejects.toMatchObject({ code: 'BILLING_ALREADY_ON_PLAN' })
      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug })
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { renewalNoticePeriodEnd: PERIOD_END },
      })
      await expect(
        schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug }),
      ).rejects.toMatchObject({ code: 'BILLING_ALREADY_ON_PLAN' })
      // Choosing the tariff one has does not take the change back: `cancelPlanChange` does.
      await expect(
        schedulePlanChange(s.deps, { userId: s.userId, planSlug: s.plan.slug }),
      ).rejects.toMatchObject({ code: 'BILLING_ALREADY_ON_PLAN' })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        nextPlanId: next.id,
        // A refusal does not ask for another letter.
        renewalNoticePeriodEnd: PERIOD_END,
      })
      expect(state.actions).toEqual([planChangeSchedule])
    })

    it('is refused when the workspace has more sites than the tariff takes', async () => {
      const s = await subscribed()
      const small = await bigger({ name: 'Меньше', maxSites: 1 })
      const fits = await bigger({ maxSites: 2 })
      for (const host of ['one', 'two']) {
        await db.site.create({
          data: {
            workspaceId: s.workspaceId,
            name: host,
            url: `https://${host}-${s.workspaceId}.example.ru`,
            stack: 'wordpress',
            // Every site counts, whatever its status.
            status: host === 'one' ? 'active' : 'onboarding',
          },
        })
      }

      await expect(
        schedulePlanChange(s.deps, { userId: s.userId, planSlug: small.slug }),
      ).rejects.toMatchObject({ code: 'BILLING_PLAN_SITE_LIMIT' })
      expect((await written(s)).subscription.nextPlanId).toBeNull()

      // Exactly as many as the tariff takes is not «more».
      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: fits.slug })
      expect((await written(s)).subscription.nextPlanId).toBe(fits.id)
    })

    it.each([
      ['a user without a workspace', async () => (await fixtures.user()).userId],
      ['a workspace without a tariff', async () => (await fixtures.workspace()).userId],
      ['a tariff that has ended', async () => (await subscribed({}, 'cancelled')).userId],
      [
        'a tariff in trial, which has no rules yet',
        async () => (await subscribed({}, 'trial')).userId,
      ],
    ])('is refused for %s', async (_case, user) => {
      const userId = await user()
      const next = await bigger()

      await expect(
        schedulePlanChange({ prisma: db, appEnv: 'test' }, { userId, planSlug: next.slug }),
      ).rejects.toMatchObject({ code: 'BILLING_NO_LIVE_SUBSCRIPTION' })
    })

    it.each(['at_bank', 'unanswered'] as const)(
      'is refused while the renewal charge of the period is under way (%s): it was sent for another amount',
      async (charge) => {
        const s = await subscribed()
        const next = await bigger()
        await chargeUnderWay(s, charge)

        await expect(
          schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug }),
        ).rejects.toMatchObject({ code: 'BILLING_PAYMENT_IN_PROGRESS' })

        const state = await written(s)
        expect(state.subscription).toMatchObject({
          nextPlanId: null,
          renewalNoticePeriodEnd: PERIOD_END,
        })
        expect(state.audit).toEqual([])
      },
    )

    it('is taken once the charge has an outcome: a closed order stands in nobody`s way', async () => {
      const s = await subscribed()
      const next = await bigger()
      await chargeUnderWay(s, 'at_bank', { status: 'failed' })

      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug })

      expect((await written(s)).subscription.nextPlanId).toBe(next.id)
    })

    it('records one of two different choices that race as replacing the other', async () => {
      const s = await subscribed()
      const first = await bigger()
      const second = await bigger({ name: 'Ещё больше' })

      await Promise.all([
        schedulePlanChange(s.deps, { userId: s.userId, planSlug: first.slug }),
        schedulePlanChange(s.deps, { userId: s.userId, planSlug: second.slug }),
      ])

      const state = await written(s)
      expect(state.actions).toEqual([planChangeSchedule, planChangeSchedule])
      const [earlier, later] = state.audit.map((entry) => entry.meta as Record<string, unknown>)
      expect(earlier?.replacedPlanSlug).toBeNull()
      expect(later?.replacedPlanSlug).toBe(earlier?.toPlanSlug)
      expect([first.id, second.id]).toContain(state.subscription.nextPlanId)
      expect([first.slug, second.slug]).toContain(later?.toPlanSlug)
    })
  })

  describe('a scheduled change taken back', () => {
    it('leaves the tariff the customer has to renew and asks for a new notice', async () => {
      const next = await fixtures.plan({ isActive: true, name: 'Больше', price: '12900.00' })
      const s = await subscribed({ nextPlanId: next.id })

      const subscription = await cancelPlanChange(s.deps, { userId: s.userId })

      expect(subscription).toMatchObject({ plan: { id: s.plan.id }, nextPlan: null })
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        planId: s.plan.id,
        nextPlanId: null,
        // The notice named the amount of the tariff that will not come.
        renewalNoticePeriodEnd: null,
        cancelAtPeriodEnd: false,
      })
      expect(state.actions).toEqual([planChangeCancel])
      expect(state.audit[0]).toMatchObject({
        actorType: 'user',
        actorId: s.userId,
        targetType: 'subscription',
        targetId: s.subscriptionId,
        meta: {
          planSlug: s.plan.slug,
          cancelledPlanSlug: next.slug,
          status: 'active',
          periodEnd: PERIOD_END.toISOString(),
        },
      })
    })

    it('is refused when nothing is scheduled, twice in a row as well', async () => {
      const next = await fixtures.plan({ isActive: true })
      const s = await subscribed({ nextPlanId: next.id })
      await cancelPlanChange(s.deps, { userId: s.userId })
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { renewalNoticePeriodEnd: PERIOD_END },
      })

      await expect(cancelPlanChange(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_NOTHING_TO_CHANGE',
      })

      const state = await written(s)
      expect(state.actions).toEqual([planChangeCancel])
      expect(state.subscription.renewalNoticePeriodEnd).toEqual(PERIOD_END)
    })

    it('is refused without a live tariff', async () => {
      const { userId } = await fixtures.workspace()

      await expect(
        cancelPlanChange({ prisma: db, appEnv: 'test' }, { userId }),
      ).rejects.toMatchObject({ code: 'BILLING_NO_LIVE_SUBSCRIPTION' })
    })

    it.each(['at_bank', 'unanswered'] as const)(
      'is refused while the renewal charge of the period is under way (%s): it was sent for the scheduled tariff',
      async (charge) => {
        const next = await fixtures.plan({ isActive: true, name: 'Больше', price: '12900.00' })
        const s = await subscribed({ nextPlanId: next.id })
        await chargeUnderWay(s, charge, { planId: next.id, amount: '12900.00' })

        await expect(cancelPlanChange(s.deps, { userId: s.userId })).rejects.toMatchObject({
          code: 'BILLING_PAYMENT_IN_PROGRESS',
        })

        const state = await written(s)
        expect(state.subscription).toMatchObject({
          nextPlanId: next.id,
          renewalNoticePeriodEnd: PERIOD_END,
        })
        expect(state.audit).toEqual([])
      },
    )

    it('works for a tariff that waits for its payment', async () => {
      const next = await fixtures.plan({ isActive: true })
      const s = await subscribed({ nextPlanId: next.id }, 'past_due')

      await cancelPlanChange(s.deps, { userId: s.userId })

      expect((await written(s)).subscription).toMatchObject({
        status: 'past_due',
        nextPlanId: null,
      })
    })
  })

  // The passes look at every due row of the database. These tests stand in 2017, where nothing
  // another suite writes to a shared database is due.
  describe('the renewal of a tariff whose next period was changed', () => {
    const START = new Date('2017-06-10T09:00:00.000Z')
    const END = new Date('2017-07-10T09:00:00.000Z')
    const NEXT_END = new Date('2017-08-10T09:00:00.000Z')

    /** The scheduler over a shop whose every charge succeeds at once, or waits at the bank. */
    function scheduler(at: string) {
      const shop = yookassaStub()
      const charges: ChargeSavedInput[] = []
      const clock = { now: new Date(at) }
      const script: { outcome: 'succeeded' | 'pending' } = { outcome: 'succeeded' }
      const client: NonNullable<RenewalDeps['yookassa']> = {
        ...shop.client,
        async chargeWithSavedMethod(input, idempotenceKey) {
          charges.push(structuredClone(input))
          const { id } = await shop.client.createPayment(
            { ...input, capture: true },
            idempotenceKey,
          )
          shop.patch(id, { confirmation: undefined })
          if (script.outcome === 'succeeded') {
            shop.succeed(id, { saved: true, capturedAt: END.toISOString() })
          }
          return shop.client.getPayment(id)
        },
      }
      const deps: RenewalDeps = {
        prisma: db,
        yookassa: client,
        appUrl: TEST_APP_URL,
        now: () => clock.now,
        settings: { noticeDays: 3, pastDueDays: 7 },
      }
      return { shop, client, charges, clock, script, deps }
    }

    /**
     * A tariff with 30 credits a month whose period ends on 10 July 2017: 12 credits are left of
     * the quota, and the notice of the coming charge is written the usual way.
     */
    async function dueForRenewal() {
      const s = await subscribed({
        currentPeriodStart: START,
        currentPeriodEnd: END,
        periodAnchor: START,
        renewalNoticePeriodEnd: null,
      })
      const { email } = await db.user.findUniqueOrThrow({ where: { id: s.userId } })
      emails.push(email)
      const first = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: s.plan.id,
        periodStart: START,
        periodEnd: END,
        paidAt: START,
        createdAt: START,
      })
      await db.$transaction((tx) =>
        grantTariffCredits(tx, { workspaceId: s.workspaceId, orderId: first.id, credits: 12 }),
      )
      const pass = scheduler('2017-07-08T09:00:00.000Z')
      expect((await sendRenewalNotices(pass.deps)).counts.notified).toBe(1)
      const deps = { ...s.deps, now: () => pass.clock.now }
      return { ...s, deps, email, pass }
    }

    const notices = async (email: string) =>
      (
        await db.outboxEvent.findMany({
          where: {
            topic: 'notifications',
            type: 'billing.renewal_notice',
            payload: { path: ['to'], equals: email },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      ).map((letter) => letter.payload)

    it('is charged at the new price only after a letter that names it, and starts the new tariff', async () => {
      const s = await dueForRenewal()
      const next = await fixtures.plan({
        isActive: true,
        name: 'Больше',
        price: '12900.00',
        creditsPerMonth: 80,
      })

      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug })
      s.pass.clock.now = new Date('2017-07-10T09:01:00.000Z')

      // The letter that stands named the old amount: no charge follows it.
      expect((await chargeRenewals(s.pass.deps)).counts.renewed).toBe(0)
      expect(s.pass.charges).toEqual([])
      expect((await sendRenewalNotices(s.pass.deps)).counts.notified).toBe(1)
      expect(await notices(s.email)).toMatchObject([
        { planName: 'Проверочный', amount: '4900.00' },
        { planName: 'Больше', amount: '12900.00' },
      ])
      expect((await chargeRenewals(s.pass.deps)).counts.renewed).toBe(1)

      expect(s.pass.charges).toMatchObject([{ amount: { value: '12900.00', currency: 'RUB' } }])
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        planId: next.id,
        nextPlanId: null,
        currentPeriodStart: END,
        currentPeriodEnd: NEXT_END,
      })
      // The credits of the old tariff are not carried over; the new quota is the new tariff's.
      expect((await getCreditBalances(db, s.workspaceId)).tariff).toMatchObject({ available: 80 })
      expect(state.entry(renewalAuditActions.renewed)[0]?.meta).toMatchObject({
        planSlug: next.slug,
        planChanged: true,
        amount: '12900.00',
        credits: 80,
        expiredCredits: 12,
      })
    })

    it('is charged at the old price after the change was taken back, again after a letter', async () => {
      const s = await dueForRenewal()
      const next = await fixtures.plan({ isActive: true, name: 'Больше', price: '12900.00' })
      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug })
      expect((await sendRenewalNotices(s.pass.deps)).counts.notified).toBe(1)

      await cancelPlanChange(s.deps, { userId: s.userId })
      s.pass.clock.now = new Date('2017-07-10T09:01:00.000Z')

      expect((await chargeRenewals(s.pass.deps)).counts.renewed).toBe(0)
      expect((await sendRenewalNotices(s.pass.deps)).counts.notified).toBe(1)
      expect(
        (await notices(s.email)).map((letter) => (letter as { amount: string }).amount),
      ).toEqual(['4900.00', '12900.00', '4900.00'])
      expect((await chargeRenewals(s.pass.deps)).counts.renewed).toBe(1)

      expect(s.pass.charges).toMatchObject([{ amount: { value: '4900.00', currency: 'RUB' } }])
      expect((await written(s)).subscription).toMatchObject({
        planId: s.plan.id,
        nextPlanId: null,
        currentPeriodEnd: NEXT_END,
      })
    })

    it('cannot be changed while the charge is at the bank, and the payment renews the tariff it was sent for', async () => {
      const s = await dueForRenewal()
      const next = await fixtures.plan({
        isActive: true,
        name: 'Больше',
        price: '12900.00',
        creditsPerMonth: 80,
      })
      s.pass.clock.now = new Date('2017-07-10T09:01:00.000Z')
      s.pass.script.outcome = 'pending'
      expect((await chargeRenewals(s.pass.deps)).counts.pending).toBe(1)

      await expect(
        schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug }),
      ).rejects.toMatchObject({ code: 'BILLING_PAYMENT_IN_PROGRESS' })

      const payment = s.pass.shop.only()
      s.pass.shop.succeed(payment.id, { saved: true, capturedAt: END.toISOString() })
      const [order] = await db.order.findMany({
        where: { workspaceId: s.workspaceId, status: 'pending' },
      })
      await settleOrder({ ...s.deps, yookassa: s.pass.client }, { orderId: order?.id ?? '' })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        planId: s.plan.id,
        nextPlanId: null,
        currentPeriodEnd: NEXT_END,
      })
      expect((await getCreditBalances(db, s.workspaceId)).tariff).toMatchObject({ available: 30 })
      // Once the charge has its outcome the change is taken, for the period after.
      await schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug })
      expect((await written(s)).subscription).toMatchObject({
        planId: s.plan.id,
        nextPlanId: next.id,
      })
    })

    it.each([
      [
        'a charge sent at the price of the tariff the customer has never grants a tariff scheduled past it',
        false,
      ],
      [
        'a charge sent for the scheduled tariff applies it even when the schedule was wiped past it',
        true,
      ],
    ])('%s', async (_case, chargedForScheduled) => {
      const next = await fixtures.plan({
        isActive: true,
        name: 'Больше',
        price: '12900.00',
        creditsPerMonth: 80,
      })
      const s = await dueForRenewal()
      if (chargedForScheduled) {
        await schedulePlanChange(s.deps, { userId: s.userId, planSlug: next.slug })
        expect((await sendRenewalNotices(s.pass.deps)).counts.notified).toBe(1)
      }
      s.pass.clock.now = new Date('2017-07-10T09:01:00.000Z')
      s.pass.script.outcome = 'pending'
      expect((await chargeRenewals(s.pass.deps)).counts.pending).toBe(1)
      // What the refusals of the two changes prevent, written past them: the tariff of the
      // next period is changed while the charge is at the bank.
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { nextPlanId: chargedForScheduled ? null : next.id },
      })

      const payment = s.pass.shop.only()
      s.pass.shop.succeed(payment.id, { saved: true, capturedAt: END.toISOString() })
      const order = await db.order.findFirstOrThrow({
        where: { workspaceId: s.workspaceId, status: 'pending' },
      })
      await settleOrder({ ...s.deps, yookassa: s.pass.client }, { orderId: order.id })

      const charged = chargedForScheduled ? next : s.plan
      const state = await written(s)
      // The tariff the money was taken for, with its quota — never the other one.
      expect(payment.amount.value).toBe(charged.price.toFixed(2))
      expect(state.subscription).toMatchObject({
        planId: charged.id,
        // A change written past the charge waits for the next renewal.
        nextPlanId: chargedForScheduled ? null : next.id,
        currentPeriodEnd: NEXT_END,
      })
      expect((await getCreditBalances(db, s.workspaceId)).tariff).toMatchObject({
        available: charged.creditsPerMonth,
      })
      expect(state.entry(renewalAuditActions.renewed)[0]?.meta).toMatchObject({
        planSlug: charged.slug,
        amount: charged.price.toFixed(2),
        credits: charged.creditsPerMonth,
      })
    })

    it('is announced and charged again after auto-renewal was switched off and on', async () => {
      const s = await dueForRenewal()

      await cancelAutoRenew(s.deps, { userId: s.userId })
      s.pass.clock.now = new Date('2017-07-09T09:00:00.000Z')
      expect((await sendRenewalNotices(s.pass.deps)).counts.notified).toBe(0)
      await resumeAutoRenew(s.deps, { userId: s.userId })
      s.pass.clock.now = new Date('2017-07-10T09:01:00.000Z')

      // The letter written before the switch does not stand for the charge after it.
      expect((await chargeRenewals(s.pass.deps)).counts.renewed).toBe(0)
      expect((await sendRenewalNotices(s.pass.deps)).counts.notified).toBe(1)
      expect((await chargeRenewals(s.pass.deps)).counts.renewed).toBe(1)

      expect(await notices(s.email)).toHaveLength(2)
      const state = await written(s)
      expect(state.entry(renewalJobAuditActions.notice)).toHaveLength(2)
      expect(state.subscription).toMatchObject({ status: 'active', currentPeriodEnd: NEXT_END })
    })

    it('ends with its period when auto-renewal stays off', async () => {
      const s = await dueForRenewal()

      await cancelAutoRenew(s.deps, { userId: s.userId })
      s.pass.clock.now = new Date('2017-07-10T09:01:00.000Z')

      expect((await sendRenewalNotices(s.pass.deps)).counts.notified).toBe(0)
      expect((await chargeRenewals(s.pass.deps)).counts.renewed).toBe(0)
      expect(s.pass.charges).toEqual([])
      expect((await endPeriods(s.pass.deps)).counts.cancelled).toBe(1)
      expect((await written(s)).subscription).toMatchObject({
        status: 'cancelled',
        currentPeriodEnd: END,
      })
    })
  })

  describe('the tariff a workspace had last', () => {
    const ended = (status: SubscriptionStatus, patch = {}) =>
      subscribed(
        {
          currentPeriodStart: new Date('2026-08-18T09:00:00Z'),
          currentPeriodEnd: new Date('2026-09-18T09:00:00Z'),
          ...patch,
        },
        status,
      )

    it('is told of nobody who has a live tariff, or never had one', async () => {
      const { workspaceId } = await fixtures.workspace()
      const active = await subscribed()
      const overdue = await subscribed({}, 'past_due')

      expect(await getEndedSubscription(db, null)).toBeNull()
      expect(await getEndedSubscription(db, workspaceId)).toBeNull()
      expect(await getEndedSubscription(db, active.workspaceId)).toBeNull()
      expect(await getEndedSubscription(db, overdue.workspaceId)).toBeNull()
    })

    it.each([
      ['cancelled', 'not_renewed'],
      // A row closed without the entry of its end: nothing tells of another moment.
      ['expired', 'not_paid'],
    ] as const)('names a %s tariff with the end of its paid period: %s', async (status, reason) => {
      const s = await ended(status)

      expect(await getEndedSubscription(db, s.workspaceId)).toEqual({
        planName: 'Проверочный',
        endedAt: new Date('2026-09-18T09:00:00Z'),
        reason,
      })
    })

    /** The entry `endPeriods` writes with the end of a tariff, written at `createdAt`. */
    const endEntry = (
      { workspaceId, subscriptionId }: { workspaceId: string; subscriptionId: string },
      reason: 'past_due_grace' | 'auto_renewal_off',
      createdAt: Date,
    ) =>
      db.auditLog.create({
        data: {
          actorType: 'system',
          actorId: 'billing',
          workspaceId,
          action: renewalJobAuditActions.subscriptionEnd,
          targetType: 'subscription',
          targetId: subscriptionId,
          meta: { status: reason === 'past_due_grace' ? 'expired' : 'cancelled', reason },
          createdAt,
        },
      })

    it('names the moment a tariff that was not paid for was ended, not the end of its paid period', async () => {
      // The paid period ended on 8 October; the page of the overdue tariff said «15 октября
      // 2026 тариф закончится», and that day the pass ended it.
      const s = await ended('expired', {
        currentPeriodStart: new Date('2026-09-08T09:00:00Z'),
        currentPeriodEnd: new Date('2026-10-08T09:00:00Z'),
        pastDueSince: new Date('2026-10-08T09:02:00Z'),
      })
      const endedAt = new Date('2026-10-15T09:05:10.000Z')
      await endEntry(s, 'past_due_grace', endedAt)

      expect(await getEndedSubscription(db, s.workspaceId)).toEqual({
        planName: 'Проверочный',
        endedAt,
        reason: 'not_paid',
      })
    })

    it('reads the end of an unpaid tariff from its own entry alone', async () => {
      const s = await ended('expired')
      const other = await ended('expired')
      // The end of another tariff, and an entry of this one that is not its end.
      await endEntry(other, 'past_due_grace', new Date('2026-09-25T09:05:00Z'))
      await db.auditLog.create({
        data: {
          actorType: 'system',
          actorId: 'billing',
          workspaceId: s.workspaceId,
          action: renewalAuditActions.pastDue,
          targetType: 'subscription',
          targetId: s.subscriptionId,
          createdAt: new Date('2026-09-18T09:02:00Z'),
        },
      })

      expect(await getEndedSubscription(db, s.workspaceId)).toMatchObject({
        endedAt: new Date('2026-09-18T09:00:00Z'),
        reason: 'not_paid',
      })
      expect(await getEndedSubscription(db, other.workspaceId)).toMatchObject({
        endedAt: new Date('2026-09-25T09:05:00Z'),
        reason: 'not_paid',
      })
    })

    it('keeps the end of the paid period for a tariff that was not renewed, whenever the pass closed it', async () => {
      const s = await ended('cancelled')
      // The pass ran some minutes after the period ended: the tariff ended with the period.
      await endEntry(s, 'auto_renewal_off', new Date('2026-09-18T09:04:00Z'))

      expect(await getEndedSubscription(db, s.workspaceId)).toEqual({
        planName: 'Проверочный',
        endedAt: new Date('2026-09-18T09:00:00Z'),
        reason: 'not_renewed',
      })
    })

    it('is ended by the pass at the end of the grace: the page and the letter name that moment', async () => {
      // The passes look at every due row of the database: this one stands in 2016.
      const START = new Date('2016-03-10T09:00:00.000Z')
      const END = new Date('2016-04-10T09:00:00.000Z')
      const s = await subscribed(
        {
          currentPeriodStart: START,
          currentPeriodEnd: END,
          periodAnchor: START,
          pastDueSince: new Date('2016-04-10T09:02:00.000Z'),
        },
        'past_due',
      )
      const { email } = await db.user.findUniqueOrThrow({ where: { id: s.userId } })
      emails.push(email)
      const clock = { now: new Date('2016-04-17T09:01:00.000Z') }
      const passes: RenewalDeps = {
        prisma: db,
        yookassa: {
          ...yookassaStub().client,
          chargeWithSavedMethod: () =>
            Promise.reject(new Error('Nothing is charged by itself for an overdue tariff')),
        },
        appUrl: TEST_APP_URL,
        now: () => clock.now,
        settings: { noticeDays: 3, pastDueDays: 7 },
      }

      // A minute before the grace runs out the tariff is overdue, and nothing has ended.
      expect((await endPeriods(passes)).counts.expired).toBe(0)
      expect(await getEndedSubscription(db, s.workspaceId)).toBeNull()

      clock.now = new Date('2016-04-17T09:03:00.000Z')
      const before = new Date()
      expect((await endPeriods(passes)).counts.expired).toBe(1)

      const state = await written(s)
      expect(state.subscription).toMatchObject({ status: 'expired', currentPeriodEnd: END })
      const [entry] = state.entry(renewalJobAuditActions.subscriptionEnd)
      expect(entry?.meta).toMatchObject({ status: 'expired', reason: 'past_due_grace' })
      const ended = await getEndedSubscription(db, s.workspaceId)
      // The moment the entry was written — this database's clock —, not 10 April.
      expect(ended).toEqual({
        planName: 'Проверочный',
        endedAt: entry?.createdAt,
        reason: 'not_paid',
      })
      expect(ended?.endedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 60_000)
      expect(ended?.endedAt).not.toEqual(END)
      // The letter names the moment of the pass: with one clock, the same day as the page.
      const letters = await db.outboxEvent.findMany({
        where: { topic: 'notifications', payload: { path: ['to'], equals: email } },
      })
      expect(letters.map((letter) => [letter.type, letter.payload])).toMatchObject([
        ['billing.subscription_ended', { endedAt: '2016-04-17T09:03:00.000Z' }],
      ])
    })

    it('tells a tariff an operator ended when returning its payment from one that was not renewed', async () => {
      const s = await ended('cancelled', { currentPeriodEnd: TEST_NOW })
      const other = await ended('cancelled')
      const entry = (workspaceId: string, subscriptionId: string, reason: string) =>
        db.$transaction((tx) =>
          writeBillingAudit(tx, {
            actor: { type: reason === REFUND_END_REASON ? 'operator' : 'system', id: 'ops' },
            workspaceId,
            action: renewalJobAuditActions.subscriptionEnd,
            target: { type: 'subscription', id: subscriptionId },
            meta: { reason },
          }),
        )
      await entry(s.workspaceId, s.subscriptionId, REFUND_END_REASON)
      await entry(other.workspaceId, other.subscriptionId, 'auto_renewal_off')

      expect(await getEndedSubscription(db, s.workspaceId)).toEqual({
        planName: 'Проверочный',
        endedAt: TEST_NOW,
        reason: 'refunded',
      })
      expect(await getEndedSubscription(db, other.workspaceId)).toMatchObject({
        endedAt: new Date('2026-09-18T09:00:00Z'),
        reason: 'not_renewed',
      })
    })

    it('is the newest of several, and is not told once a new tariff is live', async () => {
      const s = await ended('expired', { createdAt: new Date('2026-06-01T00:00:00Z') })
      const later = await fixtures.plan({ name: 'Позже' })
      await fixtures.subscription({
        workspaceId: s.workspaceId,
        planId: later.id,
        status: 'cancelled',
        currentPeriodStart: new Date('2026-09-20T09:00:00Z'),
        currentPeriodEnd: new Date('2026-10-01T09:00:00Z'),
        createdAt: new Date('2026-09-20T09:00:00Z'),
      })

      expect(await getEndedSubscription(db, s.workspaceId)).toEqual({
        planName: 'Позже',
        endedAt: new Date('2026-10-01T09:00:00Z'),
        reason: 'not_renewed',
      })

      await fixtures.subscription({
        workspaceId: s.workspaceId,
        planId: later.id,
        createdAt: new Date('2026-10-02T09:00:00Z'),
      })
      expect(await getEndedSubscription(db, s.workspaceId)).toBeNull()
    })
  })
})
