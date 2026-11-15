import { randomUUID } from 'node:crypto'

import type * as BillingModule from '@repo/billing'
import {
  getUsageActivity,
  getUsageSummary,
  listUsageHistory,
  paymentLetterKey,
  type UsageHistoryPageDto,
  type UsageSummaryDto,
} from '@repo/billing'
import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments, Money, signupGiftCredits } from '@repo/domain'
import { YookassaApiError, type Payment, type YookassaClient } from '@repo/yookassa'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import type { BillingContext, Context } from '../trpc.ts'

// «Настройки → Использование» through the router: `billing.usage` and `billing.usageHistory`.
// The read models of @repo/billing are wrapped: they run as they are — the PostgreSQL block
// reads through them — unless a test scripts the next answer.
vi.mock('@repo/billing', async (importOriginal) => {
  const original = await importOriginal<typeof BillingModule>()
  return {
    ...original,
    getUsageActivity: vi.fn(original.getUsageActivity),
    getUsageSummary: vi.fn(original.getUsageSummary),
    listUsageHistory: vi.fn(original.listUsageHistory),
  }
})
const summary = vi.mocked(getUsageSummary)
const history = vi.mocked(listUsageHistory)
const activity = vi.mocked(getUsageActivity)

/** 15:00 in Moscow on 4 October 2026: the clock of every test here. */
const NOW = new Date('2026-10-04T12:00:00.000Z')
const PAID_AT = '2026-10-04T09:00:00.000Z'
const WORKSPACE = '0199a000-0000-7000-8000-0000000000c1'
const DAY_MS = 24 * 60 * 60 * 1000

const user: User = {
  id: randomUUID(),
  name: 'Анна Ковалёва',
  lastName: null,
  email: 'usage-test@example.ru',
  emailVerified: true,
  agentMemory: true,
  image: null,
  createdAt: NOW,
  updatedAt: NOW,
}
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

beforeEach(() => {
  vi.stubEnv('APP_ENV', 'test')
  // Only the clock is set; timers run as they are, the database client needs them.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  // Back to the functions of the package, whatever a test scripted and did not use up.
  summary.mockReset()
  history.mockReset()
})

/** ЮKassa in memory: a payment waits on its page until the test pays it. */
function shopStub() {
  const payments = new Map<string, Payment>()
  const idByKey = new Map<string, string>()
  const unused = () => Promise.reject(new Error('The usage procedures do not make this call'))
  const yookassa: YookassaClient = {
    createPayment(input, idempotenceKey) {
      let id = idByKey.get(idempotenceKey)
      if (id === undefined) {
        id = randomUUID()
        idByKey.set(idempotenceKey, id)
        payments.set(id, {
          id,
          status: 'pending',
          paid: false,
          amount: { value: input.amount.value, currency: 'RUB' },
          created_at: NOW.toISOString(),
          confirmation: { type: 'redirect', confirmation_url: `https://yookassa.example/${id}` },
          ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        })
      }
      return Promise.resolve(structuredClone(payments.get(id)!))
    },
    getPayment(paymentId) {
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
      appUrl: 'https://raditi.example',
      appEnv: 'test',
      autopayments: true,
      pastDueDays: 7,
    } satisfies BillingContext,
    /** The customer paid the only payment of the shop. */
    payOnly() {
      const [payment, ...others] = [...payments.values()]
      if (payment === undefined || others.length > 0) {
        throw new Error(`The stub holds ${payments.size} payments, not one`)
      }
      payment.status = 'succeeded'
      payment.paid = true
      payment.captured_at = PAID_AT
      delete payment.confirmation
      payment.payment_method = { id: payment.id, type: 'bank_card', saved: false }
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
          token: 'usage-test-session',
          expiresAt: new Date('2030-01-01'),
          createdAt: NOW,
          updatedAt: NOW,
        }
      : null,
    billing,
    // Projects are made through the site connection wizard: a fake of its servers and Vault.
  }
}

