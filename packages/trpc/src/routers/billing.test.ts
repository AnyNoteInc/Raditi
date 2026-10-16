import { randomUUID } from 'node:crypto'

import type { Auth } from '@repo/auth'
import type * as BillingModule from '@repo/billing'
import {
  paymentLetterKey,
  startCheckout,
  startPackCheckout,
  syncOrder,
  type OrderSyncDto,
} from '@repo/billing'
import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import {
  billingOrderNotFound,
  billingPackNeedsSubscription,
  billingPaymentDeclined,
  billingPaymentInProgress,
  billingPaymentsNotConfigured,
  billingPlanNotFound,
  billingPlanSiteLimit,
  billingSubscriptionExists,
  conflict,
  legalDocuments,
  Money,
  type DomainError,
} from '@repo/domain'
import { YookassaApiError, YookassaError, type Payment, type YookassaClient } from '@repo/yookassa'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { INTERNAL_ERROR_MESSAGE } from '../errors.ts'
import { appRouter, createCaller } from '../router.ts'
import { createContext, type BillingContext, type Context } from '../trpc.ts'

// The payment functions of @repo/billing are wrapped: they run as they are — the PostgreSQL
// block pays through them — unless a test scripts the next answer.
vi.mock('@repo/billing', async (importOriginal) => {
  const original = await importOriginal<typeof BillingModule>()
  return {
    ...original,
    startCheckout: vi.fn(original.startCheckout),
    startPackCheckout: vi.fn(original.startPackCheckout),
    syncOrder: vi.fn(original.syncOrder),
  }
})
const checkout = vi.mocked(startCheckout)
const packCheckout = vi.mocked(startPackCheckout)
const sync = vi.mocked(syncOrder)

const now = new Date('2026-10-04T12:00:00Z')
const PAID_AT = '2026-10-04T09:00:00.000Z'
const APP_URL = 'https://raditi.example'
const WORKSPACE = '0199a000-0000-7000-8000-0000000000b1'
const NBSP = '\u00a0'

const user: User = {
  id: randomUUID(),
  name: 'Анна Ковалёва',
  lastName: null,
  email: 'billing-test@example.ru',
  emailVerified: true,
  image: null,
  createdAt: now,
  updatedAt: now,
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
  checkout.mockReset()
  packCheckout.mockReset()
  sync.mockReset()
})

/**
 * ЮKassa in memory: a payment waits on its page until the test pays it, a repeated
 * Idempotence-Key answers with the payment of the first request. Only the two calls the
 * payment of a tariff needs answer.
 */
function shopStub() {
  const payments = new Map<string, Payment>()
  const idByKey = new Map<string, string>()
  const returnUrls: string[] = []
  const reads: string[] = []
  const unused = () => Promise.reject(new Error('The billing router does not make this call'))
  const yookassa: YookassaClient = {
    createPayment(input, idempotenceKey) {
      let id = idByKey.get(idempotenceKey)
      if (id === undefined) {
        id = randomUUID()
        idByKey.set(idempotenceKey, id)
        if (input.confirmation?.type === 'redirect') returnUrls.push(input.confirmation.return_url)
        payments.set(id, {
          id,
          status: 'pending',
          paid: false,
          amount: { value: input.amount.value, currency: 'RUB' },
          created_at: now.toISOString(),
          confirmation: { type: 'redirect', confirmation_url: `https://yookassa.example/${id}` },
          ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        })
      }
      return Promise.resolve(structuredClone(payments.get(id)!))
    },
    getPayment(paymentId) {
      reads.push(paymentId)
      const payment = payments.get(paymentId)
      return payment === undefined
        ? Promise.reject(new YookassaApiError('not_found', 404, 'not_found', {}))
        : Promise.resolve(structuredClone(payment))
    },
    chargeWithSavedMethod: unused,
    createPaymentMethod: unused,
    getPaymentMethod: unused,
    createRefund: unused,
    getRefund: unused,
  }
  return {
    billing: {
      yookassa,
      appUrl: APP_URL,
      appEnv: 'test',
      autopayments: true,
      pastDueDays: 7,
    } satisfies BillingContext,
    payments,
    /** Where each payment sends the customer back to. */
    returnUrls,
    /** The payment id of every getPayment request. */
    reads,
    /** The customer paid on the page of the payment. */
    pay(paymentId: string) {
      const payment = payments.get(paymentId)
      if (payment === undefined) throw new Error(`The stub has no payment ${paymentId}`)
      payment.status = 'succeeded'
      payment.paid = true
      payment.captured_at = PAID_AT
      delete payment.confirmation
      payment.payment_method = { id: paymentId, type: 'bank_card', saved: false }
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
          token: 'billing-test-session',
          expiresAt: new Date('2030-01-01'),
          createdAt: now,
          updatedAt: now,
        }
      : null,
    billing,
  }
}

const planRow = (data: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  slug: 'start',
  name: 'Старт',
  kind: 'quota',
  price: new Money('4900'),
  creditsPerMonth: 30,
  tasksPerDay: 5,
  maxSites: 1,
  packCredits: null,
  ...data,
})
const business = () =>
  planRow({
    slug: 'business',
    name: 'Бизнес',
    price: new Money('12900'),
    creditsPerMonth: 80,
    tasksPerDay: 10,
    maxSites: 3,
  })
const planDto = ({
  kind: _kind,
  packCredits: _packCredits,
  price,
  ...row
}: ReturnType<typeof planRow>) => ({
  ...row,
  price: price.toFixed(2),
})

const subscriptionRow = (plan: ReturnType<typeof planRow>, data: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  status: 'active',
  currentPeriodStart: new Date('2026-09-18T09:00:00Z'),
  currentPeriodEnd: new Date('2026-10-18T09:00:00Z'),
  cancelAtPeriodEnd: false,
  pastDueSince: null,
  paymentMethodId: 'pm-1',
  paymentMethodType: 'bank_card',
  paymentMethodCardType: 'Mir',
  paymentMethodLast4: '4444',
  pendingPaymentMethodId: null,
  plan,
  nextPlan: null,
  ...data,
})

const noGift = { balance: 0, held: 0, available: 0, granted: false }
/** A new task would be taken: nothing stands in its way. */
const TAKEN = { allowed: true, reason: null }
/** What a database without a credit rate answers about every task. */
const NO_RATE = { allowed: false, reason: 'rate_missing' }
/** No credit on any account, and no tariff: a task has nothing to start on. */
const noCredits = {
  tariff: { balance: 0, held: 0, available: 0 },
  gift: noGift,
  pack: { balance: 0, held: 0, available: 0 },
  totalAvailable: 0,
  spendable: 0,
  setAside: 0,
  minToStart: 5,
  // Nothing was launched today; without a paid tariff a day takes three tasks.
  today: { used: 0, limit: 3 },
  newTask: { allowed: false, reason: 'gift_spent' },
}
/** The gift of the registration on the account of a workspace the product made. */
const giftGranted = { balance: 35, held: 0, available: 35, granted: true }
/**
 * What a user without a workspace reads: the gift they are granted together with it, and that
 * the first task would be taken on it.
 */
const promisedCredits = {
  ...noCredits,
  gift: { balance: 35, held: 0, available: 35, granted: false },
  totalAvailable: 35,
  spendable: 35,
  newTask: TAKEN,
}
/**
 * No binding waits to be read back and no renewal charge is under way; the tariff is not
 * overdue, and none has ended.
 */
const noWaits = {
  bindingPending: false,
  renewalCharge: 'none',
  pastDueEndsAt: null,
  ended: null,
}

