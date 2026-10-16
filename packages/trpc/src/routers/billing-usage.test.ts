import { randomUUID } from 'node:crypto'

import type * as BillingModule from '@repo/billing'
import {
  getUsageSummary,
  listUsageHistory,
  paymentLetterKey,
  type UsageHistoryPageDto,
  type UsageSummaryDto,
} from '@repo/billing'
import { placeReserve, settleTaskCharge } from '@repo/billing/testing'
import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments, Money } from '@repo/domain'
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
    getUsageSummary: vi.fn(original.getUsageSummary),
    listUsageHistory: vi.fn(original.listUsageHistory),
  }
})
const summary = vi.mocked(getUsageSummary)
const history = vi.mocked(listUsageHistory)

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
  }
  return { db, prisma: db as unknown as PrismaClient }
}

const plan = {
  id: randomUUID(),
  slug: 'business',
  name: 'Бизнес',
  price: '12900.00',
  creditsPerMonth: 80,
  tasksPerDay: 10,
  maxSites: 3,
}
const noPage: UsageHistoryPageDto = { items: [], nextCursor: null }
const entry = (patch: Partial<UsageHistoryPageDto['items'][number]> = {}) => ({
  id: randomUUID(),
  at: new Date('2026-10-03T08:00:00.000Z'),
  outcome: 'charged' as const,
  credits: 17,
  from: { tariff: 5, gift: 0, pack: 12 },
  task: { id: randomUUID(), title: 'Заменил фото на главной', status: 'done' as const },
  site: { id: randomUUID(), name: 'Кофейня на Лесной' },
  ...patch,
})
const TAKEN = { allowed: true, reason: null } as const
/** What a database without a credit rate answers about every task. */
const NO_RATE = { allowed: false, reason: 'rate_missing' } as const
const noTariff: UsageSummaryDto = {
  subscription: null,
  tariff: null,
  trial: { today: 0, perDay: 3 },
  gift: { left: 0, held: 0, granted: false },
  pack: { left: 0, held: 0 },
  totalLeft: 0,
  history: noPage,
  spendable: 0,
  setAside: 0,
  minToStart: 5,
  today: { used: 0, limit: 3 },
  newTask: { allowed: false, reason: 'gift_spent' },
}
/** What a user without a workspace reads: no tariff and the gift they are promised. */
const promised: UsageSummaryDto = {
  ...noTariff,
  gift: { left: 35, held: 0, granted: false },
  totalLeft: 35,
  spendable: 35,
  newTask: TAKEN,
}
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
    credits: { granted: 80, charged: 17, held: 14, expired: 4, left: 45, heldEarlier: 9 },
    today: { used: 1, limit: 10 },
    sites: { count: 2, max: 3 },
    bySite: [{ siteId: randomUUID(), name: 'Пекарня «Добро»', credits: 21 }],
  },
  trial: null,
  gift: { left: 0, held: 0, granted: false },
  pack: { left: 10, held: 0 },
  totalLeft: 55,
  history: { items: [entry()], nextCursor: null },
  spendable: 55,
  setAside: 23,
  minToStart: 5,
  today: { used: 1, limit: 10 },
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
      trial: { today: 0, perDay: 3 },
      gift: { left: 35, held: 0, granted: false },
      pack: { left: 0, held: 0 },
      totalLeft: 35,
      history: noPage,
      // The first task would be taken on the gift that is promised.
      spendable: 35,
      setAside: 0,
      minToStart: 5,
      today: { used: 0, limit: 3 },
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
      gift: { left: 35, held: 0, granted: false },
      spendable: 35,
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
        tasksPerDay: null,
        maxSites: null,
        packCredits: 100,
      },
    ])
    summary.mockResolvedValueOnce(noTariff)

    const usage = await createCaller(context(prisma)).billing.usage()

    expect(usage.packOnSale).toEqual({
      id: packId,
      slug: 'pack',
      name: 'Пакет из 100 кредитов',
      price: '1990.00',
      credits: 100,
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
    const page: UsageHistoryPageDto = { items: [entry(), entry()], nextCursor: randomUUID() }
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
    history.mockResolvedValueOnce({ items: [entry({ credits: null })], nextCursor: null })

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

  /** A tariff of the seeds (`pnpm db:seed`): the tests put no tariff of their own on sale. */
  async function seeded(slug: 'start' | 'business') {
    const row = await db.plan.findFirst({ where: { slug, kind: 'quota', isActive: true } })
    if (row === null || row.maxSites === null || row.creditsPerMonth === null) {
      throw new Error(`The tariff «${slug}» is not on sale in this database: apply the seeds`)
    }
    return { ...row, maxSites: row.maxSites, creditsPerMonth: row.creditsPerMonth }
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

  /** The pack of the seeds, as every answer of `billing.usage` offers it. */
  async function packOnSale() {
    const row = await db.plan.findFirst({
      where: { kind: 'pack', isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
    })
    if (row === null) throw new Error('No pack is on sale in this database: apply the seeds')
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      price: row.price.toFixed(2),
      credits: row.packCredits,
    }
  }

  const site = (name: string) =>
    ({ name, url: `https://${randomUUID()}.example.ru`, stack: 'wordpress' }) as const

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

  it('shows the gift as granted once the first site made the workspace: the same credits', async () => {
    const { caller } = await account()

    await caller.project.create(site('Первый'))

    expect(await caller.billing.usage()).toEqual({
      ...promised,
      gift: { ...promised.gift, granted: true },
      newTask: NO_RATE,
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      packOnSale: await packOnSale(),
    })
  })

  it('shows the full quota of a tariff that was just paid and an empty history', async () => {
    const paying = await account()
    const tariff = await seeded('business')

    const subscription = await subscribe(paying, 'business')

    expect(await paying.caller.billing.usage()).toEqual({
      paymentsEnabled: true,
      autoRenewalAvailable: true,
      packOnSale: await packOnSale(),
      subscription,
      tariff: {
        // Read from the ledger: the order of the payment carries the start of its period.
        credits: {
          granted: tariff.creditsPerMonth,
          charged: 0,
          held: 0,
          expired: 0,
          left: tariff.creditsPerMonth,
          heldEarlier: 0,
        },
        today: { used: 0, limit: tariff.tasksPerDay },
        sites: { count: 0, max: tariff.maxSites },
        bySite: [],
      },
      trial: null,
      // The gift the checkout granted with the workspace, beside the quota.
      gift: { left: 35, held: 0, granted: true },
      pack: { left: 0, held: 0 },
      totalLeft: tariff.creditsPerMonth + 35,
      history: noPage,
      spendable: tariff.creditsPerMonth + 35,
      setAside: 0,
      minToStart: 5,
      today: { used: 0, limit: tariff.tasksPerDay },
      newTask: NO_RATE,
    })
    expect(await paying.caller.billing.usageHistory({})).toEqual(noPage)
  })

  it('tells where the credits went once tasks took them, and pages through the history', async () => {
    const paying = await account()
    const tariff = await seeded('business')
    await subscribe(paying, 'business')
    const { caller } = paying
    const bakery = await caller.project.create(site('Пекарня «Добро»'))
    const { workspaceId } = await db.site.findUniqueOrThrow({ where: { id: bakery.id } })
    const expiresAt = new Date(NOW.getTime() + DAY_MS)
    const taken: string[] = []
    // Three tasks a minute apart: each sets 45 credits aside; the first is done for 5, the
    // second for 17, the third is still in work.
    for (const [minute, charged] of [5, 17, null].entries()) {
      const task = await db.task.create({
        data: {
          workspaceId,
          siteId: bakery.id,
          modelClass: 'standard',
          status: 'done',
          summary: `Правка ${minute + 1}`,
        },
      })
      const now = new Date(NOW.getTime() + minute * 60_000)
      await placeReserve(db, { workspaceId, taskId: task.id, attempt: 1, now, expiresAt })
      taken.unshift(task.id)
      if (charged !== null) {
        await db.$transaction((tx) =>
          settleTaskCharge(tx, { taskId: task.id, credits: charged, now }),
        )
      }
    }

    const usage = await caller.billing.usage()

    const quota = tariff.creditsPerMonth
    expect(usage.tariff).toMatchObject({
      credits: {
        granted: quota,
        charged: 22,
        held: 45,
        expired: 0,
        left: quota - 67,
        heldEarlier: 0,
      },
      today: { used: 3, limit: tariff.tasksPerDay },
      sites: { count: 1, max: tariff.maxSites },
      bySite: [{ siteId: bakery.id, name: 'Пекарня «Добро»', credits: 22 }],
    })
    // The tasks took credits of the tariff; the gift of the registration is untouched.
    expect(usage.gift).toEqual({ left: 35, held: 0, granted: true })
    expect(usage.totalLeft).toBe(quota - 67 + 35)
    expect(usage).toMatchObject({ spendable: quota - 67 + 35, setAside: 45 })
    expect(
      usage.history.items.map(({ id, outcome, credits, task }) => [
        id,
        outcome,
        credits,
        task.title,
      ]),
    ).toEqual([
      [taken[0], 'held', 45, 'Правка 3'],
      [taken[1], 'charged', 17, 'Правка 2'],
      [taken[2], 'charged', 5, 'Правка 1'],
    ])

    const first = await caller.billing.usageHistory({ limit: 2 })
    expect(first.items.map(({ id }) => id)).toEqual(taken.slice(0, 2))
    expect(first.nextCursor).toBe(taken[1])
    const second = await caller.billing.usageHistory({ limit: 2, cursor: first.nextCursor! })
    expect(second.items.map(({ id }) => id)).toEqual(taken.slice(2))
    expect(second.nextCursor).toBeNull()
  })

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

  it('holds a paid tariff to its number of sites when a site is added', async () => {
    const paying = await account()
    const tariff = await seeded('start')
    expect(tariff.maxSites).toBe(1)
    const { caller } = paying
    await caller.project.create(site('Первый'))
    await subscribe(paying, 'start')

    await expect(caller.project.create(site('Второй'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'В ваш тариф входит один сайт. Чтобы добавить ещё один, выберите другой тариф в настройках',
      cause: { code: 'PROJECT_PLAN_LIMIT_REACHED', details: { maxSites: 1 } },
    })

    expect((await caller.billing.usage()).tariff?.sites).toEqual({ count: 1, max: 1 })
    expect(await caller.project.list()).toHaveLength(1)
  })

  it('holds a tariff to its number of sites from the checkout on, before the payment arrives', async () => {
    const paying = await account()
    expect((await seeded('start')).maxSites).toBe(1)
    const { caller, shop } = paying
    const another = 'Чтобы добавить ещё один, выберите другой тариф в настройках'
    // The customer goes to the payment page and, before paying, adds sites.
    const { orderId } = await caller.billing.startCheckout({ planSlug: 'start', autoRenew: false })
    await caller.project.create(site('Первый'))

    await expect(caller.project.create(site('Второй'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: `В тариф, который вы оплачиваете, входит один сайт. ${another}`,
      cause: { code: 'PROJECT_PLAN_LIMIT_REACHED', details: { maxSites: 1, unpaid: true } },
    })

    shop.payOnly()
    const { subscription } = await caller.billing.syncOrder({ orderId })

    // The tariff that started holds as many sites as it takes.
    expect(subscription).toMatchObject({ status: 'active', plan: { slug: 'start' } })
    expect((await caller.billing.usage()).tariff?.sites).toEqual({ count: 1, max: 1 })
    await expect(caller.project.create(site('Второй'))).rejects.toMatchObject({
      message: `В ваш тариф входит один сайт. ${another}`,
      cause: { code: 'PROJECT_PLAN_LIMIT_REACHED' },
    })
    expect(await caller.project.list()).toHaveLength(1)
  })

  it('follows the customer to the larger tariff they choose instead', async () => {
    const paying = await account()
    const larger = await seeded('business')
    expect(larger.maxSites).toBe(3)
    const { caller } = paying
    await caller.billing.startCheckout({ planSlug: 'start', autoRenew: false })
    await caller.project.create(site('Первый'))
    await expect(caller.project.create(site('Второй'))).rejects.toMatchObject({
      cause: { code: 'PROJECT_PLAN_LIMIT_REACHED', details: { maxSites: 1, unpaid: true } },
    })

    // Another choice closes the first order and starts one of its own.
    await caller.billing.startCheckout({ planSlug: 'business', autoRenew: false })

    await caller.project.create(site('Второй'))
    await caller.project.create(site('Третий'))
    await expect(caller.project.create(site('Четвёртый'))).rejects.toMatchObject({
      cause: { code: 'PROJECT_PLAN_LIMIT_REACHED', details: { maxSites: 3, unpaid: true } },
    })
    expect(await caller.project.list()).toHaveLength(3)
  })
})
