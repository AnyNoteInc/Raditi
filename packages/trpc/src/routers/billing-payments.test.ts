import { randomUUID } from 'node:crypto'

import type * as BillingModule from '@repo/billing'
import {
  listPayments,
  paymentLetterKey,
  paymentMethodAuditActions,
  renewalKey,
  startPaymentMethodChange,
  syncPaymentMethod,
  unlinkPaymentMethod,
  type PaymentDto,
  type PaymentMethodSyncDto,
  type PaymentsPageDto,
} from '@repo/billing'
import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import {
  billingNoLiveSubscription,
  billingNothingToChange,
  billingPaymentsNotConfigured,
  legalDocuments,
  type DomainError,
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

// «Настройки → Оплата» through the router: the payment history and the saved payment method.
// The functions of @repo/billing are wrapped: they run as they are — the PostgreSQL block works
// through them — unless a test scripts the next answer.
vi.mock('@repo/billing', async (importOriginal) => {
  const original = await importOriginal<typeof BillingModule>()
  return {
    ...original,
    listPayments: vi.fn(original.listPayments),
    startPaymentMethodChange: vi.fn(original.startPaymentMethodChange),
    syncPaymentMethod: vi.fn(original.syncPaymentMethod),
    unlinkPaymentMethod: vi.fn(original.unlinkPaymentMethod),
  }
})
const payments = vi.mocked(listPayments)
const startChange = vi.mocked(startPaymentMethodChange)
const syncMethod = vi.mocked(syncPaymentMethod)
const unlink = vi.mocked(unlinkPaymentMethod)

const NOW = new Date('2026-10-04T12:00:00.000Z')
const PAID_AT = '2026-10-04T09:00:00.000Z'
const APP_URL = 'https://raditi.example'
const WORKSPACE = '0199a000-0000-7000-8000-0000000000d1'
const NBSP = String.fromCharCode(0xa0)

const user: User = {
  id: randomUUID(),
  name: 'Анна Ковалёва',
  lastName: null,
  email: 'payments-test@example.ru',
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
  payments.mockReset()
  startChange.mockReset()
  syncMethod.mockReset()
  unlink.mockReset()
})

const MIR = { first6: '220000', last4: '4444', card_type: 'Mir' }
const VISA = { first6: '411111', last4: '1234', card_type: 'Visa' }

/**
 * ЮKassa in memory: a payment and a binding wait on their pages until the test finishes them,
 * a repeated Idempotence-Key answers with the object of the first request.
 */
function shopStub() {
  const paymentsById = new Map<string, Payment>()
  const methods = new Map<string, SavedPaymentMethod>()
  const idByKey = new Map<string, string>()
  const unused = () => Promise.reject(new Error('The payment procedures do not make this call'))
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
      pastDueDays: 7,
    } satisfies BillingContext,
    methods,
    /** The customer paid; `saved`: ЮKassa saved the «Мир» card they paid with. */
    pay({ saved = false } = {}) {
      const payment = waiting(paymentsById)
      payment.status = 'succeeded'
      payment.paid = true
      payment.captured_at = PAID_AT
      delete payment.confirmation
      payment.payment_method = {
        id: payment.id,
        type: 'bank_card',
        saved,
        title: 'Bank card *4444',
        card: { ...MIR },
      }
      return payment.id
    },
    /** The bank declined the payment. */
    decline(reason: string) {
      const payment = waiting(paymentsById)
      payment.status = 'canceled'
      delete payment.confirmation
      payment.cancellation_details = { party: 'payment_network', reason }
    },
    /** The customer confirmed the binding with a Visa card. */
    bind() {
      const method = waiting(methods)
      method.status = 'active'
      method.saved = true
      method.title = 'Bank card *1234'
      method.card = { ...VISA }
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
          token: 'payments-test-session',
          expiresAt: new Date('2030-01-01'),
          createdAt: NOW,
          updatedAt: NOW,
        }
      : null,
    billing,
  }
}

/** The tables the procedures read before they call @repo/billing, answering from the test. */
function fakeDb() {
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    workspace: {
      findFirst: vi.fn<() => Promise<{ id: string } | null>>().mockResolvedValue({ id: WORKSPACE }),
    },
  }
  return { db, prisma: db as unknown as PrismaClient }
}