/** The tables the billing procedures read, answering from the test. */
function fakeDb() {
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    workspace: {
      findFirst: vi.fn<() => Promise<{ id: string } | null>>().mockResolvedValue({ id: WORKSPACE }),
      // Since when the work of a workspace without a tariff is counted.
      findUniqueOrThrow: vi.fn<() => Promise<unknown>>().mockResolvedValue({ createdAt: now }),
    },
    subscription: { findFirst: vi.fn<() => Promise<unknown>>().mockResolvedValue(null) },
    order: { findUnique: vi.fn<() => Promise<unknown>>().mockResolvedValue(null) },
    billingAccount: { findMany: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]) },
    creditLedger: {
      findFirst: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
      // The key of the user's gift: not in the ledger unless a test puts it there.
      findUnique: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
      // Nothing was charged yet.
      aggregate: vi.fn<() => Promise<unknown>>().mockResolvedValue({ _sum: { amount: null } }),
    },
    plan: {
      findMany: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
      findFirst: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
      // The terms a new task of the subscribed tariff is checked by: those of «Бизнес».
      findUniqueOrThrow: vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({ creditsPerMonth: 80, tasksPerDay: 10 }),
    },
    site: { count: vi.fn<() => Promise<number>>().mockResolvedValue(0) },
    // A credit rate is in force and no enabled model has a price: a task is refused by nothing
    // but the credits, and no table of the conversion is printed, unless a test says otherwise.
    creditRate: {
      findFirst: vi.fn<() => Promise<unknown>>().mockResolvedValue({
        id: randomUUID(),
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        rubPerCredit: new Money('6'),
        basis: 'Billing test',
      }),
    },
    llmModelPrice: { findFirst: vi.fn<() => Promise<unknown>>().mockResolvedValue(null) },
    llmModel: { findMany: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]) },
    // No launch today and no work without a charge.
    $queryRaw: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    $transaction: vi.fn(),
  }
  return { db, prisma: db as unknown as PrismaClient }
}

const procedures = ['overview', 'plans', 'startCheckout', 'startPackCheckout', 'syncOrder'] as const
const checkoutInput = { planSlug: 'business', autoRenew: true } as const