/** The tables the procedures read before they ask the read model, answering from the test. */
function fakeDb() {
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    workspace: {
      findFirst: vi.fn<() => Promise<{ id: string } | null>>().mockResolvedValue({ id: WORKSPACE }),
    },
    // Nothing is on sale unless a test puts a pack there.
    plan: { findMany: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]) },
    // The key of the user's gift: not in the ledger unless a test puts it there.
    creditLedger: { findUnique: vi.fn<() => Promise<unknown>>().mockResolvedValue(null) },
    // A credit rate is in force, and no enabled model has a price newer than it: a task is
    // refused by nothing but the credits, unless a test takes the rate away.
    creditRate: {
      findFirst: vi.fn<() => Promise<unknown>>().mockResolvedValue({
        id: randomUUID(),
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        rubPerCredit: new Money('6'),
        basis: 'Usage test',
      }),
    },
    llmModelPrice: { findFirst: vi.fn<() => Promise<unknown>>().mockResolvedValue(null) },
    // No live tariff unless a test puts one there: the pack is priced for that (КР9).
    subscription: { findFirst: vi.fn<() => Promise<unknown>>().mockResolvedValue(null) },
  }
  return { db, prisma: db as unknown as PrismaClient }
}

const plan = {
  id: randomUUID(),
  slug: 'business',
  name: 'Бизнес',
  price: '12900.00',
  creditsPerMonth: 80,
  creditsPerDay: 20,
  creditsPer5h: null,
  creditsPerWeek: null,
}
const noPage: UsageHistoryPageDto = { items: [], nextCursor: null, total: 0 }
const entry = (patch: Partial<UsageHistoryPageDto['items'][number]> = {}) => ({
  id: randomUUID(),
  at: new Date('2026-10-03T08:00:00.000Z'),
  outcome: 'charged' as const,
  credits: 17,
  from: { tariff: 5, gift: 0, pack: 12 },
  task: { id: randomUUID(), title: 'Заменил фото на главной', status: 'done' as const },
  ...patch,
})
const TAKEN = { allowed: true, reason: null } as const
/** The gift of the registration: 50 credits since 06.11.2026 (docs/plan/63-new-pricing.md, Ц5). */
const GIFT = signupGiftCredits
/** What a database without a credit rate answers about every task. */
const NO_RATE = { allowed: false, reason: 'rate_missing' } as const
const noTariff: UsageSummaryDto = {
  subscription: null,
  tariff: null,
  gift: { left: 0, held: 0, granted: false },
  pack: { left: 0, held: 0 },
  totalLeft: 0,
  history: noPage,
  spendable: 0,
  spendableNow: 0,
  setAside: 0,
  minToStart: 1,
  // Without a tariff there is no day: the gift is the bound.
  today: null,
  tier: 'none',
  windows: [],
  newTask: { allowed: false, reason: 'gift_spent' },
}
/** What a user without a workspace reads: no tariff and the gift they are promised. */
const promised: UsageSummaryDto = {
  ...noTariff,
  gift: { left: GIFT, held: 0, granted: false },
  totalLeft: GIFT,
  spendable: GIFT,
  spendableNow: GIFT,
  newTask: TAKEN,
}
/** «Бизнес» of this file, 20 tariff credits a day: one task charged 5 and one holding 14 today. */
const busyDay = { limit: 20, charged: 5, held: 14, used: 19, room: 1, left: 1 }
const onTariff = (): UsageSummaryDto => ({
  subscription: {
    id: randomUUID(),
    status: 'active',
    plan,
    period: { start: new Date('2026-09-18T09:00:00Z'), end: new Date('2026-10-18T09:00:00Z') },
    autoRenewal: true,
    nextPlan: null,
    paymentMethod: { label: 'Карта «Мир» •• 4444' },
    pastDueSince: null,
  },
  tariff: {
    // 20 carried from the period before and 80 granted; 45 left, all of them within the 80 a
    // renewal would carry.
    credits: {
      carried: 20,
      granted: 80,
      charged: 37,
      held: 14,
      expired: 4,
      left: 45,
      heldEarlier: 9,
      carryLimit: 80,
      carryNext: 45,
      burnNext: 0,
    },
    today: busyDay,
  },
  gift: { left: 0, held: 0, granted: false },
  pack: { left: 10, held: 0 },
  totalLeft: 55,
  history: { items: [entry()], nextCursor: null, total: 1 },
  spendable: 55,
  spendableNow: 11,
  setAside: 23,
  minToStart: 1,
  today: busyDay,
  tier: 'none',
  windows: [],
  newTask: TAKEN,
})

