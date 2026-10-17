import { randomUUID } from 'node:crypto'

import type * as BillingModule from '@repo/billing'
import {
  cancelAutoRenew,
  cancelPlanChange,
  paymentLetterKey,
  renewalJobAuditActions,
  renewalKey,
  resumeAutoRenew,
  schedulePlanChange,
  startPastDuePayment,
  subscriptionChangeAuditActions,
  type SubscriptionOverviewDto,
} from '@repo/billing'
import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import {
  billingAlreadyOnPlan,
  billingNoLiveSubscription,
  billingNothingToChange,
  billingPaymentInProgress,
  billingPlanNotFound,
  billingPlanSiteLimit,
  billingSubscriptionPastDue,
  legalDocuments,
  Money,
} from '@repo/domain'
import {
  YookassaApiError,
  type Payment,
  type SavedPaymentMethod,
  type YookassaClient,
} from '@repo/yookassa'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { appRouter, createCaller } from '../router.ts'
import type { BillingContext, Context } from '../trpc.ts'

// What the customer changes about a tariff they have, through the router: auto-renewal off and
// on, the tariff of the next period, the payment of an overdue tariff — and what the pages read
// for it. The functions of @repo/billing are wrapped: they run as they are — the PostgreSQL
// block works through them — unless a test scripts the next answer.
vi.mock('@repo/billing', async (importOriginal) => {
  const original = await importOriginal<typeof BillingModule>()
  return {
    ...original,
    cancelAutoRenew: vi.fn(original.cancelAutoRenew),
    resumeAutoRenew: vi.fn(original.resumeAutoRenew),
    schedulePlanChange: vi.fn(original.schedulePlanChange),
    cancelPlanChange: vi.fn(original.cancelPlanChange),
    startPastDuePayment: vi.fn(original.startPastDuePayment),
  }
})
const cancelRenew = vi.mocked(cancelAutoRenew)
const resumeRenew = vi.mocked(resumeAutoRenew)
const schedule = vi.mocked(schedulePlanChange)
const cancelChange = vi.mocked(cancelPlanChange)
const payOverdue = vi.mocked(startPastDuePayment)
const wrapped = [cancelRenew, resumeRenew, schedule, cancelChange, payOverdue]

const NOW = new Date('2026-10-04T12:00:00.000Z')
const PAID_AT = '2026-10-04T09:00:00.000Z'
const PERIOD_END = new Date('2026-10-18T09:00:00.000Z')
const APP_URL = 'https://raditi.example'
const WORKSPACE = '0199a000-0000-7000-8000-0000000000e1'
const NBSP = String.fromCharCode(0xa0)
const DAY_MS = 24 * 60 * 60_000

const user: User = {
  id: randomUUID(),
  name: 'Анна Ковалёва',
  lastName: null,
  email: 'manage-test@example.ru',
  emailVerified: true,
  image: null,
  createdAt: NOW,
  updatedAt: NOW,
}
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

beforeEach(() => vi.stubEnv('APP_ENV', 'test'))
afterEach(() => {
  vi.unstubAllEnvs()
  // Back to the functions of the package, whatever a test scripted and did not use up.
  for (const call of wrapped) call.mockReset()
})

/**
 * ЮKassa in memory: a payment and a binding wait on their pages until the test finishes them,
 * a repeated Idempotence-Key answers with the object of the first request.
 */
function shopStub(pastDueDays = 7) {
  const paymentsById = new Map<string, Payment>()
  const methods = new Map<string, SavedPaymentMethod>()
  const idByKey = new Map<string, string>()
  const unused = () => Promise.reject(new Error('These procedures do not make this call'))
  const yookassa: YookassaClient = {
    createPayment(input, idempotenceKey) {
      let id = idByKey.get(idempotenceKey)
      if (id === undefined) {
        id = randomUUID()
        idByKey.set(idempotenceKey, id)
        paymentsById.set(id, {
          id,
          status: 'pending',
          paid: false,
          amount: { value: input.amount.value, currency: 'RUB' },
          created_at: NOW.toISOString(),
          confirmation: { type: 'redirect', confirmation_url: `https://yookassa.example/${id}` },
          ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        })
      }
      return Promise.resolve(structuredClone(paymentsById.get(id)!))
    },
    getPayment(paymentId) {
      const payment = paymentsById.get(paymentId)
      return payment === undefined
        ? Promise.reject(new YookassaApiError('not_found', 404, 'not_found', {}))
        : Promise.resolve(structuredClone(payment))
    },
    createPaymentMethod(input, idempotenceKey) {
      let id = idByKey.get(idempotenceKey)
      if (id === undefined) {
        id = randomUUID()
        idByKey.set(idempotenceKey, id)
        methods.set(id, {
          id,
          type: input.type,
          saved: false,
          status: 'pending',
          confirmation: {
            type: 'redirect',
            confirmation_url: `https://yookassa.example/bind/${id}`,
            return_url: input.confirmation.return_url,
          },
          ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        })
      }
      return Promise.resolve(structuredClone(methods.get(id)!))
    },
    getPaymentMethod(methodId) {
      const method = methods.get(methodId)
      return method === undefined
        ? Promise.reject(new YookassaApiError('not_found', 404, 'not_found', {}))
        : Promise.resolve(structuredClone(method))
    },
    chargeWithSavedMethod: unused,
    createRefund: unused,
    getRefund: unused,
  }
  /** The payment or the binding that still waits on its page: the test finishes one at a time. */
  function waiting<T extends { id: string; status: string }>(objects: Map<string, T>): T {
    const [object, ...others] = [...objects.values()].filter(({ status }) => status === 'pending')
    if (object === undefined || others.length > 0) {
      throw new Error(`${others.length + (object ? 1 : 0)} objects wait on their pages, not one`)
    }
    return object
  }
  return {
    billing: {
      yookassa,
      appUrl: APP_URL,
      appEnv: 'test',
      autopayments: true,
      pastDueDays,
    } satisfies BillingContext,
    payments: paymentsById,
    methods,
    /** The customer paid; `saved`: ЮKassa saved the «Мир» card they paid with. */
    pay({ saved = false, capturedAt = PAID_AT } = {}) {
      const payment = waiting(paymentsById)
      payment.status = 'succeeded'
      payment.paid = true
      payment.captured_at = capturedAt
      delete payment.confirmation
      payment.payment_method = {
        id: payment.id,
        type: 'bank_card',
        saved,
        title: 'Bank card *4444',
        card: { first6: '220000', last4: '4444', card_type: 'Mir' },
      }
      return payment.id
    },
    /** The customer confirmed the binding with a Visa card. */
    bind() {
      const method = waiting(methods)
      method.status = 'active'
      method.saved = true
      method.title = 'Bank card *1234'
      method.card = { first6: '411111', last4: '1234', card_type: 'Visa' }
      delete method.confirmation
      return method.id
    },
  }
}

interface ContextOptions {
  currentUser?: User | null
  /** null: payments are switched off. */
  billing?: BillingContext | null
}