const payment = (patch: Partial<PaymentDto> = {}): PaymentDto => ({
  id: randomUUID(),
  kind: 'subscription',
  planName: 'Бизнес',
  period: { start: new Date('2026-09-18T09:00:00Z'), end: new Date('2026-10-18T09:00:00Z') },
  amount: '12900.00',
  status: 'paid',
  failureReason: null,
  failureText: null,
  refundedAmount: null,
  refundedAt: null,
  paidAt: new Date('2026-09-18T09:00:05Z'),
  createdAt: new Date('2026-09-18T09:00:00Z'),
  ...patch,
})
const noPage: PaymentsPageDto = { items: [], nextCursor: null }
const nothingBound: PaymentMethodSyncDto = {
  state: 'none',
  renewalCharge: 'none',
  subscription: null,
}
/** The answer of an unlink that left no renewal charge under way. */
const unlinkedClean = { unlinked: true, renewalCharge: 'none' }

const consented = ['payments', 'startPaymentMethodChange', 'syncPaymentMethod'] as const
const procedures = [...consented, 'unlinkPaymentMethod'] as const

const untouched = () => {
  expect(payments).not.toHaveBeenCalled()
  expect(startChange).not.toHaveBeenCalled()
  expect(syncMethod).not.toHaveBeenCalled()
  expect(unlink).not.toHaveBeenCalled()
}

