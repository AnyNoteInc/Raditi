import { createPrismaClient, findPersonalWorkspace, type Prisma, type PrismaClient } from '@repo/db'
import type { SubscriptionStatus } from '@repo/domain'
import {
  YookassaApiError,
  YookassaError,
  type ChargeSavedInput,
  type SavedPaymentMethod,
} from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import type { PaymentMethodSyncDto, PaymentMethodUnlinkDto } from './dto.ts'
import { orderFailureReasons } from './failure-text.ts'
import {
  bindFailureReasons,
  paymentMethodAuditActions,
  paymentMethodReturnUrl,
  settlePaymentMethod,
  startPaymentMethodChange,
  syncPaymentMethod,
  unlinkPaymentMethod,
  type PaymentMethodDeps,
  type PaymentMethodSettlement,
} from './payment-method.ts'
import { getPlanOverview } from './read-models.ts'
import { listRefundsNeeded } from './refund.ts'
import {
  chargeRenewals,
  endPeriods,
  RENEWAL_GIVE_UP_MARGIN_MS,
  RENEWAL_RETRY_WINDOW_MS,
  renewalJobAuditActions,
  sendRenewalNotices,
  settleStuckOrders,
  STUCK_ORDER_AFTER_MS,
  type RenewalDeps,
} from './renewal.ts'
import { isRenewalOrder } from './renewal-order.ts'
import {
  renewalAuditActions,
  settleOrderByPaymentId,
  settlementAuditActions,
} from './settlement.ts'
import {
  billingFixtures,
  paymentMethodStub,
  paymentMethodTestDeps,
  TEST_APP_URL,
  TEST_NOW,
  yookassaStub,
} from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const USER = '0199a000-0000-7000-8000-0000000000e5'
const NBSP = String.fromCharCode(0xa0)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const timeout = () => new YookassaError('YooKassa request timed out', { retryable: true })
const serverError = () => new YookassaApiError('internal_server_error', 500, undefined, {})
const badRequest = () => new YookassaApiError('invalid_request', 400, 'invalid_request', {})