describe('usage access', () => {
  it.each(['usage', 'usageHistory'] as const)(
    'requires a session before %s reads anything',
    async (name) => {
      const { prisma, db } = fakeDb()
      const call = createCaller(context(prisma, { currentUser: null })).billing[name] as (
        input?: unknown,
      ) => Promise<unknown>
      await expect(call({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(db.userConsent.findMany).not.toHaveBeenCalled()
      expect(db.workspace.findFirst).not.toHaveBeenCalled()
      expect(summary).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
    },
  )

  it('requires the current mandatory consents for both procedures', async () => {
    const { prisma, db } = fakeDb()
    db.userConsent.findMany.mockResolvedValue([])
    const caller = createCaller(context(prisma)).billing
    for (const call of [caller.usage(), caller.usageHistory({})]) {
      await expect(call).rejects.toMatchObject({ code: 'PRECONDITION_REQUIRED' })
    }
    expect(db.workspace.findFirst).not.toHaveBeenCalled()
    expect(summary).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
  })
})

describe('billing.usageActivity', () => {
  it('reads the days of the personal workspace as of now', async () => {
    const { prisma } = fakeDb()
    const days = [{ date: '2026-10-04', actions: 3, credits: { tariff: 10, gift: 2, pack: 0 } }]
    activity.mockResolvedValueOnce({ days })

    expect(await createCaller(context(prisma)).billing.usageActivity({ days: 7 })).toEqual({ days })
    expect(activity).toHaveBeenCalledExactlyOnceWith(prisma, {
      workspaceId: WORKSPACE,
      days: 7,
      now: NOW,
    })
  })

  it('answers days of zeros in Moscow for a user without a workspace', async () => {
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(null)
    // 01:00 of 5 October in Moscow, still 4 October by UTC.
    vi.setSystemTime(new Date('2026-10-04T22:00:00.000Z'))

    const { days } = await createCaller(context(prisma)).billing.usageActivity({ days: 30 })
    expect(days).toHaveLength(30)
    expect(days[0]).toEqual({
      date: '2026-09-06',
      actions: 0,
      credits: { tariff: 0, gift: 0, pack: 0 },
    })
    expect(days.at(-1)?.date).toBe('2026-10-05')
    expect(activity).not.toHaveBeenCalled()
  })

  it('refuses a span the page does not offer', async () => {
    const { prisma } = fakeDb()
    const call = createCaller(context(prisma)).billing.usageActivity as (
      input: unknown,
    ) => Promise<unknown>
    await expect(call({ days: 14 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(activity).not.toHaveBeenCalled()
  })
})

describe('billing.usage', () => {
  it('reads the usage of the personal workspace as of now', async () => {
    const { prisma, db } = fakeDb()
    const usage = onTariff()
    summary.mockResolvedValueOnce(usage)

    expect(await createCaller(context(prisma)).billing.usage()).toEqual({
      ...usage,
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      packOnSale: null,
    })
    expect(summary).toHaveBeenCalledExactlyOnceWith(prisma, { workspaceId: WORKSPACE, now: NOW })
    // The personal workspace of this user, by the rule of project.create.
    expect(db.workspace.findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdById: user.id, dataClass: 'synthetic' }),
      }),
    )
  })

  it('takes the moment of each request, not of the first one', async () => {
    const { prisma } = fakeDb()
    summary.mockResolvedValue(noTariff)
    const caller = createCaller(context(prisma)).billing

    await caller.usage()
    const later = new Date(NOW.getTime() + DAY_MS)
    vi.setSystemTime(later)
    await caller.usage()

    expect(summary.mock.calls.map(([, input]) => input.now)).toEqual([NOW, later])
  })

  it('answers «no tariff» and the gift as promised for a user without a workspace, and reads no further', async () => {
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(null)

    expect(await createCaller(context(prisma)).billing.usage()).toEqual({
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      packOnSale: null,
      subscription: null,
      tariff: null,
      gift: { left: GIFT, held: 0, granted: false },
      pack: { left: 0, held: 0 },
      totalLeft: GIFT,
      history: noPage,
      // The first task would be taken on the gift that is promised.
      spendable: GIFT,
      spendableNow: GIFT,
      setAside: 0,
      minToStart: 1,
      today: null,
      tier: 'none',
      windows: [],
      newTask: TAKEN,
    })
    // Whether the gift is still to come is asked of the ledger, by the key of this user.
    expect(db.creditLedger.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { idempotencyKey: `user:${user.id}:signup-gift` },
      select: { id: true },
    })
    expect(summary).not.toHaveBeenCalled()
  })

  it('tells a user without a workspace that no task is taken while no credit rate is in force', async () => {
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(null)
    db.creditRate.findFirst.mockResolvedValue(null)

    expect(await createCaller(context(prisma)).billing.usage()).toMatchObject({
      gift: { left: GIFT, held: 0, granted: false },
      spendable: GIFT,
      newTask: NO_RATE,
    })
    // The rate is asked about the moment of the request.
    expect(db.creditRate.findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { effectiveFrom: { lte: NOW } } }),
    )
  })

  it('answers «no tariff, no credits» for a user without a workspace whose gift stands in the ledger', async () => {
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(null)
    db.creditLedger.findUnique.mockResolvedValue({ id: randomUUID() })

    expect(await createCaller(context(prisma)).billing.usage()).toEqual({
      ...noTariff,
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      packOnSale: null,
    })
    expect(summary).not.toHaveBeenCalled()
    // Zeros only after a second look for the workspace, made once the key was found.
    expect(db.workspace.findFirst).toHaveBeenCalledTimes(2)
    expect(db.creditLedger.findUnique).toHaveBeenCalledOnce()
  })

  it('does not look for the workspace again while the gift is still promised', async () => {
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(null)

    expect(await createCaller(context(prisma)).billing.usage()).toMatchObject(promised)
    expect(db.workspace.findFirst).toHaveBeenCalledOnce()
  })

  // The workspace and the key of the gift are two reads. A first site or a first checkout that
  // commits between them leaves the first at «no workspace» and the second at «granted»: the
  // page must show the usage of the workspace that was made, not «no gift».
  it('reads the usage of the workspace that was made between its two reads', async () => {
    const { prisma, db } = fakeDb()
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
    const granted: UsageSummaryDto = { ...promised, gift: { ...promised.gift, granted: true } }
    summary.mockResolvedValueOnce(granted)

    expect(await createCaller(context(prisma)).billing.usage()).toEqual({
      ...granted,
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      packOnSale: null,
    })
    // The second look comes after the key: read then, the workspace of the gift is there.
    expect(order).toEqual(['workspace', 'key', 'workspace'])
    expect(summary).toHaveBeenCalledExactlyOnceWith(prisma, { workspaceId: WORKSPACE, now: NOW })
  })

  it('offers the pack that is on sale, by its name and price', async () => {
    const { prisma, db } = fakeDb()
    const packId = randomUUID()
    db.plan.findMany.mockResolvedValue([
      {
        id: packId,
        slug: 'pack',
        name: 'Пакет из 100 кредитов',
        kind: 'pack',
        price: new Money('1990'),
        creditsPerMonth: null,
        creditsPerDay: null,
        creditsPer5h: null,
        creditsPerWeek: null,
        packCredits: 100,
      },
    ])
    summary.mockResolvedValueOnce(noTariff)

    const usage = await createCaller(context(prisma)).billing.usage()

    // Without a tariff that takes tasks the pack costs twice its price (КР9).
    expect(usage.packOnSale).toEqual({
      id: packId,
      slug: 'pack',
      name: 'Пакет из 100 кредитов',
      price: '3980.00',
      credits: 100,
      withoutTariff: true,
    })
    // The purchased credits of the customer are another thing than the pack on sale.
    expect(usage.pack).toEqual({ left: 0, held: 0 })
  })

  it('shows the usage while payments are off and says that nothing can be bought', async () => {
    const { prisma } = fakeDb()
    const usage = onTariff()
    summary.mockResolvedValueOnce(usage)

    expect(await createCaller(context(prisma, { billing: null })).billing.usage()).toEqual({
      ...usage,
      paymentsEnabled: false,
      autoRenewalAvailable: false,
      packOnSale: null,
    })
  })

  it.each([
    [
      'numbers of the period that do not add up',
      (usage: UsageSummaryDto) => {
        usage.tariff!.credits.left = 44
      },
    ],
    [
      'credits of an ended period counted into the period',
      (usage: UsageSummaryDto) => {
        usage.tariff!.credits.held += usage.tariff!.credits.heldEarlier
      },
    ],
    [
      'a carry the period leaves out',
      (usage: UsageSummaryDto) => {
        usage.tariff!.credits.carried = 0
      },
    ],
    [
      'a renewal that would carry more than the quota of the period',
      (usage: UsageSummaryDto) => {
        usage.tariff!.credits.carryLimit = 40
      },
    ],
    [
      'a task that is taken for a reason',
      (usage: UsageSummaryDto) => {
        usage.newTask = { allowed: true, reason: 'empty' }
      },
    ],
    [
      'a total that is not the sum of the accounts',
      (usage: UsageSummaryDto) => {
        usage.totalLeft = 56
      },
    ],
    [
      'a total that leaves the gift out',
      (usage: UsageSummaryDto) => {
        usage.gift = { left: 30, held: 5, granted: true }
      },
    ],
    [
      'a tariff without its period',
      (usage: UsageSummaryDto) => {
        usage.tariff = null
      },
    ],
    [
      'a line of history with an outcome of its own',
      (usage: UsageSummaryDto) => {
        usage.history.items[0]!.outcome = 'returned' as 'charged'
      },
    ],
  ])('does not show a summary its schema does not describe: %s', async (_case, spoil) => {
    const { prisma } = fakeDb()
    const usage = onTariff()
    spoil(usage)
    summary.mockResolvedValueOnce(usage)

    await expect(createCaller(context(prisma)).billing.usage()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    })
  })
})