describe('access to the payment procedures', () => {
  it.each(procedures)('requires a session before %s reads anything', async (name) => {
    const { prisma, db } = fakeDb()
    const call = createCaller(context(prisma, { currentUser: null })).billing[name] as (
      input?: unknown,
    ) => Promise<unknown>

    await expect(call({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

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

    await expect(call({})).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' })

    expect(db.workspace.findFirst).not.toHaveBeenCalled()
    untouched()
  })

  it('lets a user who has not accepted the documents unlink the payment method', async () => {
    const { prisma, db } = fakeDb()
    db.userConsent.findMany.mockResolvedValue([])
    unlink.mockResolvedValueOnce({ renewalCharge: 'none' })

    await expect(createCaller(context(prisma)).billing.unlinkPaymentMethod({})).resolves.toEqual(
      unlinkedClean,
    )

    // The consents are not even asked for: stopping the charges does not depend on them.
    expect(db.userConsent.findMany).not.toHaveBeenCalled()
    expect(unlink).toHaveBeenCalledTimes(1)
  })
})

describe('billing.payments', () => {
  const cursor = randomUUID()

  it('reads a page of the history of the personal workspace', async () => {
    const { prisma, db } = fakeDb()
    const page: PaymentsPageDto = {
      items: [
        payment(),
        payment({
          status: 'failed',
          failureReason: 'general_decline',
          failureText: 'Банк отклонил платёж. Выберите другой способ оплаты или обратитесь в банк.',
          period: null,
          paidAt: null,
        }),
      ],
      nextCursor: randomUUID(),
    }
    payments.mockResolvedValueOnce(page)

    expect(await createCaller(context(prisma)).billing.payments({})).toEqual(page)
    // The first page, of the size the page of the settings shows.
    expect(payments).toHaveBeenCalledExactlyOnceWith(prisma, WORKSPACE, { limit: 20 })
    // The personal workspace of this user, by the rule of project.create.
    expect(db.workspace.findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdById: user.id, dataClass: 'synthetic' }),
      }),
    )
  })

  it('passes the cursor and the size of a page it was asked for', async () => {
    const { prisma } = fakeDb()
    payments.mockResolvedValue(noPage)
    const caller = createCaller(context(prisma)).billing

    await caller.payments({ cursor })
    await caller.payments({ cursor, limit: 50 })

    expect(payments.mock.calls.map(([, , query]) => query)).toEqual([
      { cursor, limit: 20 },
      { cursor, limit: 50 },
    ])
  })

  it('gives an empty page to a user without a workspace and reads no further', async () => {
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(null)

    expect(await createCaller(context(prisma)).billing.payments({})).toEqual(noPage)
    expect(payments).not.toHaveBeenCalled()
  })

  it('shows the history while payments are off', async () => {
    const { prisma } = fakeDb()
    const page: PaymentsPageDto = { items: [payment()], nextCursor: null }
    payments.mockResolvedValueOnce(page)

    expect(await createCaller(context(prisma, { billing: null })).billing.payments({})).toEqual(
      page,
    )
  })

  it.each([
    undefined,
    { cursor: 'last' },
    { limit: 0 },
    { limit: 101 },
    { limit: 2.5 },
    { cursor, workspaceId: WORKSPACE },
    { userId: randomUUID() },
  ])(
    'rejects a query that is not a cursor and a size, or names whose history it is: %o',
    async (input) => {
      const { prisma, db } = fakeDb()
      await expect(
        createCaller(context(prisma)).billing.payments(input as { cursor: string }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(db.workspace.findFirst).not.toHaveBeenCalled()
      expect(payments).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['money that is not a decimal string', { amount: '12900' }],
    ['a status of its own', { status: 'succeeded' as 'paid' }],
    ['a failed order without its sentence', { failureText: '' }],
  ])('does not show a page its schema does not describe: %s', async (_case, spoiled) => {
    const { prisma } = fakeDb()
    payments.mockResolvedValueOnce({ items: [payment(spoiled)], nextCursor: null })

    await expect(createCaller(context(prisma)).billing.payments({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    })
  })
})

const refusals: [string, () => DomainError, string, string][] = [
  [
    'no live tariff',
    billingNoLiveSubscription,
    'CONFLICT',
    'У вас нет действующего тарифа. Обновите страницу, чтобы увидеть, что изменилось',
  ],
  [
    'a shop that did not take the request',
    billingPaymentsNotConfigured,
    'SERVICE_UNAVAILABLE',
    'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
  ],
]

describe('billing.startPaymentMethodChange', () => {
  it('starts a binding for the user through the shop of the context', async () => {
    const { prisma } = fakeDb()
    const { billing } = shopStub()
    startChange.mockResolvedValueOnce({ confirmationUrl: 'https://yookassa.example/bind/1' })

    expect(
      await createCaller(context(prisma, { billing })).billing.startPaymentMethodChange({}),
    ).toEqual({ confirmationUrl: 'https://yookassa.example/bind/1' })

    expect(startChange).toHaveBeenCalledExactlyOnceWith(
      { prisma, yookassa: billing.yookassa, appUrl: APP_URL, appEnv: 'test', autopayments: true },
      { userId: user.id },
    )
    // The very client of the process, not a copy.
    expect(startChange.mock.calls[0]?.[0].yookassa).toBe(billing.yookassa)
  })

  it.each([
    undefined,
    { userId: randomUUID() },
    { type: 'sbp' },
    { returnUrl: 'https://evil.example' },
  ])('takes no input but the empty object: %o', async (input) => {
    const { prisma } = fakeDb()
    await expect(
      createCaller(context(prisma)).billing.startPaymentMethodChange(input as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(startChange).not.toHaveBeenCalled()
  })

  it('is refused at a shop that takes one-time payments only, before anything is read', async () => {
    // `startPaymentMethodChange` of @repo/billing itself, given the switch of the shop.
    const { prisma, db } = fakeDb()
    const billing = { ...shopStub().billing, autopayments: false }

    await expect(
      createCaller(context(prisma, { billing })).billing.startPaymentMethodChange({}),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Автопродление пока недоступно. Оформите тариф без него: он будет действовать месяц',
      cause: { code: 'BILLING_AUTO_RENEWAL_UNAVAILABLE' },
    })

    expect(startChange).toHaveBeenCalledExactlyOnceWith(
      { prisma, yookassa: billing.yookassa, appUrl: APP_URL, appEnv: 'test', autopayments: false },
      { userId: user.id },
    )
    expect(db.workspace.findFirst).not.toHaveBeenCalled()
  })

  it('is refused while payments are off, before anything is asked', async () => {
    const { prisma } = fakeDb()

    await expect(
      createCaller(context(prisma, { billing: null })).billing.startPaymentMethodChange({}),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Оплата сейчас недоступна. Попробуйте ещё раз немного позже',
      cause: { code: 'BILLING_PAYMENTS_NOT_CONFIGURED' },
    })
    expect(startChange).not.toHaveBeenCalled()
  })

  it.each(refusals)('tells the customer of %s in Russian', async (_case, refusal, code, text) => {
    const { prisma } = fakeDb()
    const domainError = refusal()
    startChange.mockRejectedValueOnce(domainError)

    await expect(
      createCaller(context(prisma)).billing.startPaymentMethodChange({}),
    ).rejects.toMatchObject({ code, message: text, cause: domainError })
  })

  it.each(['javascript:alert(1)', '/settings/billing', ''])(
    'does not send the customer to an address that is not a web page: %s',
    async (confirmationUrl) => {
      const { prisma } = fakeDb()
      startChange.mockResolvedValueOnce({ confirmationUrl })

      await expect(
        createCaller(context(prisma)).billing.startPaymentMethodChange({}),
      ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
    },
  )
})

describe('billing.syncPaymentMethod', () => {
  it('reads the binding of the user back through the shop of the context', async () => {
    const { prisma } = fakeDb()
    const { billing } = shopStub()
    syncMethod.mockResolvedValueOnce(nothingBound)

    expect(await createCaller(context(prisma, { billing })).billing.syncPaymentMethod({})).toEqual(
      nothingBound,
    )

    expect(syncMethod).toHaveBeenCalledExactlyOnceWith(
      { prisma, yookassa: billing.yookassa, appUrl: APP_URL, appEnv: 'test', autopayments: true },
      { userId: user.id },
    )
  })

  it.each([undefined, { userId: randomUUID() }, { paymentMethodId: 'pm-1' }])(
    'takes no input but the empty object: %o',
    async (input) => {
      const { prisma } = fakeDb()
      await expect(
        createCaller(context(prisma)).billing.syncPaymentMethod(input as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(syncMethod).not.toHaveBeenCalled()
    },
  )

  it('is refused while payments are off: there is no shop to ask', async () => {
    const { prisma } = fakeDb()

    await expect(
      createCaller(context(prisma, { billing: null })).billing.syncPaymentMethod({}),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'BILLING_PAYMENTS_NOT_CONFIGURED' },
    })
    expect(syncMethod).not.toHaveBeenCalled()
  })

  it('does not show a state its schema does not describe', async () => {
    const { prisma } = fakeDb()
    syncMethod.mockResolvedValueOnce({
      state: 'bound' as 'active',
      renewalCharge: 'none',
      subscription: null,
    })

    await expect(createCaller(context(prisma)).billing.syncPaymentMethod({})).rejects.toMatchObject(
      { code: 'INTERNAL_SERVER_ERROR' },
    )
  })

  it('leaves a failure of the shop that is no refusal internal', async () => {
    const { prisma } = fakeDb()
    syncMethod.mockRejectedValueOnce(new YookassaApiError('forbidden', 403, 'forbidden', {}))

    await expect(createCaller(context(prisma)).billing.syncPaymentMethod({})).rejects.toMatchObject(
      { code: 'INTERNAL_SERVER_ERROR' },
    )
  })
})

describe('billing.unlinkPaymentMethod', () => {
  it('unlinks the method of the user and needs no shop for it', async () => {
    const { prisma } = fakeDb()
    unlink.mockResolvedValue({ renewalCharge: 'none' })

    expect(
      await createCaller(context(prisma, { billing: null })).billing.unlinkPaymentMethod({}),
    ).toEqual(unlinkedClean)

    // Nothing but the database and the environment that tells the personal workspace.
    expect(unlink).toHaveBeenCalledExactlyOnceWith({ prisma, appEnv: 'test' }, { userId: user.id })
  })

  it('finds the workspace by the environment of the shop when payments are on', async () => {
    const { prisma } = fakeDb()
    unlink.mockResolvedValue({ renewalCharge: 'none' })
    const billing: BillingContext = { ...shopStub().billing, appEnv: 'development' }
    // What the process says is not asked while the shop says it.
    vi.stubEnv('APP_ENV', 'staging')

    await createCaller(context(prisma, { billing })).billing.unlinkPaymentMethod({})

    expect(unlink).toHaveBeenCalledExactlyOnceWith(
      { prisma, appEnv: 'development' },
      { userId: user.id },
    )
  })

  it.each(['at_bank', 'unanswered'] as const)(
    'tells of a renewal charge that had been started and is %s',
    async (renewalCharge) => {
      const { prisma } = fakeDb()
      unlink.mockResolvedValueOnce({ renewalCharge })

      expect(await createCaller(context(prisma)).billing.unlinkPaymentMethod({})).toEqual({
        unlinked: true,
        renewalCharge,
      })
    },
  )

  it('does not answer with a charge its schema does not describe', async () => {
    const { prisma } = fakeDb()
    unlink.mockResolvedValueOnce({ renewalCharge: 'pending' as 'at_bank' })

    await expect(
      createCaller(context(prisma)).billing.unlinkPaymentMethod({}),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  })

  it.each([undefined, { userId: randomUUID() }, { subscriptionId: randomUUID() }])(
    'takes no input but the empty object: %o',
    async (input) => {
      const { prisma } = fakeDb()
      await expect(
        createCaller(context(prisma)).billing.unlinkPaymentMethod(input as never),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(unlink).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      'nothing to unlink',
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
    unlink.mockRejectedValueOnce(domainError)

    await expect(
      createCaller(context(prisma)).billing.unlinkPaymentMethod({}),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: text, cause: domainError })
  })

  it('answers a refusal over HTTP with 409, the domain code and the Russian text', async () => {
    const { prisma } = fakeDb()
    unlink.mockRejectedValueOnce(billingNothingToChange())

    const response = await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request('http://localhost:3000/api/trpc/billing.unlinkPaymentMethod', {
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
      path: 'billing.unlinkPaymentMethod',
      domainCode: 'BILLING_NOTHING_TO_CHANGE',
    })
  })
})

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL payments through the router', () => {
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
      data: { name: 'Payments verification', email: `${randomUUID()}@payments-router.example.ru` },
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
  type Account = Awaited<ReturnType<typeof account>>

  /** A tariff of the seeds (`pnpm db:seed`): the tests put no tariff of their own on sale. */
  async function seeded(slug: 'start' | 'business') {
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
    })
    if (row === null) throw new Error('The user has no subscription')
    return row
  }

  it('has no payments and nothing bound before the first payment, and reading makes no workspace', async () => {
    const paying = await account()

    expect(await paying.caller.billing.payments({})).toEqual(noPage)
    expect(await paying.caller.billing.syncPaymentMethod({})).toEqual(nothingBound)
    await expect(paying.caller.billing.startPaymentMethodChange({})).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'BILLING_NO_LIVE_SUBSCRIPTION' },
    })
    await expect(paying.caller.billing.unlinkPaymentMethod({})).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'BILLING_NO_LIVE_SUBSCRIPTION' },
    })

    expect(await db.workspace.count({ where: { createdById: paying.user.id } })).toBe(0)
    expect(paying.shop.methods.size).toBe(0)
  })

  it('shows the payment of a tariff, replaces its card and unlinks it', async () => {
    const paying = await account()
    const tariff = await seeded('start')
    const { caller, shop } = paying
    const { orderId, subscription } = await subscribe(paying, { autoRenew: true })
    expect(subscription).toMatchObject({
      autoRenewal: true,
      paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` },
    })

    // The history: the one order, paid, with the period it bought.
    expect(await caller.billing.payments({})).toEqual({
      items: [
        expect.objectContaining({
          id: orderId,
          kind: 'subscription',
          planName: tariff.name,
          period: subscription.period,
          amount: tariff.price.toFixed(2),
          status: 'paid',
          failureText: null,
          paidAt: new Date(PAID_AT),
        }),
      ],
      nextCursor: null,
    })

    // «Заменить»: the page of the shop, then the look of the return page stores the card.
    const { confirmationUrl } = await caller.billing.startPaymentMethodChange({})
    expect(confirmationUrl).toMatch(/^https:\/\/yookassa\.example\/bind\//)
    expect(await caller.billing.syncPaymentMethod({})).toMatchObject({
      state: 'pending',
      subscription: { paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` } },
    })
    const methodId = shop.bind()
    const bound = await caller.billing.syncPaymentMethod({})
    expect(bound).toMatchObject({
      state: 'active',
      subscription: { autoRenewal: true, paymentMethod: { label: `Карта Visa ••${NBSP}1234` } },
    })
    expect(await caller.billing.overview()).toMatchObject({ subscription: bound.subscription })
    expect(await subscriptionOf(paying)).toMatchObject({
      paymentMethodId: methodId,
      pendingPaymentMethodId: null,
      cancelAtPeriodEnd: false,
    })

    // «Отвязать»: no method, no auto-renewal, the tariff as it was.
    expect(await caller.billing.unlinkPaymentMethod({})).toEqual(unlinkedClean)
    expect((await caller.billing.overview()).subscription).toMatchObject({
      status: 'active',
      period: subscription.period,
      autoRenewal: false,
      paymentMethod: null,
    })
    expect(await subscriptionOf(paying)).toMatchObject({
      paymentMethodId: null,
      paymentMethodLast4: null,
      cancelAtPeriodEnd: true,
    })
    await expect(caller.billing.unlinkPaymentMethod({})).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Это уже сделано. Обновите страницу, чтобы увидеть изменения',
      cause: { code: 'BILLING_NOTHING_TO_CHANGE' },
    })
    // The return page of the binding has nothing more to tell.
    expect((await caller.billing.syncPaymentMethod({})).state).toBe('none')
    // None of it is a payment.
    expect((await caller.billing.payments({})).items.map(({ id }) => id)).toEqual([orderId])

    const { workspaceId } = await subscriptionOf(paying)
    const actions = (
      await db.auditLog.findMany({
        where: { workspaceId, action: { startsWith: 'billing.payment_method.' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map((entry) => [entry.action, entry.actorId])
    expect(actions).toEqual([
      [paymentMethodAuditActions.bindStart, paying.user.id],
      [paymentMethodAuditActions.bound, paying.user.id],
      [paymentMethodAuditActions.unlink, paying.user.id],
    ])
  })

  it('tells the page that a binding waits, until a look at it has an outcome', async () => {
    const paying = await account()
    const { caller, shop } = paying
    await subscribe(paying, { autoRenew: true })
    expect(await caller.billing.overview()).toMatchObject({
      bindingPending: false,
      renewalCharge: 'none',
    })

    // The customer leaves for the page of the shop, and its notification never comes.
    await caller.billing.startPaymentMethodChange({})
    const [methodId] = [...shop.methods.keys()]
    const waiting = await caller.billing.overview()
    expect(waiting.bindingPending).toBe(true)
    // Which binding waits is nobody's business outside the server.
    expect(JSON.stringify(waiting)).not.toContain(methodId)
    // A look that finds the card not confirmed yet changes nothing.
    expect((await caller.billing.syncPaymentMethod({})).state).toBe('pending')
    expect((await caller.billing.overview()).bindingPending).toBe(true)

    // The customer confirms the card and opens «Оплата»: its one look stores the card.
    shop.bind()
    expect((await caller.billing.syncPaymentMethod({})).state).toBe('active')
    expect(await caller.billing.overview()).toMatchObject({
      bindingPending: false,
      subscription: { paymentMethod: { label: `Карта Visa ••${NBSP}1234` } },
    })
  })

  it('tells of a renewal charge under way: in the overview, after a replacement and on unlinking', async () => {
    const paying = await account()
    const { caller, shop } = paying
    await subscribe(paying, { autoRenew: true })
    const row = await subscriptionOf(paying)
    // The scheduler has charged the saved card for the next period; the bank has not answered.
    await db.order.create({
      data: {
        workspaceId: row.workspaceId,
        userId: paying.user.id,
        kind: 'subscription',
        planId: row.planId,
        subscriptionId: row.id,
        amount: '4900.00',
        status: 'pending',
        idempotenceKey: renewalKey(row.id, row.currentPeriodEnd),
        yookassaPaymentId: randomUUID(),
      },
    })

    expect((await caller.billing.overview()).renewalCharge).toBe('at_bank')

    // A card bound now comes too late for that charge: the return page is told so.
    await caller.billing.startPaymentMethodChange({})
    shop.bind()
    expect(await caller.billing.syncPaymentMethod({})).toMatchObject({
      state: 'active',
      renewalCharge: 'at_bank',
      subscription: { paymentMethod: { label: `Карта Visa ••${NBSP}1234` } },
    })

    // And unlinking does not stop it: the answer says where it stands.
    expect(await caller.billing.unlinkPaymentMethod({})).toEqual({
      unlinked: true,
      renewalCharge: 'at_bank',
    })
    expect(await caller.billing.overview()).toMatchObject({
      renewalCharge: 'at_bank',
      subscription: { autoRenewal: false, paymentMethod: null },
    })
  })

  it('binds a first card to a tariff bought without auto-renewal, which stays off', async () => {
    const paying = await account()
    const { caller, shop } = paying
    const { subscription } = await subscribe(paying, { autoRenew: false })
    expect(subscription).toMatchObject({ autoRenewal: false, paymentMethod: null })

    await caller.billing.startPaymentMethodChange({})
    shop.bind()

    expect(await caller.billing.syncPaymentMethod({})).toMatchObject({
      state: 'active',
      // A saved card is not a consent to be charged.
      subscription: { autoRenewal: false, paymentMethod: { label: `Карта Visa ••${NBSP}1234` } },
    })
  })

  it('lets a user unlink who has not accepted a new edition of the documents', async () => {
    const paying = await account()
    const { caller } = paying
    await subscribe(paying, { autoRenew: true })
    // A new edition of a document is published: the consents the user gave are to an older one.
    await db.userConsent.updateMany({
      where: { userId: paying.user.id },
      data: { documentVersion: '2000-01-01' },
    })

    for (const call of [
      () => caller.billing.payments({}),
      () => caller.billing.startPaymentMethodChange({}),
      () => caller.billing.syncPaymentMethod({}),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' })
    }
    expect(await caller.billing.unlinkPaymentMethod({})).toEqual(unlinkedClean)

    expect(await subscriptionOf(paying)).toMatchObject({
      paymentMethodId: null,
      cancelAtPeriodEnd: true,
    })
  })

  it('pages through the history newest first and tells why a payment failed', async () => {
    const paying = await account()
    const { caller, shop } = paying
    const tariff = await subscribe(paying, { autoRenew: false })
    const declined = await caller.billing.startPackCheckout({})
    shop.decline('insufficient_funds')
    await caller.billing.syncOrder({ orderId: declined.orderId })
    const bought = await caller.billing.startPackCheckout({})
    shop.pay()
    await caller.billing.syncOrder({ orderId: bought.orderId })
    const waiting = await caller.billing.startPackCheckout({})

    const first = await caller.billing.payments({ limit: 3 })
    expect(first.items.map(({ id, kind, status }) => [id, kind, status])).toEqual([
      [waiting.orderId, 'pack', 'pending'],
      [bought.orderId, 'pack', 'paid'],
      [declined.orderId, 'pack', 'failed'],
    ])
    expect(first.items[2]).toMatchObject({
      failureReason: 'insufficient_funds',
      failureText: 'Недостаточно средств. Пополните счёт или выберите другой способ оплаты.',
      period: null,
    })
    expect(first.nextCursor).toBe(declined.orderId)

    const second = await caller.billing.payments({ limit: 3, cursor: first.nextCursor! })
    expect(second.items.map(({ id, kind }) => [id, kind])).toEqual([
      [tariff.orderId, 'subscription'],
    ])
    expect(second.nextCursor).toBeNull()
  })

  it('does not show the payments or touch the card of another user', async () => {
    const paying = await account()
    await subscribe(paying, { autoRenew: true })
    const other = await account()
    await subscribe(other, { autoRenew: true })

    expect((await other.caller.billing.payments({})).items).toHaveLength(1)
    await other.caller.billing.unlinkPaymentMethod({})

    expect((await paying.caller.billing.overview()).subscription).toMatchObject({
      autoRenewal: true,
      paymentMethod: { label: `Карта «Мир» ••${NBSP}4444` },
    })
    expect((await paying.caller.billing.payments({})).items).toHaveLength(1)
  })
})