function context(
  prisma: PrismaClient,
  { currentUser = user, billing = shopStub().billing }: ContextOptions = {},
): Context {
  return {
    prisma,
    headers: new Headers(),
    user: currentUser,
    session: currentUser
      ? {
          id: randomUUID(),
          userId: currentUser.id,
          token: 'manage-test-session',
          expiresAt: new Date('2030-01-01'),
          createdAt: NOW,
          updatedAt: NOW,
        }
      : null,
    billing,
  }
}

const planRow = (data: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  slug: 'business',
  name: 'Бизнес',
  kind: 'quota',
  price: new Money('12900'),
  creditsPerMonth: 80,
  creditsPerDay: 20,
  maxSites: 3,
  packCredits: null,
  ...data,
})
const agencyRow = () =>
  planRow({
    slug: 'agency',
    name: 'Агентство',
    price: new Money('39900'),
    creditsPerMonth: 250,
    creditsPerDay: 30,
    maxSites: 15,
  })

const subscriptionRow = (data: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  status: 'active',
  currentPeriodStart: new Date('2026-09-18T09:00:00Z'),
  currentPeriodEnd: PERIOD_END,
  cancelAtPeriodEnd: false,
  pastDueSince: null,
  paymentMethodId: 'pm-1',
  paymentMethodType: 'bank_card',
  paymentMethodCardType: 'Mir',
  paymentMethodLast4: '4444',
  pendingPaymentMethodId: null,
  plan: planRow(),
  nextPlan: null,
  ...data,
})

/** The tables the procedures read before they call @repo/billing, answering from the test. */
function fakeDb() {
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    workspace: {
      findFirst: vi.fn<() => Promise<{ id: string } | null>>().mockResolvedValue({ id: WORKSPACE }),
      // Since when the work of a workspace that never had a tariff is counted.
      findUniqueOrThrow: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({ createdAt: new Date('2026-09-01T00:00:00Z') }),
    },
    subscription: { findFirst: vi.fn<(query: unknown) => Promise<unknown>>() },
    order: { findUnique: vi.fn<() => Promise<unknown>>().mockResolvedValue(null) },
    billingAccount: { findMany: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]) },
    auditLog: { findFirst: vi.fn<(query: unknown) => Promise<unknown>>().mockResolvedValue(null) },
    // What the answer about a new task reads beside the accounts (`credits.newTask`): no credit
    // rate is in force here, which is said before anything else is asked — but for the terms of
    // the tariff and what the workspace did today.
    creditRate: { findFirst: vi.fn<() => Promise<unknown>>().mockResolvedValue(null) },
    plan: {
      findUniqueOrThrow: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({ creditsPerMonth: 80, creditsPerDay: 20 }),
    },
    creditLedger: {
      aggregate: vi.fn<() => Promise<unknown>>().mockResolvedValue({ _sum: { amount: null } }),
    },
    // The tariff credits of the day: nothing taken; no work without a charge.
    $queryRaw: vi.fn((query: TemplateStringsArray) =>
      Promise.resolve(
        query.join('').includes(' AS transfer') ? [{ held: '0', placed: '0', transfer: '0' }] : [],
      ),
    ),
  }
  db.subscription.findFirst.mockResolvedValue(null)
  return { db, prisma: db as unknown as PrismaClient }
}