describe('billing.usageHistory', () => {
  const cursor = randomUUID()

  it('reads the page after the cursor from the personal workspace', async () => {
    const { prisma } = fakeDb()
    const page: UsageHistoryPageDto = {
      items: [entry(), entry()],
      nextCursor: randomUUID(),
      total: 5,
    }
    history.mockResolvedValueOnce(page)

    expect(await createCaller(context(prisma)).billing.usageHistory({ cursor })).toEqual(page)
    // The size of a page is the one the first page had, unless asked otherwise.
    expect(history).toHaveBeenCalledExactlyOnceWith(prisma, WORKSPACE, { cursor, limit: 20 })
  })

  it('passes the size of a page it was asked for', async () => {
    const { prisma } = fakeDb()
    history.mockResolvedValueOnce(noPage)

    await createCaller(context(prisma)).billing.usageHistory({ cursor, limit: 50 })

    expect(history).toHaveBeenCalledExactlyOnceWith(prisma, WORKSPACE, { cursor, limit: 50 })
  })

  it('passes the days of Moscow the lines are bounded by', async () => {
    const { prisma } = fakeDb()
    history.mockResolvedValueOnce(noPage)

    await createCaller(context(prisma)).billing.usageHistory({
      from: '2026-10-01',
      to: '2026-10-04',
    })

    expect(history).toHaveBeenCalledExactlyOnceWith(prisma, WORKSPACE, {
      from: '2026-10-01',
      to: '2026-10-04',
      limit: 20,
    })
  })

  it('gives an empty page to a user without a workspace and reads no further', async () => {
    const { prisma, db } = fakeDb()
    db.workspace.findFirst.mockResolvedValue(null)

    expect(await createCaller(context(prisma)).billing.usageHistory({ cursor })).toEqual(noPage)
    expect(history).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    { cursor: 'last' },
    { cursor, limit: 0 },
    { cursor, limit: 101 },
    { cursor, limit: 2.5 },
    { cursor, workspaceId: WORKSPACE },
    { cursor, userId: randomUUID() },
    { from: '2026-10-05', to: '2026-10-04' },
    { from: '04.10.2026' },
  ])(
    'rejects a query that is not a cursor and a size, or names whose history it is: %o',
    async (input) => {
      const { prisma, db } = fakeDb()
      await expect(
        createCaller(context(prisma)).billing.usageHistory(input as { cursor: string }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(db.workspace.findFirst).not.toHaveBeenCalled()
      expect(history).not.toHaveBeenCalled()
    },
  )

  it('does not show a page its schema does not describe', async () => {
    const { prisma } = fakeDb()
    // A charged task that does not say what it was charged.
    history.mockResolvedValueOnce({ items: [entry({ credits: null })], nextCursor: null, total: 1 })

    await expect(
      createCaller(context(prisma)).billing.usageHistory({ cursor }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  })
})

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL usage through the router', () => {
  let db: PrismaClient
  const userIds: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    // What refers goes first: the ledger and the holds to their accounts and tasks, and
    // everything to its workspace.
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
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.task.deleteMany({ where: owned })
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
      data: { name: 'Usage verification', email: `${randomUUID()}@usage-router.example.ru` },
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
   * A tariff of the seeds (`pnpm db:seed`): the tests put no tariff of their own on sale. No
   * tariff of the seeds limits the day since 06.11.2026 (plan 63, Ц6); a day it had would be
   * read here all the same (`dayOf`).
   */
  async function seeded(slug: 'start' | 'business') {
    const row = await db.plan.findFirst({ where: { slug, kind: 'quota', isActive: true } })
    if (row === null || row.creditsPerMonth === null) {
      throw new Error(`The tariff «${slug}» is not on sale in this database: apply the seeds`)
    }
    return { ...row, creditsPerMonth: row.creditsPerMonth }
  }

  /** The tariff credits of the Moscow day as the summary tells them, of `free` tariff credits. */
  const dayOf = (limit: number | null, charged: number, held: number, free: number) => {
    const used = charged + held
    const room = limit === null ? null : Math.max(0, limit - used)
    return { limit, charged, held, used, room, left: room === null ? free : Math.min(room, free) }
  }

  /** Pays for the tariff the way the customer does: checkout, the payment page, the return. */
  async function subscribe(
    { caller, shop }: Awaited<ReturnType<typeof account>>,
    slug: 'start' | 'business',
  ) {
    const { orderId } = await caller.billing.startCheckout({ planSlug: slug, autoRenew: false })
    shop.payOnly()
    const { subscription } = await caller.billing.syncOrder({ orderId })
    if (subscription === null) throw new Error('The payment did not start the tariff')
    return subscription
  }

  /**
   * The pack of the seeds, as `billing.usage` offers it: at twice its price to a customer whose
   * tariff does not take tasks (КР9).
   */
  async function packOnSale(withoutTariff = true) {
    const row = await db.plan.findFirst({
      where: { kind: 'pack', isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
    })
    if (row === null) throw new Error('No pack is on sale in this database: apply the seeds')
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      price: row.price.mul(withoutTariff ? 2 : 1).toFixed(2),
      credits: row.packCredits,
      withoutTariff,
    }
  }

  it('has no tariff and no workspace before the first payment, and the gift as promised', async () => {
    const { user: owner, caller } = await account()

    expect(await caller.billing.usage()).toEqual({
      ...promised,
      // The database of the tests has no credit rate: no task is taken, and the page says so.
      newTask: NO_RATE,
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      packOnSale: await packOnSale(),
    })
    expect(await caller.billing.usageHistory({})).toEqual(noPage)
    // Reading makes no workspace and grants nothing.
    expect(await db.workspace.count({ where: { createdById: owner.id } })).toBe(0)
    expect(
      await db.creditLedger.count({ where: { idempotencyKey: `user:${owner.id}:signup-gift` } }),
    ).toBe(0)
  })

  it('shows the full quota of a tariff that was just paid and an empty history', async () => {
    const paying = await account()
    const tariff = await seeded('business')

    const subscription = await subscribe(paying, 'business')
    const freshDay = dayOf(tariff.creditsPerDay, 0, 0, tariff.creditsPerMonth)

    expect(await paying.caller.billing.usage()).toEqual({
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      packOnSale: await packOnSale(false),
      subscription,
      tariff: {
        // Read from the ledger: the order of the payment carries the start of its period.
        // Nothing carried into a first period; all of it would carry at the renewal.
        credits: {
          carried: 0,
          granted: tariff.creditsPerMonth,
          charged: 0,
          held: 0,
          expired: 0,
          left: tariff.creditsPerMonth,
          heldEarlier: 0,
          carryLimit: tariff.creditsPerMonth,
          carryNext: tariff.creditsPerMonth,
          burnNext: 0,
        },
        today: freshDay,
      },
      // The gift the checkout granted with the workspace, beside the quota.
      gift: { left: GIFT, held: 0, granted: true },
      pack: { left: 0, held: 0 },
      totalLeft: tariff.creditsPerMonth + GIFT,
      history: noPage,
      spendable: tariff.creditsPerMonth + GIFT,
      // Of the tariff no more than the day gives, if it has a day; the gift is outside the day.
      // The week of the tariff bounds its credits (owner's answer of 14.11.2026).
      spendableNow: Math.min(freshDay.left, tariff.creditsPerWeek ?? Infinity) + GIFT,
      setAside: 0,
      minToStart: 1,
      today: freshDay,
      // The windows of «Бизнес» (Л4), none of them started.
      tier: 'business',
      windows: [
        {
          kind: '5h',
          limit: tariff.creditsPer5h,
          used: 0,
          left: tariff.creditsPer5h,
          resetsAt: null,
        },
        {
          kind: 'week',
          limit: tariff.creditsPerWeek,
          used: 0,
          left: tariff.creditsPerWeek,
          resetsAt: null,
        },
      ],
      newTask: NO_RATE,
    })
    expect(await paying.caller.billing.usageHistory({})).toEqual(noPage)
  })

  // docs/plan/61-chats-first.md, §5.10: a charge of a chat without a project never drops out.

  it('does not show the usage of another user', async () => {
    const paying = await account()
    await subscribe(paying, 'start')
    const other = await account()

    // Nothing of the first user: no tariff, and the gift this one is still promised.
    expect(await other.caller.billing.usage()).toMatchObject({
      ...promised,
      newTask: NO_RATE,
      paymentsEnabled: true,
    })
  })
})
