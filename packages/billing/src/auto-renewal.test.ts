import { randomUUID } from 'node:crypto'

import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import type { SubscriptionStatus } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import {
  autoRenewalAuditActions,
  stopAutoRenewalByOperator,
  stopRenewalRefusals,
  switchAutoRenewalOff,
  type StopAutoRenewalInput,
} from './auto-renewal.ts'
import type { BillingDeps } from './deps.ts'
import { getPlanOverview } from './read-models.ts'
import { renewalKey } from './renewal-order.ts'
import { billingFixtures, TEST_NOW } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const WORKSPACE = '0199a000-0000-7000-8000-0000000000a1'
const WHO = { operator: 'operator-test', reason: 'Письмо клиента от 4 октября' }

describe('auto-renewal switched off by an operator, without a database', () => {
  // Reaching the database with a refused input would throw a TypeError on the missing client.
  const deps = {} as BillingDeps

  it.each([
    ['neither a workspace nor an email', { ...WHO }],
    ['both a workspace and an email', { ...WHO, workspaceId: WORKSPACE, userEmail: 'a@b.ru' }],
    ['a workspace that is not a UUID', { ...WHO, workspaceId: 'workspace' }],
    ['an email that is not one', { ...WHO, userEmail: 'not an email' }],
    // Not an address, and it never reaches a query — which compares for equality all the same.
    ['an email with a percent sign', { ...WHO, userEmail: 'ivan%@billing.example.ru' }],
    ['an email that is only a wildcard', { ...WHO, userEmail: '%' }],
    ['no operator', { ...WHO, workspaceId: WORKSPACE, operator: '' }],
    ['no reason', { ...WHO, workspaceId: WORKSPACE, reason: ' ' }],
    ['a reason of two lines', { ...WHO, workspaceId: WORKSPACE, reason: 'one\ntwo' }],
    ['a field it does not know', { ...WHO, workspaceId: WORKSPACE, subscriptionId: WORKSPACE }],
  ])('refuses %s before any query', async (_case, input) => {
    await expect(
      stopAutoRenewalByOperator(deps, input as StopAutoRenewalInput),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('reaches the database with an input the schema takes', async () => {
    await expect(
      stopAutoRenewalByOperator(deps, { ...WHO, workspaceId: WORKSPACE }),
    ).rejects.toBeInstanceOf(TypeError)
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL auto-renewal switched off by an operator', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  let deps: Pick<BillingDeps, 'prisma' | 'appEnv' | 'now'>
  const strayUsers: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
    deps = { prisma: db, appEnv: 'test', now: () => TEST_NOW }
  })
  afterEach(async () => {
    await fixtures.cleanup()
    await db.user.deleteMany({ where: { id: { in: strayUsers.splice(0) } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  const PERIOD_END = new Date('2026-10-18T09:00:00Z')
  const CARD = {
    paymentMethodId: 'pm-saved',
    paymentMethodTitle: 'Bank card *4444',
    paymentMethodType: 'bank_card',
    paymentMethodCardType: 'Mir',
    paymentMethodLast4: '4444',
  }
  const { operatorStop } = autoRenewalAuditActions

  /** A customer on a tariff with a saved card that renews, its notice already sent. */
  async function subscribed(
    patch: Partial<Prisma.SubscriptionUncheckedCreateInput> = {},
    status: SubscriptionStatus = 'active',
  ) {
    const { userId, workspaceId } = await fixtures.workspace()
    const { email } = await db.user.findUniqueOrThrow({ where: { id: userId } })
    const plan = await fixtures.plan()
    const subscription = await fixtures.subscription({
      workspaceId,
      planId: plan.id,
      status,
      ...CARD,
      renewalNoticePeriodEnd: PERIOD_END,
      pendingPaymentMethodId: 'pm-being-bound',
      ...patch,
    })
    return { userId, email, workspaceId, subscriptionId: subscription.id }
  }

  async function written({ workspaceId }: { workspaceId: string }) {
    return {
      subscriptions: await db.subscription.findMany({ where: { workspaceId } }),
      audit: await db.auditLog.findMany({ where: { workspaceId } }),
    }
  }

  it('switches auto-renewal off by the email of the owner and keeps the saved method', async () => {
    const s = await subscribed()

    const stopped = await stopAutoRenewalByOperator(deps, { ...WHO, userEmail: s.email })

    expect(stopped).toEqual({
      subscriptionId: s.subscriptionId,
      workspaceId: s.workspaceId,
      status: 'active',
      periodEnd: PERIOD_END,
      paymentMethodSaved: true,
      // No charge of the period was started: the tariff works to its end and that is all.
      renewalCharge: 'none',
      // The address the operator's one matched, for the operator to see.
      userEmail: s.email,
    })
    const state = await written(s)
    expect(state.subscriptions).toHaveLength(1)
    expect(state.subscriptions[0]).toMatchObject({
      status: 'active',
      currentPeriodEnd: PERIOD_END,
      cancelAtPeriodEnd: true,
      cancelledAt: TEST_NOW,
      // The customer can switch it back on: nothing of the method is forgotten.
      ...CARD,
      pendingPaymentMethodId: 'pm-being-bound',
      renewalNoticePeriodEnd: PERIOD_END,
      pastDueSince: null,
    })
    expect(state.audit).toHaveLength(1)
    expect(state.audit[0]).toMatchObject({
      action: operatorStop,
      actorType: 'operator',
      actorId: WHO.operator,
      targetType: 'subscription',
      targetId: s.subscriptionId,
      meta: {
        reason: WHO.reason,
        namedBy: 'email',
        status: 'active',
        periodEnd: PERIOD_END.toISOString(),
        paymentMethodSaved: true,
        renewalCharge: 'none',
      },
    })
    // The address itself is not copied into the audit log.
    expect(JSON.stringify(state.audit[0]?.meta)).not.toContain(s.email)
    // The customer sees what their own switch would show.
    expect((await getPlanOverview(db, s.workspaceId)).subscription).toMatchObject({
      status: 'active',
      autoRenewal: false,
      paymentMethod: { label: expect.stringContaining('4444') },
    })
  })

  it('finds the owner whatever the case of the letters the operator typed', async () => {
    const s = await subscribed()

    const stopped = await stopAutoRenewalByOperator(deps, {
      ...WHO,
      userEmail: s.email.toUpperCase(),
    })

    expect(stopped.subscriptionId).toBe(s.subscriptionId)
    // As the database holds it, not as it was typed.
    expect(stopped.userEmail).toBe(s.email)
    expect((await written(s)).subscriptions[0]?.cancelAtPeriodEnd).toBe(true)
  })

  // The address is compared for equality. A pattern match would read the underscore the
  // operator typed as «any character» and stop the auto-renewal of another customer.
  describe('an address with an underscore', () => {
    /** Two addresses that differ in the one character a pattern would take for a wildcard. */
    async function lookAlikes() {
      const tag = randomUUID()
      const typed = `ivan_petrov.${tag}@billing.example.ru`
      const other = await subscribed()
      await db.user.update({
        where: { id: other.userId },
        data: { email: `ivan.petrov.${tag}@billing.example.ru` },
      })
      return { typed, other }
    }

    it('does not match an address that differs in that character', async () => {
      const { typed, other } = await lookAlikes()

      // The customer wrote from an address that is not registered, or the operator mistyped.
      await expect(
        stopAutoRenewalByOperator(deps, { ...WHO, userEmail: typed }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: stopRenewalRefusals.userNotFound })

      const state = await written(other)
      expect(state.subscriptions[0]).toMatchObject({ cancelAtPeriodEnd: false, cancelledAt: null })
      expect(state.audit).toEqual([])
    })

    it('finds exactly its user when a look-alike is registered too', async () => {
      const { typed, other } = await lookAlikes()
      const exact = await subscribed()
      await db.user.update({ where: { id: exact.userId }, data: { email: typed } })

      // Not «more than one user has this address»: the address is not ambiguous.
      const stopped = await stopAutoRenewalByOperator(deps, {
        ...WHO,
        userEmail: typed.toUpperCase(),
      })

      expect(stopped).toMatchObject({
        subscriptionId: exact.subscriptionId,
        workspaceId: exact.workspaceId,
        userEmail: typed,
      })
      expect((await written(exact)).subscriptions[0]?.cancelAtPeriodEnd).toBe(true)
      const untouched = await written(other)
      expect(untouched.subscriptions[0]?.cancelAtPeriodEnd).toBe(false)
      expect(untouched.audit).toEqual([])
    })
  })

  // A renewal charge that was started before the switch is neither stopped nor returned. The
  // operator answers the customer's letter and has to know of it: the same three states the
  // customer is told on «Тарифы» and «Оплата».
  describe('while the renewal charge of the period is under way', () => {
    const START = new Date('2026-09-04T09:00:00.000Z')
    const ENDED = new Date('2026-10-04T09:00:00.000Z')

    /** The period ended three hours before the tests' noon, and its charge was started. */
    async function charged(order: Partial<Prisma.OrderUncheckedCreateInput>) {
      const s = await subscribed({
        currentPeriodStart: START,
        currentPeriodEnd: ENDED,
        periodAnchor: START,
        renewalNoticePeriodEnd: ENDED,
      })
      const plan = await fixtures.plan()
      const renewal = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: plan.id,
        userId: s.userId,
        subscriptionId: s.subscriptionId,
        status: 'pending',
        idempotenceKey: renewalKey(s.subscriptionId, ENDED),
        ...order,
      })
      return { ...s, renewalId: renewal.id }
    }

    it.each([
      ['at_bank', { yookassaPaymentId: `payment-${randomUUID()}` }],
      ['unanswered', { yookassaPaymentId: null }],
    ] as const)('tells the operator that it is %s, and leaves it alone', async (state, order) => {
      const s = await charged(order)

      const stopped = await stopAutoRenewalByOperator(deps, { ...WHO, userEmail: s.email })

      expect(stopped).toMatchObject({
        status: 'active',
        // The paid period is over: «the tariff works until» this moment would be untrue.
        periodEnd: ENDED,
        renewalCharge: state,
      })
      expect(stopped.periodEnd.getTime()).toBeLessThan(TEST_NOW.getTime())
      const after = await written(s)
      expect(after.subscriptions[0]).toMatchObject({ cancelAtPeriodEnd: true, status: 'active' })
      expect(after.audit).toHaveLength(1)
      expect(after.audit[0]).toMatchObject({
        action: operatorStop,
        meta: { renewalCharge: state, periodEnd: ENDED.toISOString() },
      })
      // The order of the charge is not the switch's to touch.
      expect(await db.order.findUniqueOrThrow({ where: { id: s.renewalId } })).toMatchObject({
        status: 'pending',
        yookassaPaymentId: order.yookassaPaymentId,
      })
    })

    it.each(['paid', 'failed', 'cancelled'] as const)(
      'reports no charge when the order of the period is %s',
      async (status) => {
        const s = await charged({ status, yookassaPaymentId: `payment-${randomUUID()}` })

        const stopped = await stopAutoRenewalByOperator(deps, {
          ...WHO,
          workspaceId: s.workspaceId,
        })

        expect(stopped.renewalCharge).toBe('none')
        expect((await written(s)).audit[0]?.meta).toMatchObject({ renewalCharge: 'none' })
      },
    )

    it('does not take the charge of an earlier period for one under way', async () => {
      const s = await subscribed()
      const plan = await fixtures.plan()
      // A pending order of a period the tariff has left behind (never a state of the product).
      await fixtures.order({
        workspaceId: s.workspaceId,
        planId: plan.id,
        subscriptionId: s.subscriptionId,
        status: 'pending',
        yookassaPaymentId: `payment-${randomUUID()}`,
        idempotenceKey: renewalKey(s.subscriptionId, new Date('2026-09-18T09:00:00Z')),
      })

      const stopped = await stopAutoRenewalByOperator(deps, { ...WHO, userEmail: s.email })

      expect(stopped.renewalCharge).toBe('none')
    })
  })

  it('switches it off by the workspace as well', async () => {
    const s = await subscribed()

    const stopped = await stopAutoRenewalByOperator(deps, { ...WHO, workspaceId: s.workspaceId })

    // Nobody typed an address: none is shown.
    expect(stopped.userEmail).toBeNull()
    const state = await written(s)
    expect(state.subscriptions[0]).toMatchObject({ cancelAtPeriodEnd: true, cancelledAt: TEST_NOW })
    expect(state.audit[0]?.meta).toMatchObject({ namedBy: 'workspace' })
  })

  it('switches off the tariff that is on, not one of the same workspace that ended', async () => {
    const s = await subscribed({}, 'cancelled')
    const plan = await fixtures.plan()
    const live = await fixtures.subscription({
      workspaceId: s.workspaceId,
      planId: plan.id,
      ...CARD,
      currentPeriodStart: new Date('2026-10-18T09:00:00Z'),
      currentPeriodEnd: new Date('2026-11-18T09:00:00Z'),
    })

    for (const input of [{ userEmail: s.email }, { workspaceId: s.workspaceId }]) {
      await db.subscription.update({
        where: { id: live.id },
        data: { cancelAtPeriodEnd: false, cancelledAt: null },
      })
      const stopped = await stopAutoRenewalByOperator(deps, { ...WHO, ...input })
      expect(stopped.subscriptionId).toBe(live.id)
    }

    const ended = await db.subscription.findUniqueOrThrow({ where: { id: s.subscriptionId } })
    expect(ended).toMatchObject({ status: 'cancelled', cancelAtPeriodEnd: false })
  })

  it.each(['trial', 'past_due'] as const)('is open to a tariff that is %s', async (status) => {
    const s = await subscribed({}, status)

    const stopped = await stopAutoRenewalByOperator(deps, { ...WHO, userEmail: s.email })

    expect(stopped.status).toBe(status)
    const state = await written(s)
    expect(state.subscriptions[0]).toMatchObject({ status, cancelAtPeriodEnd: true })
    expect(state.audit[0]?.meta).toMatchObject({ status })
  })

  it('has nothing to change when auto-renewal is already off, and keeps the first moment', async () => {
    const off = new Date('2026-09-20T10:00:00Z')
    const s = await subscribed({ cancelAtPeriodEnd: true, cancelledAt: off })

    await expect(
      stopAutoRenewalByOperator(deps, { ...WHO, userEmail: s.email }),
    ).rejects.toMatchObject({ code: 'BILLING_NOTHING_TO_CHANGE', httpStatus: 409 })

    const state = await written(s)
    expect(state.subscriptions[0]).toMatchObject({ cancelAtPeriodEnd: true, cancelledAt: off })
    expect(state.audit).toEqual([])
  })

  it('switches it off once when two operators do it at the same time', async () => {
    const s = await subscribed()

    const results = await Promise.allSettled([
      stopAutoRenewalByOperator(deps, { ...WHO, userEmail: s.email }),
      stopAutoRenewalByOperator(deps, { ...WHO, workspaceId: s.workspaceId }),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = results.find((result) => result.status === 'rejected')
    expect(refused).toMatchObject({ reason: { code: 'BILLING_NOTHING_TO_CHANGE' } })
    expect((await written(s)).audit).toHaveLength(1)
  })

  it('reports a tariff without a saved method as it is', async () => {
    // Not a state checkout leaves: a tariff without a method does not renew from the start.
    const s = await subscribed({
      paymentMethodId: null,
      paymentMethodTitle: null,
      paymentMethodType: null,
      paymentMethodCardType: null,
      paymentMethodLast4: null,
    })

    const stopped = await stopAutoRenewalByOperator(deps, { ...WHO, userEmail: s.email })

    expect(stopped.paymentMethodSaved).toBe(false)
    expect((await written(s)).audit[0]?.meta).toMatchObject({ paymentMethodSaved: false })
  })

  it('refuses an address nobody is registered with', async () => {
    await expect(
      stopAutoRenewalByOperator(deps, { ...WHO, userEmail: `${randomUUID()}@billing.example.ru` }),
    ).rejects.toMatchObject({
      name: 'DomainError',
      code: 'CONFLICT',
      message: stopRenewalRefusals.userNotFound,
    })
  })

  it('refuses an address that two users share but for the case of its letters', async () => {
    const local = randomUUID()
    for (const email of [
      `${local}@billing.example.ru`,
      `${local.toUpperCase()}@billing.example.ru`,
    ]) {
      const user = await db.user.create({ data: { name: 'Billing verification', email } })
      strayUsers.push(user.id)
    }

    await expect(
      stopAutoRenewalByOperator(deps, { ...WHO, userEmail: `${local}@billing.example.ru` }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: stopRenewalRefusals.userAmbiguous })
  })

  it('finds no tariff for a user without a workspace, without a tariff or with an ended one', async () => {
    const noLiveSubscription = { code: 'BILLING_NO_LIVE_SUBSCRIPTION', httpStatus: 409 }
    const { email: alone } = await fixtures.user()
    await expect(
      stopAutoRenewalByOperator(deps, { ...WHO, userEmail: alone }),
    ).rejects.toMatchObject(noLiveSubscription)

    const { userId, workspaceId } = await fixtures.workspace()
    const { email } = await db.user.findUniqueOrThrow({ where: { id: userId } })
    for (const input of [{ userEmail: email }, { workspaceId }]) {
      await expect(stopAutoRenewalByOperator(deps, { ...WHO, ...input })).rejects.toMatchObject(
        noLiveSubscription,
      )
    }

    for (const status of ['cancelled', 'expired'] as const) {
      const ended = await subscribed({}, status)
      await expect(
        stopAutoRenewalByOperator(deps, { ...WHO, userEmail: ended.email }),
      ).rejects.toMatchObject(noLiveSubscription)
      const state = await written(ended)
      expect(state.subscriptions[0]).toMatchObject({ status, cancelAtPeriodEnd: false })
      expect(state.audit).toEqual([])
    }
    await expect(
      stopAutoRenewalByOperator(deps, { ...WHO, workspaceId: WORKSPACE }),
    ).rejects.toMatchObject(noLiveSubscription)
  })

  describe('the switch itself, in the transaction of its caller', () => {
    it('changes the two columns and tells the caller what its audit entry needs', async () => {
      const s = await subscribed()
      const at = new Date('2026-10-05T08:00:00Z')

      const stopped = await db.$transaction((tx) =>
        switchAutoRenewalOff(tx, { subscriptionId: s.subscriptionId, now: at }),
      )

      expect(stopped).toEqual({
        subscriptionId: s.subscriptionId,
        workspaceId: s.workspaceId,
        status: 'active',
        periodEnd: PERIOD_END,
        paymentMethodSaved: true,
      })
      const state = await written(s)
      expect(state.subscriptions[0]).toMatchObject({
        cancelAtPeriodEnd: true,
        cancelledAt: at,
        ...CARD,
        renewalNoticePeriodEnd: PERIOD_END,
      })
      // The entry is the caller's to write.
      expect(state.audit).toEqual([])
    })

    it('is undone with the transaction of its caller', async () => {
      const s = await subscribed()

      await expect(
        db.$transaction(async (tx) => {
          await switchAutoRenewalOff(tx, { subscriptionId: s.subscriptionId, now: TEST_NOW })
          throw new Error('the caller failed')
        }),
      ).rejects.toThrow('the caller failed')

      expect((await written(s)).subscriptions[0]).toMatchObject({
        cancelAtPeriodEnd: false,
        cancelledAt: null,
      })
    })

    it('refuses a subscription that is gone or over, and one that does not renew', async () => {
      const off = (subscriptionId: string) =>
        db.$transaction((tx) => switchAutoRenewalOff(tx, { subscriptionId, now: TEST_NOW }))

      await expect(off(WORKSPACE)).rejects.toMatchObject({ code: 'BILLING_NO_LIVE_SUBSCRIPTION' })
      const ended = await subscribed({}, 'expired')
      await expect(off(ended.subscriptionId)).rejects.toMatchObject({
        code: 'BILLING_NO_LIVE_SUBSCRIPTION',
      })
      const quiet = await subscribed({ cancelAtPeriodEnd: true })
      await expect(off(quiet.subscriptionId)).rejects.toMatchObject({
        code: 'BILLING_NOTHING_TO_CHANGE',
      })
    })
  })
})