describe('billing access', () => {
  it.each(procedures)('requires a session before %s reads anything', async (name) => {
    const { prisma, db } = fakeDb()
    const call = createCaller(context(prisma, { currentUser: null })).billing[name] as (
      input?: unknown,
    ) => Promise<unknown>
    await expect(call()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(db.userConsent.findMany).not.toHaveBeenCalled()
    expect(db.workspace.findFirst).not.toHaveBeenCalled()
    expect(checkout).not.toHaveBeenCalled()
    expect(packCheckout).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('requires the current mandatory consents for every procedure', async () => {
    const { prisma, db } = fakeDb()
    db.userConsent.findMany.mockResolvedValue([])
    const caller = createCaller(context(prisma)).billing
    for (const call of [
      caller.overview(),
      caller.plans(),
      caller.startCheckout(checkoutInput),
      caller.startPackCheckout({}),
      caller.syncOrder({ orderId: randomUUID() }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' })
    }
    expect(db.workspace.findFirst).not.toHaveBeenCalled()
    expect(db.plan.findMany).not.toHaveBeenCalled()
    expect(db.plan.findFirst).not.toHaveBeenCalled()
    expect(checkout).not.toHaveBeenCalled()
    expect(packCheckout).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })
})

describe('billing.overview', () => {
  it('shows the tariff and the credits of the personal workspace', async () => {
    const { prisma, db } = fakeDb()
    const plan = business()
    const subscription = subscriptionRow(plan)
    db.subscription.findFirst.mockResolvedValue(subscription)
    db.billingAccount.findMany.mockResolvedValue([
      { unit: 'credit_tariff', balance: new Money(80), held: new Money(35) },
      { unit: 'credit_pack', balance: new Money(10), held: new Money(0) },
    ])

    expect(await createCaller(context(prisma)).billing.overview()).toEqual({
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      subscription: {
        id: subscription.id,
        status: 'active',
        plan: planDto(plan),
        period: { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd },
        autoRenewal: true,
        nextPlan: null,
        paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` },
        pastDueSince: null,
      },
      credits: {
        tariff: { balance: 80, held: 35, available: 45 },
        gift: noGift,
        pack: { balance: 10, held: 0, available: 10 },
        totalAvailable: 55,
        // The tariff is paid: a new task may take what is free on every account.
        spendable: 55,
        setAside: 35,
        minToStart: 5,
        today: { used: 0, limit: 10 },
        newTask: TAKEN,
      },
      ...noWaits,
    })
    // The personal workspace of this user, by the rule of project.create.
    expect(db.workspace.findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdById: user.id, dataClass: 'synthetic' }),
      }),
    )
    // The tariff, what it waits for, and what a new task is checked by: all of that workspace.
    expect(db.subscription.findFirst).toHaveBeenCalledTimes(3)
    for (const read of [1, 2, 3]) {
      expect(db.subscription.findFirst).toHaveBeenNthCalledWith(
        read,
        expect.objectContaining({ where: expect.objectContaining({ workspaceId: WORKSPACE }) }),
      )
    }
    // The accounts are read for the balances and for the check of a new task.
    expect(db.billingAccount.findMany).toHaveBeenCalledTimes(2)
    for (const read of [1, 2]) {
      expect(db.billingAccount.findMany).toHaveBeenNthCalledWith(
        read,
        expect.objectContaining({ where: expect.objectContaining({ workspaceId: WORKSPACE }) }),
      )
    }
  })

  it('tells why a new task would not be taken, by the answer of the queue', async () => {
    const { prisma, db } = fakeDb()
    db.subscription.findFirst.mockResolvedValue(subscriptionRow(business()))
    db.billingAccount.findMany.mockResolvedValue([
      { unit: 'credit_tariff', balance: new Money(47), held: new Money(45) },
    ])
    const credits = async () => (await createCaller(context(prisma)).billing.overview()).credits

    // Two credits are free and 45 are set aside for a task in work.
    expect(await credits()).toMatchObject({
      spendable: 2,
      setAside: 45,
      minToStart: 5,
      newTask: { allowed: false, reason: 'held' },
    })

    // Ten launches today on a tariff of ten tasks a day.
    db.billingAccount.findMany.mockResolvedValue([
      { unit: 'credit_tariff', balance: new Money(80), held: new Money(0) },
    ])
    db.$queryRaw.mockResolvedValueOnce([{ launches: 10 }])
    expect(await credits()).toMatchObject({
      spendable: 80,
      today: { used: 10, limit: 10 },
      newTask: { allowed: false, reason: 'daily_limit' },
    })

    // No credit rate is in force: said before anything else.
    db.creditRate.findFirst.mockResolvedValue(null)
    expect(await credits()).toMatchObject({
      spendable: 80,
      newTask: { allowed: false, reason: 'rate_missing' },
    })
    // The rate is asked about the moment of the request.
    expect(db.creditRate.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { effectiveFrom: { lte: expect.any(Date) } } }),
    )
  })

  it('shows the gift of the registration once it is granted and counts it in what is left', async () => {
    const { prisma, db } = fakeDb()
    const giftAccount = randomUUID()
    db.billingAccount.findMany.mockResolvedValue([
      { id: randomUUID(), unit: 'credit_tariff', balance: new Money(0), held: new Money(0) },
      { id: giftAccount, unit: 'credit_gift', balance: new Money(35), held: new Money(5) },
      { id: randomUUID(), unit: 'credit_pack', balance: new Money(0), held: new Money(0) },
    ])
    db.creditLedger.findFirst.mockResolvedValue({ id: randomUUID() })

    const { credits } = await createCaller(context(prisma)).billing.overview()

    expect(credits).toEqual({
      tariff: { balance: 0, held: 0, available: 0 },
      gift: { balance: 35, held: 5, available: 30, granted: true },
      pack: { balance: 0, held: 0, available: 0 },
      totalAvailable: 30,
      // Without a tariff a task is taken on the gift.
      spendable: 30,
      setAside: 5,
      minToStart: 5,
      today: { used: 0, limit: 3 },
      newTask: TAKEN,
    })
    expect(db.billingAccount.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: WORKSPACE,
        unit: { in: ['credit_tariff', 'credit_gift', 'credit_pack'] },
      },
      select: { id: true, unit: true, balance: true, held: true },
    })
    // Whether the gift was granted is asked of the journal of the gift account alone.
    expect(db.creditLedger.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { accountId: giftAccount, kind: 'grant' },
      select: { id: true },
    })
  })

  it('shows an empty gift account as not granted: the grant of a tariff is no gift', async () => {
    const { prisma, db } = fakeDb()
    db.billingAccount.findMany.mockResolvedValue([
      { id: randomUUID(), unit: 'credit_tariff', balance: new Money(300), held: new Money(0) },
      { id: randomUUID(), unit: 'credit_gift', balance: new Money(0), held: new Money(0) },
      { id: randomUUID(), unit: 'credit_pack', balance: new Money(0), held: new Money(0) },
    ])

    const { credits } = await createCaller(context(prisma)).billing.overview()

    expect(credits.gift).toEqual(noGift)
    expect(credits.totalAvailable).toBe(300)
    expect(db.creditLedger.findFirst).toHaveBeenCalledTimes(1)
  })

  it('answers «no tariff» and the gift as promised for a user without a workspace, and reads no further', async () => {
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(null)

    expect(await createCaller(context(prisma)).billing.overview()).toEqual({
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      subscription: null,
      credits: promisedCredits,
      ...noWaits,
    })
    // Whether the gift is still to come is asked of the ledger, by the key of this user.
    expect(db.creditLedger.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { idempotencyKey: `user:${user.id}:signup-gift` },
      select: { id: true },
    })
    expect(db.subscription.findFirst).not.toHaveBeenCalled()
    expect(db.billingAccount.findMany).not.toHaveBeenCalled()
    expect(db.creditLedger.findFirst).not.toHaveBeenCalled()
    expect(db.order.findUnique).not.toHaveBeenCalled()
  })

  it('promises no gift to a user without a workspace whose gift stands in the ledger', async () => {
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(null)
    db.creditLedger.findUnique.mockResolvedValue({ id: randomUUID() })

    expect((await createCaller(context(prisma)).billing.overview()).credits).toEqual(noCredits)
    // Zeros only after a second look for the workspace, made once the key was found.
    expect(db.workspace.findFirst).toHaveBeenCalledTimes(2)
    expect(db.creditLedger.findUnique).toHaveBeenCalledOnce()
    expect(db.billingAccount.findMany).not.toHaveBeenCalled()
  })

  it('does not look for the workspace again while the gift is still promised', async () => {
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(null)

    expect((await createCaller(context(prisma)).billing.overview()).credits).toEqual(
      promisedCredits,
    )
    expect(db.workspace.findFirst).toHaveBeenCalledOnce()
  })

  // The workspace and the key of the gift are two reads. A first site or a first checkout that
  // commits between them leaves the first at «no workspace» and the second at «granted»: the
  // page must show the gift where it stands, not «no gift».
  it('reads the workspace that was made between its two reads, with the gift and the tariff on it', async () => {
    const { prisma, db } = fakeDb()
    const plan = business()
    const subscription = subscriptionRow(plan)
    const giftAccount = randomUUID()
    const order: string[] = []
    db.workspace.findFirst
      .mockImplementationOnce(() => {
        order.push('workspace')
        return Promise.resolve(null)
      })
      .mockImplementationOnce(() => {
        order.push('workspace')
        return Promise.resolve({ id: WORKSPACE })
      })
    db.creditLedger.findUnique.mockImplementation(() => {
      order.push('key')
      return Promise.resolve({ id: randomUUID() })
    })
    db.subscription.findFirst.mockResolvedValue(subscription)
    db.billingAccount.findMany.mockResolvedValue([
      { id: randomUUID(), unit: 'credit_tariff', balance: new Money(80), held: new Money(0) },
      { id: giftAccount, unit: 'credit_gift', balance: new Money(35), held: new Money(0) },
      { id: randomUUID(), unit: 'credit_pack', balance: new Money(0), held: new Money(0) },
    ])
    db.creditLedger.findFirst.mockResolvedValue({ id: randomUUID() })

    const overview = await createCaller(context(prisma)).billing.overview()

    expect(overview.credits).toEqual({
      tariff: { balance: 80, held: 0, available: 80 },
      gift: giftGranted,
      pack: { balance: 0, held: 0, available: 0 },
      totalAvailable: 115,
      spendable: 115,
      setAside: 0,
      minToStart: 5,
      today: { used: 0, limit: 10 },
      newTask: TAKEN,
    })
    expect(overview.subscription).toMatchObject({ id: subscription.id, status: 'active' })
    // The second look comes after the key: read then, the workspace of the gift is there.
    expect(order).toEqual(['workspace', 'key', 'workspace'])
    // Everything else of the answer is read for the workspace that was found.
    expect(db.billingAccount.findMany).toHaveBeenCalledTimes(2)
    for (const read of [1, 2]) {
      expect(db.billingAccount.findMany).toHaveBeenNthCalledWith(
        read,
        expect.objectContaining({ where: expect.objectContaining({ workspaceId: WORKSPACE }) }),
      )
    }
    expect(db.creditLedger.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { accountId: giftAccount, kind: 'grant' },
      select: { id: true },
    })
    expect(db.subscription.findFirst).toHaveBeenCalledTimes(3)
    for (const read of [1, 2, 3]) {
      expect(db.subscription.findFirst).toHaveBeenNthCalledWith(
        read,
        expect.objectContaining({ where: expect.objectContaining({ workspaceId: WORKSPACE }) }),
      )
    }
  })

  it('does not ask for a promise once the user has a workspace: its accounts are read', async () => {
    const { prisma, db } = fakeDb()

    expect((await createCaller(context(prisma)).billing.overview()).credits).toEqual(noCredits)
    expect(db.creditLedger.findUnique).not.toHaveBeenCalled()
    expect(db.billingAccount.findMany).toHaveBeenCalledTimes(2)
  })

  it('tells that a binding waits and where the charge of the period stands, and never the ids', async () => {
    const { prisma, db } = fakeDb()
    const subscription = subscriptionRow(business(), { pendingPaymentMethodId: 'pm-waiting' })
    db.subscription.findFirst.mockResolvedValue(subscription)
    db.order.findUnique.mockResolvedValue({ status: 'pending', yookassaPaymentId: 'pay-1' })

    const overview = await createCaller(context(prisma)).billing.overview()

    expect(overview).toMatchObject({ bindingPending: true, renewalCharge: 'at_bank' })
    expect(JSON.stringify(overview)).not.toMatch(/pm-waiting|pay-1/)
    // The one order that renews the period the subscription stands in.
    expect(db.order.findUnique).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: {
          idempotenceKey: `renew.${subscription.id}.${subscription.currentPeriodEnd.getTime()}`,
        },
      }),
    )
  })

  it('shows the tariff while payments are off and says that nothing can be paid for', async () => {
    const { prisma, db } = fakeDb()
    db.subscription.findFirst.mockResolvedValue(subscriptionRow(business()))

    const overview = await createCaller(context(prisma, { billing: null })).billing.overview()

    expect(overview).toMatchObject({
      paymentsEnabled: false,
      subscription: { status: 'active', plan: { slug: 'business' } },
      // A paid tariff with nothing on its accounts: the credits ran out.
      credits: {
        ...noCredits,
        today: { used: 0, limit: 10 },
        newTask: { allowed: false, reason: 'empty' },
      },
    })
  })

  it('learns from the context the app builds whether payments are on', async () => {
    // createContext itself, as the web route and the caller of Server Components use it.
    const { prisma } = fakeDb()
    const { session, user: currentUser } = context(prisma)
    const auth = {
      api: { getSession: () => Promise.resolve({ session, user: currentUser }) },
    } as unknown as Auth
    const options = { headers: new Headers(), prisma, auth }

    const withShop = await createContext({ ...options, billing: shopStub().billing })
    const withoutShop = await createContext(options)

    await expect(createCaller(withShop).billing.overview()).resolves.toMatchObject({
      paymentsEnabled: true,
    })
    await expect(createCaller(withoutShop).billing.overview()).resolves.toMatchObject({
      paymentsEnabled: false,
    })
  })

  it.each([
    ['a shop that saves payment methods', { autopayments: true }, true, true],
    ['a shop that takes one-time payments only', { autopayments: false }, true, false],
    // Nothing can be paid for at all: no auto-renewal either.
    ['no shop', null, false, false],
  ] as const)(
    'tells the pages whether auto-renewal can be offered: %s',
    async (_case, shop, paymentsEnabled, autoRenewalAvailable) => {
      const { prisma, db } = fakeDb()
      // A tariff with a method saved before the switch was turned off is shown as it is.
      db.subscription.findFirst.mockResolvedValue(subscriptionRow(business()))
      db.plan.findMany.mockResolvedValue([planRow(), business()])
      const billing = shop && { ...shopStub().billing, ...shop }
      const caller = createCaller(context(prisma, { billing })).billing

      expect(await caller.overview()).toMatchObject({
        paymentsEnabled,
        autoRenewalAvailable,
        subscription: { autoRenewal: true, paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` } },
      })
      // The page of the tariffs learns it with what is on sale as well.
      expect(await caller.plans()).toMatchObject({ autoRenewalAvailable })
    },
  )

  it.each([
    ['the shop while payments are on', 'production', 'development', 'client'],
    ['the shop while payments are on', 'test', 'production', 'synthetic'],
    ['APP_ENV while payments are off', null, 'production', 'client'],
    ['APP_ENV while payments are off', null, 'development', 'synthetic'],
  ] as const)(
    'finds the personal workspace by the environment of %s (%s, APP_ENV=%s)',
    async (_source, shopEnv, appEnv, dataClass) => {
      vi.stubEnv('APP_ENV', appEnv)
      const { prisma, db } = fakeDb()
      const billing = shopEnv && { ...shopStub().billing, appEnv: shopEnv }

      await createCaller(context(prisma, { billing })).billing.overview()

      expect(db.workspace.findFirst).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ where: expect.objectContaining({ dataClass }) }),
      )
    },
  )

  it.each([undefined, '', 'prod'])(
    'refuses a missing or invalid APP_ENV (%s) while payments are off, before reading',
    async (appEnv) => {
      vi.stubEnv('APP_ENV', appEnv)
      const { prisma, db } = fakeDb()
      const caller = createCaller(context(prisma, { billing: null })).billing

      await expect(caller.overview()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
      await expect(caller.plans()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
      expect(db.workspace.findFirst).not.toHaveBeenCalled()
    },
  )
})

const pack = () =>
  planRow({
    slug: 'pack',
    name: 'Пакет из 100 кредитов',
    kind: 'pack',
    price: new Money('1990'),
    creditsPerMonth: null,
    tasksPerDay: null,
    maxSites: null,
    packCredits: 100,
  })

describe('billing.plans', () => {
  const agency = () =>
    planRow({
      slug: 'agency',
      name: 'Агентство',
      price: new Money('39900'),
      creditsPerMonth: 250,
      tasksPerDay: 30,
      maxSites: 15,
    })

  it('marks the tariffs the sites do not fit and the tariff of the subscription', async () => {
    const { prisma, db } = fakeDb()
    const rows = [planRow(), business(), agency(), pack()]
    db.plan.findMany.mockResolvedValue(rows)
    db.site.count.mockResolvedValue(3)
    db.subscription.findFirst.mockResolvedValue(subscriptionRow(rows[1]!))

    expect(await createCaller(context(prisma)).billing.plans()).toEqual({
      plans: [
        { ...planDto(rows[0]!), fitsSites: false, current: false },
        // As many sites as the plan allows still fit.
        { ...planDto(rows[1]!), fitsSites: true, current: true },
        { ...planDto(rows[2]!), fitsSites: true, current: false },
      ],
      pack: {
        id: rows[3]!.id,
        slug: 'pack',
        name: 'Пакет из 100 кредитов',
        price: '1990.00',
        credits: 100,
      },
      siteCount: 3,
      autoRenewalAvailable: true,
      // No enabled model has a price in force: there is no table to print.
      creditConversion: null,
    })
    // Every site of the workspace, whatever its status: the count a checkout refuses by.
    expect(db.site.count).toHaveBeenCalledExactlyOnceWith({ where: { workspaceId: WORKSPACE } })
  })

  it('counts no sites and marks no tariff for a user without a workspace', async () => {
    const { prisma, db } = fakeDb()
    const rows = [planRow(), business()]
    db.plan.findMany.mockResolvedValue(rows)
    db.workspace.findFirst.mockResolvedValue(null)

    expect(await createCaller(context(prisma)).billing.plans()).toEqual({
      plans: rows.map((row) => ({ ...planDto(row), fitsSites: true, current: false })),
      pack: null,
      siteCount: 0,
      autoRenewalAvailable: true,
      creditConversion: null,
    })
    expect(db.site.count).not.toHaveBeenCalled()
    expect(db.subscription.findFirst).not.toHaveBeenCalled()
  })

  it('does not mark a tariff when the subscription is on one that is no longer sold', async () => {
    const { prisma, db } = fakeDb()
    db.plan.findMany.mockResolvedValue([planRow(), business()])
    db.subscription.findFirst.mockResolvedValue(subscriptionRow(agency()))

    const { plans } = await createCaller(context(prisma, { billing: null })).billing.plans()

    expect(plans.map(({ slug, current }) => [slug, current])).toEqual([
      ['start', false],
      ['business', false],
    ])
  })
})

describe('billing.startCheckout', () => {
  const answer = {
    orderId: randomUUID(),
    confirmationUrl: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=1',
  }

  it('starts the checkout of the signed-in user through the shop of the context', async () => {
    const { prisma } = fakeDb()
    const { billing } = shopStub()
    checkout.mockResolvedValueOnce(answer)

    expect(
      await createCaller(context(prisma, { billing })).billing.startCheckout(checkoutInput),
    ).toEqual(answer)

    expect(checkout).toHaveBeenCalledExactlyOnceWith(
      { prisma, yookassa: billing.yookassa, appUrl: APP_URL, appEnv: 'test', autopayments: true },
      { userId: user.id, planSlug: 'business', autoRenew: true },
    )
    expect(checkout.mock.calls[0]![0].yookassa).toBe(billing.yookassa)
  })

  it('refuses while payments are off and asks nothing', async () => {
    const { prisma, db } = fakeDb()

    await expect(
      createCaller(context(prisma, { billing: null })).billing.startCheckout(checkoutInput),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
      cause: { code: 'BILLING_PAYMENTS_NOT_CONFIGURED' },
    })
    expect(checkout).not.toHaveBeenCalled()
    expect(db.plan.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { planSlug: 'business' },
    { autoRenew: true },
    { ...checkoutInput, planSlug: '' },
    { ...checkoutInput, planSlug: 'x'.repeat(51) },
    { ...checkoutInput, autoRenew: 'yes' },
    { ...checkoutInput, userId: randomUUID() },
    { ...checkoutInput, workspaceId: WORKSPACE },
    { ...checkoutInput, amount: '1.00' },
  ])('rejects an incomplete choice or one that names the payer or the price: %o', async (input) => {
    const { prisma } = fakeDb()
    await expect(
      createCaller(context(prisma)).billing.startCheckout(input as typeof checkoutInput),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(checkout).not.toHaveBeenCalled()
  })

  it.each([
    { ...answer, orderId: 'order-1' },
    { ...answer, confirmationUrl: 'javascript:alert(1)' },
    { orderId: answer.orderId },
  ])('does not send the customer to an answer its schema does not describe: %o', async (broken) => {
    const { prisma } = fakeDb()
    checkout.mockResolvedValueOnce(broken as typeof answer)
    await expect(
      createCaller(context(prisma)).billing.startCheckout(checkoutInput),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  })

  it('refuses the consent to auto-renewal at a shop that takes one-time payments only', async () => {
    // The checkout of @repo/billing itself, given the switch of the shop: it reads nothing.
    const { prisma, db } = fakeDb()
    const billing = { ...shopStub().billing, autopayments: false }
    const caller = createCaller(context(prisma, { billing })).billing

    await expect(caller.startCheckout(checkoutInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Автопродление пока недоступно. Оформите тариф без него: он будет действовать месяц',
      cause: { code: 'BILLING_AUTO_RENEWAL_UNAVAILABLE' },
    })

    expect(checkout).toHaveBeenCalledExactlyOnceWith(
      { prisma, yookassa: billing.yookassa, appUrl: APP_URL, appEnv: 'test', autopayments: false },
      { userId: user.id, planSlug: 'business', autoRenew: true },
    )
    expect(db.plan.findFirst).not.toHaveBeenCalled()
    expect(db.$transaction).not.toHaveBeenCalled()

    // Without the consent the same shop sells the tariff: the checkout goes on to look it up.
    await expect(
      caller.startCheckout({ ...checkoutInput, autoRenew: false }),
    ).rejects.toMatchObject({ cause: { code: 'BILLING_PLAN_NOT_FOUND' } })
    expect(db.plan.findFirst).toHaveBeenCalledTimes(1)
  })

  it('refuses a tariff that is not on sale in the words of the customer', async () => {
    // The checkout of @repo/billing itself: it looks the tariff up and finds none.
    const { prisma, db } = fakeDb()

    await expect(
      createCaller(context(prisma)).billing.startCheckout(checkoutInput),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Этот тариф сейчас не продаётся. Обновите страницу и выберите другой',
      cause: { code: 'BILLING_PLAN_NOT_FOUND' },
    })
    expect(db.plan.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { slug: 'business', kind: 'quota', isActive: true },
    })
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})

describe('billing.startPackCheckout', () => {
  const answer = {
    orderId: randomUUID(),
    confirmationUrl: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=2',
  }
  const NEEDS_TARIFF =
    'Пакет кредитов можно купить только при действующем тарифе. Сначала оформите или оплатите тариф'

  it('starts the pack checkout of the signed-in user through the shop of the context', async () => {
    const { prisma } = fakeDb()
    const { billing } = shopStub()
    packCheckout.mockResolvedValueOnce(answer)

    expect(await createCaller(context(prisma, { billing })).billing.startPackCheckout({})).toEqual(
      answer,
    )

    // Who pays comes from the session; which pack and for how much, from what is on sale.
    expect(packCheckout).toHaveBeenCalledExactlyOnceWith(
      { prisma, yookassa: billing.yookassa, appUrl: APP_URL, appEnv: 'test', autopayments: true },
      { userId: user.id },
    )
    expect(packCheckout.mock.calls[0]![0].yookassa).toBe(billing.yookassa)
    expect(checkout).not.toHaveBeenCalled()
  })

  it('refuses while payments are off and asks nothing', async () => {
    const { prisma, db } = fakeDb()

    await expect(
      createCaller(context(prisma, { billing: null })).billing.startPackCheckout({}),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
      cause: { code: 'BILLING_PAYMENTS_NOT_CONFIGURED' },
    })
    expect(packCheckout).not.toHaveBeenCalled()
    expect(db.plan.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    null,
    { planSlug: 'pack' },
    { userId: randomUUID() },
    { workspaceId: WORKSPACE },
    { amount: '1.00' },
    { autoRenew: true },
  ])(
    'takes an empty object and nothing that names the pack, the payer or the price: %o',
    async (input) => {
      const { prisma } = fakeDb()
      await expect(
        createCaller(context(prisma)).billing.startPackCheckout(
          input as unknown as Record<string, never>,
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(packCheckout).not.toHaveBeenCalled()
    },
  )

  it.each([
    { ...answer, orderId: 'order-1' },
    { ...answer, confirmationUrl: 'javascript:alert(1)' },
    { orderId: answer.orderId },
  ])('does not send the customer to an answer its schema does not describe: %o', async (broken) => {
    const { prisma } = fakeDb()
    packCheckout.mockResolvedValueOnce(broken as typeof answer)
    await expect(createCaller(context(prisma)).billing.startPackCheckout({})).rejects.toMatchObject(
      { code: 'INTERNAL_SERVER_ERROR' },
    )
  })

  it.each([
    ['has no tariff', null],
    ['is overdue with its tariff', { status: 'past_due' }],
  ])('refuses a customer who %s in the words of the customer', async (_case, subscription) => {
    // The checkout of @repo/billing itself: the pack is on sale, the tariff does not take tasks.
    const { prisma, db } = fakeDb()
    db.plan.findFirst.mockResolvedValue(pack())
    db.subscription.findFirst.mockResolvedValue(subscription)

    await expect(createCaller(context(prisma)).billing.startPackCheckout({})).rejects.toMatchObject(
      {
        code: 'CONFLICT',
        message: NEEDS_TARIFF,
        cause: { code: 'BILLING_PACK_NEEDS_SUBSCRIPTION' },
      },
    )
    // The pack on sale, and the subscription of the personal workspace of this user.
    expect(db.plan.findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { kind: 'pack', isActive: true } }),
    )
    expect(db.subscription.findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WORKSPACE }) }),
    )
  })

  it('answers that no pack is sold when none is on sale', async () => {
    const { prisma, db } = fakeDb()

    await expect(createCaller(context(prisma)).billing.startPackCheckout({})).rejects.toMatchObject(
      { code: 'NOT_FOUND', cause: { code: 'BILLING_PLAN_NOT_FOUND' } },
    )
    expect(db.workspace.findFirst).not.toHaveBeenCalled()
  })
})

describe('billing.syncOrder', () => {
  const orderId = randomUUID()
  const paid = (): OrderSyncDto => {
    const plan = business()
    return {
      orderId,
      status: 'paid',
      kind: 'subscription',
      planName: plan.name,
      packCredits: null,
      amount: '12900.00',
      failureText: null,
      refundNeeded: false,
      subscription: {
        id: randomUUID(),
        status: 'active',
        plan: planDto(plan) as NonNullable<OrderSyncDto['subscription']>['plan'],
        period: { start: new Date(PAID_AT), end: new Date('2026-11-04T09:00:00.000Z') },
        autoRenewal: false,
        nextPlan: null,
        paymentMethod: null,
        pastDueSince: null,
      },
    }
  }

  it('reads the order of the signed-in user back through the shop of the context', async () => {
    const { prisma } = fakeDb()
    const { billing } = shopStub()
    const order = paid()
    sync.mockResolvedValueOnce(order)

    expect(await createCaller(context(prisma, { billing })).billing.syncOrder({ orderId })).toEqual(
      order,
    )
    expect(sync).toHaveBeenCalledExactlyOnceWith(
      { prisma, yookassa: billing.yookassa, appUrl: APP_URL, appEnv: 'test', autopayments: true },
      { userId: user.id, orderId },
    )
  })

  it('shows a failed order with the sentence for the customer', async () => {
    const { prisma } = fakeDb()
    const failed: OrderSyncDto = {
      ...paid(),
      status: 'failed',
      failureText: 'Банк отклонил платёж. Выберите другой способ оплаты или обратитесь в банк.',
      subscription: null,
    }
    sync.mockResolvedValueOnce(failed)

    expect(await createCaller(context(prisma)).billing.syncOrder({ orderId })).toEqual(failed)
  })

  it('refuses while payments are off and asks nothing', async () => {
    const { prisma, db } = fakeDb()

    await expect(
      createCaller(context(prisma, { billing: null })).billing.syncOrder({ orderId }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'BILLING_PAYMENTS_NOT_CONFIGURED' },
    })
    expect(sync).not.toHaveBeenCalled()
    expect(db.workspace.findFirst).not.toHaveBeenCalled()
  })

  it.each([{}, { orderId: 'order-1' }, { orderId, userId: randomUUID() }, { orderId, paid: true }])(
    'rejects an order id that is not one, and anything beside it: %o',
    async (input) => {
      const { prisma } = fakeDb()
      await expect(
        createCaller(context(prisma)).billing.syncOrder(input as { orderId: string }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(sync).not.toHaveBeenCalled()
    },
  )

  it('answers «not found» for a user without a workspace', async () => {
    // syncOrder of @repo/billing itself: no personal workspace, so the order is not theirs.
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(null)

    await expect(
      createCaller(context(prisma)).billing.syncOrder({ orderId }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Не нашли такой заказ. Проверьте ссылку или откройте «Тарифы» в настройках',
      cause: { code: 'BILLING_ORDER_NOT_FOUND' },
    })
  })
})

describe('billing over HTTP', () => {
  interface ErrorBody {
    error: { json: { message: string; data: { code: string; domainCode: string | null } } }
  }

  const call = (path: string, ctx: Context, input?: unknown) =>
    fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request(
        `http://localhost:3000/api/trpc/${path}`,
        input === undefined
          ? undefined
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ json: input }),
            },
      ),
      router: appRouter,
      createContext: () => ctx,
    })

  const shopRefused = () => {
    const error = billingPaymentsNotConfigured()
    error.cause = new YookassaApiError(
      'invalid_credentials: Incorrect shopId or secret key',
      401,
      'invalid_credentials',
      {},
    )
    return error
  }

  it.each<[string, () => DomainError, number, string, string]>([
    [
      'payments switched off or the shop out of reach',
      shopRefused,
      503,
      'SERVICE_UNAVAILABLE',
      'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
    ],
    [
      'a tariff that is not sold',
      billingPlanNotFound,
      404,
      'NOT_FOUND',
      'Этот тариф сейчас не продаётся. Обновите страницу и выберите другой',
    ],
    [
      'a tariff that is already on',
      billingSubscriptionExists,
      409,
      'CONFLICT',
      'Тариф уже оформлен. Обновите страницу, чтобы увидеть его',
    ],
    [
      'more sites than the tariff allows',
      billingPlanSiteLimit,
      409,
      'CONFLICT',
      'У вас больше сайтов, чем входит в этот тариф. Выберите тариф, в который они помещаются',
    ],
    [
      'a payment declined at once',
      billingPaymentDeclined,
      402,
      'PAYMENT_REQUIRED',
      'Платёж не прошёл. Попробуйте ещё раз или выберите другой способ оплаты',
    ],
    [
      'a payment that is still being processed',
      billingPaymentInProgress,
      409,
      'CONFLICT',
      'Предыдущий платёж ещё обрабатывается. Подождите пару минут и обновите страницу',
    ],
    [
      'a checkout that other requests of the customer kept changing',
      () => conflict('The checkout of the workspace was changed by other requests; try again'),
      409,
      'CONFLICT',
      'Действие сейчас недоступно',
    ],
  ])(
    'tells the browser about %s in Russian only',
    async (_case, refusal, status, code, message) => {
      const error = refusal()
      checkout.mockRejectedValueOnce(error)

      const response = await call('billing.startCheckout', context(fakeDb().prisma), checkoutInput)

      expect(response.status).toBe(status)
      const body = (await response.json()) as ErrorBody
      expect(body.error.json.message).toBe(message)
      expect(body.error.json.message).not.toMatch(/[A-Za-z]/)
      expect(body.error.json.data).toMatchObject({ code, domainCode: error.code })
      // Neither the English message of the domain nor what the shop said leaves the server.
      expect(JSON.stringify(body)).not.toContain(error.message)
      expect(JSON.stringify(body)).not.toContain('invalid_credentials')
    },
  )

  it('tells the browser that a pack needs a tariff, in Russian only', async () => {
    const error = billingPackNeedsSubscription()
    packCheckout.mockRejectedValueOnce(error)

    const response = await call('billing.startPackCheckout', context(fakeDb().prisma), {})

    expect(response.status).toBe(409)
    const body = (await response.json()) as ErrorBody
    expect(body.error.json.message).toBe(
      'Пакет кредитов можно купить только при действующем тарифе. Сначала оформите или оплатите тариф',
    )
    expect(body.error.json.message).not.toMatch(/[A-Za-z]/)
    expect(body.error.json.data).toMatchObject({
      code: 'CONFLICT',
      domainCode: 'BILLING_PACK_NEEDS_SUBSCRIPTION',
    })
    expect(JSON.stringify(body)).not.toContain(error.message)
  })

  it('tells the browser that the order was not found, whoever owns it', async () => {
    const error = billingOrderNotFound()
    sync.mockRejectedValueOnce(error)

    const response = await call('billing.syncOrder', context(fakeDb().prisma), {
      orderId: randomUUID(),
    })

    expect(response.status).toBe(404)
    const body = (await response.json()) as ErrorBody
    expect(body.error.json.message).toBe(
      'Не нашли такой заказ. Проверьте ссылку или откройте «Тарифы» в настройках',
    )
    expect(body.error.json.data).toMatchObject({
      code: 'NOT_FOUND',
      domainCode: 'BILLING_ORDER_NOT_FOUND',
    })
    expect(JSON.stringify(body)).not.toContain(error.message)
  })

  it('keeps a failure of the shop that is not the customer’s internal', async () => {
    sync.mockRejectedValueOnce(new YookassaError('Unexpected YooKassa response'))

    const response = await call('billing.syncOrder', context(fakeDb().prisma), {
      orderId: randomUUID(),
    })

    expect(response.status).toBe(500)
    const body = (await response.json()) as ErrorBody
    expect(body.error.json.message).toBe(INTERNAL_ERROR_MESSAGE)
    expect(body.error.json.data.domainCode).toBeNull()
    expect(JSON.stringify(body)).not.toContain('YooKassa')
  })

  it('sends money as strings and moments as dates', async () => {
    const { prisma, db } = fakeDb()
    db.subscription.findFirst.mockResolvedValue(subscriptionRow(business()))

    const response = await call('billing.overview', context(prisma))

    expect(response.status).toBe(200)
    const { result } = (await response.json()) as {
      result: { data: { json: unknown; meta: { values: Record<string, unknown> } } }
    }
    expect(result.data.json).toMatchObject({
      paymentsEnabled: true,
      subscription: {
        plan: { price: '12900.00' },
        period: { start: '2026-09-18T09:00:00.000Z', end: '2026-10-18T09:00:00.000Z' },
      },
    })
    // superjson marks the dates, so the client gets Date objects back.
    expect(result.data.meta.values).toMatchObject({
      'subscription.period.start': ['Date'],
      'subscription.period.end': ['Date'],
    })
  })
})

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL billing through the router', () => {
  let db: PrismaClient
  const userIds: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    // Orders, subscriptions and billing accounts hold their workspace with Restrict keys, and
    // the ledger holds the accounts and the orders: what refers goes first.
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

  /** A user who accepted the documents and has no workspace yet, with a shop of their own. */
  async function account() {
    const owner = await db.user.create({
      data: { name: 'Billing verification', email: `${randomUUID()}@billing-router.example.ru` },
    })
    userIds.push(owner.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({
        ...consent,
        userId: owner.id,
        source: 'sign_up',
      })),
    })
    const shop = shopStub()
    const caller = createCaller(context(db, { currentUser: owner, billing: shop.billing }))
    return { user: owner, caller, shop }
  }

  /**
   * A tariff of the seeds (`pnpm db:seed`). The tests put no tariff of their own on sale: a
   * suite of another package that lists the tariffs of the same database would see them come
   * and go.
   */
  async function seeded(slug: 'start' | 'business') {
    const plan = await db.plan.findFirst({ where: { slug, kind: 'quota', isActive: true } })
    if (plan === null || plan.maxSites === null || plan.creditsPerMonth === null) {
      throw new Error(`The tariff «${slug}» is not on sale in this database: apply the seeds`)
    }
    const { maxSites, creditsPerMonth } = plan
    const dto = {
      id: plan.id,
      slug,
      name: plan.name,
      price: plan.price.toFixed(2),
      creditsPerMonth,
      tasksPerDay: plan.tasksPerDay,
      maxSites,
    }
    return { ...plan, maxSites, creditsPerMonth, dto }
  }

  const site = (name: string) =>
    ({ name, url: `https://${randomUUID()}.example.ru`, stack: 'wordpress' }) as const

  it('marks the too-small tariff for a workspace with two sites', async () => {
    const { user: owner, caller } = await account()
    // «Старт» takes one site, «Бизнес» three.
    const small = await seeded('start')
    const roomy = await seeded('business')
    const sites = small.maxSites + 1
    expect(sites).toBe(2)
    expect(roomy.maxSites).toBeGreaterThanOrEqual(sites)
    const listed = async () => {
      const list = await caller.billing.plans()
      const find = (slug: string) => list.plans.find((plan) => plan.slug === slug)
      return { list, small: find(small.slug), roomy: find(roomy.slug) }
    }

    // Before the first site there is no workspace: nothing to count, and reading makes none.
    // The gift of the registration is shown as promised, and nothing is written for it.
    const before = await listed()
    expect(before.list.siteCount).toBe(0)
    expect(before.small).toEqual({ ...small.dto, fitsSites: true, current: false })
    expect(await caller.billing.overview()).toEqual({
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      subscription: null,
      // The database of the tests has no credit rate: no task is taken, and the page says so.
      credits: { ...promisedCredits, newTask: NO_RATE },
      ...noWaits,
    })
    expect(await db.workspace.count({ where: { createdById: owner.id } })).toBe(0)
    expect(
      await db.creditLedger.count({ where: { idempotencyKey: `user:${owner.id}:signup-gift` } }),
    ).toBe(0)

    await caller.project.create(site('Первый'))
    // The first site made the workspace and kept the promise: the same credits, now granted.
    const granted = { ...promisedCredits, gift: giftGranted, newTask: NO_RATE }
    expect((await caller.billing.overview()).credits).toEqual(granted)
    await caller.project.create(site('Второй'))
    expect((await caller.billing.overview()).credits).toEqual(granted)

    const after = await listed()
    expect(after.list.siteCount).toBe(sites)
    expect(after.small).toEqual({ ...small.dto, fitsSites: false, current: false })
    expect(after.roomy).toEqual({ ...roomy.dto, fitsSites: true, current: false })
    // Whatever else is on sale in this database is judged by the same count.
    const sitesFit = (maxSites: number) => maxSites >= sites
    expect(after.list.plans.filter((plan) => plan.fitsSites !== sitesFit(plan.maxSites))).toEqual(
      [],
    )

    // The checkout refuses by the same count, and the roomy tariff can be paid for.
    await expect(
      caller.billing.startCheckout({ planSlug: small.slug, autoRenew: false }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'У вас больше сайтов, чем входит в этот тариф. Выберите тариф, в который они помещаются',
      cause: { code: 'BILLING_PLAN_SITE_LIMIT' },
    })
    await expect(
      caller.billing.startCheckout({ planSlug: roomy.slug, autoRenew: false }),
    ).resolves.toMatchObject({ orderId: expect.any(String) })
  })

  it('at a shop that takes one-time payments only, refuses the consent and sells the tariff without it', async () => {
    const { user: owner, shop } = await account()
    const plan = await seeded('start')
    const createPayment = vi.spyOn(shop.billing.yookassa, 'createPayment')
    const caller = createCaller(
      context(db, { currentUser: owner, billing: { ...shop.billing, autopayments: false } }),
    )
    const unavailable = {
      code: 'CONFLICT',
      message: 'Автопродление пока недоступно. Оформите тариф без него: он будет действовать месяц',
      cause: { code: 'BILLING_AUTO_RENEWAL_UNAVAILABLE' },
    }

    // The pages are told before the customer chooses anything.
    expect(await caller.billing.overview()).toMatchObject({
      paymentsEnabled: true,
      autoRenewalAvailable: false,
    })
    expect(await caller.billing.plans()).toMatchObject({ autoRenewalAvailable: false })

    await expect(
      caller.billing.startCheckout({ planSlug: plan.slug, autoRenew: true }),
    ).rejects.toMatchObject(unavailable)
    // The shop was not asked and nothing was written: not even the workspace.
    expect(createPayment).not.toHaveBeenCalled()
    expect(await db.workspace.count({ where: { createdById: owner.id } })).toBe(0)

    const started = await caller.billing.startCheckout({ planSlug: plan.slug, autoRenew: false })
    expect(createPayment).toHaveBeenCalledTimes(1)
    // The field is left out: `false` would be a field as well.
    expect(createPayment.mock.calls[0]?.[0]).not.toHaveProperty('save_payment_method')
    const [payment] = [...shop.payments.values()]
    shop.pay(payment!.id)

    expect(await caller.billing.syncOrder({ orderId: started.orderId })).toMatchObject({
      status: 'paid',
      subscription: { status: 'active', autoRenewal: false, paymentMethod: null },
    })
    // The tariff lasts its month: no card is bound to it and auto-renewal is not switched on.
    await expect(caller.billing.startPaymentMethodChange({})).rejects.toMatchObject(unavailable)
    await expect(caller.billing.resumeAutoRenew({})).rejects.toMatchObject(unavailable)
    expect(createPayment).toHaveBeenCalledTimes(1)
    const workspace = await db.workspace.findFirstOrThrow({ where: { createdById: owner.id } })
    expect(
      await db.subscription.findFirstOrThrow({ where: { workspaceId: workspace.id } }),
    ).toMatchObject({
      cancelAtPeriodEnd: true,
      paymentMethodId: null,
      pendingPaymentMethodId: null,
    })
  })

  it('activates the tariff by startCheckout and syncOrder, and overview shows it', async () => {
    const { user: owner, caller, shop } = await account()
    const plan = await seeded('start')

    const started = await caller.billing.startCheckout({ planSlug: plan.slug, autoRenew: false })
    const [payment] = [...shop.payments.values()]
    expect(started).toEqual({
      orderId: expect.any(String),
      confirmationUrl: `https://yookassa.example/${payment!.id}`,
    })
    expect(payment!.amount).toEqual({ value: plan.dto.price, currency: 'RUB' })
    // The customer comes back to the return page of this order on the app's own origin.
    expect(shop.returnUrls).toEqual([`${APP_URL}/settings/billing/return?order=${started.orderId}`])

    // Not paid yet: the order waits, no tariff.
    expect(await caller.billing.syncOrder({ orderId: started.orderId })).toMatchObject({
      status: 'pending',
      subscription: null,
    })
    expect((await caller.billing.overview()).subscription).toBeNull()

    shop.pay(payment!.id)
    const paid = await caller.billing.syncOrder({ orderId: started.orderId })

    expect(paid).toEqual({
      orderId: started.orderId,
      status: 'paid',
      kind: 'subscription',
      planName: plan.name,
      packCredits: null,
      amount: plan.dto.price,
      failureText: null,
      refundNeeded: false,
      subscription: {
        id: expect.any(String),
        status: 'active',
        plan: plan.dto,
        // A month by Moscow time from the moment of the payment.
        period: { start: new Date(PAID_AT), end: new Date('2026-11-04T09:00:00.000Z') },
        // The box was not ticked: nothing is saved, the tariff ends with the period.
        autoRenewal: false,
        nextPlan: null,
        paymentMethod: null,
        pastDueSince: null,
      },
    })
    const quota = plan.creditsPerMonth
    const overview = await caller.billing.overview()
    expect(overview).toEqual({
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      subscription: paid.subscription,
      // The quota of the tariff beside the gift the checkout granted with the workspace.
      credits: {
        tariff: { balance: quota, held: 0, available: quota },
        gift: giftGranted,
        pack: { balance: 0, held: 0, available: 0 },
        totalAvailable: quota + 35,
        spendable: quota + 35,
        setAside: 0,
        minToStart: 5,
        today: { used: 0, limit: plan.tasksPerDay },
        newTask: NO_RATE,
      },
      ...noWaits,
    })
    const { plans } = await caller.billing.plans()
    expect(plans.filter(({ current }) => current)).toEqual([
      { ...plan.dto, fitsSites: true, current: true },
    ])

    // Asking again changes nothing: one subscription, one grant of the quota — and the one
    // grant of the gift, which the checkout made with the workspace.
    expect(await caller.billing.syncOrder({ orderId: started.orderId })).toEqual(paid)
    expect(await caller.billing.overview()).toEqual(overview)
    const workspace = await db.workspace.findFirstOrThrow({ where: { createdById: owner.id } })
    expect(await db.subscription.count({ where: { workspaceId: workspace.id } })).toBe(1)
    const ledger = await db.creditLedger.findMany({
      where: { account: { workspaceId: workspace.id } },
      select: { unit: true, kind: true, orderId: true, idempotencyKey: true },
    })
    expect(ledger).toHaveLength(2)
    expect(ledger).toEqual(
      expect.arrayContaining([
        {
          unit: 'credit_tariff',
          kind: 'grant',
          orderId: started.orderId,
          idempotencyKey: `order:${started.orderId}:grant`,
        },
        {
          unit: 'credit_gift',
          kind: 'grant',
          orderId: null,
          idempotencyKey: `user:${owner.id}:signup-gift`,
        },
      ]),
    )

    // The tariff is on: it is not bought a second time.
    await expect(
      caller.billing.startCheckout({ planSlug: plan.slug, autoRenew: true }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Тариф уже оформлен. Обновите страницу, чтобы увидеть его',
      cause: { code: 'BILLING_SUBSCRIPTION_EXISTS' },
    })
    expect(shop.payments.size).toBe(1)

    // With payments switched off the same workspace is read, and nothing is paid for.
    const off = createCaller(context(db, { currentUser: owner, billing: null })).billing
    expect(await off.overview()).toEqual({
      ...overview,
      paymentsEnabled: false,
      autoRenewalAvailable: false,
    })
    await expect(off.syncOrder({ orderId: started.orderId })).rejects.toMatchObject({
      cause: { code: 'BILLING_PAYMENTS_NOT_CONFIGURED' },
    })
  })

  it('sells the pack on top of an active tariff and adds its credits beside the quota', async () => {
    const { user: owner, caller, shop } = await account()
    const plan = await seeded('start')
    const { pack } = await caller.billing.plans()
    if (pack === null)
      throw new Error('No credit pack is on sale in this database: apply the seeds')
    const needsTariff = {
      code: 'CONFLICT',
      message:
        'Пакет кредитов можно купить только при действующем тарифе. Сначала оформите или оплатите тариф',
      cause: { code: 'BILLING_PACK_NEEDS_SUBSCRIPTION' },
    }

    // No tariff, no pack: nothing is asked of the shop, and no workspace is made for the try.
    await expect(caller.billing.startPackCheckout({})).rejects.toMatchObject(needsTariff)
    expect(shop.payments.size).toBe(0)
    expect(await db.workspace.count({ where: { createdById: owner.id } })).toBe(0)

    const tariff = await caller.billing.startCheckout({ planSlug: plan.slug, autoRenew: false })
    // The tariff is not paid yet: still no pack.
    await expect(caller.billing.startPackCheckout({})).rejects.toMatchObject(needsTariff)
    shop.pay([...shop.payments.keys()][0]!)
    const { subscription } = await caller.billing.syncOrder({ orderId: tariff.orderId })
    expect(subscription).toMatchObject({ status: 'active' })

    const started = await caller.billing.startPackCheckout({})

    const payment = [...shop.payments.values()][1]!
    expect(started).toEqual({
      orderId: expect.any(String),
      confirmationUrl: `https://yookassa.example/${payment.id}`,
    })
    expect(started.orderId).not.toBe(tariff.orderId)
    // The price of the pack on sale, and the return page of the pack order.
    expect(payment.amount).toEqual({ value: pack.price, currency: 'RUB' })
    expect(shop.returnUrls[1]).toBe(`${APP_URL}/settings/billing/return?order=${started.orderId}`)
    const waiting = {
      orderId: started.orderId,
      status: 'pending',
      kind: 'pack',
      planName: pack.name,
      packCredits: pack.credits,
      amount: pack.price,
      failureText: null,
      refundNeeded: false,
      subscription: null,
    }
    expect(await caller.billing.syncOrder({ orderId: started.orderId })).toEqual(waiting)
    const quota = plan.creditsPerMonth
    expect((await caller.billing.overview()).credits.totalAvailable).toBe(quota + 35)

    shop.pay(payment.id)
    const paid = await caller.billing.syncOrder({ orderId: started.orderId })

    expect(paid).toEqual({ ...waiting, status: 'paid', subscription })
    const overview = await caller.billing.overview()
    expect(overview).toEqual({
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      // The tariff is as it was: a pack saves no payment method and moves no period.
      subscription,
      credits: {
        tariff: { balance: quota, held: 0, available: quota },
        gift: giftGranted,
        pack: { balance: pack.credits, held: 0, available: pack.credits },
        totalAvailable: quota + 35 + pack.credits,
        spendable: quota + 35 + pack.credits,
        setAside: 0,
        minToStart: 5,
        today: { used: 0, limit: plan.tasksPerDay },
        newTask: NO_RATE,
      },
      ...noWaits,
    })

    // Asking again changes nothing: one grant of the quota, one of the pack.
    expect(await caller.billing.syncOrder({ orderId: started.orderId })).toEqual(paid)
    expect(await caller.billing.overview()).toEqual(overview)
    const workspace = await db.workspace.findFirstOrThrow({ where: { createdById: owner.id } })
    const ledger = await db.creditLedger.findMany({
      where: { account: { workspaceId: workspace.id } },
      select: { unit: true, kind: true, orderId: true },
    })
    // And the gift of the registration, which no order paid for.
    expect(ledger).toHaveLength(3)
    expect(ledger).toEqual(
      expect.arrayContaining([
        { unit: 'credit_tariff', kind: 'grant', orderId: tariff.orderId },
        { unit: 'credit_gift', kind: 'grant', orderId: null },
        { unit: 'credit_pack', kind: 'grant', orderId: started.orderId },
      ]),
    )
  })

  it('gives one workspace and one gift to a first site and a first checkout that race', async () => {
    const { user: owner, caller } = await account()
    const plan = await seeded('business')

    // The two requests that may each make the personal workspace, several of each at once.
    const results = await Promise.all([
      caller.project.create(site('Первый')),
      caller.billing.startCheckout({ planSlug: plan.slug, autoRenew: false }),
      caller.project.create(site('Второй')),
      caller.billing.startCheckout({ planSlug: plan.slug, autoRenew: false }),
    ])

    expect(results).toHaveLength(4)
    const workspaces = await db.workspace.findMany({
      where: { createdById: owner.id },
      select: { id: true },
    })
    expect(workspaces).toHaveLength(1)
    const workspaceId = workspaces[0]!.id
    // The sites and the order of the checkouts ended in it.
    expect(await db.site.count({ where: { workspaceId } })).toBe(2)
    expect(await db.order.count({ where: { workspaceId } })).toBe(1)
    // One gift, on its gift account, with one audit entry — and the page shows it.
    const gift = await db.creditLedger.findMany({
      where: { idempotencyKey: `user:${owner.id}:signup-gift` },
      include: { account: { select: { workspaceId: true, unit: true } } },
    })
    expect(gift).toHaveLength(1)
    expect(gift[0]).toMatchObject({
      kind: 'grant',
      orderId: null,
      account: { workspaceId, unit: 'credit_gift' },
    })
    expect(gift[0]!.amount.toFixed(2)).toBe('35.00')
    expect(await db.creditLedger.count({ where: { account: { workspaceId } } })).toBe(1)
    expect(await db.auditLog.count({ where: { workspaceId, action: 'billing.gift.grant' } })).toBe(
      1,
    )
    expect((await caller.billing.overview()).credits).toEqual({
      ...promisedCredits,
      gift: giftGranted,
      newTask: NO_RATE,
    })
  })

  it('answers «not found» for an order of another user', async () => {
    const first = await account()
    const stranger = await account()
    const neighbour = await account()
    const plan = await seeded('start')
    const { orderId } = await first.caller.billing.startCheckout({
      planSlug: plan.slug,
      autoRenew: false,
    })
    // One stranger has no workspace, the other has a workspace and an order of their own.
    const own = await neighbour.caller.billing.startCheckout({
      planSlug: plan.slug,
      autoRenew: false,
    })
    const notFound = {
      code: 'NOT_FOUND',
      message: 'Не нашли такой заказ. Проверьте ссылку или откройте «Тарифы» в настройках',
      cause: { code: 'BILLING_ORDER_NOT_FOUND' },
    }

    await expect(stranger.caller.billing.syncOrder({ orderId })).rejects.toMatchObject(notFound)
    await expect(neighbour.caller.billing.syncOrder({ orderId })).rejects.toMatchObject(notFound)
    // An order nobody has reads the same: the answer does not tell them apart.
    await expect(first.caller.billing.syncOrder({ orderId: randomUUID() })).rejects.toMatchObject(
      notFound,
    )

    // Nobody's shop was asked about the order, and it is still its owner's to pay.
    expect([...stranger.shop.reads, ...neighbour.shop.reads]).toEqual([])
    expect(await db.workspace.count({ where: { createdById: stranger.user.id } })).toBe(0)
    expect(await first.caller.billing.syncOrder({ orderId })).toMatchObject({
      orderId,
      status: 'pending',
    })
    expect(await neighbour.caller.billing.syncOrder({ orderId: own.orderId })).toMatchObject({
      orderId: own.orderId,
      status: 'pending',
    })
  })
})