const overviewDto = (patch: Partial<SubscriptionOverviewDto> = {}): SubscriptionOverviewDto => ({
  id: randomUUID(),
  status: 'active',
  plan: {
    id: randomUUID(),
    slug: 'business',
    name: 'Бизнес',
    price: '12900.00',
    creditsPerMonth: 80,
    creditsPerDay: 20,
    maxSites: 3,
  },
  period: { start: new Date('2026-09-18T09:00:00Z'), end: PERIOD_END },
  autoRenewal: true,
  nextPlan: null,
  paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` },
  pastDueSince: null,
  ...patch,
})

const consented = [
  'resumeAutoRenew',
  'schedulePlanChange',
  'cancelPlanChange',
  'startPastDuePayment',
] as const
const open = ['cancelAutoRenew', 'autoRenewal'] as const
const inputOf = (name: string) => (name === 'schedulePlanChange' ? { planSlug: 'agency' } : {})

const untouched = () => {
  for (const call of wrapped) expect(call).not.toHaveBeenCalled()
}

describe('access to the procedures that change a tariff', () => {
  it.each([...consented, ...open])('requires a session before %s reads anything', async (name) => {
    const { prisma, db } = fakeDb()
    const call = createCaller(context(prisma, { currentUser: null })).billing[name] as (
      input?: unknown,
    ) => Promise<unknown>

    await expect(call(inputOf(name))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    expect(db.userConsent.findMany).not.toHaveBeenCalled()
    expect(db.workspace.findFirst).not.toHaveBeenCalled()
    untouched()
  })

  it.each(consented)('requires the current mandatory consents for %s', async (name) => {
    const { prisma, db } = fakeDb()
    db.userConsent.findMany.mockResolvedValue([])
    const call = createCaller(context(prisma)).billing[name] as (
      input?: unknown,
    ) => Promise<unknown>

    await expect(call(inputOf(name))).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' })

    expect(db.workspace.findFirst).not.toHaveBeenCalled()
    untouched()
  })

  it('lets a user who has not accepted the documents see the coming charge and switch it off', async () => {
    const { prisma, db } = fakeDb()
    db.userConsent.findMany.mockResolvedValue([])
    db.subscription.findFirst.mockResolvedValue(subscriptionRow())
    cancelRenew.mockResolvedValueOnce({ renewalCharge: 'none', periodEnd: PERIOD_END })
    const caller = createCaller(context(prisma)).billing

    await expect(caller.autoRenewal()).resolves.toMatchObject({
      renewal: { planName: 'Бизнес', amount: '12900.00', chargeAt: PERIOD_END },
    })
    await expect(caller.cancelAutoRenew({})).resolves.toEqual({
      renewalCharge: 'none',
      periodEnd: PERIOD_END,
    })

    // The consents are not even asked for: stopping the charges does not depend on them.
    expect(db.userConsent.findMany).not.toHaveBeenCalled()
    expect(cancelRenew).toHaveBeenCalledTimes(1)
    // What needs the consent still does.
    await expect(caller.resumeAutoRenew({})).rejects.toMatchObject({
      code: 'PRECONDITION_REQUIRED',
    })
    expect(resumeRenew).not.toHaveBeenCalled()
  })
})

describe('billing.cancelAutoRenew', () => {
  it('switches auto-renewal of the user off and needs no shop for it', async () => {
    const { prisma } = fakeDb()
    cancelRenew.mockResolvedValue({ renewalCharge: 'none', periodEnd: PERIOD_END })

    expect(
      await createCaller(context(prisma, { billing: null })).billing.cancelAutoRenew({}),
    ).toEqual({ renewalCharge: 'none', periodEnd: PERIOD_END })

    // Nothing but the database and the environment that tells the personal workspace.
    expect(cancelRenew).toHaveBeenCalledExactlyOnceWith(
      { prisma, appEnv: 'test' },
      { userId: user.id },
    )
  })

  it('finds the workspace by the environment of the shop when payments are on', async () => {
    const { prisma } = fakeDb()
    cancelRenew.mockResolvedValue({ renewalCharge: 'none', periodEnd: PERIOD_END })
    const billing: BillingContext = { ...shopStub().billing, appEnv: 'development' }
    // What the process says is not asked while the shop says it.
    vi.stubEnv('APP_ENV', 'staging')

    await createCaller(context(prisma, { billing })).billing.cancelAutoRenew({})

    expect(cancelRenew).toHaveBeenCalledExactlyOnceWith(
      { prisma, appEnv: 'development' },
      { userId: user.id },
    )
  })

  it.each(['at_bank', 'unanswered'] as const)(
    'tells of a renewal charge that had been started and is %s',
    async (renewalCharge) => {
      const { prisma } = fakeDb()
      cancelRenew.mockResolvedValueOnce({ renewalCharge, periodEnd: PERIOD_END })

      expect(await createCaller(context(prisma)).billing.cancelAutoRenew({})).toEqual({
        renewalCharge,
        periodEnd: PERIOD_END,
      })
    },
  )

  it('does not answer with what its schema does not describe', async () => {
    const { prisma } = fakeDb()
    cancelRenew.mockResolvedValueOnce({
      renewalCharge: 'pending' as 'at_bank',
      periodEnd: PERIOD_END,
    })

    await expect(createCaller(context(prisma)).billing.cancelAutoRenew({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    })
  })

  it.each([undefined, { userId: randomUUID() }, { subscriptionId: randomUUID() }])(
    'takes no input but the empty object: %o',
    async (input) => {
      const { prisma } = fakeDb()
      await expect(
        createCaller(context(prisma)).billing.cancelAutoRenew(input as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(cancelRenew).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      'auto-renewal that is off already',
      billingNothingToChange,
      'Это уже сделано. Обновите страницу, чтобы увидеть изменения',
    ],
    [
      'no live tariff',
      billingNoLiveSubscription,
      'У вас нет действующего тарифа. Обновите страницу, чтобы увидеть, что изменилось',
    ],
  ])('tells the customer of %s in Russian', async (_case, refusal, text) => {
    const { prisma } = fakeDb()
    const domainError = refusal()
    cancelRenew.mockRejectedValueOnce(domainError)

    await expect(createCaller(context(prisma)).billing.cancelAutoRenew({})).rejects.toMatchObject({
      code: 'CONFLICT',
      message: text,
      cause: domainError,
    })
  })
})

describe('billing.autoRenewal', () => {
  it('tells of the coming charge of a tariff that renews: its name, the amount and the day', async () => {
    const { prisma, db } = fakeDb()
    db.subscription.findFirst.mockResolvedValue(subscriptionRow())

    expect(await createCaller(context(prisma)).billing.autoRenewal()).toEqual({
      renewal: {
        planName: 'Бизнес',
        nextPlanName: null,
        amount: '12900.00',
        chargeAt: PERIOD_END,
        renewalCharge: 'none',
        oneTimeOnly: false,
      },
    })
  })

  it('names the scheduled tariff and its price when a change is scheduled', async () => {
    const { prisma, db } = fakeDb()
    db.subscription.findFirst.mockResolvedValue(subscriptionRow({ nextPlan: agencyRow() }))

    expect(await createCaller(context(prisma)).billing.autoRenewal()).toMatchObject({
      renewal: { planName: 'Бизнес', nextPlanName: 'Агентство', amount: '39900.00' },
    })
  })

  it.each([
    ['a shop that saves payment methods', { autopayments: true }, false],
    ['a shop that takes one-time payments only', { autopayments: false }, true],
    // Payments are off: nothing is said of what a shop does not do.
    ['no shop', null, false],
  ] as const)(
    'tells the page whether auto-renewal switched off there stays off: %s',
    async (_case, shop, oneTimeOnly) => {
      const { prisma, db } = fakeDb()
      // The card was saved before the switch was turned off: the tariff still renews.
      db.subscription.findFirst.mockResolvedValue(subscriptionRow())
      const billing = shop && { ...shopStub().billing, ...shop }

      expect(await createCaller(context(prisma, { billing })).billing.autoRenewal()).toMatchObject({
        renewal: { planName: 'Бизнес', oneTimeOnly },
      })
    },
  )

  it('tells of a charge that is already under way', async () => {
    const { prisma, db } = fakeDb()
    db.subscription.findFirst.mockResolvedValue(subscriptionRow())
    db.order.findUnique.mockResolvedValue({ status: 'pending', yookassaPaymentId: 'pay-1' })

    const answer = await createCaller(context(prisma)).billing.autoRenewal()

    expect(answer.renewal).toMatchObject({ renewalCharge: 'at_bank' })
    expect(JSON.stringify(answer)).not.toContain('pay-1')
  })

  it.each([
    ['a user without a workspace', null, null],
    ['a workspace without a tariff', { id: WORKSPACE }, null],
    [
      'a tariff whose auto-renewal is off',
      { id: WORKSPACE },
      subscriptionRow({ cancelAtPeriodEnd: true }),
    ],
    [
      'a tariff without a saved payment method',
      { id: WORKSPACE },
      subscriptionRow({ paymentMethodId: null }),
    ],
    [
      // It is charged by nobody: it waits for a payment the customer makes by hand.
      'a tariff that is overdue',
      { id: WORKSPACE },
      subscriptionRow({ status: 'past_due', pastDueSince: NOW }),
    ],
  ])('tells nothing to %s', async (_case, workspace, subscription) => {
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(workspace)
    db.subscription.findFirst.mockResolvedValue(subscription)

    expect(await createCaller(context(prisma)).billing.autoRenewal()).toEqual({ renewal: null })
    // Nothing more is read for somebody who is not charged.
    expect(db.order.findUnique).not.toHaveBeenCalled()
  })

  it('shows nothing of the payment method, the ids or the credits', async () => {
    const { prisma, db } = fakeDb()
    const row = subscriptionRow({ nextPlan: agencyRow() })
    db.subscription.findFirst.mockResolvedValue(row)

    const answer = await createCaller(context(prisma, { billing: null })).billing.autoRenewal()

    expect(Object.keys(answer.renewal ?? {}).sort()).toEqual([
      'amount',
      'chargeAt',
      'nextPlanName',
      'oneTimeOnly',
      'planName',
      'renewalCharge',
    ])
    expect(JSON.stringify(answer)).not.toMatch(/4444|pm-1|Мир/)
    expect(JSON.stringify(answer)).not.toContain(row.id)
    expect(db.billingAccount.findMany).not.toHaveBeenCalled()
  })
})

describe('billing.resumeAutoRenew', () => {
  it('switches auto-renewal on through the shop of the context', async () => {
    const { prisma } = fakeDb()
    const { billing } = shopStub()
    resumeRenew.mockResolvedValueOnce({ needsPaymentMethod: false, renewalCharge: 'none' })

    expect(await createCaller(context(prisma, { billing })).billing.resumeAutoRenew({})).toEqual({
      needsPaymentMethod: false,
      renewalCharge: 'none',
    })

    expect(resumeRenew).toHaveBeenCalledExactlyOnceWith(
      { prisma, yookassa: billing.yookassa, appUrl: APP_URL, appEnv: 'test', autopayments: true },
      { userId: user.id },
    )
    // The very client of the process, not a copy.
    expect(resumeRenew.mock.calls[0]?.[0].yookassa).toBe(billing.yookassa)
  })

  it('sends a customer without a saved method to the page that binds a card', async () => {
    const { prisma } = fakeDb()
    resumeRenew.mockResolvedValueOnce({
      needsPaymentMethod: true,
      confirmationUrl: 'https://yookassa.example/bind/1',
    })

    expect(await createCaller(context(prisma)).billing.resumeAutoRenew({})).toEqual({
      needsPaymentMethod: true,
      confirmationUrl: 'https://yookassa.example/bind/1',
    })
  })

  it.each(['javascript:alert(1)', '/settings/billing', ''])(
    'does not send the customer to an address that is not a web page: %s',
    async (confirmationUrl) => {
      const { prisma } = fakeDb()
      resumeRenew.mockResolvedValueOnce({ needsPaymentMethod: true, confirmationUrl })

      await expect(createCaller(context(prisma)).billing.resumeAutoRenew({})).rejects.toMatchObject(
        { code: 'INTERNAL_SERVER_ERROR' },
      )
    },
  )

  it('is refused at a shop that takes one-time payments only, before anything is read', async () => {
    // `resumeAutoRenew` of @repo/billing itself, given the switch of the shop.
    const { prisma, db } = fakeDb()
    const billing = { ...shopStub().billing, autopayments: false }

    await expect(
      createCaller(context(prisma, { billing })).billing.resumeAutoRenew({}),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Автопродление пока недоступно. Оформите тариф без него: он будет действовать месяц',
      cause: { code: 'BILLING_AUTO_RENEWAL_UNAVAILABLE' },
    })

    expect(resumeRenew).toHaveBeenCalledExactlyOnceWith(
      { prisma, yookassa: billing.yookassa, appUrl: APP_URL, appEnv: 'test', autopayments: false },
      { userId: user.id },
    )
    expect(db.workspace.findFirst).not.toHaveBeenCalled()
  })

  it('is refused while payments are off, before anything is asked', async () => {
    const { prisma } = fakeDb()

    await expect(
      createCaller(context(prisma, { billing: null })).billing.resumeAutoRenew({}),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
      cause: { code: 'BILLING_PAYMENTS_NOT_CONFIGURED' },
    })
    expect(resumeRenew).not.toHaveBeenCalled()
  })

  it.each([undefined, { userId: randomUUID() }, { autoRenew: true }])(
    'takes no input but the empty object: %o',
    async (input) => {
      const { prisma } = fakeDb()
      await expect(
        createCaller(context(prisma)).billing.resumeAutoRenew(input as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(resumeRenew).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      'auto-renewal that is on already',
      billingNothingToChange,
      'Это уже сделано. Обновите страницу, чтобы увидеть изменения',
    ],
    [
      'a tariff that waits for its payment',
      billingSubscriptionPastDue,
      'Сначала оплатите тариф: последнее списание не прошло. Откройте «Тарифы» и нажмите «Оплатить сейчас»',
    ],
    [
      'no live tariff',
      billingNoLiveSubscription,
      'У вас нет действующего тарифа. Обновите страницу, чтобы увидеть, что изменилось',
    ],
  ])('tells the customer of %s in Russian', async (_case, refusal, text) => {
    const { prisma } = fakeDb()
    const domainError = refusal()
    resumeRenew.mockRejectedValueOnce(domainError)

    await expect(createCaller(context(prisma)).billing.resumeAutoRenew({})).rejects.toMatchObject({
      code: 'CONFLICT',
      message: text,
      cause: domainError,
    })
  })
})

describe('billing.schedulePlanChange and billing.cancelPlanChange', () => {
  it('schedules the tariff the customer named, without a shop', async () => {
    const { prisma } = fakeDb()
    const subscription = overviewDto({ nextPlan: { ...overviewDto().plan, slug: 'agency' } })
    schedule.mockResolvedValueOnce(subscription)

    expect(
      await createCaller(context(prisma, { billing: null })).billing.schedulePlanChange({
        planSlug: 'agency',
      }),
    ).toEqual(subscription)

    expect(schedule).toHaveBeenCalledExactlyOnceWith(
      { prisma, appEnv: 'test' },
      { userId: user.id, planSlug: 'agency' },
    )
  })

  it('takes the scheduled change back, without a shop', async () => {
    const { prisma } = fakeDb()
    const subscription = overviewDto()
    cancelChange.mockResolvedValueOnce(subscription)

    expect(
      await createCaller(context(prisma, { billing: null })).billing.cancelPlanChange({}),
    ).toEqual(subscription)

    expect(cancelChange).toHaveBeenCalledExactlyOnceWith(
      { prisma, appEnv: 'test' },
      { userId: user.id },
    )
  })

  it.each([
    undefined,
    {},
    { planSlug: '' },
    { planSlug: 'p'.repeat(51) },
    { planSlug: 'agency', userId: randomUUID() },
    { planSlug: 'agency', autoRenew: true },
    { planId: randomUUID() },
  ])('schedules nothing for an input that names no tariff or more than it: %o', async (input) => {
    const { prisma } = fakeDb()
    await expect(
      createCaller(context(prisma)).billing.schedulePlanChange(input as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(schedule).not.toHaveBeenCalled()
  })

  it.each([undefined, { planSlug: 'agency' }, { userId: randomUUID() }])(
    'takes no input but the empty object to take a change back: %o',
    async (input) => {
      const { prisma } = fakeDb()
      await expect(
        createCaller(context(prisma)).billing.cancelPlanChange(input as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(cancelChange).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      'a tariff that is not on sale',
      billingPlanNotFound,
      'NOT_FOUND',
      'Этот тариф сейчас не продаётся. Обновите страницу и выберите другой',
    ],
    [
      'the tariff they have or have already chosen',
      billingAlreadyOnPlan,
      'CONFLICT',
      'Этот тариф у вас уже есть или уже выбран на следующий период. Обновите страницу, чтобы увидеть изменения',
    ],
    [
      'more sites than the tariff takes',
      billingPlanSiteLimit,
      'CONFLICT',
      'У вас больше сайтов, чем входит в этот тариф. Выберите тариф, в который они помещаются',
    ],
    [
      'a renewal charge that is under way',
      billingPaymentInProgress,
      'CONFLICT',
      'Предыдущий платёж ещё обрабатывается. Подождите пару минут и обновите страницу',
    ],
    [
      'no live tariff',
      billingNoLiveSubscription,
      'CONFLICT',
      'У вас нет действующего тарифа. Обновите страницу, чтобы увидеть, что изменилось',
    ],
  ])('tells the customer of %s in Russian', async (_case, refusal, code, text) => {
    const { prisma } = fakeDb()
    const domainError = refusal()
    schedule.mockRejectedValueOnce(domainError)

    await expect(
      createCaller(context(prisma)).billing.schedulePlanChange({ planSlug: 'agency' }),
    ).rejects.toMatchObject({ code, message: text, cause: domainError })
  })

  it('answers a refused change over HTTP with 409, the domain code and the Russian text', async () => {
    const { prisma } = fakeDb()
    cancelChange.mockRejectedValueOnce(billingNothingToChange())

    const response = await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request('http://localhost:3000/api/trpc/billing.cancelPlanChange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: {} }),
      }),
      router: appRouter,
      createContext: () => context(prisma),
    })

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { json: { message: string; data: object } } }
    expect(body.error.json.message).toBe(
      'Это уже сделано. Обновите страницу, чтобы увидеть изменения',
    )
    expect(body.error.json.data).toEqual({
      code: 'CONFLICT',
      httpStatus: 409,
      path: 'billing.cancelPlanChange',
      domainCode: 'BILLING_NOTHING_TO_CHANGE',
    })
  })
})

describe('billing.startPastDuePayment', () => {
  const started = { orderId: randomUUID(), confirmationUrl: 'https://yookassa.example/pay/1' }

  it('starts the payment of the overdue tariff through the shop of the context', async () => {
    const { prisma } = fakeDb()
    const { billing } = shopStub()
    payOverdue.mockResolvedValueOnce(started)

    expect(
      await createCaller(context(prisma, { billing })).billing.startPastDuePayment({}),
    ).toEqual(started)

    expect(payOverdue).toHaveBeenCalledExactlyOnceWith(
      { prisma, yookassa: billing.yookassa, appUrl: APP_URL, appEnv: 'test', autopayments: true },
      { userId: user.id },
    )
  })

  it.each([undefined, { planSlug: 'start' }, { autoRenew: true }, { orderId: randomUUID() }])(
    'takes no input but the empty object: %o',
    async (input) => {
      const { prisma } = fakeDb()
      await expect(
        createCaller(context(prisma)).billing.startPastDuePayment(input as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(payOverdue).not.toHaveBeenCalled()
    },
  )

  it('is refused while payments are off, before anything is asked', async () => {
    const { prisma } = fakeDb()

    await expect(
      createCaller(context(prisma, { billing: null })).billing.startPastDuePayment({}),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'BILLING_PAYMENTS_NOT_CONFIGURED' },
    })
    expect(payOverdue).not.toHaveBeenCalled()
  })

  it('does not send the customer to an address that is not a web page', async () => {
    const { prisma } = fakeDb()
    payOverdue.mockResolvedValueOnce({ ...started, confirmationUrl: 'javascript:alert(1)' })

    await expect(
      createCaller(context(prisma)).billing.startPastDuePayment({}),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  })

  it.each([
    [
      'a tariff that is paid for',
      billingNothingToChange,
      'Это уже сделано. Обновите страницу, чтобы увидеть изменения',
    ],
    [
      'a payment that is still being processed',
      billingPaymentInProgress,
      'Предыдущий платёж ещё обрабатывается. Подождите пару минут и обновите страницу',
    ],
  ])('tells the customer of %s in Russian', async (_case, refusal, text) => {
    const { prisma } = fakeDb()
    const domainError = refusal()
    payOverdue.mockRejectedValueOnce(domainError)

    await expect(
      createCaller(context(prisma)).billing.startPastDuePayment({}),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: text, cause: domainError })
  })
})

describe('what billing.overview tells of an overdue and of an ended tariff', () => {
  const SINCE = new Date('2026-10-18T09:05:00.000Z')
  const overdue = (data: Record<string, unknown> = {}) =>
    subscriptionRow({ status: 'past_due', pastDueSince: SINCE, ...data })

  it('names the moment the grace of an overdue tariff runs out, by the setting of the context', async () => {
    const { prisma, db } = fakeDb()
    db.subscription.findFirst.mockResolvedValue(overdue())

    const week = await createCaller(context(prisma)).billing.overview()
    const fortnight = await createCaller(
      context(prisma, { billing: shopStub(14).billing }),
    ).billing.overview()

    expect(week).toMatchObject({
      subscription: { status: 'past_due', pastDueSince: SINCE },
      pastDueEndsAt: new Date(SINCE.getTime() + 7 * DAY_MS),
      ended: null,
    })
    expect(fortnight.pastDueEndsAt).toEqual(new Date(SINCE.getTime() + 14 * DAY_MS))
  })

  it('counts the grace from the end of the paid period when the row keeps no moment', async () => {
    const { prisma, db } = fakeDb()
    db.subscription.findFirst.mockResolvedValue(overdue({ pastDueSince: null }))

    expect((await createCaller(context(prisma)).billing.overview()).pastDueEndsAt).toEqual(
      new Date(PERIOD_END.getTime() + 7 * DAY_MS),
    )
  })

  it('names no such moment while payments are off: nobody is ended then', async () => {
    const { prisma, db } = fakeDb()
    db.subscription.findFirst.mockResolvedValue(overdue())

    expect(await createCaller(context(prisma, { billing: null })).billing.overview()).toMatchObject(
      { paymentsEnabled: false, pastDueEndsAt: null },
    )
  })

  it('names none for a tariff that is paid for', async () => {
    const { prisma, db } = fakeDb()
    db.subscription.findFirst.mockResolvedValue(subscriptionRow())

    expect(await createCaller(context(prisma)).billing.overview()).toMatchObject({
      pastDueEndsAt: null,
      ended: null,
    })
    // A customer with a live tariff is not asked about the one before it.
    expect(db.auditLog.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    ['expired', 'not_paid', null],
    ['cancelled', 'not_renewed', null],
    ['cancelled', 'refunded', { id: randomUUID() }],
  ] as const)(
    'tells of the last tariff once none is live: %s, %s',
    async (status, reason, refundEntry) => {
      const { prisma, db } = fakeDb()
      const ended = {
        id: randomUUID(),
        status,
        currentPeriodEnd: PERIOD_END,
        plan: { name: 'Бизнес' },
      }
      // The live tariff is looked for with its statuses; the last one without them.
      db.subscription.findFirst.mockImplementation((query) =>
        Promise.resolve(
          (query as { where: { status?: unknown } }).where.status === undefined ? ended : null,
        ),
      )
      db.auditLog.findFirst.mockResolvedValue(refundEntry)

      const overview = await createCaller(context(prisma)).billing.overview()

      expect(overview).toMatchObject({
        subscription: null,
        pastDueEndsAt: null,
        ended: { planName: 'Бизнес', endedAt: PERIOD_END, reason },
      })
      expect(JSON.stringify(overview)).not.toContain(ended.id)
      if (status === 'cancelled') {
        expect(db.auditLog.findFirst).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            where: expect.objectContaining({
              action: renewalJobAuditActions.subscriptionEnd,
              targetId: ended.id,
              meta: { path: ['reason'], equals: 'refund' },
            }),
          }),
        )
      }
    },
  )
})

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL management of a tariff through the router', () => {
  let db: PrismaClient
  const userIds: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    // What refers goes first: the ledger to its accounts and orders, everything to its workspace.
    const ids = userIds.splice(0)
    const workspaces = await db.workspace.findMany({
      where: { createdById: { in: ids } },
      select: { id: true },
    })
    const owned = { workspaceId: { in: workspaces.map(({ id }) => id) } }
    const orders = await db.order.findMany({ where: owned, select: { id: true } })
    await db.outboxEvent.deleteMany({
      where: { dedupeKey: { in: orders.map(({ id }) => paymentLetterKey(id)) } },
    })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.site.deleteMany({ where: owned })
    await db.order.deleteMany({ where: owned })
    await db.subscription.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.user.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /**
   * A user with a shop of their own and no workspace yet. `consents`: whether they accepted
   * the current documents.
   */
  async function account({ consents = true } = {}) {
    const owner = await db.user.create({
      data: { name: 'Manage verification', email: `${randomUUID()}@manage-router.example.ru` },
    })
    userIds.push(owner.id)
    const accept = () =>
      db.userConsent.createMany({
        data: requiredConsents.map((consent) => ({
          ...consent,
          userId: owner.id,
          source: 'sign_up',
        })),
      })
    if (consents) await accept()
    const shop = shopStub()
    const caller = createCaller(context(db, { currentUser: owner, billing: shop.billing }))
    return { user: owner, caller, shop, accept }
  }
  type Account = Awaited<ReturnType<typeof account>>

  /** A tariff of the seeds (`pnpm db:seed`): the tests put no tariff of their own on sale. */
  async function seeded(slug: 'start' | 'business' | 'agency') {
    const row = await db.plan.findFirst({ where: { slug, kind: 'quota', isActive: true } })
    if (row === null) {
      throw new Error(`The tariff «${slug}» is not on sale in this database: apply the seeds`)
    }
    return row
  }

  /** Pays for «Старт» the way the customer does; `autoRenew`: with the consent and a saved card. */
  async function subscribe({ caller, shop }: Account, { autoRenew }: { autoRenew: boolean }) {
    await seeded('start')
    const { orderId } = await caller.billing.startCheckout({ planSlug: 'start', autoRenew })
    shop.pay({ saved: autoRenew })
    const { subscription } = await caller.billing.syncOrder({ orderId })
    if (subscription === null) throw new Error('The payment did not start the tariff')
    return { orderId, subscription }
  }

  const subscriptionOf = async ({ user: owner }: Account) => {
    const row = await db.subscription.findFirst({
      where: { workspace: { createdById: owner.id } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    if (row === null) throw new Error('The user has no subscription')
    return row
  }

  const actionsOf = async (paying: Account) => {
    const { workspaceId } = await subscriptionOf(paying)
    const entries = await db.auditLog.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { action: true },
    })
    return entries.map(({ action }) => action)
  }

  const { autoRenewalCancel, autoRenewalResume, planChangeSchedule, planChangeCancel } =
    subscriptionChangeAuditActions

  it('switches auto-renewal off and on again with the saved card', async () => {
    const paying = await account()
    const { caller, shop } = paying
    const { subscription } = await subscribe(paying, { autoRenew: true })

    expect(await caller.billing.cancelAutoRenew({})).toEqual({
      renewalCharge: 'none',
      periodEnd: subscription.period.end,
    })
    expect((await caller.billing.overview()).subscription).toMatchObject({
      status: 'active',
      autoRenewal: false,
      // The card stays: with it auto-renewal comes back without a page of the shop.
      paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` },
    })
    expect(await caller.billing.autoRenewal()).toEqual({ renewal: null })
    await expect(caller.billing.cancelAutoRenew({})).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'BILLING_NOTHING_TO_CHANGE' },
    })

    expect(await caller.billing.resumeAutoRenew({})).toEqual({
      needsPaymentMethod: false,
      renewalCharge: 'none',
    })
    expect((await caller.billing.overview()).subscription?.autoRenewal).toBe(true)
    expect(await caller.billing.autoRenewal()).toEqual({
      renewal: {
        planName: 'Старт',
        nextPlanName: null,
        amount: subscription.plan.price,
        chargeAt: subscription.period.end,
        renewalCharge: 'none',
        oneTimeOnly: false,
      },
    })
    expect(shop.methods.size).toBe(0)
    expect((await actionsOf(paying)).slice(-2)).toEqual([autoRenewalCancel, autoRenewalResume])
  })

  it('switches auto-renewal on only after the card a customer without one binds for it is saved', async () => {
    const paying = await account()
    const { caller, shop } = paying
    await subscribe(paying, { autoRenew: false })

    const answer = await caller.billing.resumeAutoRenew({})

    const [methodId] = [...shop.methods.keys()]
    expect(answer).toEqual({
      needsPaymentMethod: true,
      confirmationUrl: `https://yookassa.example/bind/${methodId}`,
    })
    expect(await caller.billing.overview()).toMatchObject({
      bindingPending: true,
      subscription: { autoRenewal: false, paymentMethod: null },
    })
    // The page asks before the customer confirmed the card: nothing is switched on.
    expect((await caller.billing.syncPaymentMethod({})).state).toBe('pending')
    expect((await subscriptionOf(paying)).cancelAtPeriodEnd).toBe(true)

    shop.bind()
    expect(await caller.billing.syncPaymentMethod({})).toMatchObject({
      state: 'active',
      subscription: { autoRenewal: true, paymentMethod: { label: `Карта Visa ••${NBSP}1234` } },
    })
    expect(await subscriptionOf(paying)).toMatchObject({
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      paymentMethodId: methodId,
      renewalNoticePeriodEnd: null,
    })
    expect((await actionsOf(paying)).at(-1)).toBe(autoRenewalResume)
  })

  it('schedules another tariff for the next period and takes the choice back', async () => {
    const paying = await account()
    const { caller } = paying
    const { subscription } = await subscribe(paying, { autoRenew: true })
    const business = await seeded('business')
    await db.subscription.update({
      where: { id: subscription.id },
      data: { renewalNoticePeriodEnd: subscription.period.end },
    })

    const scheduled = await caller.billing.schedulePlanChange({ planSlug: 'business' })

    expect(scheduled).toMatchObject({
      id: subscription.id,
      plan: { slug: 'start' },
      nextPlan: { id: business.id, slug: 'business', price: business.price.toFixed(2) },
      period: subscription.period,
    })
    expect((await caller.billing.overview()).subscription).toEqual(scheduled)
    expect(await caller.billing.autoRenewal()).toMatchObject({
      renewal: {
        planName: 'Старт',
        nextPlanName: business.name,
        amount: business.price.toFixed(2),
      },
    })
    // Nothing changes today: the tariff, the credits and the list of what is on sale.
    expect((await caller.billing.plans()).plans.find((plan) => plan.current)?.slug).toBe('start')
    expect((await caller.billing.overview()).credits.tariff.available).toBe(300)
    // The letter before the charge has to be written again, with the new amount.
    expect((await subscriptionOf(paying)).renewalNoticePeriodEnd).toBeNull()
    await expect(caller.billing.schedulePlanChange({ planSlug: 'business' })).rejects.toMatchObject(
      { code: 'CONFLICT', cause: { code: 'BILLING_ALREADY_ON_PLAN' } },
    )
    await expect(caller.billing.schedulePlanChange({ planSlug: 'start' })).rejects.toMatchObject({
      cause: { code: 'BILLING_ALREADY_ON_PLAN' },
    })

    await db.subscription.update({
      where: { id: subscription.id },
      data: { renewalNoticePeriodEnd: subscription.period.end },
    })
    expect(await caller.billing.cancelPlanChange({})).toMatchObject({
      plan: { slug: 'start' },
      nextPlan: null,
    })
    expect(await subscriptionOf(paying)).toMatchObject({
      nextPlanId: null,
      renewalNoticePeriodEnd: null,
    })
    await expect(caller.billing.cancelPlanChange({})).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'BILLING_NOTHING_TO_CHANGE' },
    })
    expect((await actionsOf(paying)).slice(-2)).toEqual([planChangeSchedule, planChangeCancel])
  })

  it('refuses a tariff the sites of the workspace do not fit, and a change while the charge is at the bank', async () => {
    const paying = await account()
    const { caller } = paying
    await seeded('business')
    await seeded('start')
    const { orderId } = await caller.billing.startCheckout({
      planSlug: 'business',
      autoRenew: true,
    })
    paying.shop.pay({ saved: true })
    await caller.billing.syncOrder({ orderId })
    const subscription = await subscriptionOf(paying)
    for (const host of ['one', 'two']) {
      await db.site.create({
        data: {
          workspaceId: subscription.workspaceId,
          name: host,
          url: `https://${host}-${subscription.id}.example.ru`,
          stack: 'wordpress',
        },
      })
    }

    try {
      await expect(caller.billing.schedulePlanChange({ planSlug: 'start' })).rejects.toMatchObject({
        code: 'CONFLICT',
        message:
          'У вас больше сайтов, чем входит в этот тариф. Выберите тариф, в который они помещаются',
        cause: { code: 'BILLING_PLAN_SITE_LIMIT' },
      })
      expect((await subscriptionOf(paying)).nextPlanId).toBeNull()
    } finally {
      await db.site.deleteMany({ where: { workspaceId: subscription.workspaceId } })
    }

    // The scheduler has started the charge of the period: its order is pending.
    await db.order.create({
      data: {
        workspaceId: subscription.workspaceId,
        kind: 'subscription',
        planId: subscription.planId,
        subscriptionId: subscription.id,
        amount: '12900.00',
        status: 'pending',
        idempotenceKey: renewalKey(subscription.id, subscription.currentPeriodEnd),
        yookassaPaymentId: `pay-${subscription.id}`,
      },
    })
    await expect(caller.billing.schedulePlanChange({ planSlug: 'start' })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'BILLING_PAYMENT_IN_PROGRESS' },
    })
    expect(await caller.billing.overview()).toMatchObject({ renewalCharge: 'at_bank' })
    // Switching off does not wait for the charge, and says where it stands.
    expect(await caller.billing.cancelAutoRenew({})).toMatchObject({ renewalCharge: 'at_bank' })
    expect((await subscriptionOf(paying)).nextPlanId).toBeNull()
  })

  describe('the sites of a customer who chose a smaller tariff for the next period', () => {
    // Default «м» of docs/plan/37-billing-plan.md: a tariff the sites do not fit cannot be
    // chosen. Nothing counts the sites again when the renewal applies the choice, so from the
    // moment it is made `project.create` holds the workspace to the smaller of the two.
    const site = (index: number) => ({
      name: `Сайт ${index}`,
      url: `https://limit-${index}-${randomUUID()}.example.ru`,
      stack: 'wordpress' as const,
    })
    const refusalOf = (adding: Promise<unknown>) =>
      adding.then(
        () => {
          throw new Error('The site was added')
        },
        (error: unknown) => error as { message: string; cause: { code: string; details: unknown } },
      )

    /** A customer on «Агентство» (15 sites) with auto-renewal. */
    async function onAgency() {
      const paying = await account()
      for (const slug of ['start', 'business', 'agency'] as const) await seeded(slug)
      const { orderId } = await paying.caller.billing.startCheckout({
        planSlug: 'agency',
        autoRenew: true,
      })
      paying.shop.pay({ saved: true })
      await paying.caller.billing.syncOrder({ orderId })
      return paying
    }
    const sitesOf = async (paying: Account) =>
      db.site.count({ where: { workspaceId: (await subscriptionOf(paying)).workspaceId } })

    it('cannot add a site above the limit of the chosen tariff, and can again after «Отменить переход»', async () => {
      const paying = await onAgency()
      const { caller } = paying
      await caller.project.create(site(1))
      // One site fits «Старт»: the choice is allowed.
      await caller.billing.schedulePlanChange({ planSlug: 'start' })

      const refused = await refusalOf(caller.project.create(site(2)))

      expect(refused).toMatchObject({
        code: 'FORBIDDEN',
        message:
          'В тариф, который вы выбрали на следующий период, входит один сайт. Чтобы добавить ещё один, отмените переход или выберите другой тариф в настройках',
        cause: { code: 'PROJECT_PLAN_LIMIT_REACHED' },
      })
      expect(refused.cause.details).toEqual({ maxSites: 1, scheduled: true })
      expect(await sitesOf(paying)).toBe(1)
      // The tariff of today is what it was: the limit is not its own.
      expect((await caller.billing.overview()).subscription).toMatchObject({
        plan: { slug: 'agency', maxSites: 15 },
        nextPlan: { slug: 'start', maxSites: 1 },
      })

      await caller.billing.cancelPlanChange({})

      await caller.project.create(site(2))
      await caller.project.create(site(3))
      expect(await sitesOf(paying)).toBe(3)
      // And the smaller tariff no longer fits: the rule holds in both directions.
      await expect(caller.billing.schedulePlanChange({ planSlug: 'start' })).rejects.toMatchObject({
        cause: { code: 'BILLING_PLAN_SITE_LIMIT' },
      })
    })

    it('follows the customer to the other tariff they choose instead', async () => {
      const paying = await onAgency()
      const { caller } = paying
      await caller.project.create(site(1))
      await caller.billing.schedulePlanChange({ planSlug: 'start' })
      await expect(caller.project.create(site(2))).rejects.toMatchObject({
        cause: { code: 'PROJECT_PLAN_LIMIT_REACHED' },
      })

      // «Бизнес» (3 sites) replaces «Старт» as the tariff of the next period.
      await caller.billing.schedulePlanChange({ planSlug: 'business' })

      await caller.project.create(site(2))
      await caller.project.create(site(3))
      const refused = await refusalOf(caller.project.create(site(4)))
      expect(refused.cause.details).toEqual({ maxSites: 3, scheduled: true })
      expect(refused.message).toBe(
        'В тариф, который вы выбрали на следующий период, входит до 3 сайтов. Чтобы добавить ещё один, отмените переход или выберите другой тариф в настройках',
      )
      expect(await sitesOf(paying)).toBe(3)
    })

    it('never ends with more sites than the chosen tariff takes when a site and the choice come at once', async () => {
      // Both take the lock of the user's row first: whichever is second sees what the first did.
      for (let round = 0; round < 4; round += 1) {
        const paying = await onAgency()
        const { caller } = paying
        await caller.project.create(site(1))

        const [added, chosen] = await Promise.allSettled([
          caller.project.create(site(2)),
          caller.billing.schedulePlanChange({ planSlug: 'start' }),
        ])

        const sites = await sitesOf(paying)
        const { nextPlanId } = await subscriptionOf(paying)
        if (chosen.status === 'fulfilled') {
          expect(added).toMatchObject({
            status: 'rejected',
            reason: { cause: { code: 'PROJECT_PLAN_LIMIT_REACHED' } },
          })
          expect(sites).toBe(1)
          expect(nextPlanId).not.toBeNull()
        } else {
          expect(chosen.reason).toMatchObject({ cause: { code: 'BILLING_PLAN_SITE_LIMIT' } })
          expect(added.status).toBe('fulfilled')
          expect(sites).toBe(2)
          expect(nextPlanId).toBeNull()
        }
      }
    })
  })

  it('pays for an overdue tariff: active again for a month from the payment', async () => {
    const paying = await account()
    const { caller, shop } = paying
    const { subscription } = await subscribe(paying, { autoRenew: true })
    // The renewal charge of the period was declined a day ago.
    const periodEnd = new Date('2026-10-03T09:00:00.000Z')
    const since = new Date('2026-10-03T09:05:00.000Z')
    await db.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'past_due',
        currentPeriodStart: new Date('2026-09-03T09:00:00.000Z'),
        currentPeriodEnd: periodEnd,
        periodAnchor: new Date('2026-09-03T09:00:00.000Z'),
        pastDueSince: since,
      },
    })

    const overdue = await caller.billing.overview()
    expect(overdue).toMatchObject({
      subscription: { status: 'past_due', pastDueSince: since },
      pastDueEndsAt: new Date(since.getTime() + 7 * DAY_MS),
      ended: null,
    })
    // Nobody is charged by itself for an overdue tariff.
    expect(await caller.billing.autoRenewal()).toEqual({ renewal: null })
    await expect(caller.billing.startPackCheckout({})).rejects.toMatchObject({
      cause: { code: 'BILLING_PACK_NEEDS_SUBSCRIPTION' },
    })

    const checkout = await caller.billing.startPastDuePayment({})
    expect(await caller.billing.startPastDuePayment({})).toEqual(checkout)
    const paymentId = shop.pay({ saved: true, capturedAt: '2026-10-04T11:00:00.000Z' })
    expect(checkout.confirmationUrl).toBe(`https://yookassa.example/${paymentId}`)
    const order = await caller.billing.syncOrder({ orderId: checkout.orderId })

    const paidAt = new Date('2026-10-04T11:00:00.000Z')
    expect(order).toMatchObject({
      status: 'paid',
      kind: 'subscription',
      planName: 'Старт',
      refundNeeded: false,
      subscription: {
        status: 'active',
        period: { start: paidAt, end: new Date('2026-11-04T11:00:00.000Z') },
        autoRenewal: true,
        pastDueSince: null,
      },
    })
    expect(await caller.billing.overview()).toMatchObject({
      subscription: order.subscription,
      pastDueEndsAt: null,
      credits: { tariff: { available: 300 } },
    })
    expect(await subscriptionOf(paying)).toMatchObject({
      periodAnchor: paidAt,
      paymentMethodId: paymentId,
      pastDueSince: null,
    })
    await expect(caller.billing.startPastDuePayment({})).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'BILLING_NOTHING_TO_CHANGE' },
    })
    // Both payments are in the history, each with the period it bought.
    expect(
      (await caller.billing.payments({})).items.map(({ status, period }) => [status, period?.end]),
    ).toEqual([
      ['paid', new Date('2026-11-04T11:00:00.000Z')],
      ['paid', subscription.period.end],
    ])
  })

  it('tells of the tariff that ended once the customer has none, and no longer after a new one', async () => {
    const paying = await account()
    const { caller, shop } = paying
    const { subscription } = await subscribe(paying, { autoRenew: false })
    await db.subscription.update({
      where: { id: subscription.id },
      data: { status: 'cancelled' },
    })

    expect(await caller.billing.overview()).toMatchObject({
      subscription: null,
      pastDueEndsAt: null,
      ended: { planName: 'Старт', endedAt: subscription.period.end, reason: 'not_renewed' },
    })
    for (const call of [
      () => caller.billing.cancelAutoRenew({}),
      () => caller.billing.resumeAutoRenew({}),
      () => caller.billing.cancelPlanChange({}),
      () => caller.billing.schedulePlanChange({ planSlug: 'business' }),
      () => caller.billing.startPastDuePayment({}),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'BILLING_NO_LIVE_SUBSCRIPTION' },
      })
    }

    // «Выбрать тариф»: a first payment again.
    const { orderId } = await caller.billing.startCheckout({ planSlug: 'start', autoRenew: false })
    shop.pay()
    await caller.billing.syncOrder({ orderId })
    expect(await caller.billing.overview()).toMatchObject({
      subscription: { status: 'active' },
      ended: null,
    })
  })

  it('lets a user who has not accepted a new edition of the documents see the charge and stop it', async () => {
    const paying = await account()
    await subscribe(paying, { autoRenew: true })
    // A new edition is published: the consents of the user are of the edition before it.
    await db.userConsent.deleteMany({ where: { userId: paying.user.id } })
    const { caller } = paying

    await expect(caller.billing.overview()).rejects.toMatchObject({
      code: 'PRECONDITION_REQUIRED',
    })
    expect(await caller.billing.autoRenewal()).toMatchObject({
      renewal: { planName: 'Старт', renewalCharge: 'none' },
    })
    await expect(caller.billing.cancelAutoRenew({})).resolves.toMatchObject({
      renewalCharge: 'none',
    })
    expect(await caller.billing.autoRenewal()).toEqual({ renewal: null })
    expect(await subscriptionOf(paying)).toMatchObject({ cancelAtPeriodEnd: true })
    // Switching it back on is a consent to be charged: it waits for the documents.
    await expect(caller.billing.resumeAutoRenew({})).rejects.toMatchObject({
      code: 'PRECONDITION_REQUIRED',
    })

    await paying.accept()
    await expect(caller.billing.resumeAutoRenew({})).resolves.toEqual({
      needsPaymentMethod: false,
      renewalCharge: 'none',
    })
  })

  it('changes the tariff of the customer alone', async () => {
    const paying = await account()
    const other = await account()
    await subscribe(paying, { autoRenew: true })
    await subscribe(other, { autoRenew: true })

    await paying.caller.billing.cancelAutoRenew({})
    await paying.caller.billing.schedulePlanChange({ planSlug: 'business' })

    expect(await subscriptionOf(other)).toMatchObject({
      cancelAtPeriodEnd: false,
      nextPlanId: null,
    })
    expect(await other.caller.billing.autoRenewal()).toMatchObject({
      renewal: { planName: 'Старт', nextPlanName: null },
    })
  })
})
