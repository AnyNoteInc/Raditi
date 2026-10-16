import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import { paymentMethodLabel } from '@repo/domain'
import {
  YookassaApiError,
  YookassaError,
  type ChargeSavedInput,
  type Payment,
} from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { startCheckout } from './checkout.ts'
import { orderFailureReasons } from './failure-text.ts'
import { grantPackCredits, grantSignupGift, grantTariffCredits, ledgerKeys } from './ledger.ts'
import { getCreditBalances } from './read-models.ts'
import {
  ABANDONED_CHECKOUT_AFTER_MS,
  abandonedCheckout,
  autoRenewalStopReasons,
  chargeRenewals,
  endPeriods,
  RENEWAL_GIVE_UP_MARGIN_MS,
  RENEWAL_RETRY_WINDOW_MS,
  renewalJobAuditActions,
  sendRenewalNotices,
  settleStuckOrders,
  STUCK_ORDER_AFTER_MS,
  subscriptionEndedLetterKey,
  type RenewalDeps,
  type RenewalFailureReport,
} from './renewal.ts'
import { isRenewalOrder, renewalKey } from './renewal-order.ts'
import {
  applyPayment,
  paymentFailedLetterKey,
  paymentLetterKey,
  refundReasons,
  renewalAuditActions,
  settleOrder,
  settlementAuditActions,
} from './settlement.ts'
import { billingFixtures, NO_GIFT, TEST_APP_URL, yookassaStub } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL

// The passes look at every due row of the database, not at the rows of one workspace. So the
// tests stand in 2021: nothing another suite writes to a shared database — a subscription of
// 2026, an order made «now» — is due then, and a pass meets only the rows of its own test.
const at = (iso: string) => new Date(iso)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const START = '2021-03-10T09:00:00.000Z'
const END = '2021-04-10T09:00:00.000Z'
const NEXT_END = '2021-05-10T09:00:00.000Z'
/** Between the end of the period the tests start in and the end of the next one. */
const HALF_WAY = '2021-04-25T00:00:00.000Z'
const CARD = { type: 'bank_card', cardType: 'Mir', last4: '4444' }

type Answer =
  | { status: 'succeeded'; capturedAt?: string }
  | { status: 'canceled'; reason?: string }
  | { status: 'pending' }

/**
 * The scripted shop of testing.ts with the request a renewal makes. A charge answers at once:
 * the money came, unless the test says otherwise. A repeated key answers with the payment of
 * the first request and makes no second one.
 */
function renewalShop() {
  const shop = yookassaStub()
  const charges: { input: ChargeSavedInput; idempotenceKey: string }[] = []
  const charged = new Set<string>()
  const failures: { error: unknown; processed: boolean }[] = []
  const answers: Answer[] = []

  const client = {
    ...shop.client,
    async chargeWithSavedMethod(input: ChargeSavedInput, idempotenceKey: string) {
      charges.push({ input: structuredClone(input), idempotenceKey })
      const failure = failures.shift()
      if (failure !== undefined && !failure.processed) throw failure.error
      const first = !charged.has(idempotenceKey)
      charged.add(idempotenceKey)
      const { id } = await shop.client.createPayment({ ...input, capture: true }, idempotenceKey)
      if (first) {
        const answer = answers.shift() ?? { status: 'succeeded' }
        if (answer.status === 'succeeded') {
          shop.succeed(id, { saved: true, capturedAt: answer.capturedAt })
        } else if (answer.status === 'canceled') {
          shop.cancel(id, answer.reason)
        }
      }
      if (failure !== undefined) throw failure.error
      return structuredClone(shop.payments.get(id)) as Payment
    },
  } satisfies NonNullable<RenewalDeps['yookassa']>

  return {
    ...shop,
    client,
    /** Every charge request, a failed and a repeated one included. */
    charges,
    /** What the shop does with the next new charge. */
    willAnswer(answer: Answer) {
      answers.push(answer)
    },
    /**
     * The next charge request fails with this error. `processed`: ЮKassa made the payment and
     * only the answer was lost.
     */
    failCharge(error: unknown, { processed = false } = {}) {
      failures.push({ error, processed })
    },
  }
}

const timeout = () => new YookassaError('YooKassa request timed out', { retryable: true })
const serverError = () => new YookassaApiError('internal_server_error', 500, undefined, {})