describe('a saved payment method without a database', () => {
  // Reaching the database or the shop with a refused input would throw a TypeError on the
  // missing client: only the schema throws a ZodError.
  const deps = {} as PaymentMethodDeps

  it.each([
    ['a start', startPaymentMethodChange],
    ['a look from the return page', syncPaymentMethod],
    ['an unlink', unlinkPaymentMethod],
  ] as const)('refuses %s for a broken user and anything beside it', async (_case, call) => {
    await expect(call(deps, { userId: 'user' })).rejects.toBeInstanceOf(ZodError)
    await expect(call(deps, {} as { userId: string })).rejects.toBeInstanceOf(ZodError)
    for (const extra of [
      { workspaceId: USER },
      { subscriptionId: USER },
      { paymentMethodId: 'x' },
    ]) {
      await expect(
        call(deps, { userId: USER, ...extra } as { userId: string }),
      ).rejects.toBeInstanceOf(ZodError)
    }
  })

  it('refuses a settlement that names no method or anything beside it', async () => {
    await expect(settlePaymentMethod(deps, { paymentMethodId: '' })).rejects.toBeInstanceOf(
      ZodError,
    )
    await expect(
      settlePaymentMethod(deps, { paymentMethodId: 'pm-1', userId: USER } as {
        paymentMethodId: string
      }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('takes an id that is too long for a method of ours as unknown, without a query', async () => {
    expect(await settlePaymentMethod(deps, { paymentMethodId: 'm'.repeat(65) })).toEqual({
      state: 'unknown',
    })
  })

  it('sends the customer back to the return page of a binding', () => {
    expect(paymentMethodReturnUrl('https://raditi.example')).toBe(
      'https://raditi.example/settings/billing/return?method=1',
    )
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL saved payment method', () => {
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
  const OLD_CARD = {
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
  const VISA = { card_type: 'Visa', last4: '1234', first6: '411111' }

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
      ...OLD_CARD,
      renewalNoticePeriodEnd: PERIOD_END,
      ...patch,
    })
    return { ...paymentMethodTestDeps(db), userId, workspaceId, subscriptionId: subscription.id }
  }
  type Subscribed = Awaited<ReturnType<typeof subscribed>>

  /** A tariff bought without the consent to auto-renewal: no method, and it does not renew. */
  const withoutMethod = { ...NO_CARD, cancelAtPeriodEnd: true, renewalNoticePeriodEnd: null }

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

  /** The customer starts a binding; the id of the method the shop made for it. */
  async function started(s: Subscribed): Promise<string> {
    const before = new Set(s.shop.methods.keys())
    await startPaymentMethodChange(s.deps, { userId: s.userId })
    const [id, ...others] = [...s.shop.methods.keys()].filter((key) => !before.has(key))
    if (id === undefined || others.length > 0) throw new Error('The start made no one binding')
    return id
  }

  const { bindStart, bound, bindFailed, unlink } = paymentMethodAuditActions

  describe('the start of a binding', () => {
    it('asks the shop for a card binding and remembers which one the subscription waits for', async () => {
      const s = await subscribed()

      const change = await startPaymentMethodChange(s.deps, { userId: s.userId })

      const method = s.shop.only()
      expect(change).toEqual({ confirmationUrl: method.confirmation?.confirmation_url })
      expect(s.shop.created).toEqual([
        {
          idempotenceKey: expect.stringMatching(UUID),
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
      // Nothing but the binding it waits for changes before the method is read back.
      expect(state.subscription).toMatchObject({
        ...OLD_CARD,
        pendingPaymentMethodId: method.id,
        renewalNoticePeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        status: 'active',
      })
      expect(state.actions).toEqual([bindStart])
      expect(state.audit[0]).toMatchObject({
        actorType: 'user',
        actorId: s.userId,
        targetType: 'subscription',
        targetId: s.subscriptionId,
        meta: { paymentMethodId: method.id, replaces: true },
      })
      // The read is left to the notification and the return page.
      expect(s.shop.reads).toEqual([])
    })

    it('gives every start a binding of its own, and waits for the latest', async () => {
      const s = await subscribed(withoutMethod)

      const first = await started(s)
      const second = await started(s)

      expect(second).not.toBe(first)
      expect(new Set(s.shop.created.map((request) => request.idempotenceKey)).size).toBe(2)
      const state = await written(s)
      expect(state.subscription.pendingPaymentMethodId).toBe(second)
      expect(state.entry(bindStart).map((entry) => entry.meta)).toEqual([
        { paymentMethodId: first, replaces: false },
        { paymentMethodId: second, replaces: false },
      ])
    })

    it.each(['trial', 'active', 'past_due'] as const)(
      'is open to a tariff that is %s',
      async (status) => {
        const s = await subscribed({}, status)

        await expect(startPaymentMethodChange(s.deps, { userId: s.userId })).resolves.toEqual({
          confirmationUrl: expect.stringContaining('https://yookassa.example/bind/'),
        })
        expect((await written(s)).subscription.pendingPaymentMethodId).toBe(s.shop.only().id)
      },
    )

    it('is refused for a user who has no workspace, and makes none', async () => {
      const { shop, deps } = paymentMethodTestDeps(db)
      const { userId } = await fixtures.user()

      await expect(startPaymentMethodChange(deps, { userId })).rejects.toMatchObject({
        code: 'BILLING_NO_LIVE_SUBSCRIPTION',
        httpStatus: 409,
      })

      expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toBeNull()
      expect(shop.created).toEqual([])
    })

    it.each([
      ['has never had a tariff', null],
      ['had its tariff end with the period', 'cancelled'],
      ['had its tariff end unpaid', 'expired'],
    ] as const)('is refused for a workspace that %s', async (_case, status) => {
      const s = await subscribed({}, status ?? 'active')
      if (status === null) await db.subscription.delete({ where: { id: s.subscriptionId } })

      await expect(startPaymentMethodChange(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_NO_LIVE_SUBSCRIPTION',
      })

      expect(s.shop.created).toEqual([])
      expect(await db.auditLog.count({ where: { workspaceId: s.workspaceId } })).toBe(0)
    })

    it('binds to the live tariff, not to one of the same workspace that ended before it', async () => {
      const s = await subscribed({}, 'expired')
      const plan = await fixtures.plan()
      const live = await fixtures.subscription({ workspaceId: s.workspaceId, planId: plan.id })

      await startPaymentMethodChange(s.deps, { userId: s.userId })

      const method = s.shop.only()
      expect(method.metadata).toEqual({ subscription_id: live.id })
      expect(
        (await db.subscription.findUniqueOrThrow({ where: { id: live.id } }))
          .pendingPaymentMethodId,
      ).toBe(method.id)
      expect((await written(s)).subscription.pendingPaymentMethodId).toBeNull()
    })

    it('asks once more under the same key when the answer of the shop was lost', async () => {
      const s = await subscribed()
      s.shop.failCreate(timeout(), { processed: true })

      const change = await startPaymentMethodChange(s.deps, { userId: s.userId })

      const method = s.shop.only()
      expect(change.confirmationUrl).toBe(method.confirmation?.confirmation_url)
      expect(s.shop.created).toHaveLength(2)
      expect(s.shop.created[1]?.idempotenceKey).toBe(s.shop.created[0]?.idempotenceKey)
      expect((await written(s)).subscription.pendingPaymentMethodId).toBe(method.id)
    })

    it.each([
      ['refuses the request', [badRequest()], 1],
      ['does not answer twice', [timeout(), serverError()], 2],
    ] as const)(
      'answers «payments unavailable» and stores nothing when the shop %s',
      async (_case, failures, requests) => {
        const s = await subscribed()
        for (const failure of failures) s.shop.failCreate(failure)

        const error = await startPaymentMethodChange(s.deps, { userId: s.userId }).catch(
          (thrown: unknown) => thrown,
        )

        expect(error).toMatchObject({ code: 'BILLING_PAYMENTS_NOT_CONFIGURED', httpStatus: 503 })
        // What the shop said stays with the refusal, for the log.
        expect((error as Error).cause).toBe(failures.at(-1))
        expect(s.shop.created).toHaveLength(requests)
        const state = await written(s)
        expect(state.subscription.pendingPaymentMethodId).toBeNull()
        expect(state.audit).toEqual([])
      },
    )

    it.each([
      ['no page', { confirmation: undefined }],
      [
        'a page that is not a web address',
        { confirmation: { type: 'redirect', confirmation_url: 'javascript:alert(1)' } },
      ],
      ['a method that is refused already', { status: 'inactive' }],
      ['an id that does not fit the column', { id: 'm'.repeat(65) }],
    ] as [string, Partial<SavedPaymentMethod>][])(
      'stores nothing for an answer of the shop with %s',
      async (_case, answer) => {
        const s = await subscribed()
        s.shop.createAs(answer)

        await expect(startPaymentMethodChange(s.deps, { userId: s.userId })).rejects.toMatchObject({
          code: 'BILLING_PAYMENTS_NOT_CONFIGURED',
        })

        const state = await written(s)
        expect(state.subscription).toMatchObject({ ...OLD_CARD, pendingPaymentMethodId: null })
        expect(state.audit).toEqual([])
      },
    )

    it('sends the customer straight to the return page for a method that is bound at once', async () => {
      const s = await subscribed()
      s.shop.createAs({ status: 'active', saved: true, confirmation: undefined })

      expect(await startPaymentMethodChange(s.deps, { userId: s.userId })).toEqual({
        confirmationUrl: `${TEST_APP_URL}/settings/billing/return?method=1`,
      })

      // Stored as waited for: the return page reads it back like any other.
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        ...OLD_CARD,
        pendingPaymentMethodId: s.shop.only().id,
      })
    })

    it('binds nothing to a tariff that ended while the shop was being asked', async () => {
      const s = await subscribed()
      const { createPaymentMethod } = s.shop.client
      const deps: PaymentMethodDeps = {
        ...s.deps,
        yookassa: {
          ...s.shop.client,
          async createPaymentMethod(input, key) {
            await db.subscription.update({
              where: { id: s.subscriptionId },
              data: { status: 'cancelled' },
            })
            return createPaymentMethod(input, key)
          },
        },
      }

      await expect(startPaymentMethodChange(deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_NO_LIVE_SUBSCRIPTION',
      })

      const state = await written(s)
      expect(state.subscription.pendingPaymentMethodId).toBeNull()
      expect(state.audit).toEqual([])
    })
  })

  describe('a binding that is read back on a notification', () => {
    it('makes a bound method the method of the subscription and asks for a new notice', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)

      expect(await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).toEqual({
        state: 'active',
        subscriptionId: s.subscriptionId,
        // No charge of the period was under way.
        renewalCharge: 'none',
      })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: methodId,
        paymentMethodTitle: 'Bank card *1234',
        paymentMethodType: 'bank_card',
        paymentMethodCardType: 'Visa',
        paymentMethodLast4: '1234',
        pendingPaymentMethodId: null,
        // The notice named the card that is gone: the next charge is announced again.
        renewalNoticePeriodEnd: null,
        // Auto-renewal is as it was, and so are the tariff and its period.
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        status: 'active',
        currentPeriodEnd: PERIOD_END,
      })
      expect(state.actions).toEqual([bindStart, bound])
      expect(state.audit[1]).toMatchObject({
        actorType: 'system',
        actorId: 'billing',
        targetType: 'subscription',
        targetId: s.subscriptionId,
        meta: {
          paymentMethodId: methodId,
          replaced: true,
          type: 'bank_card',
          cardType: 'Visa',
          last4: '1234',
          autoRenewal: true,
          renewalCharge: 'none',
          periodEnd: PERIOD_END.toISOString(),
        },
      })
      expect(s.shop.reads).toEqual([methodId])
      expect((await getPlanOverview(db, s.workspaceId)).subscription).toMatchObject({
        autoRenewal: true,
        paymentMethod: { label: `Карта Visa ••${NBSP}1234` },
      })
    })

    it('gives a tariff that does not renew its first method without switching auto-renewal on', async () => {
      const s = await subscribed(withoutMethod)
      const methodId = await started(s)
      s.shop.confirm(methodId)

      expect((await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).state).toBe(
        'active',
      )

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: methodId,
        paymentMethodCardType: 'Mir',
        paymentMethodLast4: '4444',
        pendingPaymentMethodId: null,
        // Binding a card is not a consent to be charged.
        cancelAtPeriodEnd: true,
      })
      expect(state.entry(bound)[0]?.meta).toMatchObject({ replaced: false, autoRenewal: false })
      expect((await getPlanOverview(db, s.workspaceId)).subscription).toMatchObject({
        autoRenewal: false,
        paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` },
      })
    })

    it('leaves no column of the method before beside the new one', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId)
      // A method without a title and with a card ЮKassa tells nothing of.
      s.shop.patch(methodId, { title: undefined, card: undefined })

      await settlePaymentMethod(s.deps, { paymentMethodId: methodId })

      expect((await written(s)).subscription).toMatchObject({
        paymentMethodId: methodId,
        paymentMethodType: 'bank_card',
        paymentMethodTitle: null,
        paymentMethodCardType: null,
        paymentMethodLast4: null,
      })
    })

    it('stops waiting for a method that was not bound, and keeps the saved one', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.refuse(methodId)

      expect(await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).toEqual({
        state: 'inactive',
        subscriptionId: s.subscriptionId,
      })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        ...OLD_CARD,
        pendingPaymentMethodId: null,
        // The notice of the card that stays still stands.
        renewalNoticePeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: false,
      })
      expect(state.actions).toEqual([bindStart, bindFailed])
      expect(state.audit[1]).toMatchObject({
        actorType: 'system',
        meta: { paymentMethodId: methodId, reason: bindFailureReasons.inactive },
      })
    })

    it.each([
      ['the customer has not confirmed yet', {}],
      ['ЮKassa reports it active and not saved', { status: 'active', saved: false }],
      ['ЮKassa reports it saved and not active', { status: 'pending', saved: true }],
      ['the answer is about another method', { id: 'pm-another', status: 'active', saved: true }],
    ] as [string, Partial<SavedPaymentMethod>][])(
      'changes nothing while %s',
      async (_case, answer) => {
        const s = await subscribed()
        const methodId = await started(s)
        s.shop.patch(methodId, answer)

        expect(await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).toEqual({
          state: 'pending',
          subscriptionId: s.subscriptionId,
        })

        const state = await written(s)
        expect(state.subscription).toMatchObject({
          ...OLD_CARD,
          pendingPaymentMethodId: methodId,
          renewalNoticePeriodEnd: PERIOD_END,
        })
        expect(state.actions).toEqual([bindStart])
      },
    )

    it('changes nothing for a method the subscription does not wait for', async () => {
      const s = await subscribed()
      const first = await started(s)
      const second = await started(s)
      // The customer confirms the page of the binding that was given up.
      s.shop.confirm(first, VISA)

      expect(await settlePaymentMethod(s.deps, { paymentMethodId: first })).toEqual({
        state: 'unknown',
      })
      expect(await settlePaymentMethod(s.deps, { paymentMethodId: 'pm-of-nobody' })).toEqual({
        state: 'unknown',
      })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        ...OLD_CARD,
        pendingPaymentMethodId: second,
        renewalNoticePeriodEnd: PERIOD_END,
      })
      expect(state.actions).toEqual([bindStart, bindStart])
      // A method nobody waits for is not even asked about.
      expect(s.shop.reads).toEqual([])
    })

    it('writes once, however often the notification is repeated', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)

      const states: string[] = []
      for (let repeat = 0; repeat < 3; repeat += 1) {
        states.push((await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).state)
      }

      // Once it is stored nothing waits for it any more.
      expect(states).toEqual(['active', 'unknown', 'unknown'])
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: methodId,
        pendingPaymentMethodId: null,
      })
      expect(state.entry(bound)).toHaveLength(1)
      expect(s.shop.reads).toEqual([methodId])
    })

    it('writes once when the notification and the return page read the method at once', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)
      // Both hold the answer of the shop before either writes.
      const { getPaymentMethod } = s.shop.client
      let asked = 0
      let release!: () => void
      const both = new Promise<void>((resolve) => {
        release = resolve
      })
      const deps: PaymentMethodDeps = {
        ...s.deps,
        yookassa: {
          ...s.shop.client,
          async getPaymentMethod(id) {
            const method = await getPaymentMethod(id)
            asked += 1
            if (asked === 2) release()
            await both
            return method
          },
        },
      }

      const [notified, returned] = await Promise.all([
        settlePaymentMethod(deps, { paymentMethodId: methodId }),
        syncPaymentMethod(deps, { userId: s.userId }),
      ])

      expect(notified.state).toBe('active')
      expect(returned.state).toBe('active')
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: methodId,
        paymentMethodLast4: '1234',
        pendingPaymentMethodId: null,
        renewalNoticePeriodEnd: null,
      })
      expect(state.entry(bound)).toHaveLength(1)
    })

    it('ends a binding the shop does not know', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.forget(methodId)

      expect((await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).state).toBe(
        'inactive',
      )

      const state = await written(s)
      expect(state.subscription).toMatchObject({ ...OLD_CARD, pendingPaymentMethodId: null })
      expect(state.entry(bindFailed)[0]?.meta).toEqual({
        paymentMethodId: methodId,
        reason: bindFailureReasons.unknownToShop,
      })
    })

    it.each([
      ['was refused', (s: Subscribed, id: string) => s.shop.refuse(id)],
      ['is unknown to the shop', (s: Subscribed, id: string) => s.shop.forget(id)],
    ])(
      'leaves a newer binding alone when the one that %s is read back late',
      async (_case, end) => {
        const s = await subscribed()
        const first = await started(s)
        end(s, first)
        // The customer starts another binding while the shop is asked about the first.
        const { getPaymentMethod } = s.shop.client
        let second: string | undefined
        const deps: PaymentMethodDeps = {
          ...s.deps,
          yookassa: {
            ...s.shop.client,
            async getPaymentMethod(id) {
              second ??= await started(s)
              return getPaymentMethod(id)
            },
          },
        }

        expect(await settlePaymentMethod(deps, { paymentMethodId: first })).toEqual({
          state: 'unknown',
        })

        const state = await written(s)
        expect(second).toBeDefined()
        expect(state.subscription).toMatchObject({ ...OLD_CARD, pendingPaymentMethodId: second })
        expect(state.actions).toEqual([bindStart, bindStart])
      },
    )

    it.each([
      ['does not answer', timeout()],
      ['fails', serverError()],
      ['refuses us', new YookassaApiError('forbidden', 403, 'forbidden', {})],
    ])('throws and changes nothing when the shop %s', async (_case, failure) => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)
      s.shop.failRead(failure)

      await expect(settlePaymentMethod(s.deps, { paymentMethodId: methodId })).rejects.toBe(failure)

      const state = await written(s)
      expect(state.subscription).toMatchObject({ ...OLD_CARD, pendingPaymentMethodId: methodId })
      expect(state.actions).toEqual([bindStart])
      // The repeat of the notification stores it.
      expect((await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).state).toBe(
        'active',
      )
    })

    it('gives no method to a tariff that has ended', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { status: 'cancelled' },
      })

      expect(await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).toEqual({
        state: 'unknown',
      })

      expect((await written(s)).subscription).toMatchObject({
        ...OLD_CARD,
        pendingPaymentMethodId: methodId,
      })
      expect(s.shop.reads).toEqual([])
    })

    it('gives no method to a tariff that ends while the shop is being asked', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)
      const { getPaymentMethod } = s.shop.client
      const deps: PaymentMethodDeps = {
        ...s.deps,
        yookassa: {
          ...s.shop.client,
          async getPaymentMethod(id) {
            await db.subscription.update({
              where: { id: s.subscriptionId },
              data: { status: 'expired' },
            })
            return getPaymentMethod(id)
          },
        },
      }

      expect(await settlePaymentMethod(deps, { paymentMethodId: methodId })).toEqual({
        state: 'unknown',
      })

      const state = await written(s)
      expect(state.subscription).toMatchObject(OLD_CARD)
      expect(state.actions).toEqual([bindStart])
    })
  })

  describe('a binding as its return page asks about it', () => {
    it('stores the bound method when the notification never came', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)

      const sync = await syncPaymentMethod(s.deps, { userId: s.userId })

      expect(sync).toEqual({
        state: 'active',
        renewalCharge: 'none',
        subscription: (await getPlanOverview(db, s.workspaceId)).subscription,
      })
      expect(sync.subscription).toMatchObject({
        id: s.subscriptionId,
        autoRenewal: true,
        paymentMethod: { label: `Карта Visa ••${NBSP}1234` },
      })
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        paymentMethodId: methodId,
        pendingPaymentMethodId: null,
        renewalNoticePeriodEnd: null,
      })
      // The customer came back themselves: the entry names them.
      expect(state.entry(bound)[0]).toMatchObject({ actorType: 'user', actorId: s.userId })
    })

    it('tells of a binding the notification stored before the customer came back', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)
      await settlePaymentMethod(s.deps, { paymentMethodId: methodId })

      for (let look = 0; look < 2; look += 1) {
        expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
          state: 'active',
          subscription: { paymentMethod: { label: `Карта Visa ••${NBSP}1234` } },
        })
      }

      // Nothing is waited for: the shop is not asked again and nothing more is written.
      expect(s.shop.reads).toEqual([methodId])
      expect((await written(s)).actions).toEqual([bindStart, bound])
    })

    it('tells that the method was not bound, and goes on telling it', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.refuse(methodId)

      for (let look = 0; look < 2; look += 1) {
        expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
          state: 'inactive',
          // The saved card is the one from before.
          subscription: { paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` } },
        })
      }

      const state = await written(s)
      expect(state.subscription).toMatchObject({ ...OLD_CARD, pendingPaymentMethodId: null })
      expect(state.entry(bindFailed)).toHaveLength(1)
      expect(state.entry(bindFailed)[0]).toMatchObject({ actorType: 'user', actorId: s.userId })
      expect(s.shop.reads).toEqual([methodId])
    })

    it('tells the outcome of the latest binding, not of one before it', async () => {
      const s = await subscribed()
      const first = await started(s)
      s.shop.confirm(first, VISA)
      await settlePaymentMethod(s.deps, { paymentMethodId: first })
      // The next replacement is refused: the card of the first one stays.
      s.shop.refuse(await started(s))

      for (let look = 0; look < 2; look += 1) {
        expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
          state: 'inactive',
          subscription: { paymentMethod: { label: `Карта Visa ••${NBSP}1234` } },
        })
      }

      // And one more, confirmed, is what the page tells of after it.
      const third = await started(s)
      s.shop.confirm(third)
      await settlePaymentMethod(s.deps, { paymentMethodId: third })
      expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
        state: 'active',
        subscription: { paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` } },
      })
      expect((await written(s)).actions).toEqual([
        bindStart,
        bound,
        bindStart,
        bindFailed,
        bindStart,
        bound,
      ])
    })

    it('tells nothing of a refused binding once the method it left in place is unlinked', async () => {
      const s = await subscribed()
      s.shop.refuse(await started(s))
      expect((await syncPaymentMethod(s.deps, { userId: s.userId })).state).toBe('inactive')

      await unlinkPaymentMethod(s.deps, { userId: s.userId })

      expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
        state: 'none',
        subscription: { paymentMethod: null },
      })
    })

    it('tells of the binding of this subscription, whatever happened to another since', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)
      await settlePaymentMethod(s.deps, { paymentMethodId: methodId })
      // Another customer's binding ends later, and otherwise.
      const other = await subscribed()
      other.shop.refuse(await started(other))
      expect((await syncPaymentMethod(other.deps, { userId: other.userId })).state).toBe('inactive')

      expect((await syncPaymentMethod(s.deps, { userId: s.userId })).state).toBe('active')
      expect((await syncPaymentMethod(other.deps, { userId: other.userId })).state).toBe('inactive')
    })

    it('waits while the customer has not confirmed, and for the binding started last', async () => {
      const s = await subscribed()
      const first = await started(s)
      s.shop.confirm(first, VISA)
      await settlePaymentMethod(s.deps, { paymentMethodId: first })
      // Another replacement after a finished one.
      const second = await started(s)

      expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
        state: 'pending',
        subscription: { paymentMethod: { label: `Карта Visa ••${NBSP}1234` } },
      })

      expect(s.shop.reads).toEqual([first, second])
      expect((await written(s)).subscription).toMatchObject({
        paymentMethodId: first,
        pendingPaymentMethodId: second,
      })
    })

    it('shows the binding as waiting while the shop cannot be reached', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)
      s.shop.failRead(timeout())
      s.shop.failRead(serverError())

      for (let look = 0; look < 2; look += 1) {
        expect((await syncPaymentMethod(s.deps, { userId: s.userId })).state).toBe('pending')
      }
      expect((await written(s)).subscription).toMatchObject({
        ...OLD_CARD,
        pendingPaymentMethodId: methodId,
      })
      // The next look, once the shop answers, stores the method.
      expect((await syncPaymentMethod(s.deps, { userId: s.userId })).state).toBe('active')
    })

    it('throws a failure of the shop that asking again does not cure', async () => {
      const s = await subscribed()
      await started(s)
      const refused = new YookassaApiError('invalid_credentials', 401, 'invalid_credentials', {})
      s.shop.failRead(refused)

      await expect(syncPaymentMethod(s.deps, { userId: s.userId })).rejects.toBe(refused)
    })

    it('ends a binding the shop does not know instead of waiting for it', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.forget(methodId)

      expect((await syncPaymentMethod(s.deps, { userId: s.userId })).state).toBe('inactive')
      expect((await written(s)).subscription.pendingPaymentMethodId).toBeNull()
    })

    it('has nothing to tell a user without a workspace, and makes none', async () => {
      const { shop, deps } = paymentMethodTestDeps(db)
      const { userId } = await fixtures.user()

      expect(await syncPaymentMethod(deps, { userId })).toEqual({
        state: 'none',
        renewalCharge: 'none',
        subscription: null,
      })

      expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toBeNull()
      expect(shop.reads).toEqual([])
    })

    it.each(['cancelled', 'expired'] as const)(
      'has nothing to tell once the tariff is %s, whatever it waited for',
      async (status) => {
        const s = await subscribed()
        const methodId = await started(s)
        s.shop.confirm(methodId, VISA)
        await db.subscription.update({ where: { id: s.subscriptionId }, data: { status } })

        expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toEqual({
          state: 'none',
          renewalCharge: 'none',
          subscription: null,
        })
        expect(s.shop.reads).toEqual([])
      },
    )

    it('has nothing to tell of a method that was saved by a payment', async () => {
      const s = await subscribed()

      expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
        state: 'none',
        subscription: { paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` } },
      })
      expect(s.shop.reads).toEqual([])
    })

    it('does not look at the binding of another user', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)
      const other = await subscribed()

      expect((await syncPaymentMethod(s.deps, { userId: other.userId })).state).toBe('none')

      expect(s.shop.reads).toEqual([])
      expect((await written(s)).subscription.pendingPaymentMethodId).toBe(methodId)
      expect((await written(other)).subscription).toMatchObject(OLD_CARD)
    })
  })

  describe('unlinking the method', () => {
    it('clears the method, switches auto-renewal off and leaves the tariff to its period', async () => {
      const s = await subscribed()

      // No charge of the period had been started: nothing is left under way.
      expect(await unlinkPaymentMethod(s.deps, { userId: s.userId })).toEqual({
        renewalCharge: 'none',
      })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        ...NO_CARD,
        pendingPaymentMethodId: null,
        cancelAtPeriodEnd: true,
        cancelledAt: TEST_NOW,
        renewalNoticePeriodEnd: null,
        // The tariff itself is as it was.
        status: 'active',
        currentPeriodEnd: PERIOD_END,
      })
      expect(state.actions).toEqual([unlink])
      expect(state.audit[0]).toMatchObject({
        actorType: 'user',
        actorId: s.userId,
        targetType: 'subscription',
        targetId: s.subscriptionId,
        meta: {
          paymentMethodId: OLD_CARD.paymentMethodId,
          autoRenewalWasOn: true,
          periodEnd: PERIOD_END.toISOString(),
          renewalCharge: 'none',
        },
      })
      expect((await getPlanOverview(db, s.workspaceId)).subscription).toMatchObject({
        status: 'active',
        autoRenewal: false,
        paymentMethod: null,
      })
      // ЮKassa has no call that deletes a saved method: the shop is not asked.
      expect(s.shop.created).toEqual([])
      expect(s.shop.reads).toEqual([])
    })

    it('needs no shop', async () => {
      const s = await subscribed()

      await unlinkPaymentMethod({ prisma: db, appEnv: 'test' }, { userId: s.userId })

      const { subscription } = await written(s)
      expect(subscription).toMatchObject({ ...NO_CARD, cancelAtPeriodEnd: true })
      // Without a clock of its own it takes the system one.
      expect(Math.abs((subscription.cancelledAt?.getTime() ?? 0) - Date.now())).toBeLessThan(60_000)
    })

    it('keeps the moment auto-renewal was switched off before', async () => {
      const switchedOff = new Date('2026-09-20T10:00:00Z')
      const s = await subscribed({ cancelAtPeriodEnd: true, cancelledAt: switchedOff })

      await unlinkPaymentMethod(s.deps, { userId: s.userId })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        ...NO_CARD,
        cancelAtPeriodEnd: true,
        cancelledAt: switchedOff,
      })
      expect(state.audit[0]?.meta).toMatchObject({ autoRenewalWasOn: false })
    })

    it.each([
      ['a tariff that never renewed', { cancelAtPeriodEnd: true, cancelledAt: null }],
      // A moment left behind by an earlier switching off, with auto-renewal on again.
      ['a tariff that renews again', { cancelledAt: new Date('2026-09-20T10:00:00Z') }],
    ])('records the moment for %s', async (_case, patch) => {
      const s = await subscribed(patch)

      await unlinkPaymentMethod(s.deps, { userId: s.userId })

      expect((await written(s)).subscription).toMatchObject({
        cancelAtPeriodEnd: true,
        cancelledAt: TEST_NOW,
      })
    })

    it('unlinks the method of an overdue tariff and leaves it overdue', async () => {
      const pastDueSince = new Date('2026-09-30T09:00:00Z')
      const s = await subscribed({ pastDueSince }, 'past_due')

      await unlinkPaymentMethod(s.deps, { userId: s.userId })

      expect((await written(s)).subscription).toMatchObject({
        ...NO_CARD,
        status: 'past_due',
        pastDueSince,
        cancelAtPeriodEnd: true,
      })
    })

    it('has nothing to change without a saved method, and leaves a binding under way alone', async () => {
      const s = await subscribed(withoutMethod)
      const methodId = await started(s)

      await expect(unlinkPaymentMethod(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_NOTHING_TO_CHANGE',
        httpStatus: 409,
      })

      const state = await written(s)
      expect(state.subscription).toMatchObject({
        ...NO_CARD,
        pendingPaymentMethodId: methodId,
        cancelAtPeriodEnd: true,
        cancelledAt: null,
      })
      expect(state.actions).toEqual([bindStart])
    })

    it('is refused for a user who has no workspace, and makes none', async () => {
      const { userId } = await fixtures.user()

      await expect(
        unlinkPaymentMethod({ prisma: db, appEnv: 'test' }, { userId }),
      ).rejects.toMatchObject({ code: 'BILLING_NO_LIVE_SUBSCRIPTION', httpStatus: 409 })

      expect(await findPersonalWorkspace(db, { userId, appEnv: 'test' })).toBeNull()
    })

    it.each(['cancelled', 'expired'] as const)(
      'is refused once the tariff is %s, and its method stays in the row',
      async (status) => {
        const s = await subscribed({}, status)

        await expect(unlinkPaymentMethod(s.deps, { userId: s.userId })).rejects.toMatchObject({
          code: 'BILLING_NO_LIVE_SUBSCRIPTION',
        })

        const state = await written(s)
        expect(state.subscription).toMatchObject(OLD_CARD)
        expect(state.audit).toEqual([])
      },
    )

    it('is refused for a tariff that ends between the look and the change', async () => {
      const s = await subscribed()
      // The tariff ends right after the first read found it live.
      const { findFirst } = db.subscription
      const racing = {
        ...db,
        $transaction: db.$transaction.bind(db),
        workspace: db.workspace,
        subscription: {
          ...db.subscription,
          async findFirst(args: Parameters<typeof findFirst>[0]) {
            const row = await findFirst.call(db.subscription, args)
            await db.subscription.update({
              where: { id: s.subscriptionId },
              data: { status: 'cancelled' },
            })
            return row
          },
        },
      } as unknown as PrismaClient

      await expect(
        unlinkPaymentMethod({ ...s.deps, prisma: racing }, { userId: s.userId }),
      ).rejects.toMatchObject({ code: 'BILLING_NO_LIVE_SUBSCRIPTION' })

      const state = await written(s)
      expect(state.subscription).toMatchObject({ ...OLD_CARD, cancelAtPeriodEnd: false })
      expect(state.audit).toEqual([])
    })

    it('writes once when the customer presses twice', async () => {
      const s = await subscribed()

      const outcomes = await Promise.allSettled([
        unlinkPaymentMethod(s.deps, { userId: s.userId }),
        unlinkPaymentMethod(s.deps, { userId: s.userId }),
      ])

      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
      const refused = outcomes.find((outcome) => outcome.status === 'rejected')
      expect(refused).toMatchObject({ reason: { code: 'BILLING_NOTHING_TO_CHANGE' } })
      const state = await written(s)
      expect(state.subscription).toMatchObject({ ...NO_CARD, cancelAtPeriodEnd: true })
      expect(state.actions).toEqual([unlink])
      // And a later try has nothing to change either.
      await expect(unlinkPaymentMethod(s.deps, { userId: s.userId })).rejects.toMatchObject({
        code: 'BILLING_NOTHING_TO_CHANGE',
      })
    })

    it('forgets a replacement under way: its card, confirmed afterwards, is not saved', async () => {
      const s = await subscribed()
      const methodId = await started(s)

      await unlinkPaymentMethod(s.deps, { userId: s.userId })
      s.shop.confirm(methodId, VISA)

      expect(await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).toEqual({
        state: 'unknown',
      })
      expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
        state: 'none',
        subscription: { autoRenewal: false, paymentMethod: null },
      })
      const state = await written(s)
      expect(state.subscription).toMatchObject({ ...NO_CARD, pendingPaymentMethodId: null })
      expect(state.actions).toEqual([bindStart, unlink])
    })

    it('tells nothing of a binding that was unlinked after it', async () => {
      const s = await subscribed()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)
      await settlePaymentMethod(s.deps, { paymentMethodId: methodId })

      await unlinkPaymentMethod(s.deps, { userId: s.userId })

      expect((await syncPaymentMethod(s.deps, { userId: s.userId })).state).toBe('none')
    })

    it('does not touch the method of another user', async () => {
      const s = await subscribed()
      const other = await subscribed()

      await unlinkPaymentMethod(s.deps, { userId: s.userId })

      expect((await written(other)).subscription).toMatchObject({
        ...OLD_CARD,
        cancelAtPeriodEnd: false,
      })
    })
  })

  // The renewal passes look at every due row of the database. These tests stand in 2019, where
  // no other suite has a row that is due.
  describe('the renewal of a tariff whose method changed', () => {
    const START = new Date('2019-03-10T09:00:00.000Z')
    const END = new Date('2019-04-10T09:00:00.000Z')

    /** A shop that charges saved methods: every charge succeeds at once. */
    function chargingShop() {
      const shop = yookassaStub()
      const charges: ChargeSavedInput[] = []
      const client: NonNullable<RenewalDeps['yookassa']> = {
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
      }
      return { client, charges }
    }

    function passes(at: string) {
      const charging = chargingShop()
      const deps: RenewalDeps = {
        prisma: db,
        yookassa: charging.client,
        appUrl: TEST_APP_URL,
        now: () => new Date(at),
        settings: { noticeDays: 3, pastDueDays: 7 },
      }
      return { deps, charges: charging.charges }
    }

    /** A tariff whose period ends on 10 April 2019, with its notice written the usual way. */
    async function dueForRenewal() {
      const s = await subscribed({
        currentPeriodStart: START,
        currentPeriodEnd: END,
        periodAnchor: START,
        renewalNoticePeriodEnd: null,
      })
      const { email } = await db.user.findUniqueOrThrow({ where: { id: s.userId } })
      emails.push(email)
      const noticed = passes('2019-04-08T09:00:00.000Z')
      expect((await sendRenewalNotices(noticed.deps)).counts.notified).toBe(1)
      const clock = { now: new Date('2019-04-09T09:00:00.000Z') }
      return { ...s, email, deps: { ...s.deps, now: () => clock.now } }
    }

    const notices = (email: string) =>
      db.outboxEvent.findMany({
        where: {
          topic: 'notifications',
          type: 'billing.renewal_notice',
          payload: { path: ['to'], equals: email },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })

    it('is announced again with the new method before that method is charged', async () => {
      const s = await dueForRenewal()
      const methodId = await started(s)
      s.shop.confirm(methodId, VISA)
      await settlePaymentMethod(s.deps, { paymentMethodId: methodId })
      const afterTheEnd = passes('2019-04-10T09:01:00.000Z')

      // The notice that stands named the card that is gone: no charge follows it.
      expect((await chargeRenewals(afterTheEnd.deps)).counts.renewed).toBe(0)
      expect(afterTheEnd.charges).toEqual([])

      expect((await sendRenewalNotices(afterTheEnd.deps)).counts.notified).toBe(1)
      expect((await notices(s.email)).map((letter) => letter.payload)).toMatchObject([
        { paymentMethod: `Карта «Мир» ••${NBSP}4444` },
        { paymentMethod: `Карта Visa ••${NBSP}1234` },
      ])
      expect((await chargeRenewals(afterTheEnd.deps)).counts.renewed).toBe(1)

      expect(afterTheEnd.charges).toMatchObject([{ payment_method_id: methodId }])
      const state = await written(s)
      expect(state.subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: END,
        paymentMethodId: methodId,
      })
      expect(state.entry(renewalJobAuditActions.notice)).toHaveLength(2)
    })

    it('is not made after the method was unlinked: the tariff ends with its period', async () => {
      const s = await dueForRenewal()

      await unlinkPaymentMethod(s.deps, { userId: s.userId })
      const afterTheEnd = passes('2019-04-10T09:01:00.000Z')

      expect((await sendRenewalNotices(afterTheEnd.deps)).counts.notified).toBe(0)
      expect((await chargeRenewals(afterTheEnd.deps)).counts.renewed).toBe(0)
      expect(afterTheEnd.charges).toEqual([])
      expect((await endPeriods(afterTheEnd.deps)).counts.cancelled).toBe(1)

      const state = await written(s)
      expect(state.subscription).toMatchObject({ status: 'cancelled', currentPeriodEnd: END })
      const orders = await db.order.findMany({ where: { workspaceId: s.workspaceId } })
      expect(orders.filter(isRenewalOrder)).toEqual([])
      expect(await notices(s.email)).toHaveLength(1)
    })

    // A charge that was started is not stopped and not returned when the method changes: the
    // customer is told where it stands. The tests below change the method while one is under
    // way.
    const NEXT_END = new Date('2019-05-10T09:00:00.000Z')
    const AFTER_THE_END = '2019-04-10T09:01:00.000Z'
    const MIR = `Карта «Мир» ••${NBSP}4444`
    const NEW_VISA = `Карта Visa ••${NBSP}1234`

    /**
     * The passes of the scheduler over a shop whose charge the test scripts — what happens
     * while the request is on its way, and how it ends: the payment succeeds at once, has no
     * outcome yet, or the answer is lost — with a clock the test moves.
     */
    function scheduler(at: string) {
      const shop = yookassaStub()
      const charges: ChargeSavedInput[] = []
      const made = new Set<string>()
      const clock = { now: new Date(at) }
      const script: {
        during?: () => Promise<void>
        outcome: 'succeeded' | 'pending' | 'lost'
        /** ЮKassa names the method a payment was made with. */
        namesMethod: boolean
      } = { outcome: 'succeeded', namesMethod: true }
      const client: NonNullable<RenewalDeps['yookassa']> = {
        ...shop.client,
        async chargeWithSavedMethod(input, idempotenceKey) {
          charges.push(structuredClone(input))
          const { id } = await shop.client.createPayment(
            { ...input, capture: true },
            idempotenceKey,
          )
          // A repeat under the same key is answered with the payment of the first request.
          if (!made.has(id)) {
            made.add(id)
            const old = input.payment_method_id === OLD_CARD.paymentMethodId
            shop.patch(id, {
              // A charge has no page to confirm it on.
              confirmation: undefined,
              ...(script.namesMethod
                ? {
                    payment_method: {
                      id: input.payment_method_id,
                      type: 'bank_card',
                      saved: true,
                      title: old ? 'Bank card *4444' : 'Bank card *1234',
                      card: old ? { card_type: 'Mir', last4: '4444' } : VISA,
                    },
                  }
                : {}),
            })
          }
          await script.during?.()
          if (script.outcome === 'lost') throw timeout()
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
      return { shop, client, charges, script, clock, deps }
    }

    /**
     * The database as a charge pass sees it, with `then` run right after the transaction that
     * made the order of the charge has committed: before the request leaves.
     */
    function afterChargeStarted(then: () => Promise<unknown>): PrismaClient {
      let done = false
      return new Proxy(db, {
        get(target, property, receiver) {
          if (property !== '$transaction') return Reflect.get(target, property, receiver)
          return async (...args: unknown[]) => {
            const result: unknown = await Reflect.apply(
              target.$transaction as (...a: unknown[]) => Promise<unknown>,
              target,
              args,
            )
            if (!done && typeof result === 'object' && result !== null && 'order' in result) {
              done = true
              await then()
            }
            return result
          }
        },
      })
    }

    const renewals = async ({ workspaceId }: Subscribed) =>
      (await db.order.findMany({ where: { workspaceId } })).filter(isRenewalOrder)
    const failureLetters = (email: string) =>
      db.outboxEvent.findMany({
        where: {
          topic: 'notifications',
          type: 'billing.payment_failed',
          payload: { path: ['to'], equals: email },
        },
      })
    const later = (clock: { now: Date }, ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms)
    }

    describe('an unlink while the charge of the period is under way', () => {
      it('does not stop a charge whose request is on its way, and says that it has no answer', async () => {
        const s = await dueForRenewal()
        const pass = scheduler(AFTER_THE_END)
        let unlinked: PaymentMethodUnlinkDto | undefined
        // The customer confirms «Отвязать» while the shop is answering the charge.
        pass.script.during = async () => {
          unlinked = await unlinkPaymentMethod(s.deps, { userId: s.userId })
        }

        expect((await chargeRenewals(pass.deps)).counts.renewed).toBe(1)

        expect(unlinked).toEqual({ renewalCharge: 'unanswered' })
        const state = await written(s)
        expect(state.entry(unlink)[0]?.meta).toMatchObject({
          paymentMethodId: OLD_CARD.paymentMethodId,
          renewalCharge: 'unanswered',
        })
        // The charge was made with the card that is unlinked by now, and its payment is
        // applied: the tariff has another month, without a method and without auto-renewal.
        expect(pass.charges).toMatchObject([{ payment_method_id: OLD_CARD.paymentMethodId }])
        expect(state.subscription).toMatchObject({
          ...NO_CARD,
          status: 'active',
          currentPeriodEnd: NEXT_END,
          cancelAtPeriodEnd: true,
        })
        expect((await renewals(s)).map((order) => order.status)).toEqual(['paid'])

        // «Больше списаний не будет»: the month that was paid for is the last one.
        pass.clock.now = new Date('2019-05-10T09:01:00.000Z')
        expect((await sendRenewalNotices(pass.deps)).counts.notified).toBe(0)
        expect((await chargeRenewals(pass.deps)).counts.renewed).toBe(0)
        expect(pass.charges).toHaveLength(1)
        expect((await endPeriods(pass.deps)).counts.cancelled).toBe(1)
      })

      it('sees a charge that was started and has not left yet: the request still goes, with the unlinked card', async () => {
        const s = await dueForRenewal()
        const pass = scheduler(AFTER_THE_END)
        let unlinked: PaymentMethodUnlinkDto | undefined
        let cardAtRequest: string | null | undefined
        pass.script.during = async () => {
          cardAtRequest = (await written(s)).subscription.paymentMethodId
        }
        // The unlink waited for the lock of the pass and commits right after the order of the
        // charge was made.
        const prisma = afterChargeStarted(async () => {
          unlinked = await unlinkPaymentMethod(s.deps, { userId: s.userId })
        })

        expect((await chargeRenewals({ ...pass.deps, prisma })).counts.renewed).toBe(1)

        // The customer was told of the charge before its request left.
        expect(unlinked).toEqual({ renewalCharge: 'unanswered' })
        expect(cardAtRequest).toBeNull()
        expect(pass.charges).toMatchObject([{ payment_method_id: OLD_CARD.paymentMethodId }])
        expect((await written(s)).subscription).toMatchObject({
          ...NO_CARD,
          status: 'active',
          currentPeriodEnd: NEXT_END,
          cancelAtPeriodEnd: true,
        })
        expect((await renewals(s)).map((order) => order.status)).toEqual(['paid'])
      })

      it('does not repeat a charge that got no answer; the notification of its payment still renews the tariff', async () => {
        const s = await dueForRenewal()
        const pass = scheduler(AFTER_THE_END)
        pass.script.outcome = 'lost'
        let unlinked: PaymentMethodUnlinkDto | undefined
        pass.script.during = async () => {
          unlinked = await unlinkPaymentMethod(s.deps, { userId: s.userId })
        }

        expect((await chargeRenewals(pass.deps)).counts.unanswered).toBe(1)

        expect(unlinked).toEqual({ renewalCharge: 'unanswered' })
        const [order] = await renewals(s)
        expect(order).toMatchObject({ status: 'pending', yookassaPaymentId: null })

        // The request is not repeated for a customer who switched the charges off, and the
        // tariff does not end while nobody can tell whether its next month was paid for.
        later(pass.clock, STUCK_ORDER_AFTER_MS)
        expect((await settleStuckOrders(pass.deps)).counts.waiting).toBe(1)
        expect(pass.charges).toHaveLength(1)
        expect((await endPeriods(pass.deps)).counts.cancelled).toBe(0)

        // The shop did make the payment, and its notification comes. No order holds a payment
        // whose id was never stored: it is read back, found to be the payment of this order by
        // its metadata and amount, attached and applied — the month that was paid for is the
        // customer's, as with a charge that was already at the bank.
        const payment = pass.shop.only()
        pass.shop.succeed(payment.id, { saved: true, capturedAt: '2019-04-10T09:02:00.000Z' })
        expect(
          await settleOrderByPaymentId(
            { ...pass.deps, yookassa: pass.client },
            { paymentId: payment.id },
          ),
        ).toEqual({ state: 'paid', orderId: order?.id, refundNeeded: false })

        const state = await written(s)
        expect(await renewals(s)).toMatchObject([{ status: 'paid', yookassaPaymentId: payment.id }])
        expect(state.entry(settlementAuditActions.paymentAttached)).toMatchObject([
          { targetType: 'order', targetId: order?.id, meta: { paymentId: payment.id } },
        ])
        // One more month without a method and without auto-renewal: nothing more is charged.
        expect(state.subscription).toMatchObject({
          ...NO_CARD,
          status: 'active',
          currentPeriodEnd: NEXT_END,
          cancelAtPeriodEnd: true,
        })
        expect(state.entry(renewalAuditActions.unknownResult)).toEqual([])
        expect(await failureLetters(s.email)).toEqual([])
        expect(pass.charges).toHaveLength(1)
      })

      it('gives up a charge whose answer and notification never came, for an operator to look up', async () => {
        const s = await dueForRenewal()
        const pass = scheduler(AFTER_THE_END)
        pass.script.outcome = 'lost'
        pass.script.during = async () => {
          await unlinkPaymentMethod(s.deps, { userId: s.userId })
        }
        expect((await chargeRenewals(pass.deps)).counts.unanswered).toBe(1)
        const [order] = await renewals(s)
        // The shop did make the payment; web was down for the day its notification was repeated.
        const payment = pass.shop.only()
        pass.shop.succeed(payment.id, { saved: true })

        // Once a repeat is no longer safe the order ends for an operator.
        pass.clock.now = new Date(
          new Date(AFTER_THE_END).getTime() + RENEWAL_RETRY_WINDOW_MS + RENEWAL_GIVE_UP_MARGIN_MS,
        )
        expect((await settleStuckOrders(pass.deps)).counts.gave_up).toBe(1)

        const state = await written(s)
        expect(await renewals(s)).toMatchObject([
          {
            status: 'failed',
            failureReason: orderFailureReasons.unknownResult,
            yookassaPaymentId: null,
          },
        ])
        expect(state.entry(renewalAuditActions.unknownResult)).toMatchObject([
          { targetType: 'order', targetId: order?.id, meta: { pastDue: false } },
        ])
        // The tariff is not overdue and nobody is written to about a debt.
        expect(state.subscription).toMatchObject({ status: 'active', currentPeriodEnd: END })
        expect(await failureLetters(s.email)).toEqual([])
        expect(pass.charges).toHaveLength(1)
        // The operator sees the charge, with what to look its payment up by.
        const listed = await listRefundsNeeded({ prisma: db })
        expect(
          listed.unknownCharges.filter((charge) => charge.workspaceId === s.workspaceId),
        ).toMatchObject([
          {
            orderId: order?.id,
            amount: order?.amount.toFixed(2),
            idempotenceKey: order?.idempotenceKey,
          },
        ])
        // And the tariff ends with the period it was paid for.
        expect((await endPeriods(pass.deps)).counts.cancelled).toBe(1)

        // The payment turns up — a late notification, or the operator's `billing:settle-payment`
        // with the id from the cabinet: the money was taken for an order that was closed, and
        // it is asked back.
        expect(
          await settleOrderByPaymentId(
            { ...pass.deps, yookassa: pass.client },
            { paymentId: payment.id },
          ),
        ).toEqual({ state: 'failed', orderId: order?.id, refundNeeded: true })
        const after = await listRefundsNeeded({ prisma: db })
        expect(
          after.unknownCharges.filter((charge) => charge.workspaceId === s.workspaceId),
        ).toEqual([])
        expect(after.items.filter((item) => item.workspaceId === s.workspaceId)).toMatchObject([
          { orderId: order?.id, paymentId: payment.id, byCommand: false },
        ])
      })

      it('says that the charge is at the bank, and its payment still renews the tariff', async () => {
        const s = await dueForRenewal()
        const pass = scheduler(AFTER_THE_END)
        pass.script.outcome = 'pending'
        expect((await chargeRenewals(pass.deps)).counts.pending).toBe(1)

        expect(await unlinkPaymentMethod(s.deps, { userId: s.userId })).toEqual({
          renewalCharge: 'at_bank',
        })

        expect((await written(s)).entry(unlink)[0]?.meta).toMatchObject({
          renewalCharge: 'at_bank',
        })
        // The tariff does not end while the payment is on its way.
        expect((await endPeriods(pass.deps)).counts.cancelled).toBe(0)
        // The bank takes the money a few minutes later.
        pass.shop.succeed(pass.shop.only().id, {
          saved: true,
          capturedAt: '2019-04-10T09:05:00.000Z',
        })
        later(pass.clock, STUCK_ORDER_AFTER_MS)
        expect((await settleStuckOrders(pass.deps)).counts.paid).toBe(1)

        expect((await written(s)).subscription).toMatchObject({
          ...NO_CARD,
          status: 'active',
          currentPeriodEnd: NEXT_END,
          cancelAtPeriodEnd: true,
        })
        expect((await renewals(s)).map((order) => order.status)).toEqual(['paid'])
        expect(pass.charges).toHaveLength(1)
      })

      it('ends the tariff with its period when the bank declines that charge, and owes nothing', async () => {
        const s = await dueForRenewal()
        const pass = scheduler(AFTER_THE_END)
        pass.script.outcome = 'pending'
        await chargeRenewals(pass.deps)
        expect(await unlinkPaymentMethod(s.deps, { userId: s.userId })).toEqual({
          renewalCharge: 'at_bank',
        })

        pass.shop.cancel(pass.shop.only().id, 'insufficient_funds')
        later(pass.clock, STUCK_ORDER_AFTER_MS)
        expect((await settleStuckOrders(pass.deps)).counts.failed).toBe(1)

        // «Если оно пройдёт»: it did not, and the customer had switched the charges off.
        expect((await written(s)).subscription).toMatchObject({
          status: 'active',
          currentPeriodEnd: END,
        })
        expect(await failureLetters(s.email)).toEqual([])
        expect((await endPeriods(pass.deps)).counts.cancelled).toBe(1)
      })
    })

    describe('a replacement while the charge of the period is under way', () => {
      it('tells of the charge that was started with the method before it, for as long as it is under way', async () => {
        const s = await dueForRenewal()
        // The customer is on the page of the binding when the period ends.
        const methodId = await started(s)
        s.shop.confirm(methodId, VISA)
        const pass = scheduler(AFTER_THE_END)
        let settled: PaymentMethodSettlement | undefined
        let onTheWay: PaymentMethodSyncDto | undefined
        // The return page asks while the request is on its way.
        pass.script.during = async () => {
          onTheWay = await syncPaymentMethod(s.deps, { userId: s.userId })
        }
        // The notification stores the card right after the order of the charge was made.
        const prisma = afterChargeStarted(async () => {
          settled = await settlePaymentMethod(s.deps, { paymentMethodId: methodId })
        })

        expect((await chargeRenewals({ ...pass.deps, prisma })).counts.renewed).toBe(1)

        expect(settled).toEqual({
          state: 'active',
          subscriptionId: s.subscriptionId,
          renewalCharge: 'unanswered',
        })
        // The page is not told «спишем этим способом» of a charge that left with the old card.
        expect(onTheWay).toMatchObject({
          state: 'active',
          renewalCharge: 'unanswered',
          subscription: { paymentMethod: { label: NEW_VISA } },
        })
        const state = await written(s)
        expect(state.entry(bound)[0]?.meta).toMatchObject({
          paymentMethodId: methodId,
          renewalCharge: 'unanswered',
          periodEnd: END.toISOString(),
        })
        // The card that was saved when the charge was started is the one that is charged.
        expect(pass.charges).toMatchObject([{ payment_method_id: OLD_CARD.paymentMethodId }])
        expect(state.subscription).toMatchObject({
          status: 'active',
          currentPeriodEnd: NEXT_END,
          paymentMethodId: methodId,
        })
        // The charge is over: the page has nothing more to say of it.
        expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
          state: 'active',
          renewalCharge: 'none',
        })
      })

      it.each([
        ['the card the payment was made with', true, MIR],
        ['the card of the subscription when the payment names none', false, NEW_VISA],
      ])(
        'announces nothing more for a charge that is at the bank, and a declined one is told of with %s',
        async (_case, namesMethod, declinedCard) => {
          const s = await dueForRenewal()
          const pass = scheduler(AFTER_THE_END)
          pass.script.outcome = 'pending'
          pass.script.namesMethod = namesMethod
          expect((await chargeRenewals(pass.deps)).counts.pending).toBe(1)

          // The customer replaces the card while the old one is being charged.
          const methodId = await started(s)
          s.shop.confirm(methodId, VISA)
          expect(await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).toEqual({
            state: 'active',
            subscriptionId: s.subscriptionId,
            renewalCharge: 'at_bank',
          })

          // Nothing more can be charged for the period: its notice stands.
          const stored = await written(s)
          expect(stored.subscription).toMatchObject({
            paymentMethodId: methodId,
            renewalNoticePeriodEnd: END,
          })
          expect(stored.entry(bound)[0]?.meta).toMatchObject({
            renewalCharge: 'at_bank',
            periodEnd: END.toISOString(),
          })
          expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
            state: 'active',
            renewalCharge: 'at_bank',
          })
          // No second «скоро списание» about a charge that is being made from the old card.
          later(pass.clock, 60_000)
          expect((await sendRenewalNotices(pass.deps)).counts.notified).toBe(0)
          expect((await notices(s.email)).map((letter) => letter.payload)).toMatchObject([
            { paymentMethod: MIR },
          ])
          expect((await chargeRenewals(pass.deps)).counts.renewed).toBe(0)
          expect(pass.charges).toMatchObject([{ payment_method_id: OLD_CARD.paymentMethodId }])

          // The bank declines the charge of the old card.
          pass.shop.cancel(pass.shop.only().id, 'card_expired')
          later(pass.clock, STUCK_ORDER_AFTER_MS)
          expect((await settleStuckOrders(pass.deps)).counts.failed).toBe(1)

          expect((await written(s)).subscription).toMatchObject({
            status: 'past_due',
            paymentMethodId: methodId,
          })
          // «Не получилось списать» names the card that was asked, not the one saved since.
          expect((await failureLetters(s.email)).map((letter) => letter.payload)).toMatchObject([
            { paymentMethod: declinedCard },
          ])
          expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
            state: 'active',
            renewalCharge: 'none',
          })
        },
      )

      it('names the saved card by what the subscription knows of it when that card was declined', async () => {
        const s = await dueForRenewal()
        const pass = scheduler(AFTER_THE_END)
        pass.script.outcome = 'pending'
        await chargeRenewals(pass.deps)
        // The payment names the method it was made with, and tells less of its card.
        const payment = pass.shop.only()
        pass.shop.patch(payment.id, {
          payment_method: { id: OLD_CARD.paymentMethodId, type: 'bank_card', saved: true },
        })

        pass.shop.cancel(payment.id, 'insufficient_funds')
        later(pass.clock, STUCK_ORDER_AFTER_MS)
        expect((await settleStuckOrders(pass.deps)).counts.failed).toBe(1)

        expect((await failureLetters(s.email)).map((letter) => letter.payload)).toMatchObject([
          { paymentMethod: MIR },
        ])
      })

      it('announces a charge without an answer again, and repeats it with the new method', async () => {
        const s = await dueForRenewal()
        const pass = scheduler(AFTER_THE_END)
        pass.script.outcome = 'lost'
        expect((await chargeRenewals(pass.deps)).counts.unanswered).toBe(1)

        // The notification never comes: the look of the return page stores the card, and tells.
        const methodId = await started(s)
        s.shop.confirm(methodId, VISA)
        expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
          state: 'active',
          renewalCharge: 'unanswered',
          subscription: { paymentMethod: { label: NEW_VISA } },
        })

        // A repeat would ask another card than the notice named: it waits for a notice of its own.
        expect((await written(s)).subscription.renewalNoticePeriodEnd).toBeNull()
        later(pass.clock, STUCK_ORDER_AFTER_MS)
        expect((await settleStuckOrders(pass.deps)).counts.waiting).toBe(1)
        expect(pass.charges).toHaveLength(1)
        expect((await sendRenewalNotices(pass.deps)).counts.notified).toBe(1)
        expect((await notices(s.email)).map((letter) => letter.payload)).toMatchObject([
          { paymentMethod: MIR },
          { paymentMethod: NEW_VISA },
        ])

        pass.script.outcome = 'succeeded'
        expect((await settleStuckOrders(pass.deps)).counts.paid).toBe(1)

        expect(pass.charges).toMatchObject([
          { payment_method_id: OLD_CARD.paymentMethodId },
          { payment_method_id: methodId },
        ])
        expect((await written(s)).subscription).toMatchObject({
          status: 'active',
          currentPeriodEnd: NEXT_END,
          paymentMethodId: methodId,
        })
      })

      it('says nothing of the charge of a later period, which is made with the method it saved', async () => {
        const s = await dueForRenewal()
        const pass = scheduler(AFTER_THE_END)
        pass.script.outcome = 'pending'
        await chargeRenewals(pass.deps)
        const methodId = await started(s)
        s.shop.confirm(methodId, VISA)
        expect(await settlePaymentMethod(s.deps, { paymentMethodId: methodId })).toMatchObject({
          renewalCharge: 'at_bank',
        })
        pass.shop.succeed(pass.shop.only().id, { saved: true, capturedAt: END.toISOString() })
        later(pass.clock, STUCK_ORDER_AFTER_MS)
        expect((await settleStuckOrders(pass.deps)).counts.paid).toBe(1)

        // A month later the new card is announced and charged, and its payment waits for the bank.
        pass.clock.now = new Date('2019-05-10T09:01:00.000Z')
        expect((await sendRenewalNotices(pass.deps)).counts.notified).toBe(1)
        expect((await chargeRenewals(pass.deps)).counts.pending).toBe(1)
        expect(pass.charges.at(-1)).toMatchObject({ payment_method_id: methodId })

        // The entry of the binding spoke of the period before this one.
        expect(await syncPaymentMethod(s.deps, { userId: s.userId })).toMatchObject({
          state: 'active',
          renewalCharge: 'none',
        })
      })
    })
  })
})

// The stub alone, for the tests above: what it answers has to be what ЮKassa would.
describe('the scripted shop of payment methods', () => {
  it('answers a repeated key with the first binding and a read with what the test did to it', async () => {
    const shop = paymentMethodStub()
    const request = {
      type: 'bank_card',
      confirmation: { type: 'redirect', return_url: 'https://raditi.example/return' },
    } as const

    const first = await shop.client.createPaymentMethod(request, 'key-1')
    const repeated = await shop.client.createPaymentMethod(request, 'key-1')
    const other = await shop.client.createPaymentMethod(request, 'key-2')

    expect(repeated).toEqual(first)
    expect(other.id).not.toBe(first.id)
    expect(first).toMatchObject({ status: 'pending', saved: false })
    shop.confirm(first.id)
    shop.refuse(other.id)
    expect(await shop.client.getPaymentMethod(first.id)).toMatchObject({
      status: 'active',
      saved: true,
      card: { last4: '4444', card_type: 'Mir' },
    })
    expect(await shop.client.getPaymentMethod(other.id)).toMatchObject({
      status: 'inactive',
      saved: false,
    })
    await expect(shop.client.getPaymentMethod('nobody')).rejects.toMatchObject({ status: 404 })
  })
})