describe('whether an order is a checkout nobody will finish', () => {
  const SUBSCRIPTION = '0199a000-0000-7000-8000-0000000000f1'
  const pack = {
    kind: 'pack',
    subscriptionId: null,
    idempotenceKey: '0199a000-0000-7000-8000-0000000000f2',
    yookassaPaymentId: null,
  } as const
  const firstTariff = { ...pack, kind: 'subscription' } as const
  const HOUR_MS = 60 * 60_000

  it.each([
    ['yes: a pack order without a payment, an hour old', pack, HOUR_MS, true],
    ['yes: a first tariff order without a payment, an hour old', firstTariff, HOUR_MS, true],
    ['yes: the same a day later', pack, 24 * HOUR_MS, true],
    ['no: one that is a millisecond short of the hour', pack, HOUR_MS - 1, false],
    // Five minutes make an order stuck, not abandoned.
    ['no: one that is five minutes old', firstTariff, STUCK_ORDER_AFTER_MS, false],
    ['no: one that holds a payment', { ...pack, yookassaPaymentId: 'pay-1' }, 24 * HOUR_MS, false],
    [
      'yes: a payment by hand of an overdue tariff without a payment, an hour old',
      { ...firstTariff, subscriptionId: SUBSCRIPTION },
      HOUR_MS,
      true,
    ],
    [
      'no: the same a millisecond short of the hour',
      { ...firstTariff, subscriptionId: SUBSCRIPTION },
      HOUR_MS - 1,
      false,
    ],
    [
      'no: a renewal, whose charge nobody starts on a page',
      {
        ...firstTariff,
        subscriptionId: SUBSCRIPTION,
        idempotenceKey: `renew.${SUBSCRIPTION}.1555000000000`,
      },
      24 * HOUR_MS,
      false,
    ],
    ['no: a top-up', { ...pack, kind: 'topup' }, 24 * HOUR_MS, false],
  ] as const)('%s', (_case, order, age, abandoned) => {
    expect(abandonedCheckout(order, age)).toBe(abandoned)
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL renewal', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  const emails: string[] = []
  /** Audit entries a fixture wrote: `written` shows only what renewal itself did. */
  const fixtureAudit = new Set<string>()
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    fixtureAudit.clear()
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

  interface Subscribed {
    userId: string
    email: string
    workspaceId: string
    planId: string
    subscriptionId: string
    paymentMethodId: string | null
    periodEnd: Date
  }

  /**
   * What the notice of the subscription's period leaves besides the mark: the audit entry
   * with the plan, the amount and the moment it announced — of the coming plan as it is now
   * unless told otherwise. A charge is made only for what the newest of these entries says.
   */
  async function recordNotice(
    subscriptionId: string,
    said: { planSlug?: string; amount?: string; chargeAt?: string } = {},
  ): Promise<void> {
    const subscription = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })
    const coming = await db.plan.findUniqueOrThrow({
      where: { id: subscription.nextPlanId ?? subscription.planId },
    })
    const entry = await db.auditLog.create({
      data: {
        actorType: 'system',
        actorId: 'billing',
        workspaceId: subscription.workspaceId,
        action: renewalJobAuditActions.notice,
        targetType: 'subscription',
        targetId: subscription.id,
        meta: {
          planSlug: coming.slug,
          amount: coming.price.toFixed(2),
          chargeAt: subscription.currentPeriodEnd.toISOString(),
          ...said,
        },
      },
      select: { id: true },
    })
    fixtureAudit.add(entry.id)
  }

  /**
   * A workspace on a tariff of its own: a paid first order, the quota of the period on the
   * tariff account and the subscription — for March 2021, with a saved card and auto-renewal
   * unless told otherwise. `noticed`: the notice of the period is already recorded, the mark
   * and what the letter said.
   */
  async function subscribed(
    options: {
      start?: string
      end?: string
      autoRenewal?: boolean
      noticed?: boolean
      plan?: Parameters<typeof fixtures.plan>[0]
      subscription?: Partial<Prisma.SubscriptionUncheckedCreateInput>
    } = {},
  ): Promise<Subscribed> {
    const { start = START, end = END, autoRenewal = true, noticed = false } = options
    const { userId, workspaceId } = await fixtures.workspace()
    const { email } = await db.user.findUniqueOrThrow({ where: { id: userId } })
    emails.push(email)
    const plan = await fixtures.plan(options.plan)
    const first = await fixtures.order({
      workspaceId,
      planId: plan.id,
      userId,
      amount: plan.price,
      periodStart: at(start),
      periodEnd: at(end),
      paidAt: at(start),
      createdAt: at(start),
    })
    await db.$transaction((tx) =>
      grantTariffCredits(tx, {
        workspaceId,
        orderId: first.id,
        credits: plan.creditsPerMonth ?? 30,
      }),
    )
    const paymentMethodId = autoRenewal ? `pm-${first.id}` : null
    const subscription = await fixtures.subscription({
      workspaceId,
      planId: plan.id,
      currentPeriodStart: at(start),
      currentPeriodEnd: at(end),
      periodAnchor: at(start),
      cancelAtPeriodEnd: !autoRenewal,
      ...(autoRenewal
        ? {
            paymentMethodId,
            paymentMethodTitle: 'Bank card *4444',
            paymentMethodType: CARD.type,
            paymentMethodCardType: CARD.cardType,
            paymentMethodLast4: CARD.last4,
          }
        : {}),
      renewalNoticePeriodEnd: noticed ? at(end) : null,
      ...options.subscription,
    })
    if (noticed) await recordNotice(subscription.id)
    return {
      userId,
      email,
      workspaceId,
      planId: plan.id,
      subscriptionId: subscription.id,
      paymentMethodId,
      periodEnd: subscription.currentPeriodEnd,
    }
  }

  /** The passes at a moment the test moves: a scripted shop, or none while payments are off. */
  function passes(startAt: string, shop: ReturnType<typeof renewalShop> | null = renewalShop()) {
    const clock = { now: at(startAt) }
    const errors: RenewalFailureReport[] = []
    const deps: RenewalDeps = {
      prisma: db,
      yookassa: shop?.client ?? null,
      appUrl: TEST_APP_URL,
      now: () => clock.now,
      settings: { noticeDays: 3, pastDueDays: 7 },
      onError: (report) => errors.push(report),
    }
    return {
      deps,
      clock,
      errors,
      /** Never null here: the tests of «payments off» build their own. */
      shop: shop ?? renewalShop(),
      later(ms: number) {
        clock.now = new Date(clock.now.getTime() + ms)
      },
    }
  }

  const lettersTo = (email: string) =>
    db.outboxEvent.findMany({
      where: { topic: 'notifications', payload: { path: ['to'], equals: email } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })

  /** Everything renewal may have written for the workspace. */
  async function written(s: Subscribed) {
    const { workspaceId } = s
    const orders = await db.order.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const audit = (await db.auditLog.findMany({ where: { workspaceId } })).filter(
      (entry) => !fixtureAudit.has(entry.id),
    )
    const letters = await lettersTo(s.email)
    return {
      subscription: await db.subscription.findUniqueOrThrow({ where: { id: s.subscriptionId } }),
      orders,
      renewals: orders.filter(isRenewalOrder),
      balances: await getCreditBalances(db, workspaceId),
      ledger: await db.creditLedger.findMany({
        where: { account: { workspaceId } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      audit,
      actions: audit.map((entry) => entry.action).sort(),
      meta: (action: string) => audit.find((entry) => entry.action === action)?.meta,
      letters,
      letterTypes: letters.map((letter) => letter.type),
    }
  }

  const only = <T>(items: readonly T[]): T => {
    const [item, ...others] = items
    if (item === undefined || others.length > 0) {
      throw new Error(`Expected one item, got ${items.length}`)
    }
    return item
  }

  /** The gift account of the workspace with its journal and its reserves, row for row. */
  const giftRows = (workspaceId: string) =>
    db.billingAccount.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId, unit: 'credit_gift' } },
      include: { entries: { orderBy: { id: 'asc' } }, holds: { orderBy: { id: 'asc' } } },
    })

  /**
   * Grants the gift of the registration to the owner of the workspace and reserves 5 of its 35
   * credits for a task; the gift account as it then is.
   */
  async function gifted(s: Subscribed) {
    await db.$transaction((tx) =>
      grantSignupGift(tx, { userId: s.userId, workspaceId: s.workspaceId }),
    )
    await fixtures.hold(s.workspaceId, 'gift', 5)
    return giftRows(s.workspaceId)
  }

  describe('the notice', () => {
    it('goes out once per period, with the amount, the day and the payment method', async () => {
      const s = await subscribed()
      // Two days and a minute before the charge.
      const { deps, shop, errors } = passes('2021-04-08T08:59:00.000Z')

      expect(await sendRenewalNotices(deps)).toEqual({
        counts: { notified: 1, auto_renewal_stopped: 0, past_due: 0, skipped: 0, failed: 0 },
        complete: true,
      })

      let state = await written(s)
      const letter = only(state.letters)
      expect(letter).toMatchObject({
        type: 'billing.renewal_notice',
        dedupeKey: null,
        status: 'pending',
      })
      expect(letter.payload).toEqual({
        planName: 'Проверочный',
        amount: '4900.00',
        chargeAt: END,
        paymentMethod: paymentMethodLabel(CARD),
        appUrl: TEST_APP_URL,
        to: s.email,
      })
      expect(state.subscription.renewalNoticePeriodEnd).toEqual(at(END))
      expect(state.actions).toEqual([renewalJobAuditActions.notice])
      expect(state.meta(renewalJobAuditActions.notice)).toEqual({
        planSlug: expect.stringMatching(/^test-/),
        amount: '4900.00',
        chargeAt: END,
      })

      // The next ticks find the mark and write nothing.
      for (let tick = 0; tick < 3; tick += 1) {
        expect((await sendRenewalNotices(deps)).counts.notified).toBe(0)
      }
      state = await written(s)
      expect(state.letters).toHaveLength(1)
      expect(state.actions).toEqual([renewalJobAuditActions.notice])
      // A notice charges nobody.
      expect(shop.charges).toEqual([])
      expect(state.orders).toHaveLength(1)
      expect(errors).toEqual([])
    })

    it('is written by one of two passes that run at once', async () => {
      const s = await subscribed()
      const { deps } = passes('2021-04-09T09:00:00.000Z')

      const results = await Promise.all([
        sendRenewalNotices(deps),
        sendRenewalNotices(deps),
        sendRenewalNotices(deps),
      ])

      expect(results.reduce((sum, pass) => sum + pass.counts.notified, 0)).toBe(1)
      expect(results.every((pass) => pass.counts.failed === 0)).toBe(true)
      expect((await written(s)).letters).toHaveLength(1)
    })

    it('waits for the days before the end of the period', async () => {
      const s = await subscribed()
      // Three days and a minute before: not yet.
      const { deps, later } = passes('2021-04-07T08:59:00.000Z')

      expect((await sendRenewalNotices(deps)).counts.notified).toBe(0)
      expect((await written(s)).letters).toEqual([])

      later(MINUTE)
      expect((await sendRenewalNotices(deps)).counts.notified).toBe(1)
    })

    it('is not sent for a tariff that is not renewed, and not while payments are off', async () => {
      const off = await subscribed({ autoRenewal: false })
      const unbound = await subscribed({ subscription: { paymentMethodId: null } })
      const overdue = await subscribed({
        subscription: { status: 'past_due', pastDueSince: at('2021-04-08T00:00:00.000Z') },
      })
      const { deps } = passes('2021-04-09T09:00:00.000Z')

      expect((await sendRenewalNotices(deps)).counts.notified).toBe(0)

      const on = await subscribed()
      const withoutShop = passes('2021-04-09T09:00:00.000Z', null)
      expect(await sendRenewalNotices(withoutShop.deps)).toEqual({
        counts: { notified: 0, auto_renewal_stopped: 0, past_due: 0, skipped: 0, failed: 0 },
        complete: true,
      })
      for (const s of [off, unbound, overdue, on]) {
        const state = await written(s)
        expect(state.letters).toEqual([])
        expect(state.subscription.renewalNoticePeriodEnd).toBeNull()
      }
    })

    it('is written again, with the new plan and price, when the mark is cleared', async () => {
      const s = await subscribed()
      const { deps } = passes('2021-04-08T09:00:00.000Z')
      await sendRenewalNotices(deps)

      // What scheduling a plan change does: the next plan, and the notice does not stand.
      const business = await fixtures.plan({
        name: 'Бизнес',
        price: '12900.00',
        creditsPerMonth: 100,
      })
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { nextPlanId: business.id, renewalNoticePeriodEnd: null },
      })
      expect((await sendRenewalNotices(deps)).counts.notified).toBe(1)

      const state = await written(s)
      expect(state.letters.map((letter) => letter.payload)).toEqual([
        expect.objectContaining({ planName: 'Проверочный', amount: '4900.00' }),
        expect.objectContaining({ planName: 'Бизнес', amount: '12900.00', chargeAt: END }),
      ])
      expect(state.subscription.renewalNoticePeriodEnd).toEqual(at(END))
      // The plan itself changes at the renewal, not now.
      expect(state.subscription.planId).toBe(s.planId)
    })

    it('keeps its mark equal to a period end the database holds in microseconds', async () => {
      const s = await subscribed()
      await db.$executeRaw`
        UPDATE subscriptions SET current_period_end = '2021-04-10 09:00:00.000123+00'
        WHERE id = ${s.subscriptionId}::uuid
      `
      const { deps } = passes('2021-04-09T09:00:00.000Z')

      expect((await sendRenewalNotices(deps)).counts.notified).toBe(1)
      // A mark written from a Date would differ by the microseconds, and the notice would be
      // sent on every tick while the charge never came.
      expect((await sendRenewalNotices(deps)).counts.notified).toBe(0)
      const [row] = await db.$queryRaw<{ same: boolean }[]>`
        SELECT renewal_notice_period_end = current_period_end AS same
        FROM subscriptions WHERE id = ${s.subscriptionId}::uuid
      `
      expect(row?.same).toBe(true)
      expect((await written(s)).letters).toHaveLength(1)
    })

    it.each([
      [
        'the workspace has no owner to write to',
        autoRenewalStopReasons.noRecipient,
        async (s: Subscribed) => {
          await db.member.deleteMany({ where: { workspaceId: s.workspaceId } })
        },
      ],
      [
        'the coming plan cannot be charged for',
        autoRenewalStopReasons.planUnavailable,
        async (s: Subscribed) => {
          const free = await fixtures.plan({ price: '0.00' })
          await db.subscription.update({
            where: { id: s.subscriptionId },
            data: { nextPlanId: free.id },
          })
        },
      ],
      [
        'the letter cannot be written to the address of the owner',
        autoRenewalStopReasons.letterRefused,
        async (s: Subscribed) => {
          await db.user.update({
            where: { id: s.userId },
            data: { email: `no-address-${s.userId}` },
          })
        },
      ],
    ])('switches auto-renewal off instead when %s', async (_case, reason, arrange) => {
      const s = await subscribed()
      await arrange(s)
      const { deps, shop, later } = passes('2021-04-09T09:00:00.000Z')

      expect((await sendRenewalNotices(deps)).counts).toMatchObject({
        notified: 0,
        auto_renewal_stopped: 1,
      })

      let state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        cancelAtPeriodEnd: true,
        cancelledAt: at('2021-04-09T09:00:00.000Z'),
        renewalNoticePeriodEnd: null,
      })
      expect(state.letters).toEqual([])
      expect(state.meta(renewalJobAuditActions.autoRenewalStop)).toEqual({ reason, periodEnd: END })

      // Nothing hangs: no charge without a notice, and the tariff ends with its period.
      later(DAY + MINUTE)
      await sendRenewalNotices(deps)
      await chargeRenewals(deps)
      expect((await endPeriods(deps)).counts.cancelled).toBe(1)
      state = await written(s)
      expect(state.subscription.status).toBe('cancelled')
      expect(shop.charges).toEqual([])
      expect(state.renewals).toEqual([])
    })
  })

  describe('the charge', () => {
    it('is not made without the notice of the period: the notice comes first', async () => {
      // Auto-renewal was switched on in the last minutes: the period ended unannounced.
      const s = await subscribed()
      const { deps, shop } = passes('2021-04-10T09:01:00.000Z')

      expect((await chargeRenewals(deps)).counts.renewed).toBe(0)
      expect(shop.charges).toEqual([])
      expect((await written(s)).renewals).toEqual([])

      expect((await sendRenewalNotices(deps)).counts.notified).toBe(1)
      expect(only((await written(s)).letters).payload).toMatchObject({ chargeAt: END })
      expect((await chargeRenewals(deps)).counts.renewed).toBe(1)

      const state = await written(s)
      expect(state.subscription.currentPeriodEnd).toEqual(at(NEXT_END))
      expect(state.letterTypes).toEqual(['billing.renewal_notice', 'billing.payment_succeeded'])
    })

    it.each([
      [
        'the price of the plan was changed after the notice',
        async (s: Subscribed) => {
          await db.plan.update({ where: { id: s.planId }, data: { price: '6900.00' } })
          return { planName: 'Проверочный', amount: '6900.00' }
        },
      ],
      [
        'a change of plan was scheduled after the notice and the mark was left in place',
        async (s: Subscribed) => {
          const business = await fixtures.plan({
            name: 'Бизнес',
            price: '12900.00',
            creditsPerMonth: 100,
          })
          await db.subscription.update({
            where: { id: s.subscriptionId },
            data: { nextPlanId: business.id },
          })
          return { planName: 'Бизнес', amount: '12900.00' }
        },
      ],
      [
        'a change to a plan of the same price was scheduled after the notice',
        async (s: Subscribed) => {
          const other = await fixtures.plan({ name: 'Студия', creditsPerMonth: 60 })
          await db.subscription.update({
            where: { id: s.subscriptionId },
            data: { nextPlanId: other.id },
          })
          return { planName: 'Студия', amount: '4900.00' }
        },
      ],
    ])(
      'is made only for what the notice named: when %s, a new letter comes first',
      async (_case, arrange) => {
        const s = await subscribed()
        const { deps, shop, later, errors } = passes('2021-04-08T09:00:00.000Z')
        await sendRenewalNotices(deps)
        const real = await arrange(s)

        // The period ends: the letter of two days ago named another charge.
        later(2 * DAY)
        expect((await chargeRenewals(deps)).counts).toMatchObject({
          notice_outdated: 1,
          renewed: 0,
        })
        let state = await written(s)
        expect(shop.charges).toEqual([])
        expect(state.renewals).toEqual([])
        expect(state.subscription).toMatchObject({
          status: 'active',
          renewalNoticePeriodEnd: null,
          currentPeriodEnd: at(END),
        })
        // And nothing more until the owner is told what is true now.
        expect((await chargeRenewals(deps)).counts).toMatchObject({
          notice_outdated: 0,
          renewed: 0,
        })

        expect((await sendRenewalNotices(deps)).counts.notified).toBe(1)
        expect((await chargeRenewals(deps)).counts).toMatchObject({
          notice_outdated: 0,
          renewed: 1,
        })

        state = await written(s)
        expect(state.letters.map((letter) => [letter.type, letter.payload])).toEqual([
          [
            'billing.renewal_notice',
            expect.objectContaining({ planName: 'Проверочный', amount: '4900.00' }),
          ],
          ['billing.renewal_notice', expect.objectContaining({ ...real, chargeAt: END })],
          ['billing.payment_succeeded', expect.objectContaining(real)],
        ])
        // One charge, of the amount the last letter named.
        expect(shop.charges.map((charge) => charge.input.amount.value)).toEqual([real.amount])
        const order = only(state.renewals)
        expect(order.status).toBe('paid')
        expect(order.amount.toFixed(2)).toBe(real.amount)
        expect(state.subscription.currentPeriodEnd).toEqual(at(NEXT_END))
        expect(errors).toEqual([])
      },
    )

    it.each([
      ['nothing records what the notice said', async () => {}],
      [
        'the only record is of an earlier period',
        (s: Subscribed) => recordNotice(s.subscriptionId, { chargeAt: START }),
      ],
    ])(
      'is not made on the mark alone: when %s, the notice is written again',
      async (_case, arrange) => {
        const s = await subscribed({ subscription: { renewalNoticePeriodEnd: at(END) } })
        await arrange(s)
        const { deps, shop } = passes('2021-04-10T09:00:00.000Z')

        expect((await chargeRenewals(deps)).counts).toMatchObject({
          notice_outdated: 1,
          renewed: 0,
        })
        expect(shop.charges).toEqual([])
        expect((await written(s)).renewals).toEqual([])

        expect((await sendRenewalNotices(deps)).counts.notified).toBe(1)
        expect((await chargeRenewals(deps)).counts.renewed).toBe(1)
        expect((await written(s)).letterTypes).toEqual([
          'billing.renewal_notice',
          'billing.payment_succeeded',
        ])
        expect(shop.charges).toHaveLength(1)
      },
    )

    it('waits for the end of the period', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later } = passes('2021-04-10T08:59:59.999Z')

      expect((await chargeRenewals(deps)).counts.renewed).toBe(0)
      expect(shop.charges).toEqual([])

      later(1)
      expect((await chargeRenewals(deps)).counts.renewed).toBe(1)
      expect((await written(s)).subscription.currentPeriodStart).toEqual(at(END))
    })

    it('rolls the period from its end by the anchor, applies the scheduled plan, expires the available remainder and grants the new quota once', async () => {
      // Paid on 31 January at noon in Moscow: February ends on the 28th, March on the 31st.
      const business = await fixtures.plan({
        name: 'Бизнес',
        price: '12900.00',
        creditsPerMonth: 100,
      })
      const s = await subscribed({
        start: '2021-01-31T09:00:00.000Z',
        end: '2021-02-28T09:00:00.000Z',
        noticed: true,
        subscription: { nextPlanId: business.id },
      })
      // Two of the thirty credits are held by a running task; a pack was bought as well.
      await fixtures.hold(s.workspaceId, 'tariff', 2)
      const pack = await fixtures.plan({ kind: 'pack', packCredits: 10, maxSites: null })
      const packOrder = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: pack.id,
        kind: 'pack',
      })
      await db.$transaction((tx) =>
        grantPackCredits(tx, { workspaceId: s.workspaceId, orderId: packOrder.id, credits: 10 }),
      )
      // The charge runs five hours after the period ended: the new one still starts at its end.
      const { deps, shop, errors } = passes('2021-02-28T14:00:00.000Z')
      shop.willAnswer({ status: 'succeeded', capturedAt: '2021-02-28T14:00:03.000Z' })

      expect(await chargeRenewals(deps)).toEqual({
        counts: {
          renewed: 1,
          declined: 0,
          pending: 0,
          unanswered: 0,
          refund_needed: 0,
          auto_renewal_stopped: 0,
          notice_outdated: 0,
          blocked: 0,
          skipped: 0,
          failed: 0,
        },
        complete: true,
      })

      const periodStart = at('2021-02-28T09:00:00.000Z')
      const periodEnd = at('2021-03-31T09:00:00.000Z')
      const state = await written(s)
      const order = only(state.renewals)
      const key = renewalKey(s.subscriptionId, periodStart)
      expect(order).toMatchObject({
        kind: 'subscription',
        status: 'paid',
        subscriptionId: s.subscriptionId,
        userId: s.userId,
        planId: business.id,
        idempotenceKey: key,
        savePaymentMethod: false,
        yookassaPaymentId: shop.only().id,
        periodStart,
        periodEnd,
        paidAt: at('2021-02-28T14:00:03.000Z'),
        failureReason: null,
      })
      expect(order.amount.toFixed(2)).toBe('12900.00')
      expect(shop.charges).toEqual([
        {
          idempotenceKey: key,
          input: {
            amount: { value: '12900.00', currency: 'RUB' },
            payment_method_id: s.paymentMethodId,
            description: 'Радити: продление тарифа «Бизнес»',
            metadata: {
              order_id: order.id,
              workspace_id: s.workspaceId,
              subscription_id: s.subscriptionId,
            },
          },
        },
      ])
      expect(state.subscription).toMatchObject({
        status: 'active',
        planId: business.id,
        nextPlanId: null,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        periodAnchor: at('2021-01-31T09:00:00.000Z'),
        renewalNoticePeriodEnd: null,
        pastDueSince: null,
        cancelAtPeriodEnd: false,
        paymentMethodId: s.paymentMethodId,
      })

      // 30 granted, 2 held: 28 expire, 100 come. The pack is not touched.
      expect(state.balances).toEqual({
        tariff: { balance: 102, held: 2, available: 100 },
        gift: NO_GIFT,
        pack: { balance: 10, held: 0, available: 10 },
        totalAvailable: 110,
      })
      // The rows of one transaction carry one moment: compared without their order.
      const ledger = state.ledger.map((entry) => [
        entry.kind,
        entry.amount.toNumber(),
        entry.idempotencyKey,
      ])
      expect(ledger).toHaveLength(4)
      expect(ledger).toEqual(
        expect.arrayContaining([
          ['grant', 30, expect.stringMatching(/^order:.+:grant$/)],
          ['grant', 10, ledgerKeys.packGrant(packOrder.id)],
          ['expire', -28, ledgerKeys.tariffExpiry(s.subscriptionId, periodStart)],
          ['grant', 100, ledgerKeys.tariffGrant(order.id)],
        ]),
      )

      const letter = only(state.letters)
      expect(letter).toMatchObject({
        type: 'billing.payment_succeeded',
        dedupeKey: paymentLetterKey(order.id),
      })
      expect(letter.payload).toEqual({
        item: 'plan',
        planName: 'Бизнес',
        amount: '12900.00',
        periodEnd: periodEnd.toISOString(),
        // The credits of the tariff the renewal paid for, as the grant beside it.
        credits: 100,
        appUrl: TEST_APP_URL,
        to: s.email,
      })
      expect(state.actions).toEqual([renewalAuditActions.renewed])
      expect(state.meta(renewalAuditActions.renewed)).toEqual({
        orderId: order.id,
        planSlug: business.slug,
        planChanged: true,
        amount: '12900.00',
        credits: 100,
        expiredCredits: 28,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        reanchored: false,
        notified: true,
      })
      expect(errors).toEqual([])
    })

    it('changes nothing when the same renewal is played again', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
      await chargeRenewals(deps)
      const before = await written(s)
      const order = only(before.renewals)
      const payment = structuredClone(shop.only())

      // Every way the same outcome may arrive again: the next ticks, the notification, a
      // caller that still holds the order as it was before the payment.
      later(10 * MINUTE)
      await chargeRenewals(deps)
      await settleStuckOrders(deps)
      await sendRenewalNotices(deps)
      await endPeriods(deps)
      expect(await settleOrder({ ...deps, yookassa: shop.client }, { orderId: order.id })).toEqual({
        state: 'paid',
        orderId: order.id,
        refundNeeded: false,
      })
      const stale = { ...order, status: 'pending' as const }
      await Promise.all([
        applyPayment(deps, stale, payment),
        applyPayment(deps, stale, payment),
        applyPayment(deps, stale, payment),
      ])

      const after = await written(s)
      expect(after.subscription).toEqual(before.subscription)
      expect(after.orders).toEqual(before.orders)
      expect(after.ledger).toEqual(before.ledger)
      expect(after.balances).toEqual({
        tariff: { balance: 30, held: 0, available: 30 },
        gift: NO_GIFT,
        pack: { balance: 0, held: 0, available: 0 },
        totalAvailable: 30,
      })
      expect(after.letterTypes).toEqual(['billing.payment_succeeded'])
      expect(after.actions).toEqual([renewalAuditActions.renewed])
      expect(shop.charges).toHaveLength(1)
    })

    it('leaves the gift as it was: a renewal expires and grants credits of the tariff only', async () => {
      const s = await subscribed({ noticed: true })
      const gift = await gifted(s)
      const { deps } = passes('2021-04-10T09:00:00.000Z')

      expect((await chargeRenewals(deps)).counts.renewed).toBe(1)

      const state = await written(s)
      // 30 expire with the period and 30 come. The gift is neither expired nor granted anew.
      expect(state.balances).toEqual({
        tariff: { balance: 30, held: 0, available: 30 },
        gift: { balance: 35, held: 5, available: 30, granted: true },
        pack: { balance: 0, held: 0, available: 0 },
        totalAvailable: 60,
      })
      expect(
        state.ledger.map((entry) => [entry.unit, entry.kind, entry.amount.toNumber()]).sort(),
      ).toEqual(
        [
          ['credit_tariff', 'grant', 30],
          ['credit_gift', 'grant', 35],
          ['credit_tariff', 'expire', -30],
          ['credit_tariff', 'grant', 30],
        ].sort(),
      )
      // Not a column of the account, of its journal or of its reserve moved.
      expect(await giftRows(s.workspaceId)).toEqual(gift)
    })

    it('makes one order and one charge when two passes run at once', async () => {
      const subscriptions = [
        await subscribed({ noticed: true }),
        await subscribed({ noticed: true }),
        await subscribed({ noticed: true }),
      ]
      const { deps, shop, errors } = passes('2021-04-10T09:00:00.000Z')

      const results = await Promise.all([
        chargeRenewals(deps),
        chargeRenewals(deps),
        chargeRenewals(deps),
      ])

      expect(results.reduce((sum, pass) => sum + pass.counts.renewed, 0)).toBe(3)
      expect(shop.charges).toHaveLength(3)
      expect(new Set(shop.charges.map((charge) => charge.idempotenceKey)).size).toBe(3)
      for (const s of subscriptions) {
        const state = await written(s)
        expect(only(state.renewals).status).toBe('paid')
        expect(state.subscription.currentPeriodEnd).toEqual(at(NEXT_END))
        expect(state.balances.tariff).toEqual({ balance: 30, held: 0, available: 30 })
        expect(state.letterTypes).toEqual(['billing.payment_succeeded'])
      }
      expect(errors).toEqual([])
    })

    it('works through the due subscriptions in batches, the earliest period end first', async () => {
      const ends = [
        '2021-04-10T09:00:04.000Z',
        '2021-04-10T09:00:01.000Z',
        '2021-04-10T09:00:05.000Z',
        '2021-04-10T09:00:02.000Z',
        '2021-04-10T09:00:03.000Z',
      ]
      const subscriptions: Subscribed[] = []
      for (const end of ends) subscriptions.push(await subscribed({ end, noticed: true }))
      const { deps, shop } = passes('2021-04-10T10:00:00.000Z')
      deps.settings = { ...deps.settings, batchSize: 2, maxBatches: 2 }
      const keyOf = (index: number) => {
        const s = subscriptions[index]
        if (s === undefined) throw new Error('No such subscription')
        return renewalKey(s.subscriptionId, s.periodEnd)
      }

      // Two batches of two: the four that have waited longest, and the tick is over.
      const first = await chargeRenewals(deps)
      expect(first.counts.renewed).toBe(4)
      expect(first.complete).toBe(false)
      expect(shop.charges.map((charge) => charge.idempotenceKey)).toEqual([
        keyOf(1),
        keyOf(3),
        keyOf(4),
        keyOf(0),
      ])

      const second = await chargeRenewals(deps)
      expect(second.counts.renewed).toBe(1)
      expect(second.complete).toBe(true)
      expect(shop.charges.at(-1)?.idempotenceKey).toBe(keyOf(2))
      expect((await chargeRenewals(deps)).counts.renewed).toBe(0)
      expect(shop.charges).toHaveLength(5)
    })

    it('makes a refusal of the bank a past-due tariff and tells the owner, without a retry', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later, errors } = passes('2021-04-10T09:02:00.000Z')
      shop.willAnswer({ status: 'canceled', reason: 'insufficient_funds' })

      expect((await chargeRenewals(deps)).counts).toMatchObject({ renewed: 0, declined: 1 })

      let state = await written(s)
      const order = only(state.renewals)
      expect(order).toMatchObject({
        status: 'failed',
        failureReason: 'insufficient_funds',
        yookassaPaymentId: shop.only().id,
        paidAt: null,
        periodStart: null,
        periodEnd: null,
      })
      expect(state.subscription).toMatchObject({
        status: 'past_due',
        pastDueSince: at('2021-04-10T09:02:00.000Z'),
        // The period, the plan, the notice and the method stay as they were.
        currentPeriodStart: at(START),
        currentPeriodEnd: at(END),
        planId: s.planId,
        renewalNoticePeriodEnd: at(END),
        paymentMethodId: s.paymentMethodId,
        cancelAtPeriodEnd: false,
      })
      expect(state.balances.tariff).toEqual({ balance: 30, held: 0, available: 30 })
      expect(state.ledger).toHaveLength(1)
      const letter = only(state.letters)
      expect(letter).toMatchObject({
        type: 'billing.payment_failed',
        dedupeKey: paymentFailedLetterKey(order.id),
      })
      expect(letter.payload).toEqual({
        planName: 'Проверочный',
        amount: '4900.00',
        paymentMethod: paymentMethodLabel(CARD),
        // The workspace of the fixture holds no gift: the letter says «не принимаются».
        giftCreditsLeft: 0,
        appUrl: TEST_APP_URL,
        to: s.email,
      })
      expect(state.actions).toEqual([renewalAuditActions.pastDue])
      expect(state.meta(renewalAuditActions.pastDue)).toEqual({
        orderId: order.id,
        reason: 'insufficient_funds',
        amount: '4900.00',
        pastDueSince: '2021-04-10T09:02:00.000Z',
        notified: true,
      })

      // No ticks charge again, and none ends the tariff before the grace is over.
      for (const wait of [10 * MINUTE, DAY, 5 * DAY]) {
        later(wait)
        await sendRenewalNotices(deps)
        await chargeRenewals(deps)
        await settleStuckOrders(deps)
        await endPeriods(deps)
      }
      state = await written(s)
      expect(shop.charges).toHaveLength(1)
      expect(state.orders).toHaveLength(2)
      expect(state.subscription.status).toBe('past_due')
      expect(state.letters).toHaveLength(1)
      expect(errors).toEqual([])
    })

    it('tells the letter of a refused charge the gift credits that still take tasks', async () => {
      const s = await subscribed({ noticed: true })
      const gift = await gifted(s)
      const { deps, shop } = passes('2021-04-10T09:02:00.000Z')
      shop.willAnswer({ status: 'canceled', reason: 'insufficient_funds' })

      expect((await chargeRenewals(deps)).counts).toMatchObject({ renewed: 0, declined: 1 })

      const state = await written(s)
      expect(state.subscription.status).toBe('past_due')
      // What can be spent, not the balance: 35 granted, 5 of them held by a task. With it the
      // letter says «принимаются, только пока есть подарочные кредиты», as «Тарифы» does.
      expect(only(state.letters)).toMatchObject({
        type: 'billing.payment_failed',
        payload: { giftCreditsLeft: 30 },
      })
      // The gift itself is not touched by the refusal.
      expect(await giftRows(s.workspaceId)).toEqual(gift)
    })

    it.each([
      [400, 'invalid_request'],
      [404, 'not_found'],
    ])(
      'closes the order at once when the shop refuses the request itself with %i: past due, the owner told, nothing repeated',
      async (status, code) => {
        const s = await subscribed({ noticed: true })
        const { deps, shop, later, errors } = passes('2021-04-10T09:02:00.000Z')
        // For example the shop does not know the saved payment method: it made no payment.
        const refusal = new YookassaApiError(`${code}: payment_method_id`, status, code, {})
        shop.failCharge(refusal)

        expect((await chargeRenewals(deps)).counts).toMatchObject({
          declined: 1,
          unanswered: 0,
          failed: 0,
        })

        let state = await written(s)
        const order = only(state.renewals)
        expect(order).toMatchObject({
          status: 'failed',
          failureReason: orderFailureReasons.chargeRejected,
          yookassaPaymentId: null,
          paidAt: null,
        })
        expect(state.subscription).toMatchObject({
          status: 'past_due',
          pastDueSince: at('2021-04-10T09:02:00.000Z'),
          currentPeriodEnd: at(END),
          paymentMethodId: s.paymentMethodId,
        })
        expect(state.ledger).toHaveLength(1)
        const letter = only(state.letters)
        expect(letter).toMatchObject({
          type: 'billing.payment_failed',
          dedupeKey: paymentFailedLetterKey(order.id),
        })
        expect(letter.payload).toMatchObject({ planName: 'Проверочный', amount: '4900.00' })
        // Not «nobody can tell»: no operator is sent to look for a payment that was not made.
        expect(state.actions).toEqual([renewalAuditActions.pastDue])
        expect(state.meta(renewalAuditActions.pastDue)).toEqual({
          orderId: order.id,
          reason: orderFailureReasons.chargeRejected,
          amount: '4900.00',
          pastDueSince: '2021-04-10T09:02:00.000Z',
          notified: true,
          shopStatus: status,
          shopError: `${code}: payment_method_id`,
        })
        // The row is finished: nothing is left for the next tick to report.
        expect(errors).toEqual([])

        // The same request is never sent again, and the order is not given up as unknown.
        for (const wait of [STUCK_ORDER_AFTER_MS, RENEWAL_RETRY_WINDOW_MS, DAY]) {
          later(wait)
          await sendRenewalNotices(deps)
          await chargeRenewals(deps)
          await settleStuckOrders(deps)
        }
        state = await written(s)
        expect(shop.charges).toHaveLength(1)
        expect(state.orders).toHaveLength(2)
        expect(only(state.renewals).failureReason).toBe(orderFailureReasons.chargeRejected)
        expect(state.actions).toEqual([renewalAuditActions.pastDue])
        expect(state.letters).toHaveLength(1)
      },
    )

    it('leaves the order to its payment when one was stored while the refusal was on its way', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop } = passes('2021-04-10T09:00:00.000Z')
      const paymentId = `late-${s.subscriptionId}`
      shop.client.chargeWithSavedMethod = async (_input, idempotenceKey) => {
        // Another pass got an answer for the same order meanwhile.
        await db.order.updateMany({
          where: { idempotenceKey },
          data: { yookassaPaymentId: paymentId },
        })
        throw new YookassaApiError('invalid_request', 400, 'invalid_request', {})
      }

      expect((await chargeRenewals(deps)).counts).toMatchObject({ skipped: 1, declined: 0 })

      const state = await written(s)
      expect(only(state.renewals)).toMatchObject({
        status: 'pending',
        failureReason: null,
        yookassaPaymentId: paymentId,
      })
      expect(state.subscription.status).toBe('active')
      expect(state.letters).toEqual([])
      expect(state.audit).toEqual([])
    })

    it.each([
      ['a timeout', timeout],
      ['an answer 500', serverError],
      ['an answer 429', () => new YookassaApiError('too_many_requests', 429, undefined, {})],
      ['a shop that does not know us', () => new YookassaApiError('invalid', 401, undefined, {})],
      // What a real shop answers when it has no right to the operation (AnyNote, 13.05.2026).
      [
        'a shop without the right to autopayments',
        () =>
          new YookassaApiError(
            'forbidden: Магазин не имеет права на проведение операции',
            403,
            'forbidden',
            {},
          ),
      ],
    ])('decides nothing after %s: the order stays pending', async (_case, error) => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, errors } = passes('2021-04-10T09:00:00.000Z')
      const failure = error()
      shop.failCharge(failure)

      expect((await chargeRenewals(deps)).counts).toMatchObject({
        renewed: 0,
        declined: 0,
        unanswered: 1,
        failed: 0,
      })

      const state = await written(s)
      expect(only(state.renewals)).toMatchObject({
        status: 'pending',
        yookassaPaymentId: null,
        failureReason: null,
        createdAt: at('2021-04-10T09:00:00.000Z'),
      })
      // Not ended, not past due, nothing expired or granted, nobody told.
      expect(state.subscription).toMatchObject({
        status: 'active',
        pastDueSince: null,
        currentPeriodEnd: at(END),
      })
      expect(state.ledger).toHaveLength(1)
      expect(state.letters).toEqual([])
      expect(state.actions).toEqual([])
      expect(errors).toEqual([{ job: 'charges', id: s.subscriptionId, error: failure }])

      // The next ticks of this pass leave the order to the pass of stuck orders: no second
      // order, no second request.
      await chargeRenewals(deps)
      await endPeriods(deps)
      expect(shop.charges).toHaveLength(1)
      expect((await written(s)).orders).toHaveLength(2)
    })

    it.each([
      ['does not answer', timeout],
      ['answers 500', serverError],
      ['does not know us', () => new YookassaApiError('invalid_credentials', 401, undefined, {})],
      [
        'has no right to autopayments',
        () => new YookassaApiError('forbidden', 403, 'forbidden', {}),
      ],
    ])('stops a pass after a few requests in a row when the shop %s', async (_case, error) => {
      const subscriptions: Subscribed[] = []
      for (let index = 0; index < 5; index += 1) {
        subscriptions.push(
          await subscribed({ end: `2021-04-10T09:00:0${index}.000Z`, noticed: true }),
        )
      }
      const { deps, shop } = passes('2021-04-10T09:01:00.000Z')
      for (let index = 0; index < 5; index += 1) shop.failCharge(error())

      const pass = await chargeRenewals(deps)

      // The rows behind are not started: no order of theirs waits for a shop that is away.
      expect(pass.counts.unanswered).toBe(3)
      expect(pass.complete).toBe(false)
      expect(shop.charges).toHaveLength(3)
      const started = await Promise.all(subscriptions.map(async (s) => (await written(s)).renewals))
      expect(started.map((orders) => orders.length)).toEqual([1, 1, 1, 0, 0])
    })

    it('goes on past the rows whose request the shop refused: they do not hold up the others', async () => {
      const subscriptions: Subscribed[] = []
      for (let index = 0; index < 5; index += 1) {
        subscriptions.push(
          await subscribed({ end: `2021-04-10T09:00:0${index}.000Z`, noticed: true }),
        )
      }
      const { deps, shop } = passes('2021-04-10T09:01:00.000Z')
      // Something about these three payments themselves; the shop serves the next ones.
      for (let index = 0; index < 3; index += 1) {
        shop.failCharge(new YookassaApiError('invalid_request', 400, 'invalid_request', {}))
      }

      const pass = await chargeRenewals(deps)

      // A refusal is an answer: the three are closed, and the pass is not stopped by them.
      expect(pass.counts).toMatchObject({ declined: 3, unanswered: 0, renewed: 2 })
      expect(pass.complete).toBe(true)
      const states = await Promise.all(subscriptions.map((s) => written(s)))
      expect(states.map((state) => only(state.renewals).status)).toEqual([
        'failed',
        'failed',
        'failed',
        'paid',
        'paid',
      ])
      expect(states.map((state) => state.subscription.status)).toEqual([
        'past_due',
        'past_due',
        'past_due',
        'active',
        'active',
      ])
    })

    it('stops after the row it is at when the process shuts down', async () => {
      const subscriptions: Subscribed[] = []
      for (let index = 0; index < 4; index += 1) {
        subscriptions.push(
          await subscribed({ end: `2021-04-10T09:00:0${index}.000Z`, noticed: true }),
        )
      }
      const { deps, shop } = passes('2021-04-10T09:01:00.000Z')
      const shutdown = new AbortController()
      const charge = shop.client.chargeWithSavedMethod
      shop.client.chargeWithSavedMethod = async (input, idempotenceKey) => {
        // The signal arrives while the second charge is on its way.
        if (shop.charges.length === 1) shutdown.abort()
        return charge(input, idempotenceKey)
      }

      const pass = await chargeRenewals({ ...deps, signal: shutdown.signal })

      // The second row is finished, not dropped half-way; the others wait for the next start.
      expect(pass.counts.renewed).toBe(2)
      expect(pass.complete).toBe(false)
      const periods = await Promise.all(
        subscriptions.map(
          async (s) => (await written(s)).subscription.currentPeriodEnd > at(HALF_WAY),
        ),
      )
      expect(periods).toEqual([true, true, false, false])

      // A pass that starts after the signal touches nothing.
      const late = await chargeRenewals({ ...deps, signal: shutdown.signal })
      expect(late).toMatchObject({ complete: false, counts: { renewed: 0, skipped: 0 } })
      expect(shop.charges).toHaveLength(2)
      expect((await chargeRenewals(deps)).counts.renewed).toBe(2)
    })

    it('fails the order and asks for the money back when the charge is not what was asked', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop } = passes('2021-04-10T09:00:00.000Z')
      shop.createAs({ amount: { value: '49.00', currency: 'RUB' } })

      expect((await chargeRenewals(deps)).counts.refund_needed).toBe(1)

      const state = await written(s)
      const order = only(state.renewals)
      expect(order).toMatchObject({
        status: 'failed',
        failureReason: orderFailureReasons.amountMismatch,
      })
      // Not renewed: the customer pays by hand, and an operator returns what came.
      expect(state.subscription).toMatchObject({
        status: 'past_due',
        currentPeriodEnd: at(END),
      })
      expect(state.ledger).toHaveLength(1)
      expect(state.actions).toEqual([
        settlementAuditActions.refundNeeded,
        renewalAuditActions.pastDue,
      ])
      expect(state.meta(settlementAuditActions.refundNeeded)).toMatchObject({
        reason: refundReasons.amountMismatch,
        orderAmount: '4900.00',
        paidAmount: '49.00',
      })
      // «Не получилось списать» would not be true: the money was taken.
      expect(state.letters).toEqual([])
    })

    it('asks for the money back when the order was closed while the charge request was on its way', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
      const charge = shop.client.chargeWithSavedMethod
      shop.client.chargeWithSavedMethod = async (input, idempotenceKey) => {
        // An operator cancels the order while the shop is taking the money.
        await db.order.updateMany({ where: { idempotenceKey }, data: { status: 'cancelled' } })
        return charge(input, idempotenceKey)
      }

      expect((await chargeRenewals(deps)).counts).toMatchObject({
        refund_needed: 1,
        renewed: 0,
        failed: 0,
      })

      let state = await written(s)
      const order = only(state.renewals)
      expect(order).toMatchObject({ status: 'cancelled', yookassaPaymentId: null, paidAt: null })
      // Nothing was applied: the period did not move, no quota came.
      expect(state.subscription).toMatchObject({ status: 'active', currentPeriodEnd: at(END) })
      expect(state.ledger).toHaveLength(1)
      expect(state.letters).toEqual([])
      expect(state.actions).toEqual([settlementAuditActions.refundNeeded])
      expect(state.meta(settlementAuditActions.refundNeeded)).toMatchObject({
        reason: refundReasons.orderClosed,
        orderStatus: 'cancelled',
        paymentId: shop.only().id,
        orderAmount: '4900.00',
        paidAmount: '4900.00',
      })

      // The period had its one charge: the tariff is past due, and the owner is not told
      // that the charge failed — the money was taken.
      later(MINUTE)
      expect((await chargeRenewals(deps)).counts).toMatchObject({ declined: 1, refund_needed: 0 })
      state = await written(s)
      expect(state.subscription.status).toBe('past_due')
      expect(state.meta(renewalAuditActions.pastDue)).toMatchObject({ notified: false })
      expect(state.letters).toEqual([])
      expect(shop.charges).toHaveLength(1)
      expect(
        state.audit.filter((entry) => entry.action === settlementAuditActions.refundNeeded),
      ).toHaveLength(1)
    })

    it.each([
      [
        'another unfinished tariff order of the workspace stands in the way',
        // A checkout that broke off before the shop was asked: a workspace holds one
        // unfinished tariff order at most.
        (s: Subscribed) => ({
          status: 'pending' as const,
          createdAt: at('2021-04-09T09:00:00.000Z'),
          workspaceId: s.workspaceId,
          planId: s.planId,
        }),
      ],
      [
        'the order of the period is paid though the period did not move',
        // An operator holds its refund entry; the period keeps its one charge.
        (s: Subscribed) => ({
          status: 'paid' as const,
          subscriptionId: s.subscriptionId,
          idempotenceKey: renewalKey(s.subscriptionId, s.periodEnd),
          paidAt: at('2021-04-10T09:00:00.000Z'),
          createdAt: at('2021-04-10T09:00:00.000Z'),
          workspaceId: s.workspaceId,
          planId: s.planId,
        }),
      ],
    ])('is not made while %s', async (_case, blocking) => {
      const s = await subscribed({ noticed: true })
      const inTheWay = await fixtures.order(blocking(s))
      const { deps, shop, errors } = passes('2021-04-10T09:01:00.000Z')

      for (let tick = 0; tick < 2; tick += 1) {
        expect((await chargeRenewals(deps)).counts).toMatchObject({
          blocked: 1,
          renewed: 0,
          failed: 0,
        })
      }

      const state = await written(s)
      expect(shop.charges).toEqual([])
      expect(state.orders.map((order) => order.id)).toEqual(expect.arrayContaining([inTheWay.id]))
      expect(state.orders).toHaveLength(2)
      expect(state.subscription).toMatchObject({
        status: 'active',
        currentPeriodEnd: at(END),
        renewalNoticePeriodEnd: at(END),
      })
      expect(state.audit).toEqual([])
      expect(errors).toEqual([])
    })

    it('still buys a month when the period end is not a boundary of the anchor', async () => {
      // Dates changed by hand, as a stand moves time: the end is two days off the anchor's day.
      const s = await subscribed({ end: '2021-04-12T09:00:00.000Z', noticed: true })
      const { deps } = passes('2021-04-12T09:00:00.000Z')

      expect((await chargeRenewals(deps)).counts.renewed).toBe(1)

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: at('2021-04-12T09:00:00.000Z'),
        currentPeriodEnd: at('2021-05-12T09:00:00.000Z'),
        // The months go on from that end.
        periodAnchor: at('2021-04-12T09:00:00.000Z'),
      })
      expect(state.meta(renewalAuditActions.renewed)).toMatchObject({ reanchored: true })
      expect(state.balances.tariff.available).toBe(30)
    })
  })

  describe('a charge without an outcome', () => {
    it('is repeated under the same key after a few minutes and finds the payment that was made', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
      // The shop made the payment; only its answer was lost.
      shop.failCharge(serverError(), { processed: true })
      await chargeRenewals(deps)
      expect(only((await written(s)).renewals).status).toBe('pending')

      // Too early to call it stuck.
      later(STUCK_ORDER_AFTER_MS - 1)
      expect((await settleStuckOrders(deps)).counts.paid).toBe(0)
      expect(shop.charges).toHaveLength(1)

      later(1)
      expect((await settleStuckOrders(deps)).counts).toMatchObject({ paid: 1, failed: 0 })

      const state = await written(s)
      const order = only(state.renewals)
      expect(order).toMatchObject({ status: 'paid', yookassaPaymentId: shop.only().id })
      // The same request twice, one payment, one period.
      expect(shop.charges.map((charge) => charge.idempotenceKey)).toEqual([
        order.idempotenceKey,
        order.idempotenceKey,
      ])
      expect(shop.charges[1]?.input).toEqual(shop.charges[0]?.input)
      expect(shop.payments.size).toBe(1)
      expect(state.subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: at(END),
        currentPeriodEnd: at(NEXT_END),
      })
      expect(state.balances.tariff).toEqual({ balance: 30, held: 0, available: 30 })
      expect(state.letterTypes).toEqual(['billing.payment_succeeded'])

      later(MINUTE)
      await settleStuckOrders(deps)
      expect(shop.charges).toHaveLength(2)
    })

    it('is repeated on every tick of the first twelve hours while the shop keeps silent', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later, errors } = passes('2021-04-10T09:00:00.000Z')
      shop.failCharge(timeout())
      await chargeRenewals(deps)

      later(RENEWAL_RETRY_WINDOW_MS - 1)
      shop.failCharge(timeout())
      expect((await settleStuckOrders(deps)).counts.unanswered).toBe(1)
      expect(shop.charges).toHaveLength(2)
      expect(errors.map((report) => [report.job, report.id])).toEqual([
        ['charges', s.subscriptionId],
        ['stuck_orders', only((await written(s)).renewals).id],
      ])

      // At twelve hours the key may not be trusted for long: no more requests.
      later(1)
      expect((await settleStuckOrders(deps)).counts).toMatchObject({ waiting: 1, gave_up: 0 })
      expect(shop.charges).toHaveLength(2)
      const state = await written(s)
      expect(only(state.renewals).status).toBe('pending')
      expect(state.subscription.status).toBe('active')
    })

    it('is not decided by a refusal of the repeat: the request before it may have been served', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later, errors } = passes('2021-04-10T09:00:00.000Z')
      shop.failCharge(timeout())
      await chargeRenewals(deps)

      later(STUCK_ORDER_AFTER_MS)
      const refusal = new YookassaApiError('invalid_request', 400, 'invalid_request', {})
      shop.failCharge(refusal)
      expect((await settleStuckOrders(deps)).counts).toMatchObject({ unanswered: 1, failed: 0 })

      let state = await written(s)
      const order = only(state.renewals)
      expect(order).toMatchObject({ status: 'pending', failureReason: null })
      expect(state.subscription.status).toBe('active')
      expect(state.letters).toEqual([])
      expect(state.actions).toEqual([])
      expect(errors.at(-1)).toEqual({ job: 'stuck_orders', id: order.id, error: refusal })

      // The order is still the one to repeat: the next request is served.
      later(STUCK_ORDER_AFTER_MS)
      expect((await settleStuckOrders(deps)).counts.paid).toBe(1)
      state = await written(s)
      expect(state.subscription.currentPeriodEnd).toEqual(at(NEXT_END))
      expect(shop.charges).toHaveLength(3)
    })

    it('is given up after twelve hours: the order fails as unknown, the tariff is past due and an operator is asked', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
      shop.failCharge(timeout())
      await chargeRenewals(deps)

      later(RENEWAL_RETRY_WINDOW_MS + RENEWAL_GIVE_UP_MARGIN_MS)
      expect((await settleStuckOrders(deps)).counts).toMatchObject({ gave_up: 1, unanswered: 0 })

      const state = await written(s)
      const order = only(state.renewals)
      expect(order).toMatchObject({
        status: 'failed',
        failureReason: orderFailureReasons.unknownResult,
        yookassaPaymentId: null,
      })
      expect(state.subscription).toMatchObject({
        status: 'past_due',
        pastDueSince: deps.now?.(),
        currentPeriodEnd: at(END),
      })
      expect(state.actions).toEqual([
        renewalAuditActions.unknownResult,
        renewalAuditActions.pastDue,
      ])
      expect(state.meta(renewalAuditActions.unknownResult)).toEqual({
        subscriptionId: s.subscriptionId,
        amount: '4900.00',
        idempotenceKey: order.idempotenceKey,
        orderCreatedAt: '2021-04-10T09:00:00.000Z',
        pastDue: true,
      })
      // Nobody knows whether the money was taken: no «оплата не прошла», no second request.
      expect(state.letters).toEqual([])
      expect(shop.charges).toHaveLength(1)
      expect(state.ledger).toHaveLength(1)

      // Given up once.
      later(DAY)
      expect((await settleStuckOrders(deps)).counts.gave_up).toBe(0)
      expect((await written(s)).audit).toHaveLength(2)
    })

    it('waits for a payment the shop does not know, and is given up as unknown after twelve hours', async () => {
      const s = await subscribed({ noticed: true })
      // The order holds a payment of another shop, or of a stand that was restarted.
      const paymentId = `gone-${s.subscriptionId}`
      const order = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: s.planId,
        userId: s.userId,
        subscriptionId: s.subscriptionId,
        status: 'pending',
        idempotenceKey: renewalKey(s.subscriptionId, s.periodEnd),
        yookassaPaymentId: paymentId,
        createdAt: at('2021-04-10T09:00:00.000Z'),
      })
      const { deps, shop, later, errors } = passes('2021-04-10T10:00:00.000Z')

      // Not cancelled like an order of another kind: the charge may have been made.
      expect((await settleStuckOrders(deps)).counts).toMatchObject({
        waiting: 1,
        cancelled: 0,
        gave_up: 0,
      })
      expect((await endPeriods(deps)).counts.cancelled).toBe(0)
      let state = await written(s)
      expect(only(state.renewals).status).toBe('pending')
      expect(state.subscription.status).toBe('active')

      later(12 * HOUR)
      expect((await settleStuckOrders(deps)).counts).toMatchObject({ gave_up: 1, waiting: 0 })

      state = await written(s)
      expect(only(state.renewals)).toMatchObject({
        id: order.id,
        status: 'failed',
        failureReason: orderFailureReasons.unknownResult,
        yookassaPaymentId: paymentId,
      })
      expect(state.subscription).toMatchObject({
        status: 'past_due',
        pastDueSince: deps.now?.(),
        currentPeriodEnd: at(END),
      })
      expect(state.actions).toEqual([
        renewalAuditActions.unknownResult,
        renewalAuditActions.pastDue,
      ])
      expect(state.letters).toEqual([])
      // Asked about, never charged again.
      expect(shop.reads).toEqual([paymentId, paymentId])
      expect(shop.charges).toEqual([])
      expect(errors).toEqual([])
    })

    it('is not repeated for a customer who switched auto-renewal off meanwhile; the tariff then ends with its period', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
      shop.failCharge(timeout())
      await chargeRenewals(deps)
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { cancelAtPeriodEnd: true, cancelledAt: at('2021-04-10T09:03:00.000Z') },
      })

      later(HOUR)
      expect((await settleStuckOrders(deps)).counts.waiting).toBe(1)
      // While the charge may still have been made, the tariff is not ended either.
      expect((await endPeriods(deps)).counts.cancelled).toBe(0)
      expect(shop.charges).toHaveLength(1)
      expect((await written(s)).subscription.status).toBe('active')

      later(RENEWAL_RETRY_WINDOW_MS)
      expect((await settleStuckOrders(deps)).counts.gave_up).toBe(1)
      let state = await written(s)
      expect(only(state.renewals).failureReason).toBe(orderFailureReasons.unknownResult)
      // Not past due: the customer did not want the next period.
      expect(state.subscription.status).toBe('active')
      expect(state.meta(renewalAuditActions.unknownResult)).toMatchObject({ pastDue: false })

      expect((await endPeriods(deps)).counts.cancelled).toBe(1)
      state = await written(s)
      expect(state.subscription.status).toBe('cancelled')
      expect(state.letterTypes).toEqual(['billing.subscription_ended'])
    })

    it('is not repeated once the owner has been told of another charge than its order', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
      shop.failCharge(timeout())
      await chargeRenewals(deps)
      // A change of plan is scheduled while nobody knows what became of the charge, and its
      // notice goes out: the last letter names 12 900 ₽ for «Бизнес».
      const business = await fixtures.plan({
        name: 'Бизнес',
        price: '12900.00',
        creditsPerMonth: 100,
      })
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { nextPlanId: business.id, renewalNoticePeriodEnd: null },
      })
      expect((await sendRenewalNotices(deps)).counts.notified).toBe(1)

      // The order would take 4 900 ₽ for the old plan: not what the owner was told last.
      later(HOUR)
      expect((await settleStuckOrders(deps)).counts).toMatchObject({ waiting: 1, unanswered: 0 })
      expect((await chargeRenewals(deps)).counts.renewed).toBe(0)
      expect(shop.charges).toHaveLength(1)

      later(RENEWAL_RETRY_WINDOW_MS)
      expect((await settleStuckOrders(deps)).counts.gave_up).toBe(1)
      const state = await written(s)
      expect(only(state.renewals)).toMatchObject({
        status: 'failed',
        failureReason: orderFailureReasons.unknownResult,
        planId: s.planId,
      })
      expect(state.subscription).toMatchObject({ status: 'past_due', nextPlanId: business.id })
      expect(shop.charges).toHaveLength(1)
    })

    it('is finished when the payment that was pending gets its outcome', async () => {
      const paid = await subscribed({ noticed: true })
      const declined = await subscribed({ end: '2021-04-10T09:00:01.000Z', noticed: true })
      const { deps, shop, later } = passes('2021-04-10T09:00:01.000Z')
      shop.willAnswer({ status: 'pending' })
      shop.willAnswer({ status: 'pending' })

      expect((await chargeRenewals(deps)).counts.pending).toBe(2)
      const paidOrder = only((await written(paid)).renewals)
      const declinedOrder = only((await written(declined)).renewals)
      expect(paidOrder).toMatchObject({ status: 'pending' })
      expect(paidOrder.yookassaPaymentId).not.toBeNull()

      // No outcome yet: read back, nothing changes, nothing is charged again.
      later(STUCK_ORDER_AFTER_MS)
      expect((await settleStuckOrders(deps)).counts.pending).toBe(2)
      expect((await endPeriods(deps)).counts.cancelled).toBe(0)
      expect((await written(paid)).subscription.status).toBe('active')

      shop.succeed(paidOrder.yookassaPaymentId ?? '', { saved: true })
      shop.cancel(declinedOrder.yookassaPaymentId ?? '', 'card_expired')
      later(MINUTE)
      expect((await settleStuckOrders(deps)).counts).toMatchObject({ paid: 1, failed: 1 })

      expect((await written(paid)).subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: at(END),
        currentPeriodEnd: at(NEXT_END),
      })
      const state = await written(declined)
      expect(only(state.renewals)).toMatchObject({
        status: 'failed',
        failureReason: 'card_expired',
      })
      expect(state.subscription.status).toBe('past_due')
      expect(state.letterTypes).toEqual(['billing.payment_failed'])
      expect(shop.charges).toHaveLength(2)
    })

    it.each([
      // Switching auto-renewal on clears the notice: the notice pass meets the row first.
      ['the notice pass', { renewalNoticePeriodEnd: null }, { notices: 1, charges: 0 }],
      // Should the mark ever be left in place, the charge pass decides the same.
      ['the charge pass', {}, { notices: 0, charges: 1 }],
    ])(
      'leaves the tariff past due and tells the owner, with no notice and no second charge, when auto-renewal comes back after the charge of the period failed (%s)',
      async (_pass, resumed, moved) => {
        const s = await subscribed({ noticed: true })
        const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
        shop.willAnswer({ status: 'pending' })
        await chargeRenewals(deps)
        const order = only((await written(s)).renewals)
        // The customer switches auto-renewal off while the bank is thinking; the bank says no.
        await db.subscription.update({
          where: { id: s.subscriptionId },
          data: { cancelAtPeriodEnd: true, cancelledAt: at('2021-04-10T09:01:00.000Z') },
        })
        shop.cancel(order.yookassaPaymentId ?? '', 'insufficient_funds')
        later(STUCK_ORDER_AFTER_MS)
        expect((await settleStuckOrders(deps)).counts.failed).toBe(1)
        let state = await written(s)
        // The tariff was to end with its period: not past due, and nobody is told of a debt.
        expect(state.subscription.status).toBe('active')
        expect(state.letters).toEqual([])

        // Before the tariff is ended the customer switches auto-renewal on again. The period
        // keeps its one charge, and that charge did not bring the money.
        await db.subscription.update({
          where: { id: s.subscriptionId },
          data: { cancelAtPeriodEnd: false, cancelledAt: null, ...resumed },
        })
        expect((await endPeriods(deps)).counts.cancelled).toBe(0)
        expect((await sendRenewalNotices(deps)).counts).toMatchObject({
          notified: 0,
          past_due: moved.notices,
        })
        expect((await chargeRenewals(deps)).counts).toMatchObject({
          declined: moved.charges,
          renewed: 0,
        })

        state = await written(s)
        expect(state.subscription).toMatchObject({
          status: 'past_due',
          pastDueSince: deps.now?.(),
          currentPeriodEnd: at(END),
        })
        expect(state.renewals).toHaveLength(1)
        expect(shop.charges).toHaveLength(1)
        // Not «списание назначено»: the charge was made, and the bank said no.
        expect(only(state.letters)).toMatchObject({
          type: 'billing.payment_failed',
          dedupeKey: paymentFailedLetterKey(order.id),
        })
        expect(state.actions).toEqual([renewalAuditActions.pastDue])
        expect(state.meta(renewalAuditActions.pastDue)).toEqual({
          orderId: order.id,
          reason: 'insufficient_funds',
          amount: '4900.00',
          pastDueSince: deps.now?.().toISOString(),
          notified: true,
        })
        // And it stays so on the next ticks.
        later(MINUTE)
        expect((await sendRenewalNotices(deps)).counts.past_due).toBe(0)
        expect((await chargeRenewals(deps)).counts.declined).toBe(0)
        state = await written(s)
        expect(state.audit).toHaveLength(1)
        expect(state.letters).toHaveLength(1)
      },
    )

    it('does not tell the owner that the charge failed when nobody knows what became of it', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
      shop.failCharge(timeout())
      await chargeRenewals(deps)
      // Auto-renewal is off while the charge is given up, and on again before the tariff ends.
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { cancelAtPeriodEnd: true, cancelledAt: at('2021-04-10T09:03:00.000Z') },
      })
      later(RENEWAL_RETRY_WINDOW_MS + RENEWAL_GIVE_UP_MARGIN_MS)
      expect((await settleStuckOrders(deps)).counts.gave_up).toBe(1)
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { cancelAtPeriodEnd: false, cancelledAt: null, renewalNoticePeriodEnd: null },
      })

      expect((await sendRenewalNotices(deps)).counts).toMatchObject({ notified: 0, past_due: 1 })

      const state = await written(s)
      expect(state.subscription.status).toBe('past_due')
      // «Не получилось списать» may be untrue: the money may have been taken.
      expect(state.letters).toEqual([])
      expect(state.meta(renewalAuditActions.pastDue)).toMatchObject({
        reason: orderFailureReasons.unknownResult,
        notified: false,
      })
      expect(shop.charges).toHaveLength(1)
    })

    it('ends as a refund request when the money comes for a subscription that moved on', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
      shop.willAnswer({ status: 'pending' })
      await chargeRenewals(deps)
      const order = only((await written(s)).renewals)
      // An operator closed the subscription while the bank was thinking.
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { status: 'expired' },
      })
      shop.succeed(order.yookassaPaymentId ?? '', { saved: true })

      later(STUCK_ORDER_AFTER_MS)
      expect((await settleStuckOrders(deps)).counts.refund_needed).toBe(1)

      const state = await written(s)
      expect(only(state.renewals)).toMatchObject({
        status: 'paid',
        periodStart: null,
        periodEnd: null,
      })
      expect(state.subscription).toMatchObject({ status: 'expired', currentPeriodEnd: at(END) })
      expect(state.ledger).toHaveLength(1)
      expect(state.letters).toEqual([])
      expect(state.actions).toEqual([settlementAuditActions.refundNeeded])
      expect(state.meta(settlementAuditActions.refundNeeded)).toMatchObject({
        reason: refundReasons.staleRenewal,
        orderStatus: 'paid',
        paidAmount: '4900.00',
      })
    })
  })

  describe('stuck orders of other kinds', () => {
    it('settles a first payment whose notification was lost', async () => {
      const { userId, email } = await fixtures.user()
      emails.push(email)
      const plan = await fixtures.plan({ isActive: true })
      const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
      const { orderId } = await startCheckout(
        { ...deps, yookassa: shop.client, appEnv: 'test', autopayments: true },
        { userId, planSlug: plan.slug, autoRenew: false },
      )
      // The order was made at the moment the test stands at.
      await db.order.update({
        where: { id: orderId },
        data: { createdAt: at('2021-04-10T09:00:00.000Z') },
      })
      shop.succeed(shop.only().id, { capturedAt: '2021-04-10T09:01:00.000Z' })

      later(STUCK_ORDER_AFTER_MS - 1)
      expect((await settleStuckOrders(deps)).counts.paid).toBe(0)
      later(1)
      expect((await settleStuckOrders(deps)).counts.paid).toBe(1)

      const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })
      expect(order.status).toBe('paid')
      const subscription = await db.subscription.findFirstOrThrow({
        where: { workspaceId: order.workspaceId },
      })
      expect(subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: at('2021-04-10T09:01:00.000Z'),
        cancelAtPeriodEnd: true,
      })
      expect((await lettersTo(email)).map((letter) => letter.type)).toEqual([
        'billing.payment_succeeded',
      ])
    })

    it('is not kept from an order it can finish by older ones nobody can pay', async () => {
      const s = await subscribed({ noticed: true })
      const pack = await fixtures.plan({ kind: 'pack', packCredits: 10, maxSites: null })
      // Checkouts that broke off before the shop was asked, older than the order the pass can
      // finish and not an hour old yet: nothing closes them so far.
      for (let index = 0; index < 3; index += 1) {
        await fixtures.order({
          workspaceId: s.workspaceId,
          planId: pack.id,
          kind: 'pack',
          status: 'pending',
          createdAt: at(`2021-04-10T08:3${index}:00.000Z`),
        })
      }
      const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
      shop.failCharge(serverError(), { processed: true })
      await chargeRenewals(deps)
      later(STUCK_ORDER_AFTER_MS)
      // One row per tick is all the pass takes here.
      deps.settings = { ...deps.settings, batchSize: 1, maxBatches: 1 }

      expect((await settleStuckOrders(deps)).counts).toMatchObject({ paid: 1, skipped: 0 })

      expect((await written(s)).subscription.currentPeriodEnd).toEqual(at(NEXT_END))
      expect(
        await db.order.count({ where: { workspaceId: s.workspaceId, status: 'pending' } }),
      ).toBe(3)
    })

    it('looks at an order once per pass, however long it stays unfinished', async () => {
      const waiting: Subscribed[] = []
      for (let index = 0; index < 3; index += 1) {
        waiting.push(await subscribed({ end: `2021-04-10T09:00:0${index}.000Z`, noticed: true }))
      }
      const { deps, shop, later } = passes('2021-04-10T09:01:00.000Z')
      for (let index = 0; index < 3; index += 1) shop.willAnswer({ status: 'pending' })
      await chargeRenewals(deps)
      later(STUCK_ORDER_AFTER_MS)
      // Batches smaller than what is stuck: the orders stay pending after they are read.
      deps.settings = { ...deps.settings, batchSize: 2, maxBatches: 5 }

      const pass = await settleStuckOrders(deps)

      expect(pass.counts.pending).toBe(3)
      expect(pass.complete).toBe(true)
      // One question to the shop per order, the oldest order first, and none asked twice.
      const paymentIds = await Promise.all(
        waiting.map(async (s) => only((await written(s)).renewals).yookassaPaymentId),
      )
      expect(shop.reads).toEqual(paymentIds)
    })

    it('closes an order whose payment the shop does not know, and leaves alone a young one that never had a payment', async () => {
      const s = await subscribed({ autoRenewal: false, end: '2021-06-10T09:00:00.000Z' })
      const other = await subscribed({ autoRenewal: false, end: '2021-06-10T09:00:00.000Z' })
      const pack = await fixtures.plan({ kind: 'pack', packCredits: 10, maxSites: null })
      const unknown = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: pack.id,
        kind: 'pack',
        status: 'pending',
        yookassaPaymentId: `gone-${s.subscriptionId}`,
        createdAt: at('2021-04-10T08:00:00.000Z'),
      })
      const unstarted = await fixtures.order({
        workspaceId: other.workspaceId,
        planId: pack.id,
        kind: 'pack',
        status: 'pending',
        createdAt: at('2021-04-10T08:00:00.001Z'),
      })
      const { deps, shop, errors } = passes('2021-04-10T09:00:00.000Z')

      // A checkout without a payment is its customer's for an hour and is not even read until
      // then: it would be there on every tick.
      expect((await settleStuckOrders(deps)).counts).toMatchObject({ cancelled: 1, skipped: 0 })

      expect((await db.order.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe(
        'cancelled',
      )
      expect((await db.order.findUniqueOrThrow({ where: { id: unstarted.id } })).status).toBe(
        'pending',
      )
      expect(shop.reads).toEqual([unknown.yookassaPaymentId])
      expect(shop.charges).toEqual([])
      expect(errors).toEqual([])
    })
  })

  describe('a checkout that broke off before its payment was stored', () => {
    const BROKE_OFF = '2021-04-10T08:00:00.000Z'

    /** A pending order without a payment, made at 08:00 unless told otherwise. */
    async function brokenOff(
      kind: 'pack' | 'subscription',
      data: Partial<Prisma.OrderUncheckedCreateInput> = {},
    ) {
      const { workspaceId } = await fixtures.workspace()
      const plan = await fixtures.plan(
        kind === 'pack' ? { kind: 'pack', packCredits: 10, maxSites: null } : {},
      )
      return fixtures.order({
        workspaceId,
        planId: plan.id,
        kind,
        status: 'pending',
        createdAt: at(BROKE_OFF),
        ...data,
      })
    }
    const statusOf = async (order: { id: string }) =>
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).status

    it('waits an hour, as long as a payment page of ЮKassa lives', () => {
      expect(ABANDONED_CHECKOUT_AFTER_MS).toBe(60 * MINUTE)
    })

    it.each(['pack', 'subscription'] as const)(
      'is cancelled after an hour when it is the order of a %s',
      async (kind) => {
        const order = await brokenOff(kind)
        const { deps, shop, later, errors } = passes(BROKE_OFF)

        // A payment page of ЮKassa lives one hour: until then the order is its customer's.
        later(ABANDONED_CHECKOUT_AFTER_MS - 1)
        expect((await settleStuckOrders(deps)).counts).toMatchObject({ cancelled: 0, skipped: 0 })
        expect(await statusOf(order)).toBe('pending')

        later(1)
        expect((await settleStuckOrders(deps)).counts).toMatchObject({ cancelled: 1, failed: 0 })

        expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
          status: 'cancelled',
          // Closed by us: nothing failed for the customer, and nothing was paid.
          failureReason: null,
          yookassaPaymentId: null,
          paidAt: null,
        })
        // Nobody is asked, written to or charged for an order nobody could pay.
        expect(shop.reads).toEqual([])
        expect(shop.charges).toEqual([])
        expect(await db.auditLog.count({ where: { workspaceId: order.workspaceId } })).toBe(0)
        expect(errors).toEqual([])
        // And the pass does not meet it again.
        expect((await settleStuckOrders(deps)).counts).toMatchObject({ cancelled: 0, skipped: 0 })
      },
    )

    it('lets the customer start the same tariff anew once the old order is closed', async () => {
      const { userId, workspaceId } = await fixtures.workspace()
      const plan = await fixtures.plan({ isActive: true })
      const stale = await fixtures.order({
        workspaceId,
        planId: plan.id,
        userId,
        amount: plan.price,
        status: 'pending',
        createdAt: at(BROKE_OFF),
      })
      const { deps, shop, later } = passes(BROKE_OFF)
      const checkout = () =>
        startCheckout(
          { ...deps, yookassa: shop.client, appEnv: 'test', autopayments: true },
          { userId, planSlug: plan.slug, autoRenew: false },
        )

      later(ABANDONED_CHECKOUT_AFTER_MS)
      expect((await settleStuckOrders(deps)).counts.cancelled).toBe(1)

      // Left pending, the old order would have been the one the same choice goes on with.
      const { orderId } = await checkout()
      expect(orderId).not.toBe(stale.id)
      expect(await statusOf(stale)).toBe('cancelled')
      expect(await statusOf({ id: orderId })).toBe('pending')
      expect(shop.created.map((request) => request.idempotenceKey)).not.toContain(
        stale.idempotenceKey,
      )
    })

    it('closes a payment by hand of an overdue tariff the same way, and leaves the tariff as it is', async () => {
      const s = await subscribed({ autoRenewal: false, end: '2021-06-10T09:00:00.000Z' })
      // «Оплатить сейчас» that broke off before a payment was stored: an order of the
      // subscription with a key of its own.
      const byHand = await brokenOff('subscription', {
        workspaceId: s.workspaceId,
        planId: s.planId,
        subscriptionId: s.subscriptionId,
      })
      const { deps, later } = passes(BROKE_OFF)

      later(ABANDONED_CHECKOUT_AFTER_MS - MINUTE)
      expect((await settleStuckOrders(deps)).counts).toMatchObject({ cancelled: 0, skipped: 0 })
      expect(await statusOf(byHand)).toBe('pending')

      later(MINUTE)
      expect((await settleStuckOrders(deps)).counts).toMatchObject({ cancelled: 1, failed: 0 })

      expect(await statusOf(byHand)).toBe('cancelled')
      expect((await written(s)).subscription).toMatchObject({ status: 'active' })
    })

    it('is left alone when it is a top-up', async () => {
      const s = await subscribed({ autoRenewal: false, end: '2021-06-10T09:00:00.000Z' })
      const topup = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: null,
        kind: 'topup',
        status: 'pending',
        createdAt: at(BROKE_OFF),
      })
      const { deps, later } = passes(BROKE_OFF)

      later(ABANDONED_CHECKOUT_AFTER_MS + DAY)
      expect((await settleStuckOrders(deps)).counts).toMatchObject({ cancelled: 0, skipped: 0 })

      expect(await statusOf(topup)).toBe('pending')
    })

    it('does not touch a renewal order: that one keeps its own twelve hours', async () => {
      const s = await subscribed({ noticed: true })
      const { deps, shop, later } = passes('2021-04-10T09:00:00.000Z')
      shop.failCharge(timeout())
      await chargeRenewals(deps)
      const order = only((await written(s)).renewals)
      expect(order).toMatchObject({ status: 'pending', yookassaPaymentId: null })

      // Past the hour of a checkout, with the shop still silent: the renewal goes on waiting.
      later(ABANDONED_CHECKOUT_AFTER_MS + MINUTE)
      shop.failCharge(timeout())
      expect((await settleStuckOrders(deps)).counts).toMatchObject({
        cancelled: 0,
        unanswered: 1,
      })
      expect(await statusOf(order)).toBe('pending')
    })

    it('keeps an order that got its payment while the pass was looking at it', async () => {
      const order = await brokenOff('pack')
      const { deps, later } = passes(BROKE_OFF)
      later(ABANDONED_CHECKOUT_AFTER_MS)
      // The request that was on its way stores its payment between the read and the update of
      // the pass.
      const { findUnique } = db.order
      const racing = {
        ...db,
        $queryRaw: db.$queryRaw.bind(db),
        order: {
          ...db.order,
          updateMany: db.order.updateMany.bind(db.order),
          async findUnique(args: Parameters<typeof findUnique>[0]) {
            const row = await findUnique.call(db.order, args)
            await db.order.update({
              where: { id: order.id },
              data: { yookassaPaymentId: `late-${order.id}` },
            })
            return row
          },
        },
      } as unknown as PrismaClient

      expect((await settleStuckOrders({ ...deps, prisma: racing })).counts).toMatchObject({
        cancelled: 0,
        skipped: 1,
      })

      expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
        status: 'pending',
        yookassaPaymentId: `late-${order.id}`,
      })
    })
  })

  describe('the end of a period that is not renewed', () => {
    it('cancels the subscription, expires the available remainder, keeps the pack and tells the owner', async () => {
      const s = await subscribed({ autoRenewal: false })
      await fixtures.hold(s.workspaceId, 'tariff', 2)
      const pack = await fixtures.plan({ kind: 'pack', packCredits: 10, maxSites: null })
      const packOrder = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: pack.id,
        kind: 'pack',
      })
      await db.$transaction((tx) =>
        grantPackCredits(tx, { workspaceId: s.workspaceId, orderId: packOrder.id, credits: 10 }),
      )
      const { deps, shop, later, errors } = passes('2021-04-10T08:59:59.999Z')

      // The period is still paid for.
      expect((await endPeriods(deps)).counts.cancelled).toBe(0)
      expect((await written(s)).subscription.status).toBe('active')

      later(1)
      expect(await endPeriods(deps)).toEqual({
        counts: { cancelled: 1, expired: 0, skipped: 0, failed: 0 },
        complete: true,
        waitingForShop: 0,
      })

      let state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'cancelled',
        currentPeriodStart: at(START),
        currentPeriodEnd: at(END),
        pastDueSince: null,
      })
      // 30 granted, 2 held by a running task: 28 expire. The pack is as it was.
      expect(state.balances).toEqual({
        tariff: { balance: 2, held: 2, available: 0 },
        gift: NO_GIFT,
        pack: { balance: 10, held: 0, available: 10 },
        totalAvailable: 10,
      })
      expect(state.ledger.map((entry) => [entry.kind, entry.amount.toNumber()])).toEqual([
        ['grant', 30],
        ['grant', 10],
        ['expire', -28],
      ])
      expect(state.ledger.at(-1)?.idempotencyKey).toBe(
        ledgerKeys.tariffExpiry(s.subscriptionId, at(END)),
      )
      const letter = only(state.letters)
      expect(letter).toMatchObject({
        type: 'billing.subscription_ended',
        dedupeKey: subscriptionEndedLetterKey(s.subscriptionId),
      })
      expect(letter.payload).toEqual({
        planName: 'Проверочный',
        endedAt: END,
        packCreditsLeft: 10,
        giftCreditsLeft: 0,
        appUrl: TEST_APP_URL,
        to: s.email,
      })
      expect(state.actions).toEqual([renewalJobAuditActions.subscriptionEnd])
      expect(state.meta(renewalJobAuditActions.subscriptionEnd)).toEqual({
        status: 'cancelled',
        reason: 'auto_renewal_off',
        periodEnd: END,
        expiredCredits: 28,
        packCreditsLeft: 10,
        notified: true,
      })

      // Once: the ticks after it, and two at once, find nothing to end.
      later(DAY)
      await Promise.all([endPeriods(deps), endPeriods(deps)])
      state = await written(s)
      expect(state.ledger).toHaveLength(3)
      expect(state.letters).toHaveLength(1)
      expect(state.audit).toHaveLength(1)
      expect(shop.charges).toEqual([])
      expect(errors).toEqual([])
    })

    it('keeps the gift when the tariff ends: only credits of the tariff expire', async () => {
      const s = await subscribed({ autoRenewal: false })
      const gift = await gifted(s)
      const { deps } = passes('2021-04-10T09:00:00.000Z')

      expect((await endPeriods(deps)).counts.cancelled).toBe(1)

      const state = await written(s)
      expect(state.subscription.status).toBe('cancelled')
      expect(state.balances).toEqual({
        tariff: { balance: 0, held: 0, available: 0 },
        gift: { balance: 35, held: 5, available: 30, granted: true },
        pack: { balance: 0, held: 0, available: 0 },
        totalAvailable: 30,
      })
      expect(state.ledger.filter((entry) => entry.kind === 'expire')).toMatchObject([
        { unit: 'credit_tariff' },
      ])
      expect(await giftRows(s.workspaceId)).toEqual(gift)
      // The letter is told what of the gift can be spent — 35 less the 5 a task holds —, so it
      // says that tasks are taken on gift credits, as the page does.
      expect(only(state.letters).payload).toMatchObject({ packCreditsLeft: 0, giftCreditsLeft: 30 })
    })

    it('is decided by one of two passes that run at once', async () => {
      const s = await subscribed({ subscription: { paymentMethodId: null } })
      const { deps } = passes('2021-04-10T09:00:00.000Z')

      const results = await Promise.all([endPeriods(deps), endPeriods(deps), endPeriods(deps)])

      expect(results.reduce((sum, pass) => sum + pass.counts.cancelled, 0)).toBe(1)
      expect(results.every((pass) => pass.counts.failed === 0)).toBe(true)
      const state = await written(s)
      expect(state.subscription.status).toBe('cancelled')
      expect(state.ledger.map((entry) => entry.kind)).toEqual(['grant', 'expire'])
      expect(state.letters).toHaveLength(1)
      expect(state.audit).toHaveLength(1)
    })

    it('leaves a renewed tariff alone', async () => {
      const s = await subscribed({ noticed: true })
      const { deps } = passes('2021-04-10T09:00:00.000Z')

      // Whichever pass the tick starts with.
      expect((await endPeriods(deps)).counts.cancelled).toBe(0)
      await chargeRenewals(deps)
      expect((await endPeriods(deps)).counts.cancelled).toBe(0)

      expect((await written(s)).subscription).toMatchObject({
        status: 'active',
        currentPeriodEnd: at(NEXT_END),
      })
    })
  })

  describe('an overdue tariff', () => {
    it('expires after the days of grace, with the same expiry and letter', async () => {
      const s = await subscribed({
        noticed: true,
        subscription: { status: 'past_due', pastDueSince: at('2021-04-10T09:02:00.000Z') },
      })
      const pack = await fixtures.plan({ kind: 'pack', packCredits: 10, maxSites: null })
      const packOrder = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: pack.id,
        kind: 'pack',
      })
      await db.$transaction((tx) =>
        grantPackCredits(tx, { workspaceId: s.workspaceId, orderId: packOrder.id, credits: 10 }),
      )
      // Seven days less a millisecond.
      const { deps, shop, later } = passes('2021-04-17T09:01:59.999Z')

      expect((await endPeriods(deps)).counts.expired).toBe(0)
      expect((await written(s)).subscription.status).toBe('past_due')

      later(1)
      expect((await endPeriods(deps)).counts).toEqual({
        cancelled: 0,
        expired: 1,
        skipped: 0,
        failed: 0,
      })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'expired',
        currentPeriodEnd: at(END),
        pastDueSince: at('2021-04-10T09:02:00.000Z'),
      })
      expect(state.balances).toEqual({
        tariff: { balance: 0, held: 0, available: 0 },
        gift: NO_GIFT,
        pack: { balance: 10, held: 0, available: 10 },
        totalAvailable: 10,
      })
      expect(only(state.letters).payload).toEqual({
        planName: 'Проверочный',
        // The moment the grace ran out and the tariff was ended — the day the customer had been
        // told —, not the end of the paid period a week before it.
        endedAt: '2021-04-17T09:02:00.000Z',
        packCreditsLeft: 10,
        giftCreditsLeft: 0,
        appUrl: TEST_APP_URL,
        to: s.email,
      })
      expect(state.meta(renewalJobAuditActions.subscriptionEnd)).toEqual({
        status: 'expired',
        reason: 'past_due_grace',
        periodEnd: END,
        expiredCredits: 30,
        packCreditsLeft: 10,
        notified: true,
      })
      expect(shop.charges).toEqual([])
    })

    it('keeps the gift when the overdue tariff ends unpaid', async () => {
      const s = await subscribed({
        noticed: true,
        subscription: { status: 'past_due', pastDueSince: at('2021-04-10T09:02:00.000Z') },
      })
      const gift = await gifted(s)
      const { deps } = passes('2021-04-17T09:02:00.000Z')

      expect((await endPeriods(deps)).counts.expired).toBe(1)

      const state = await written(s)
      expect(state.subscription.status).toBe('expired')
      expect(state.balances).toEqual({
        tariff: { balance: 0, held: 0, available: 0 },
        gift: { balance: 35, held: 5, available: 30, granted: true },
        pack: { balance: 0, held: 0, available: 0 },
        totalAvailable: 30,
      })
      expect(await giftRows(s.workspaceId)).toEqual(gift)
      expect(only(state.letters).payload).toMatchObject({ packCreditsLeft: 0, giftCreditsLeft: 30 })
    })

    it('waits for a payment that is on its way, and not for an order nobody can pay', async () => {
      const overdue = { status: 'past_due' as const, pastDueSince: at('2021-04-10T09:00:00.000Z') }
      const paying = await subscribed({ subscription: overdue })
      const abandoned = await subscribed({ subscription: overdue })
      const { deps, shop, later } = passes('2021-04-17T09:00:00.000Z')
      // The customer of the first is on the payment page; the checkout of the second broke
      // off before the shop was asked.
      const payment = await shop.client.createPayment(
        { amount: { value: '4900.00', currency: 'RUB' }, capture: true },
        'pay-now',
      )
      const byHand = {
        kind: 'subscription' as const,
        status: 'pending' as const,
        createdAt: at('2021-04-17T08:59:00.000Z'),
      }
      const withPayment = await fixtures.order({
        ...byHand,
        workspaceId: paying.workspaceId,
        planId: paying.planId,
        subscriptionId: paying.subscriptionId,
        yookassaPaymentId: payment.id,
      })
      await fixtures.order({
        ...byHand,
        workspaceId: abandoned.workspaceId,
        planId: abandoned.planId,
        subscriptionId: abandoned.subscriptionId,
      })

      expect((await endPeriods(deps)).counts.expired).toBe(1)
      expect((await written(abandoned)).subscription.status).toBe('expired')
      expect((await written(paying)).subscription.status).toBe('past_due')

      // The page is never paid: the shop cancels the payment, and the grace is over.
      shop.cancel(payment.id, 'expired_on_confirmation')
      later(STUCK_ORDER_AFTER_MS)
      expect((await settleStuckOrders(deps)).counts.failed).toBe(1)
      expect((await endPeriods(deps)).counts.expired).toBe(1)
      const state = await written(paying)
      expect(state.subscription.status).toBe('expired')
      expect(state.orders.find((order) => order.id === withPayment.id)).toMatchObject({
        status: 'failed',
        failureReason: 'expired_on_confirmation',
      })
    })

    it('goes the whole way from a refused charge to the end without a second charge', async () => {
      const s = await subscribed()
      const { deps, shop, later } = passes('2021-04-07T09:00:00.000Z')
      shop.willAnswer({ status: 'canceled', reason: 'general_decline' })
      const tick = async () => {
        await sendRenewalNotices(deps)
        await chargeRenewals(deps)
        await settleStuckOrders(deps)
        await endPeriods(deps)
      }

      await tick()
      expect((await written(s)).letterTypes).toEqual(['billing.renewal_notice'])
      later(3 * DAY)
      await tick()
      expect((await written(s)).subscription.status).toBe('past_due')
      later(7 * DAY - MINUTE)
      await tick()
      expect((await written(s)).subscription.status).toBe('past_due')
      later(MINUTE)
      await tick()

      const state = await written(s)
      expect(state.subscription.status).toBe('expired')
      expect(state.letterTypes).toEqual([
        'billing.renewal_notice',
        'billing.payment_failed',
        'billing.subscription_ended',
      ])
      expect(shop.charges).toHaveLength(1)
      expect(state.balances.tariff.balance).toBe(0)
    })
  })

  describe('while payments are off', () => {
    it('does not charge afterwards for a period that passed whole meanwhile: the tariff ends', async () => {
      // The shop was away for a month. Two subscriptions waited for it since the end of their
      // period, one with its notice and one without; the period their charge would pay for
      // ends at this very moment.
      const noticed = await subscribed({ noticed: true })
      const unannounced = await subscribed()
      // A millisecond of that period is left for this one, and three weeks for the next.
      const inTime = await subscribed({
        start: '2021-03-10T09:00:00.001Z',
        end: '2021-04-10T09:00:00.001Z',
        noticed: true,
      })
      const late = await subscribed({
        start: '2021-04-01T09:00:00.000Z',
        end: '2021-05-01T09:00:00.000Z',
        noticed: true,
      })
      expect((await endPeriods(passes(NEXT_END, null).deps)).waitingForShop).toBe(4)

      const { deps, shop } = passes(NEXT_END)
      expect((await sendRenewalNotices(deps)).counts).toMatchObject({
        notified: 0,
        auto_renewal_stopped: 1,
      })
      expect((await chargeRenewals(deps)).counts).toMatchObject({
        renewed: 2,
        auto_renewal_stopped: 1,
      })

      // A charge now would take the money for a month that has passed, and the next tick
      // would charge again for the one after it. The tariff ends instead, uncharged.
      expect(shop.charges.map((charge) => charge.idempotenceKey).sort()).toEqual(
        [inTime, late].map((s) => renewalKey(s.subscriptionId, s.periodEnd)).sort(),
      )
      expect((await endPeriods(deps)).counts.cancelled).toBe(2)
      for (const s of [noticed, unannounced]) {
        const state = await written(s)
        expect(state.subscription).toMatchObject({
          status: 'cancelled',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: at(END),
        })
        expect(state.renewals).toEqual([])
        expect(state.meta(renewalJobAuditActions.autoRenewalStop)).toEqual({
          reason: autoRenewalStopReasons.periodMissed,
          periodEnd: END,
        })
        expect(state.letterTypes).toEqual(['billing.subscription_ended'])
      }
      expect((await written(inTime)).subscription).toMatchObject({
        status: 'active',
        currentPeriodEnd: at('2021-05-10T09:00:00.001Z'),
      })
      expect((await written(late)).subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: at('2021-05-01T09:00:00.000Z'),
        currentPeriodEnd: at('2021-06-01T09:00:00.000Z'),
      })
    })

    it('charges and announces nothing, ends what is not renewed and keeps the rest active', async () => {
      const renewed = await subscribed({ noticed: true })
      const unannounced = await subscribed()
      const off = await subscribed({ autoRenewal: false })
      // Overdue for longer than the grace, and no way to pay while the shop is away.
      const overdue = await subscribed({
        noticed: true,
        subscription: { status: 'past_due', pastDueSince: at('2021-04-01T09:00:00.000Z') },
      })
      const pending = await fixtures.order({
        workspaceId: off.workspaceId,
        planId: off.planId,
        kind: 'pack',
        status: 'pending',
        yookassaPaymentId: `off-${off.subscriptionId}`,
        createdAt: at('2021-04-10T08:00:00.000Z'),
      })
      const { deps, errors } = passes('2021-04-11T09:00:00.000Z', null)

      const zero = (pass: { counts: Record<string, number> }) =>
        Object.values(pass.counts).every((count) => count === 0)
      expect(zero(await sendRenewalNotices(deps))).toBe(true)
      expect(zero(await chargeRenewals(deps))).toBe(true)
      expect(zero(await settleStuckOrders(deps))).toBe(true)
      const ends = await endPeriods(deps)

      expect(ends.counts).toEqual({ cancelled: 1, expired: 0, skipped: 0, failed: 0 })
      // Two subscriptions wait for the shop: nothing irreversible is decided without it.
      expect(ends.waitingForShop).toBe(2)
      for (const s of [renewed, unannounced]) {
        const state = await written(s)
        expect(state.subscription).toMatchObject({ status: 'active', currentPeriodEnd: at(END) })
        expect(state.renewals).toEqual([])
        expect(state.letters).toEqual([])
        expect(state.ledger).toHaveLength(1)
      }
      expect((await written(off)).subscription.status).toBe('cancelled')
      expect((await written(overdue)).subscription.status).toBe('past_due')
      expect((await db.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(
        'pending',
      )
      expect(errors).toEqual([])

      // The shop comes back: the waiting subscription is charged late, from its period end.
      const back = passes('2021-04-11T09:05:00.000Z')
      await sendRenewalNotices(back.deps)
      await chargeRenewals(back.deps)
      expect(await endPeriods(back.deps)).toMatchObject({
        counts: { expired: 1 },
        waitingForShop: 0,
      })
      expect((await written(overdue)).subscription.status).toBe('expired')
      expect((await written(renewed)).subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: at(END),
        currentPeriodEnd: at(NEXT_END),
      })
    })
  })
})
