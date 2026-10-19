import { randomUUID } from 'node:crypto'

import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import { Money } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

import { lockCreditAccount } from './accounts.ts'
import { startCheckout, startPastDuePayment } from './checkout.ts'
import { MAX_USAGE_PAGE, usageEntrySchema, usageSummarySchema } from './dto.ts'
import { chargeTask, releaseTask, settleTaskCharge } from './holds.ts'
import {
  expireTariffRemainder,
  grantPackCredits,
  grantSignupGift,
  grantTariffCredits,
  ledgerKeys,
  post,
} from './ledger.ts'
import { getPromisedCreditsOverview } from './read-models.ts'
import { renewalKey } from './renewal-order.ts'
import { settleOrder } from './settlement.ts'
import { billingFixtures, billingTestDeps, underPrivateCreditRate } from './testing.ts'
import { getUsageSummary, listUsageHistory, promisedUsage } from './usage.ts'

const databaseUrl = process.env.DATABASE_URL
const WORKSPACE = '0199a000-0000-7000-8000-0000000000a1'
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
const PERIOD_MS = 30 * DAY_MS
/** The period of the fixtures' subscription. */
const PERIOD_START = new Date('2026-09-18T09:00:00.000Z')
const PERIOD_END = new Date('2026-10-18T09:00:00.000Z')
/** 15:00 in Moscow on 4 October 2026, inside that period. */
const NOW = new Date('2026-10-04T12:00:00.000Z')
const minutesAfter = (minutes: number, from = NOW) => new Date(from.getTime() + minutes * MINUTE_MS)

const noHistory = { items: [], nextCursor: null }
/** What a new task is told while nothing stands in its way. */
const TAKEN = { allowed: true, reason: null }

describe('usage input', () => {
  // A refused input never reaches the database: this client would throw a TypeError there.
  const db = {} as Parameters<typeof getUsageSummary>[0]

  it('refuses a workspace id that is not one, a moment that is not one and an unknown field', async () => {
    const input = { workspaceId: WORKSPACE, now: NOW }
    for (const broken of [
      { ...input, workspaceId: 'ws' },
      { ...input, now: new Date(Number.NaN) },
      { ...input, now: '2026-10-04' as unknown as Date },
      { ...input, userId: WORKSPACE },
    ]) {
      await expect(getUsageSummary(db, broken)).rejects.toBeInstanceOf(ZodError)
    }
  })

  it('refuses a page size or a cursor outside the query schema before reading', async () => {
    const findFirst = vi.fn()
    const reader = { subscription: { findFirst }, $queryRaw: vi.fn() }
    const history = reader as unknown as Parameters<typeof listUsageHistory>[0]
    await expect(listUsageHistory(history, WORKSPACE, { limit: 0 })).rejects.toThrow(ZodError)
    await expect(
      listUsageHistory(history, WORKSPACE, { limit: MAX_USAGE_PAGE + 1 }),
    ).rejects.toThrow(ZodError)
    await expect(listUsageHistory(history, WORKSPACE, { cursor: 'last' })).rejects.toThrow(ZodError)
    expect(findFirst).not.toHaveBeenCalled()
    expect(reader.$queryRaw).not.toHaveBeenCalled()
  })

  it('reads the history of a workspace without a live subscription as well: it has no period', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const reader = { subscription: { findFirst }, $queryRaw: vi.fn().mockResolvedValue([]) }
    expect(
      await listUsageHistory(
        reader as unknown as Parameters<typeof listUsageHistory>[0],
        WORKSPACE,
      ),
    ).toEqual(noHistory)
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { workspaceId: WORKSPACE, status: { in: ['trial', 'active', 'past_due'] } },
      select: { currentPeriodStart: true },
    })
    expect(reader.$queryRaw).toHaveBeenCalledOnce()
  })
})

describe('usage summary DTO', () => {
  const credits = { granted: 300, charged: 89, held: 45, expired: 0, left: 166, heldEarlier: 0 }
  // «Бизнес», 100 a day: 5 charged and 45 set aside today.
  const today = { limit: 100, charged: 5, held: 45, used: 50, room: 50, left: 50 }
  const tariff = {
    credits,
    today,
    sites: { count: 2, max: 3 },
    bySite: [],
  }
  const subscription = {
    id: WORKSPACE,
    status: 'active',
    plan: {
      id: WORKSPACE,
      slug: 'business',
      name: 'Бизнес',
      price: '12900.00',
      creditsPerMonth: 300,
      creditsPerDay: 100,
      maxSites: 3,
    },
    period: { start: PERIOD_START, end: PERIOD_END },
    autoRenewal: false,
    nextPlan: null,
    paymentMethod: null,
    pastDueSince: null,
  }
  const summary = {
    subscription,
    tariff,
    gift: { left: 0, held: 0, granted: false },
    pack: { left: 10, held: 0 },
    totalLeft: 176,
    history: noHistory,
    spendable: 176,
    spendableNow: 60,
    setAside: 45,
    minToStart: 5,
    today,
    newTask: TAKEN,
  }
  const withoutTariff = {
    ...summary,
    subscription: null,
    tariff: null,
    totalLeft: 10,
    spendable: 0,
    spendableNow: 0,
    setAside: 0,
    today: null,
    newTask: { allowed: false, reason: 'ended' },
  }

  it('accepts a tariff with its period and «no tariff» with the purchased credits', () => {
    expect(usageSummarySchema.safeParse(summary).success).toBe(true)
    expect(usageSummarySchema.safeParse(withoutTariff).success).toBe(true)
  })

  it('counts gift credits in what is left, with a tariff and without one', () => {
    const gift = { left: 30, held: 5, granted: true }
    expect(usageSummarySchema.parse({ ...summary, gift, totalLeft: 206 })).toMatchObject({
      gift,
      totalLeft: 206,
    })
    expect(usageSummarySchema.safeParse({ ...withoutTariff, gift, totalLeft: 40 }).success).toBe(
      true,
    )
  })

  it('accepts the gift a user without a workspace is promised: credits left, nothing granted', () => {
    const promised = {
      ...withoutTariff,
      gift: { left: 35, held: 0, granted: false },
      pack: { left: 0, held: 0 },
      totalLeft: 35,
      spendable: 35,
      spendableNow: 35,
      newTask: TAKEN,
    }
    expect(usageSummarySchema.parse(promised)).toEqual(promised)
  })

  it.each([
    // The example of the design: 89 charged, 45 set aside, 166 left of 300.
    ['what the period went to', {}],
    ['credits of the period that expired', { charged: 65, expired: 24 }],
    // Beside the meter: they are of the period that ended and add to nothing here.
    ['credits of an ended period still set aside', { heldEarlier: 45 }],
    ['a quota an operator added to', { granted: 310, left: 176 }],
  ])('accepts a meter that adds up: %s', (_case, patch) => {
    const meter = { ...credits, ...patch }
    const parsed = usageSummarySchema.parse({
      ...summary,
      tariff: { ...tariff, credits: meter },
      totalLeft: meter.left + 10,
    })
    expect(parsed.tariff?.credits).toEqual(meter)
    expect(meter.charged + meter.held + meter.expired + meter.left).toBe(meter.granted)
  })

  it.each([
    [
      'numbers of a period that do not add up',
      { tariff: { ...tariff, credits: { ...credits, charged: 88 } } },
    ],
    [
      'expired credits that the sum leaves out',
      { tariff: { ...tariff, credits: { ...credits, expired: 24 } } },
    ],
    [
      // 45 of the ended period are not of this one: counted in, the sum is wrong.
      'credits of an ended period counted into the meter',
      { tariff: { ...tariff, credits: { ...credits, held: 0, heldEarlier: 45 } } },
    ],
    [
      'a meter without the credits of an ended period',
      { tariff: { ...tariff, credits: { ...credits, heldEarlier: undefined } } },
    ],
    ['a total that is not the sum of the accounts', { totalLeft: 175 }],
    ['a total that leaves the gift out', { gift: { left: 30, held: 0, granted: true } }],
    ['a summary without the gift', { gift: undefined }],
    ['a gift that does not say whether it was granted', { gift: { left: 0, held: 0 } }],
    [
      'a fraction of a gift credit',
      { gift: { left: 0.5, held: 0, granted: true }, totalLeft: 176.5 },
    ],
    ['a period without a subscription', { subscription: null }],
    ['a subscription without its period', { tariff: null, totalLeft: 10 }],
    [
      'a tariff whose day is not the day of the answer',
      { today: { ...today, held: 40, used: 45, room: 55, left: 55 } },
    ],
    [
      'a tariff whose meter has no day while the answer has one',
      { tariff: { ...tariff, today: null } },
    ],
    ['a fraction of a credit', { pack: { left: 9.5, held: 0 }, totalLeft: 175.5 }],
    [
      'a site without a charged credit',
      { tariff: { ...tariff, bySite: [{ siteId: WORKSPACE, name: 'Сайт', credits: 0 }] } },
    ],
    ['a summary without its history', { history: undefined }],
    ['a summary that does not say whether a task would be taken', { newTask: undefined }],
    ['a task that is taken for a reason', { newTask: { allowed: true, reason: 'empty' } }],
    ['a task that is refused without a reason', { newTask: { allowed: false, reason: null } }],
    ['a reason no task is refused by', { newTask: { allowed: false, reason: 'no_money' } }],
    ['a new task that needs no credits', { minToStart: 0 }],
    ['a summary without the day a task is checked by', { today: undefined }],
    ['a day of tasks', { today: { used: 0, limit: 10 } }],
  ])('refuses %s', (_case, patch) => {
    expect(usageSummarySchema.safeParse({ ...summary, ...patch }).success).toBe(false)
  })

  // An overdue tariff has a meter of its period and no day: tariff credits are not spent then.
  it('accepts a tariff that is not paid, with no day on either side', () => {
    const overdue = {
      ...summary,
      subscription: { ...subscription, status: 'past_due', pastDueSince: PERIOD_END },
      tariff: { ...tariff, today: null },
      today: null,
      spendable: 0,
      spendableNow: 0,
      newTask: { allowed: false, reason: 'past_due' },
    }
    expect(usageSummarySchema.parse(overdue).tariff?.today).toBeNull()
  })
})

describe('usage history line DTO', () => {
  const line = {
    id: WORKSPACE,
    at: NOW,
    outcome: 'charged',
    credits: 17,
    from: { tariff: 5, gift: 0, pack: 12 },
    task: { id: WORKSPACE, title: 'Новый блок', status: 'done' },
    site: { id: WORKSPACE, name: 'Блог' },
  }
  const nothing = { credits: null, from: null }

  it.each([
    ['a charged task', {}],
    ['a task in work', { outcome: 'held', credits: 45, from: { tariff: 45, gift: 0, pack: 0 } }],
    ['a task that ended without a charge', { outcome: 'unpaid', ...nothing }],
    ['an undo', { outcome: 'free', ...nothing }],
  ])('accepts %s', (_case, patch) => {
    expect(usageEntrySchema.safeParse({ ...line, ...patch }).success).toBe(true)
  })

  it.each([
    ['a charged task without its credits', nothing],
    ['a charge of nothing', { credits: 0, from: { tariff: 0, gift: 0, pack: 0 } }],
    ['credits that are not the sum of their accounts', { credits: 18 }],
    ['credits without the accounts they are of', { from: null }],
    ['a task without a charge that names credits', { outcome: 'unpaid' }],
    ['an undo that names credits', { outcome: 'free' }],
    ['a credit that came back, as a line of its own', { outcome: 'returned', ...nothing }],
    ['a credit that expired, as a line of its own', { outcome: 'expired', ...nothing }],
  ])('refuses %s', (_case, patch) => {
    expect(usageEntrySchema.safeParse({ ...line, ...patch }).success).toBe(false)
  })
})

describe('promisedUsage', () => {
  // The credit rate is all the promise reads: this client has one in force and no price.
  const rated = {
    creditRate: {
      findFirst: () =>
        Promise.resolve({
          id: WORKSPACE,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          rubPerCredit: new Money('6'),
          basis: 'test',
        }),
    },
    llmModelPrice: { findFirst: () => Promise.resolve(null) },
  } as unknown as Parameters<typeof getPromisedCreditsOverview>[0]
  const unrated = {
    creditRate: { findFirst: () => Promise.resolve(null) },
    llmModelPrice: { findFirst: () => Promise.reject(new Error('Not asked without a rate')) },
  } as unknown as Parameters<typeof getPromisedCreditsOverview>[0]
  const promised = (db: typeof rated, giftGranted: boolean) =>
    getPromisedCreditsOverview(db, { giftGranted, now: NOW })
  const empty = {
    subscription: null,
    tariff: null,
    pack: { left: 0, held: 0 },
    history: noHistory,
    setAside: 0,
    minToStart: 5,
    today: null,
  }

  it('shows a user without a workspace the gift they are promised, and that a task would be taken', async () => {
    expect(promisedUsage(await promised(rated, false))).toEqual({
      ...empty,
      gift: { left: 35, held: 0, granted: false },
      totalLeft: 35,
      spendable: 35,
      spendableNow: 35,
      newTask: TAKEN,
    })
  })

  it('shows nothing to a user whose gift stands in the ledger', async () => {
    expect(promisedUsage(await promised(rated, true))).toEqual({
      ...empty,
      gift: { left: 0, held: 0, granted: false },
      totalLeft: 0,
      spendable: 0,
      spendableNow: 0,
      newTask: { allowed: false, reason: 'gift_spent' },
    })
  })

  it('tells that no task is taken while no credit rate is in force, whatever is promised', async () => {
    expect(promisedUsage(await promised(unrated, false))).toMatchObject({
      gift: { left: 35, held: 0, granted: false },
      spendable: 35,
      newTask: { allowed: false, reason: 'rate_missing' },
    })
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL usage summary', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  const workspaceIds: string[] = []
  const patient = { maxWait: 15_000, timeout: 30_000 }
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    // An undo refers to the task it reverts, and the tasks of a workspace go in one statement.
    await db.task.updateMany({
      where: { workspaceId: { in: workspaceIds.splice(0) }, revertsTaskId: { not: null } },
      data: { revertsTaskId: null },
    })
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /**
   * A workspace on a tariff of 300 credits a month and 2 sites, without a daily limit unless
   * told otherwise (`plan: startDay`) — active for the period of the fixtures unless told
   * otherwise, `subscription: null` for none — with the quota on the tariff account, granted by
   * the order of that period, and `pack` purchased credits.
   */
  async function funded(
    options: {
      tariff?: number
      pack?: number
      plan?: Partial<Prisma.PlanUncheckedCreateInput>
      subscription?: Partial<Parameters<typeof fixtures.subscription>[0]> | null
    } = {},
  ) {
    const { tariff = 300, pack = 0 } = options
    const { userId, workspaceId } = await fixtures.workspace()
    workspaceIds.push(workspaceId)
    const plan = await fixtures.plan({ creditsPerMonth: 300, maxSites: 2, ...options.plan })
    const subscription =
      options.subscription === null
        ? null
        : await fixtures.subscription({ workspaceId, planId: plan.id, ...options.subscription })
    if (tariff > 0) {
      const order = await fixtures.order({
        workspaceId,
        planId: plan.id,
        periodStart: subscription?.currentPeriodStart ?? PERIOD_START,
        periodEnd: subscription?.currentPeriodEnd ?? PERIOD_END,
      })
      await db.$transaction((tx) =>
        grantTariffCredits(tx, { workspaceId, orderId: order.id, credits: tariff }),
      )
    }
    if (pack > 0) await buyPack(workspaceId, pack)
    return { userId, workspaceId, plan, subscription }
  }

  /** «Старт» of the decision of 17.10.2026: of the 300 credits of a month, 50 a day. */
  const startDay = { creditsPerDay: 50 }
  /** The tariff credits of the Moscow day as the summary tells them. */
  const dayOf = (limit: number | null, charged: number, held: number, free: number) => {
    const used = charged + held
    const room = limit === null ? null : Math.max(0, limit - used)
    return { limit, charged, held, used, room, left: room === null ? free : Math.min(room, free) }
  }

  async function buyPack(workspaceId: string, credits: number) {
    const packPlan = await fixtures.plan({
      kind: 'pack',
      price: '1990.00',
      creditsPerMonth: null,
      maxSites: null,
      packCredits: credits,
    })
    const order = await fixtures.order({
      workspaceId,
      planId: packPlan.id,
      kind: 'pack',
      amount: '1990.00',
    })
    await db.$transaction((tx) => grantPackCredits(tx, { workspaceId, orderId: order.id, credits }))
  }

  const site = (workspaceId: string, name: string) =>
    db.site.create({
      data: { workspaceId, name, url: `https://${randomUUID()}.example.ru`, stack: 'wordpress' },
    })

  /** A task of the site in the class a new task of the queue has. */
  const task = (
    workspaceId: string,
    siteId: string,
    data: Partial<Prisma.TaskUncheckedCreateInput> = {},
  ) => db.task.create({ data: { workspaceId, siteId, modelClass: 'standard', ...data } })

  /**
   * Sets the step of an attempt aside — 45 credits, or what is free —, as the queue will;
   * `retry`: «Попробовать ещё» after the chain was given back.
   */
  const place = (
    workspaceId: string,
    taskId: string,
    { now = NOW, attempt = 1, retry }: { now?: Date; attempt?: number; retry?: true } = {},
  ) =>
    fixtures.reserve({
      workspaceId,
      taskId,
      attempt,
      now,
      expiresAt: new Date(now.getTime() + 60 * DAY_MS),
      ...(retry === undefined ? {} : { retry }),
    })
  /** The task is done for `credits`: the posting half of the charge. */
  const charge = (taskId: string, credits: number, { now = minutesAfter(20) } = {}) =>
    db.$transaction((tx) => settleTaskCharge(tx, { taskId, credits, now }))
  const release = (taskId: string, { now = minutesAfter(20) } = {}) =>
    db.$transaction((tx) => releaseTask(tx, { taskId, now }))

  /** A task of the site whose reserve is placed at `now` and which is then done for `credits`. */
  async function charged(workspaceId: string, siteId: string, now = NOW, credits = 5) {
    const { id } = await task(workspaceId, siteId, { status: 'done' })
    await place(workspaceId, id, { now })
    await charge(id, credits, { now: minutesAfter(20, now) })
    return { taskId: id }
  }

  /**
   * The task is done and charged the way the queue will charge it: from a recorded model call
   * that cost `costRub` of accounting cost, at 6.00 RUB in a credit (`chargeTask`).
   */
  async function doneFor(taskId: string, costRub: string, { now = minutesAfter(20) } = {}) {
    const pool = await fixtures.modelPool()
    const price = await fixtures.modelPrice(pool, {
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    })
    await fixtures.modelCall({
      taskId,
      pool,
      priceId: price.id,
      costRub,
      occurredAt: new Date(now.getTime() - MINUTE_MS),
    })
    await db.task.update({ where: { id: taskId }, data: { status: 'done' } })
    return db.$transaction(
      (tx) => underPrivateCreditRate(tx, () => chargeTask(tx, { taskId, now })),
      patient,
    )
  }

  /**
   * What a renewal does in one transaction: the remainder goes, the period moves, the quota
   * comes — paid by the order of the new period. The remainder is written by the transaction
   * that starts the new period, so by the clock it is a row of the new period: it is stamped so.
   */
  async function renew(workspaceId: string, subscriptionId: string, planId: string, credits = 300) {
    const next = { start: PERIOD_END, end: new Date(PERIOD_END.getTime() + PERIOD_MS) }
    const order = await fixtures.order({
      workspaceId,
      planId,
      periodStart: next.start,
      periodEnd: next.end,
    })
    await db.$transaction(async (tx) => {
      await expireTariffRemainder(tx, { workspaceId, subscriptionId, periodEnd: PERIOD_END })
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: { currentPeriodStart: next.start, currentPeriodEnd: next.end },
      })
      await grantTariffCredits(tx, { workspaceId, orderId: order.id, credits })
    })
    await db.creditLedger.updateMany({
      where: { idempotencyKey: ledgerKeys.tariffExpiry(subscriptionId, PERIOD_END) },
      data: { createdAt: minutesAfter(1, PERIOD_END) },
    })
  }

  /** The summary as the page reads it, with a credit rate in force that nobody else sees. */
  const summaryAt = (workspaceId: string, now = NOW) =>
    db.$transaction(
      (tx) => underPrivateCreditRate(tx, () => getUsageSummary(tx, { workspaceId, now })),
      patient,
    )
  const tariffAt = async (workspaceId: string, now = NOW) => {
    const { tariff } = await summaryAt(workspaceId, now)
    if (tariff === null) throw new Error('The scenario needs a tariff')
    return tariff
  }
  const meterAt = async (workspaceId: string, now = NOW) =>
    (await tariffAt(workspaceId, now)).credits
  const historyAt = async (workspaceId: string, now = NOW) =>
    (await summaryAt(workspaceId, now)).history

  /** The tariff account as it stands: what its meter has to explain. */
  const tariffAccount = (workspaceId: string) =>
    db.billingAccount.findUniqueOrThrow({
      where: { workspaceId_unit: { workspaceId, unit: 'credit_tariff' } },
      select: { balance: true, held: true },
    })
  const balanceOf = async (workspaceId: string) => {
    const { balance, held } = await tariffAccount(workspaceId)
    return { balance: balance.toNumber(), held: held.toNumber() }
  }

  const NOTHING_SPENT = { charged: 0, held: 0, expired: 0, heldEarlier: 0 }
  const FULL = { granted: 300, ...NOTHING_SPENT, left: 300 }

  it('shows the full quota of a fresh tariff and nothing spent', async () => {
    const { workspaceId, plan, subscription } = await funded({ plan: startDay })

    expect(await summaryAt(workspaceId)).toEqual({
      subscription: {
        id: subscription!.id,
        status: 'active',
        plan: {
          id: plan.id,
          slug: plan.slug,
          name: 'Проверочный',
          price: '4900.00',
          creditsPerMonth: 300,
          creditsPerDay: 50,
          maxSites: 2,
        },
        period: { start: PERIOD_START, end: PERIOD_END },
        autoRenewal: false,
        nextPlan: null,
        paymentMethod: null,
        pastDueSince: null,
      },
      tariff: {
        credits: FULL,
        today: dayOf(50, 0, 0, 300),
        sites: { count: 0, max: 2 },
        bySite: [],
      },
      gift: { left: 0, held: 0, granted: false },
      pack: { left: 0, held: 0 },
      totalLeft: 300,
      history: noHistory,
      spendable: 300,
      spendableNow: 50,
      setAside: 0,
      minToStart: 5,
      today: dayOf(50, 0, 0, 300),
      newTask: TAKEN,
    })
  })

  it('tells that no task is taken while no credit rate is in force, and still shows the credits', async () => {
    const { workspaceId } = await funded()

    // Read as the page reads it, on a database that has no rate.
    const summary = await getUsageSummary(db, { workspaceId, now: NOW })

    expect(summary.newTask).toEqual({ allowed: false, reason: 'rate_missing' })
    expect(summary).toMatchObject({ spendable: 300, setAside: 0, minToStart: 5, totalLeft: 300 })
    expect(summary.tariff?.credits).toEqual(FULL)
  })

  it('adds gift credits to what is left and leaves the quota of the period as it is', async () => {
    const { userId, workspaceId } = await funded({ pack: 100, plan: startDay })
    await db.$transaction((tx) => grantSignupGift(tx, { userId, workspaceId }))

    const summary = await summaryAt(workspaceId)

    expect(summary.gift).toEqual({ left: 35, held: 0, granted: true })
    expect(summary.pack).toEqual({ left: 100, held: 0 })
    expect(summary.totalLeft).toBe(435)
    expect(summary.spendable).toBe(435)
    // Gift and pack credits are outside the day: fifty of the tariff, and all of them.
    expect(summary.spendableNow).toBe(185)
    // The gift is no part of the quota: it was not granted for the period and is not charged
    // to it.
    expect(summary.tariff).toMatchObject({
      credits: FULL,
      today: dayOf(50, 0, 0, 300),
      bySite: [],
    })
    expect(summary.history).toEqual(noHistory)
  })

  it('shows gift credits a task has set aside as held, not as left', async () => {
    const { userId, workspaceId } = await funded()
    await db.$transaction((tx) => grantSignupGift(tx, { userId, workspaceId }))
    await fixtures.hold(workspaceId, 'gift', 5)

    const summary = await summaryAt(workspaceId)

    expect(summary.gift).toEqual({ left: 30, held: 5, granted: true })
    expect(summary.totalLeft).toBe(330)
    expect(summary).toMatchObject({ spendable: 330, setAside: 5, newTask: TAKEN })
    expect(summary.tariff?.credits).toEqual(FULL)
  })

  it('adds purchased credits to what is left and leaves the tariff as it is', async () => {
    const { workspaceId } = await funded()
    await buyPack(workspaceId, 100)

    const summary = await summaryAt(workspaceId)

    expect(summary.pack).toEqual({ left: 100, held: 0 })
    expect(summary.totalLeft).toBe(400)
    expect(summary.tariff).toMatchObject({ credits: FULL, bySite: [] })
    expect(summary.history).toEqual(noHistory)
  })

  describe('what the quota went to', () => {
    it('tells every outcome of a task: charged, in work, without a charge and free', async () => {
      const { workspaceId } = await funded({ pack: 100, plan: { maxSites: 3 } })
      const bakery = await site(workspaceId, 'Пекарня «Добро»')
      const cafe = await site(workspaceId, 'Кофейня на Лесной')
      const done = await task(workspaceId, bakery.id, {
        summary: 'Поправил часы работы в контактах',
      })
      const failed = await task(workspaceId, bakery.id, { status: 'failed' })
      const cancelled = await task(workspaceId, bakery.id, { status: 'cancelled' })
      const rolledBack = await task(workspaceId, cafe.id, { status: 'rolled_back' })
      const running = await task(workspaceId, cafe.id, { status: 'running', summary: '   ' })
      const undo = await task(workspaceId, cafe.id, {
        status: 'done',
        billable: false,
        revertsTaskId: done.id,
        summary: 'Вернул прежний баннер',
        createdAt: minutesAfter(5),
      })
      await place(workspaceId, done.id, { now: minutesAfter(0) })
      // A small edit: 22.09 RUB of accounting cost is 3.68 credits, charged the minimum.
      const smallEdit = await doneFor(done.id, '22.09', { now: minutesAfter(1) })
      expect(smallEdit.credits).toBe(5)
      await place(workspaceId, failed.id, { now: minutesAfter(1) })
      await release(failed.id, { now: minutesAfter(2) })
      await place(workspaceId, cancelled.id, { now: minutesAfter(2) })
      await release(cancelled.id, { now: minutesAfter(3) })
      await place(workspaceId, rolledBack.id, { now: minutesAfter(3) })
      await release(rolledBack.id, { now: minutesAfter(4) })
      await place(workspaceId, running.id, { now: minutesAfter(4) })

      const summary = await summaryAt(workspaceId)

      expect(summary.tariff).toEqual({
        // Five of the 45 set aside for the done task were charged; the 45 of the running one
        // are held, as a sum of what its reserve holds; the three that came back are left.
        credits: { granted: 300, charged: 5, held: 45, expired: 0, left: 250, heldEarlier: 0 },
        // What the day took of the tariff: the 5 charged and the 45 set aside; the reserves that
        // came back took nothing. This plan has no daily limit.
        today: dayOf(null, 5, 45, 250),
        sites: { count: 2, max: 3 },
        bySite: [{ siteId: bakery.id, name: 'Пекарня «Добро»', credits: 5 }],
      })
      const from = (tariff: number) => ({ tariff, gift: 0, pack: 0 })
      const nothing = { credits: null, from: null }
      expect(summary.history).toEqual({
        items: [
          {
            id: undo.id,
            at: minutesAfter(5),
            outcome: 'free',
            ...nothing,
            task: { id: undo.id, title: 'Вернул прежний баннер', status: 'done' },
            site: { id: cafe.id, name: 'Кофейня на Лесной' },
          },
          {
            id: running.id,
            at: minutesAfter(4),
            outcome: 'held',
            credits: 45,
            from: from(45),
            // A summary of spaces is no title.
            task: { id: running.id, title: null, status: 'running' },
            site: { id: cafe.id, name: 'Кофейня на Лесной' },
          },
          {
            id: rolledBack.id,
            at: minutesAfter(3),
            outcome: 'unpaid',
            ...nothing,
            task: { id: rolledBack.id, title: null, status: 'rolled_back' },
            site: { id: cafe.id, name: 'Кофейня на Лесной' },
          },
          {
            id: cancelled.id,
            at: minutesAfter(2),
            outcome: 'unpaid',
            ...nothing,
            task: { id: cancelled.id, title: null, status: 'cancelled' },
            site: { id: bakery.id, name: 'Пекарня «Добро»' },
          },
          {
            id: failed.id,
            at: minutesAfter(1),
            outcome: 'unpaid',
            ...nothing,
            task: { id: failed.id, title: null, status: 'failed' },
            site: { id: bakery.id, name: 'Пекарня «Добро»' },
          },
          {
            id: done.id,
            at: minutesAfter(0),
            outcome: 'charged',
            credits: 5,
            from: from(5),
            task: { id: done.id, title: 'Поправил часы работы в контактах', status: 'done' },
            site: { id: bakery.id, name: 'Пекарня «Добро»' },
          },
        ],
        nextCursor: null,
      })
      expect(summary.pack).toEqual({ left: 100, held: 0 })
      expect(summary.totalLeft).toBe(350)
      expect(summary).toMatchObject({ spendable: 350, setAside: 45, newTask: TAKEN })
    })

    it('shows a task charged on two accounts as one line, with what each of them paid', async () => {
      // The first walk of the design: 5 credits of the tariff, 100 of a pack, a new block.
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const shop = await site(workspaceId, 'Магазин')
      const block = await task(workspaceId, shop.id)
      const { holds } = await place(workspaceId, block.id)
      expect(holds.map((hold) => [hold.unit, hold.amount.toNumber()])).toEqual([
        ['credit_tariff', 5],
        ['credit_pack', 40],
      ])

      const inWork = await summaryAt(workspaceId)

      expect(inWork.tariff?.credits).toEqual({
        granted: 5,
        charged: 0,
        held: 5,
        expired: 0,
        left: 0,
        heldEarlier: 0,
      })
      expect(inWork.pack).toEqual({ left: 60, held: 40 })
      expect(inWork.history.items).toMatchObject([
        { id: block.id, outcome: 'held', credits: 45, from: { tariff: 5, gift: 0, pack: 40 } },
      ])

      // 101.37 RUB of accounting cost: 16.90 credits, charged 17.
      const paid = await doneFor(block.id, '101.37')
      expect(paid).toMatchObject({ credits: 17, from: { tariff: 5, gift: 0, pack: 12 } })
      const done = await summaryAt(workspaceId)

      expect(done.tariff?.credits).toEqual({
        granted: 5,
        charged: 5,
        held: 0,
        expired: 0,
        left: 0,
        heldEarlier: 0,
      })
      expect(done.pack).toEqual({ left: 88, held: 0 })
      // One line and one sum by site, whatever accounts paid.
      expect(done.tariff?.bySite).toEqual([{ siteId: shop.id, name: 'Магазин', credits: 17 }])
      expect(done.history.items).toMatchObject([
        { id: block.id, outcome: 'charged', credits: 17, from: { tariff: 5, gift: 0, pack: 12 } },
      ])
      expect(done.history.items).toHaveLength(1)
    })

    it('shows a task whose reserve stands on three accounts as one line, and sums what they paid', async () => {
      const { userId, workspaceId } = await funded({ tariff: 5, pack: 100, plan: startDay })
      await db.$transaction((tx) => grantSignupGift(tx, { userId, workspaceId }))
      const shop = await site(workspaceId, 'Магазин')
      const big = await task(workspaceId, shop.id, { status: 'running' })
      // 5 of the tariff, 35 of the gift and 5 of the pack: three rows of one attempt.
      await place(workspaceId, big.id)
      expect(await db.creditHold.count({ where: { taskId: big.id } })).toBe(3)

      const inWork = await summaryAt(workspaceId)

      expect(inWork.tariff?.credits).toMatchObject({ granted: 5, held: 5, left: 0 })
      expect(inWork.gift).toEqual({ left: 0, held: 35, granted: true })
      expect(inWork.pack).toEqual({ left: 95, held: 5 })
      // One line; the day took five of the tariff, gift and pack credits are outside it.
      expect(inWork.tariff?.today).toEqual(dayOf(50, 0, 5, 0))
      expect(inWork.history.items).toMatchObject([
        { id: big.id, outcome: 'held', credits: 45, from: { tariff: 5, gift: 35, pack: 5 } },
      ])

      // Done for 43: the tariff pays 5, the gift 35, the pack 3.
      await charge(big.id, 43)
      const done = await summaryAt(workspaceId)

      expect(done.tariff?.bySite).toEqual([{ siteId: shop.id, name: 'Магазин', credits: 43 }])
      expect(done.history.items).toMatchObject([
        { id: big.id, outcome: 'charged', credits: 43, from: { tariff: 5, gift: 35, pack: 3 } },
      ])
    })

    it('shows the accounts that paid for a task, not the ones its reserve stood on', async () => {
      // The second walk of the design: two tasks in work at once.
      const { workspaceId } = await funded({ tariff: 40, pack: 100 })
      const shop = await site(workspaceId, 'Магазин')
      const small = await task(workspaceId, shop.id, { status: 'done' })
      const block = await task(workspaceId, shop.id, { status: 'done' })
      // The first takes the tariff and five credits of the pack, the second stands on the pack.
      await place(workspaceId, small.id, { now: minutesAfter(0) })
      await place(workspaceId, block.id, { now: minutesAfter(1) })
      expect((await historyAt(workspaceId)).items).toMatchObject([
        { id: block.id, outcome: 'held', credits: 45, from: { tariff: 0, gift: 0, pack: 45 } },
        { id: small.id, outcome: 'held', credits: 45, from: { tariff: 40, gift: 0, pack: 5 } },
      ])
      // The first is done for 5 and frees 35 tariff credits: they pay the 17 of the second.
      await charge(small.id, 5, { now: minutesAfter(20) })
      await charge(block.id, 17, { now: minutesAfter(21) })

      const summary = await summaryAt(workspaceId)

      expect(summary.pack).toEqual({ left: 100, held: 0 })
      expect(summary.tariff?.credits).toEqual({
        granted: 40,
        charged: 22,
        held: 0,
        expired: 0,
        left: 18,
        heldEarlier: 0,
      })
      expect(summary.history.items).toMatchObject([
        { id: block.id, outcome: 'charged', credits: 17, from: { tariff: 17, gift: 0, pack: 0 } },
        { id: small.id, outcome: 'charged', credits: 5, from: { tariff: 5, gift: 0, pack: 0 } },
      ])
    })

    it('counts purchased credits once the quota is used up', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 60 })
      const shop = await site(workspaceId, 'Магазин')
      // Reserved on the tariff and the pack, paid by the tariff alone.
      const first = await charged(workspaceId, shop.id, minutesAfter(0), 5)
      const fromPack = await charged(workspaceId, shop.id, minutesAfter(1), 17)
      const waiting = await task(workspaceId, shop.id, { status: 'awaiting_user' })
      await place(workspaceId, waiting.id, { now: minutesAfter(2) })

      const summary = await summaryAt(workspaceId)

      expect(summary.tariff).toMatchObject({
        // What the period was granted is what the ledger says, not what the plan promises.
        credits: { granted: 5, charged: 5, held: 0, expired: 0, left: 0, heldEarlier: 0 },
        // Only the tariff counts in the day: the 5 the first task paid.
        today: dayOf(null, 5, 0, 0),
        // Five from the tariff and 17 from the pack.
        bySite: [{ siteId: shop.id, name: 'Магазин', credits: 22 }],
      })
      // The waiting task took everything the pack had left.
      expect(summary.pack).toEqual({ left: 0, held: 43 })
      expect(summary.totalLeft).toBe(0)
      // Credits exist, and all of them wait for the task in work.
      expect(summary).toMatchObject({
        spendable: 0,
        setAside: 43,
        newTask: { allowed: false, reason: 'held' },
      })
      expect(
        summary.history.items.map(({ id, outcome, credits, from }) => [id, outcome, credits, from]),
      ).toEqual([
        [waiting.id, 'held', 43, { tariff: 0, gift: 0, pack: 43 }],
        [fromPack.taskId, 'charged', 17, { tariff: 0, gift: 0, pack: 17 }],
        [first.taskId, 'charged', 5, { tariff: 5, gift: 0, pack: 0 }],
      ])
    })

    it('sums the charged credits of each site and puts the largest first', async () => {
      const { workspaceId } = await funded({ plan: { maxSites: 3 } })
      const quiet = await site(workspaceId, 'Аптека')
      const busy = await site(workspaceId, 'Яблоко')
      const equal = await site(workspaceId, 'Булочная')
      const idle = await site(workspaceId, 'Без задач')
      for (const [target, count] of [
        [quiet, 2],
        [busy, 3],
        [equal, 2],
      ] as const) {
        for (let index = 0; index < count; index += 1) await charged(workspaceId, target.id)
      }
      // Reserved and returned credits are not charged ones.
      const inWork = await task(workspaceId, idle.id)
      await place(workspaceId, inWork.id)
      const back = await task(workspaceId, idle.id, { status: 'cancelled' })
      await place(workspaceId, back.id)
      await release(back.id)

      const tariff = await tariffAt(workspaceId)

      expect(tariff.bySite).toEqual([
        { siteId: busy.id, name: 'Яблоко', credits: 15 },
        // Equal sites go by name.
        { siteId: quiet.id, name: 'Аптека', credits: 10 },
        { siteId: equal.id, name: 'Булочная', credits: 10 },
      ])
      expect(tariff.credits).toEqual({
        granted: 300,
        charged: 35,
        held: 45,
        expired: 0,
        left: 220,
        heldEarlier: 0,
      })
      expect(tariff.sites).toEqual({ count: 4, max: 3 })
    })

    it('shows a task that was tried again as one line, at the moment of its first reserve', async () => {
      const { workspaceId } = await funded()
      const blog = await site(workspaceId, 'Блог')
      const retried = await task(workspaceId, blog.id, { status: 'done', attempt: 2 })
      await place(workspaceId, retried.id, { now: minutesAfter(0), attempt: 1 })
      await release(retried.id)
      expect((await historyAt(workspaceId)).items).toMatchObject([
        { id: retried.id, outcome: 'unpaid', credits: null, from: null },
      ])
      await place(workspaceId, retried.id, { now: minutesAfter(5), attempt: 2, retry: true })
      // In work again: what is set aside is what its active rows hold — the 45 of the second
      // attempt, not the 45 of the first one as well, which came back.
      expect((await historyAt(workspaceId)).items).toMatchObject([
        { id: retried.id, outcome: 'held', credits: 45, from: { tariff: 45, gift: 0, pack: 0 } },
      ])
      await charge(retried.id, 17)

      const summary = await summaryAt(workspaceId)

      expect(summary.tariff?.credits).toMatchObject({ charged: 17, held: 0, left: 283 })
      expect(summary.tariff?.bySite).toEqual([{ siteId: blog.id, name: 'Блог', credits: 17 }])
      expect(
        summary.history.items.map(({ id, at, outcome, credits }) => [id, at, outcome, credits]),
      ).toEqual([[retried.id, minutesAfter(0), 'charged', 17]])
    })

    it('reports credits an operator took off or added, and still adds up', async () => {
      const { workspaceId } = await funded()
      const adjust = (credits: number, at: Date) =>
        db.$transaction(async (tx) => {
          const account = await lockCreditAccount(tx, workspaceId, 'tariff')
          if (account === null) throw new Error('The scenario needs a tariff account')
          await post(tx, {
            account,
            kind: 'adjust',
            amount: new Money(credits),
            orderId: null,
            idempotencyKey: `test:${randomUUID()}:adjust`,
            note: 'Usage test',
            createdAt: at,
          })
        })

      await adjust(-50, minutesAfter(1))
      // Taken off the account: gone without a charge.
      expect(await meterAt(workspaceId)).toEqual({ ...FULL, expired: 50, left: 250 })

      await adjust(80, minutesAfter(2))
      // Added to the account: the period was granted that much more.
      expect(await meterAt(workspaceId)).toEqual({
        ...FULL,
        granted: 380,
        expired: 50,
        left: 330,
      })
    })
  })

  describe('the end of a period', () => {
    /** 17 October 2026, the day before the period of the fixtures ends. */
    const DAY_BEFORE = new Date('2026-10-17T12:00:00.000Z')
    /** 19 October 2026, the day after the renewal. */
    const DAY_AFTER = new Date('2026-10-19T12:00:00.000Z')

    it('adds up through the sequence of the design: a reserve of 45, the renewal, a charge of 17', async () => {
      const { workspaceId, plan, subscription } = await funded({ plan: startDay })
      const blog = await site(workspaceId, 'Блог')
      const long = await task(workspaceId, blog.id, { status: 'running' })
      // 45 tariff credits reserved on the 17th.
      const { holds } = await place(workspaceId, long.id, { now: DAY_BEFORE })
      expect(await meterAt(workspaceId, DAY_BEFORE)).toEqual({ ...FULL, held: 45, left: 255 })
      expect((await historyAt(workspaceId, DAY_BEFORE)).items).toHaveLength(1)

      // The period renews on the 18th with 300 new credits: 255 expired, the 45 stayed.
      await renew(workspaceId, subscription!.id, plan.id)
      expect(await balanceOf(workspaceId)).toEqual({ balance: 345, held: 45 })
      const renewed = await summaryAt(workspaceId, minutesAfter(1, PERIOD_END))
      expect(renewed.subscription?.period).toEqual({
        start: PERIOD_END,
        end: new Date(PERIOD_END.getTime() + PERIOD_MS),
      })
      // 300 = 0 + 0 + 0 + 300: the credits in work are of the period that ended, and stand
      // beside the meter of the new one.
      expect(renewed.tariff).toEqual({
        credits: { ...FULL, heldEarlier: 45 },
        // The reserve of the 17th takes nothing of the 18th.
        today: dayOf(50, 0, 0, 300),
        sites: { count: 1, max: 2 },
        bySite: [],
      })
      expect(renewed.history).toEqual(noHistory)
      expect(renewed).toMatchObject({ totalLeft: 300, spendable: 300, setAside: 45 })

      // The task is done on the 19th for 17: the old row pays 17 and its other 28 expire.
      await charge(long.id, 17, { now: DAY_AFTER })
      expect(await balanceOf(workspaceId)).toEqual({ balance: 300, held: 0 })
      const paid = await db.creditLedger.findUniqueOrThrow({
        where: { idempotencyKey: ledgerKeys.holdCharge(holds[0]!.id) },
      })
      // Written — and stamped — in the new period, and still of the period of its reserve.
      expect(paid.createdAt).toEqual(DAY_AFTER)
      const settled = await summaryAt(workspaceId, DAY_AFTER)
      // 300 = 0 + 0 + 0 + 300 again: the 17 and the 28 are of the period that ended.
      expect(settled.tariff?.credits).toEqual(FULL)
      expect(settled.tariff?.bySite).toEqual([])
      expect(settled.history).toEqual(noHistory)
    })

    it('keeps a task continued across a renewal in the period of its first reserve, as one line with its whole charge', async () => {
      const { workspaceId, plan, subscription } = await funded({ plan: startDay })
      const blog = await site(workspaceId, 'Блог')
      const long = await task(workspaceId, blog.id, { status: 'awaiting_user' })
      await place(workspaceId, long.id, { now: DAY_BEFORE })
      await renew(workspaceId, subscription!.id, plan.id)
      const afterRenewal = minutesAfter(1, PERIOD_END)
      // «Продолжить» after the renewal: the second attempt reserves credits of the new quota.
      await place(workspaceId, long.id, { now: afterRenewal, attempt: 2 })

      const continued = await summaryAt(workspaceId, minutesAfter(2, PERIOD_END))

      // The row of the new period is held in it; the row of the old one stands beside the meter.
      expect(continued.tariff?.credits).toEqual({ ...FULL, held: 45, left: 255, heldEarlier: 45 })
      // «Продолжить» took 45 of the 18th.
      expect(continued.tariff?.today).toEqual(dayOf(50, 0, 45, 255))
      // The line of the task is of the period it was first queued in.
      expect(continued.history).toEqual(noHistory)

      // Done for 50 of the 90 set aside: the row of the ended period pays its 45, the quota
      // of the new one the other 5.
      await charge(long.id, 50, { now: DAY_AFTER })
      const settled = await summaryAt(workspaceId, DAY_AFTER)
      // The meter counts each ledger row in its own period.
      expect(settled.tariff?.credits).toEqual({ ...FULL, charged: 5, left: 295 })
      expect(settled.tariff?.bySite).toEqual([{ siteId: blog.id, name: 'Блог', credits: 5 }])
      expect(settled.history).toEqual(noHistory)

      // Once there is no period — the tariff has ended —, the history has no lower bound: the
      // task is one line, at the moment of its first reserve, with everything it was charged.
      await db.subscription.update({
        where: { id: subscription!.id },
        data: { status: 'cancelled' },
      })
      const whole = await summaryAt(workspaceId, DAY_AFTER)
      expect(whole.tariff).toBeNull()
      expect(whole.history.items).toEqual([
        {
          id: long.id,
          at: DAY_BEFORE,
          outcome: 'charged',
          credits: 50,
          from: { tariff: 50, gift: 0, pack: 0 },
          task: { id: long.id, title: null, status: 'awaiting_user' },
          site: { id: blog.id, name: 'Блог' },
        },
      ])
    })

    it('takes the first moment of a period into it', async () => {
      const { workspaceId } = await funded()
      const blog = await site(workspaceId, 'Блог')
      // The clock that queues the task is behind the clock that started the period: the reserve
      // is stamped with the start of the period.
      const early = await charged(workspaceId, blog.id, minutesAfter(-5, PERIOD_START))
      expect(
        (await db.creditHold.findFirstOrThrow({ where: { taskId: early.taskId } })).createdAt,
      ).toEqual(PERIOD_START)

      const waiting = await task(workspaceId, blog.id)
      await place(workspaceId, waiting.id, { now: minutesAfter(-4, PERIOD_START) })

      const summary = await summaryAt(workspaceId, PERIOD_START)

      expect(summary.tariff?.credits).toEqual({ ...FULL, charged: 5, held: 45, left: 250 })
      expect(summary.tariff?.bySite).toEqual([{ siteId: blog.id, name: 'Блог', credits: 5 }])
      expect(summary.history.items.map(({ id, at }) => [id, at]).sort()).toEqual(
        [
          [early.taskId, PERIOD_START],
          [waiting.id, PERIOD_START],
        ].sort(),
      )
    })

    it('counts credits taken after the period ended, while the renewal is not settled, in that period', async () => {
      const { workspaceId, plan, subscription } = await funded({ plan: startDay })
      const blog = await site(workspaceId, 'Блог')
      const late = await task(workspaceId, blog.id)
      const placedAt = minutesAfter(2, PERIOD_END)
      await place(workspaceId, late.id, { now: placedAt })

      const before = await summaryAt(workspaceId, minutesAfter(3, PERIOD_END))
      expect(before.tariff?.credits).toEqual({ ...FULL, held: 45, left: 255 })
      // The line stands at the moment the task was queued, whatever the stamp of its period.
      expect(before.history.items.map(({ id, at, outcome }) => [id, at, outcome])).toEqual([
        [late.id, placedAt, 'held'],
      ])
      // And the reserve takes credits of the day it was placed on.
      expect(before.tariff?.today).toEqual(dayOf(50, 0, 45, 255))

      await renew(workspaceId, subscription!.id, plan.id)
      const after = await summaryAt(workspaceId, minutesAfter(4, PERIOD_END))
      expect(after.tariff?.credits).toEqual({ ...FULL, heldEarlier: 45 })
      expect(after.history).toEqual(noHistory)
      // The renewal does not give the day back.
      expect(after.tariff?.today).toEqual(dayOf(50, 0, 45, 300))
    })

    it('shows a tariff whose payment failed with its numbers as they are', async () => {
      const { workspaceId, subscription } = await funded()
      const blog = await site(workspaceId, 'Блог')
      const paid = await charged(workspaceId, blog.id)
      const stuck = await task(workspaceId, blog.id, { status: 'failed' })
      await place(workspaceId, stuck.id, { now: minutesAfter(1) })
      const inWork = await task(workspaceId, blog.id, { status: 'done' })
      await place(workspaceId, inWork.id, { now: minutesAfter(2) })
      await db.subscription.update({
        where: { id: subscription!.id },
        data: { status: 'past_due', pastDueSince: PERIOD_END },
      })
      const overdue = minutesAfter(60, PERIOD_END)
      // Credits of the tariff given back while the tariff is not paid for do not come back,
      // and a task that is done then is paid by its own reserve, the rest of which expires.
      await release(stuck.id, { now: overdue })
      await charge(inWork.id, 20, { now: overdue })

      const summary = await summaryAt(workspaceId, overdue)

      expect(summary.subscription).toMatchObject({ status: 'past_due', pastDueSince: PERIOD_END })
      // 25 charged; 45 that expired with one reserve and 25 with the other; 205 not used.
      expect(summary.tariff?.credits).toEqual({
        granted: 300,
        charged: 25,
        held: 0,
        expired: 70,
        left: 205,
        heldEarlier: 0,
      })
      expect(
        summary.history.items.map(({ id, outcome, credits }) => [id, outcome, credits]),
      ).toEqual([
        [inWork.id, 'charged', 20],
        // An expired reserve is no line of its own: the task ended without a charge.
        [stuck.id, 'unpaid', null],
        [paid.taskId, 'charged', 5],
      ])
      expect(summary.totalLeft).toBe(205)
      // Nothing of an unpaid tariff can be spent.
      expect(summary).toMatchObject({
        spendable: 0,
        newTask: { allowed: false, reason: 'past_due' },
      })
    })
  })

  describe('the real payments', () => {
    // The periods are in the past of any clock these tests run by: the rows the settlement
    // stamps with the clock of the database — the grant, the remainder that expired — are then
    // written after the period they open has started, as in production.
    const FIRST_PAID = '2026-06-01T09:00:00.000Z'
    const FIRST = { start: new Date(FIRST_PAID), end: new Date('2026-07-01T09:00:00.000Z') }
    const SECOND_END = new Date('2026-08-01T09:00:00.000Z')
    const inFirst = (minutes: number) => minutesAfter(minutes, new Date('2026-06-10T12:00:00.000Z'))

    /** A user who paid for a tariff of 300 credits on 1 June 2026, through the checkout. */
    async function subscribed() {
      const { userId } = await fixtures.user()
      const plan = await fixtures.plan({ isActive: true, creditsPerMonth: 300, maxSites: 2 })
      const { shop, deps } = billingTestDeps(db)
      const { orderId } = await startCheckout(deps, {
        userId,
        planSlug: plan.slug,
        autoRenew: false,
      })
      shop.succeed(shop.only().id, { capturedAt: FIRST_PAID })
      expect(await settleOrder(deps, { orderId })).toMatchObject({ state: 'paid' })
      const subscription = await db.subscription.findFirstOrThrow({
        where: { workspace: { createdById: userId } },
      })
      expect(subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: FIRST.start,
        currentPeriodEnd: FIRST.end,
      })
      const { workspaceId } = subscription
      return { shop, deps, userId, plan, workspaceId, subscriptionId: subscription.id }
    }
    type Subscribed = Awaited<ReturnType<typeof subscribed>>

    /** The renewal charge of the period that ended on 1 July went through. */
    async function renewed(s: Subscribed) {
      const order = await fixtures.order({
        workspaceId: s.workspaceId,
        planId: s.plan.id,
        userId: s.userId,
        subscriptionId: s.subscriptionId,
        status: 'pending',
        idempotenceKey: renewalKey(s.subscriptionId, FIRST.end),
      })
      const payment = await s.shop.client.createPayment(
        {
          amount: { value: '4900.00', currency: 'RUB' },
          capture: true,
          description: 'Renewal',
          metadata: { order_id: order.id, workspace_id: s.workspaceId },
        },
        order.idempotenceKey,
      )
      await db.order.update({ where: { id: order.id }, data: { yookassaPaymentId: payment.id } })
      s.shop.succeed(payment.id, { capturedAt: '2026-07-01T09:00:05.000Z' })
      expect(await settleOrder(s.deps, { orderId: order.id })).toMatchObject({ state: 'paid' })
      return order
    }

    it('reads what the first payment granted by the period of its order', async () => {
      const s = await subscribed()

      const summary = await summaryAt(s.workspaceId, inFirst(0))

      const [order] = await db.order.findMany({ where: { workspaceId: s.workspaceId } })
      expect(order).toMatchObject({ periodStart: FIRST.start, periodEnd: FIRST.end })
      expect(summary.tariff?.credits).toEqual(FULL)
      // The checkout made the workspace, and the gift of the registration with it.
      expect(summary.gift).toEqual({ left: 35, held: 0, granted: true })
      expect(summary.totalLeft).toBe(335)
    })

    it('refuses to answer for a period that was moved without the order that paid for it', async () => {
      const s = await subscribed()
      // No payment does this: the period of the subscription and of its order are written in
      // one transaction. A hand in the database did, and the period now holds no grant.
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { currentPeriodStart: new Date(FIRST.start.getTime() - 1) },
      })

      // Wrong numbers are not shown: 0 granted beside 300 left does not add up.
      await expect(summaryAt(s.workspaceId, inFirst(0))).rejects.toThrow(
        'The parts of the period do not add up to what it was granted',
      )

      // Moved together, as the stand moves time, the period adds up again.
      await db.order.updateMany({
        where: { subscriptionId: s.subscriptionId },
        data: { periodStart: new Date(FIRST.start.getTime() - 1) },
      })
      expect((await summaryAt(s.workspaceId, inFirst(0))).tariff?.credits).toEqual(FULL)
    })

    it('adds up through a renewal that leaves 187 credits unused: they are not expired credits of the new period', async () => {
      const s = await subscribed()
      const blog = await site(s.workspaceId, 'Блог')
      for (const [minute, credits] of [45, 45, 23].entries()) {
        await charged(s.workspaceId, blog.id, inFirst(minute), credits)
      }
      expect(await meterAt(s.workspaceId, inFirst(30))).toEqual({
        ...FULL,
        charged: 113,
        left: 187,
      })

      const order = await renewed(s)

      const paid = await db.order.findUniqueOrThrow({ where: { id: order.id } })
      // The order of the renewal carries the start of the period it opened.
      expect(paid).toMatchObject({ periodStart: FIRST.end, periodEnd: SECOND_END })
      // What was left of the old quota expired in the transaction of the renewal, under the key
      // of the period that ended; by the clock the row is of the new period.
      const gone = await db.creditLedger.findUniqueOrThrow({
        where: { idempotencyKey: ledgerKeys.tariffExpiry(s.subscriptionId, FIRST.end) },
      })
      expect(gone.amount.toNumber()).toBe(-187)
      expect(gone.createdAt.getTime()).toBeGreaterThan(FIRST.end.getTime())
      expect(await balanceOf(s.workspaceId)).toEqual({ balance: 300, held: 0 })
      const after = await summaryAt(s.workspaceId, new Date('2026-07-02T12:00:00.000Z'))
      expect(after.subscription?.period).toEqual({ start: FIRST.end, end: SECOND_END })
      // 300 = 0 + 0 + 0 + 300: the 187 are of the period that ended, not «сгорело» of this one.
      expect(after.tariff?.credits).toEqual(FULL)
      expect(after.tariff?.bySite).toEqual([])
      expect(after.history).toEqual(noHistory)
    })

    it('adds up through a payment while the tariff is overdue', async () => {
      const s = await subscribed()
      const blog = await site(s.workspaceId, 'Блог')
      await charged(s.workspaceId, blog.id, inFirst(0), 17)
      const waiting = await task(s.workspaceId, blog.id, { status: 'awaiting_user' })
      await place(s.workspaceId, waiting.id, { now: inFirst(5) })
      const done = await task(s.workspaceId, blog.id, { status: 'done' })
      await place(s.workspaceId, done.id, { now: inFirst(6) })
      // The renewal charge failed: the tariff is overdue and takes no tasks.
      const overdueSince = new Date('2026-07-01T09:05:00.000Z')
      await db.subscription.update({
        where: { id: s.subscriptionId },
        data: { status: 'past_due', pastDueSince: overdueSince },
      })
      const overdue = new Date('2026-07-03T12:00:00.000Z')
      expect(await meterAt(s.workspaceId, overdue)).toEqual({
        ...FULL,
        charged: 17,
        held: 90,
        left: 193,
      })
      // A task that ends meanwhile is paid by its own reserve; what it did not use expires.
      await charge(done.id, 20, { now: overdue })
      expect(await meterAt(s.workspaceId, overdue)).toEqual({
        ...FULL,
        charged: 37,
        held: 45,
        expired: 25,
        left: 193,
      })

      // «Оплатить сейчас»: the customer pays on 5 July, and the period starts then.
      const checkout = await startPastDuePayment(s.deps, { userId: s.userId })
      const { yookassaPaymentId } = await db.order.findUniqueOrThrow({
        where: { id: checkout.orderId },
      })
      const PAID_AT = '2026-07-05T10:00:00.000Z'
      s.shop.succeed(yookassaPaymentId ?? '', { capturedAt: PAID_AT })
      expect(await settleOrder(s.deps, { orderId: checkout.orderId })).toMatchObject({
        state: 'paid',
      })

      const subscription = await db.subscription.findUniqueOrThrow({
        where: { id: s.subscriptionId },
      })
      expect(subscription).toMatchObject({
        status: 'active',
        currentPeriodStart: new Date(PAID_AT),
      })
      // The order of the payment carries the start of the period it opened.
      expect(await db.order.findUniqueOrThrow({ where: { id: checkout.orderId } })).toMatchObject({
        periodStart: new Date(PAID_AT),
        periodEnd: subscription.currentPeriodEnd,
      })
      const afterPayment = new Date('2026-07-06T12:00:00.000Z')
      // 300 = 0 + 0 + 0 + 300, and the reserve of the task that still waits stands beside it.
      expect(await meterAt(s.workspaceId, afterPayment)).toEqual({ ...FULL, heldEarlier: 45 })
      expect(await balanceOf(s.workspaceId)).toEqual({ balance: 345, held: 45 })

      await release(waiting.id, { now: afterPayment })
      // Given back after its period ended, it expires: nothing joins the new quota.
      expect(await meterAt(s.workspaceId, afterPayment)).toEqual(FULL)
      expect(await balanceOf(s.workspaceId)).toEqual({ balance: 300, held: 0 })
    })
  })

  describe('without a tariff', () => {
    it('keeps the gift and the purchased credits in what is left, with no day', async () => {
      const { userId, workspaceId } = await funded({ tariff: 0, pack: 100, subscription: null })
      await db.$transaction((tx) => grantSignupGift(tx, { userId, workspaceId }))

      expect(await summaryAt(workspaceId)).toEqual({
        subscription: null,
        tariff: null,
        gift: { left: 35, held: 0, granted: true },
        pack: { left: 100, held: 0 },
        totalLeft: 135,
        history: noHistory,
        // Purchased credits wait for a tariff: a task may take the gift alone.
        spendable: 35,
        spendableNow: 35,
        setAside: 0,
        minToStart: 5,
        // Without a tariff there is no day: the gift is the bound.
        today: null,
        newTask: TAKEN,
      })
    })

    it('shows the history of a workspace that never had a tariff: tasks done on gift credits', async () => {
      const { userId, workspaceId } = await funded({ tariff: 0, subscription: null })
      await db.$transaction((tx) => grantSignupGift(tx, { userId, workspaceId }))
      const blog = await site(workspaceId, 'Блог')
      const first = await task(workspaceId, blog.id, { summary: 'Заменил телефон в шапке' })
      // The whole gift is set aside for the task: it is the trial.
      await place(workspaceId, first.id, { now: minutesAfter(0) })
      const inWork = await summaryAt(workspaceId, minutesAfter(1))
      expect(inWork.gift).toEqual({ left: 0, held: 35, granted: true })
      expect(inWork.history.items).toMatchObject([
        { id: first.id, outcome: 'held', credits: 35, from: { tariff: 0, gift: 35, pack: 0 } },
      ])
      expect(inWork).toMatchObject({
        today: null,
        spendable: 0,
        setAside: 35,
        newTask: { allowed: false, reason: 'held' },
      })

      await doneFor(first.id, '22.09', { now: minutesAfter(10) })
      const failed = await task(workspaceId, blog.id, { status: 'failed' })
      await place(workspaceId, failed.id, { now: minutesAfter(11) })
      await release(failed.id, { now: minutesAfter(12) })
      const undo = await task(workspaceId, blog.id, {
        billable: false,
        revertsTaskId: first.id,
        createdAt: minutesAfter(13),
      })

      const summary = await summaryAt(workspaceId, minutesAfter(20))

      expect(summary.tariff).toBeNull()
      expect(summary.gift).toEqual({ left: 30, held: 0, granted: true })
      expect(summary.today).toBeNull()
      expect(
        summary.history.items.map(({ id, outcome, credits, from }) => [id, outcome, credits, from]),
      ).toEqual([
        [undo.id, 'free', null, null],
        [failed.id, 'unpaid', null, null],
        [first.id, 'charged', 5, { tariff: 0, gift: 5, pack: 0 }],
      ])
      expect(await listUsageHistory(db, workspaceId)).toEqual(summary.history)
    })

    it.each(['cancelled', 'expired'] as const)(
      'answers «no tariff» with the purchased credits and the whole history once the tariff is %s',
      async (status) => {
        const { workspaceId, subscription } = await funded({ pack: 100 })
        const blog = await site(workspaceId, 'Блог')
        const paid = await charged(workspaceId, blog.id)
        await db.$transaction(async (tx) => {
          await expireTariffRemainder(tx, {
            workspaceId,
            subscriptionId: subscription!.id,
            periodEnd: PERIOD_END,
          })
          await tx.subscription.update({ where: { id: subscription!.id }, data: { status } })
        })

        const summary = await summaryAt(workspaceId)

        expect(summary).toMatchObject({
          subscription: null,
          tariff: null,
          today: null,
          gift: { left: 0, held: 0, granted: false },
          pack: { left: 100, held: 0 },
          totalLeft: 100,
          spendable: 0,
          // Credits of a pack wait for a tariff.
          newTask: { allowed: false, reason: 'ended' },
        })
        // No period, no lower bound: what the tariff was charged for is still there.
        expect(summary.history.items).toMatchObject([
          { id: paid.taskId, outcome: 'charged', credits: 5 },
        ])
        expect(await listUsageHistory(db, workspaceId)).toEqual(summary.history)
      },
    )

    it('answers «no tariff, no credits» for a workspace that never paid', async () => {
      const { workspaceId } = await funded({ tariff: 0, subscription: null })
      await site(workspaceId, 'Блог')

      expect(await summaryAt(workspaceId)).toEqual({
        subscription: null,
        tariff: null,
        gift: { left: 0, held: 0, granted: false },
        pack: { left: 0, held: 0 },
        totalLeft: 0,
        history: noHistory,
        spendable: 0,
        spendableNow: 0,
        setAside: 0,
        minToStart: 5,
        today: null,
        newTask: { allowed: false, reason: 'gift_spent' },
      })
    })
  })

  it('counts the tariff credits of a day by the Moscow calendar', async () => {
    const { workspaceId } = await funded({ plan: startDay })
    const blog = await site(workspaceId, 'Блог')
    // 23:59 in Moscow on 4 October.
    const lateEvening = new Date('2026-10-04T20:59:00.000Z')
    await charged(workspaceId, blog.id, lateEvening)

    // Placed at 23:59 and charged twenty minutes later: the five count on the 4th.
    expect((await tariffAt(workspaceId, lateEvening)).today).toEqual(dayOf(50, 5, 0, 295))
    // Midnight in Moscow: a new day, and the credits are still of the period.
    const midnight = new Date('2026-10-04T21:00:00.000Z')
    const nextDay = await tariffAt(workspaceId, midnight)
    expect(nextDay.today).toEqual(dayOf(50, 0, 0, 295))
    expect(nextDay.credits).toEqual({ ...FULL, charged: 5, left: 295 })
  })

  it('shows only the sites, credits and history of its own workspace', async () => {
    const mine = await funded()
    const theirs = await funded({ pack: 100 })
    const theirSite = await site(theirs.workspaceId, 'Чужой сайт')
    const theirCharge = await charged(theirs.workspaceId, theirSite.id)
    const theirUndo = await task(theirs.workspaceId, theirSite.id, {
      billable: false,
      revertsTaskId: theirCharge.taskId,
    })

    expect(await summaryAt(mine.workspaceId)).toMatchObject({
      tariff: {
        credits: FULL,
        today: dayOf(null, 0, 0, 300),
        sites: { count: 0, max: 2 },
        bySite: [],
      },
      pack: { left: 0, held: 0 },
      totalLeft: 300,
      history: noHistory,
    })
    // A line of another workspace is no cursor here.
    for (const cursor of [theirCharge.taskId, theirUndo.id]) {
      expect(await listUsageHistory(db, mine.workspaceId, { cursor })).toEqual(noHistory)
    }
    expect((await historyAt(theirs.workspaceId)).items).toHaveLength(2)
  })

  it('lists a free task only when it is an undo', async () => {
    const { workspaceId } = await funded()
    const blog = await site(workspaceId, 'Блог')
    const original = await charged(workspaceId, blog.id, minutesAfter(0))
    // A retry by an operator takes no credit either, and is the operator's business.
    await task(workspaceId, blog.id, { billable: false, createdAt: minutesAfter(1) })
    const undo = await task(workspaceId, blog.id, {
      billable: false,
      revertsTaskId: original.taskId,
      createdAt: minutesAfter(2),
    })

    const history = await historyAt(workspaceId)

    expect(history.items.map(({ id, outcome }) => [id, outcome])).toEqual([
      [undo.id, 'free'],
      [original.taskId, 'charged'],
    ])
  })

  it('lists an undo in the period it was queued in, and in the whole history once there is no period', async () => {
    const { workspaceId, subscription } = await funded()
    const blog = await site(workspaceId, 'Блог')
    const original = await charged(workspaceId, blog.id, minutesAfter(0))
    const undoAt = (createdAt: Date) =>
      task(workspaceId, blog.id, { billable: false, revertsTaskId: original.taskId, createdAt })
    // Queued in the period before: a minute before the period of the fixtures started.
    const earlier = await undoAt(minutesAfter(-1, PERIOD_START))
    // The first moment of the period is in it.
    const atStart = await undoAt(PERIOD_START)
    const lines = (history: { items: { id: string; outcome: string }[] }) =>
      history.items.map(({ id, outcome }) => [id, outcome])

    const ofPeriod = await historyAt(workspaceId)

    expect(lines(ofPeriod)).toEqual([
      [original.taskId, 'charged'],
      [atStart.id, 'free'],
    ])
    expect(await listUsageHistory(db, workspaceId)).toEqual(ofPeriod)
    // An undo of another period is no cursor in this one.
    expect(await listUsageHistory(db, workspaceId, { cursor: earlier.id })).toEqual(noHistory)

    // Once there is no period — the tariff has ended —, the history has no lower bound.
    await db.subscription.update({ where: { id: subscription!.id }, data: { status: 'cancelled' } })
    const whole = await historyAt(workspaceId)
    expect(lines(whole)).toEqual([
      [original.taskId, 'charged'],
      [atStart.id, 'free'],
      [earlier.id, 'free'],
    ])
    expect(await listUsageHistory(db, workspaceId)).toEqual(whole)
  })

  it('lists an undo once: by the credits it set aside, when it took some after all', async () => {
    const { workspaceId } = await funded()
    const blog = await site(workspaceId, 'Блог')
    const original = await charged(workspaceId, blog.id, minutesAfter(0))
    const undo = await task(workspaceId, blog.id, {
      revertsTaskId: original.taskId,
      createdAt: minutesAfter(1),
    })
    await place(workspaceId, undo.id, { now: minutesAfter(2) })

    const history = await historyAt(workspaceId)

    expect(history.items.map(({ id, at, outcome }) => [id, at, outcome])).toEqual([
      // At the moment of its reserve, not of its creation.
      [undo.id, minutesAfter(2), 'held'],
      [original.taskId, minutesAfter(0), 'charged'],
    ])
  })

  describe('pages of the history', () => {
    /** Five charged tasks a minute apart and an undo between them; newest first. */
    async function history() {
      const { workspaceId } = await funded()
      const blog = await site(workspaceId, 'Блог')
      const ids: string[] = []
      for (let minute = 0; minute < 5; minute += 1) {
        ids.push((await charged(workspaceId, blog.id, minutesAfter(minute))).taskId)
      }
      const [t0, t1, t2, t3, t4] = ids as [string, string, string, string, string]
      const undo = await task(workspaceId, blog.id, {
        billable: false,
        revertsTaskId: t0,
        createdAt: new Date(minutesAfter(2).getTime() + 30_000),
      })
      return { workspaceId, newestFirst: [t4, t3, undo.id, t2, t1, t0] }
    }

    it('walks the history page by page without a gap or a repeat', async () => {
      const { workspaceId, newestFirst } = await history()

      const seen: string[] = []
      let cursor: string | undefined
      const sizes: number[] = []
      for (;;) {
        const page = await listUsageHistory(db, workspaceId, {
          limit: 4,
          ...(cursor === undefined ? {} : { cursor }),
        })
        sizes.push(page.items.length)
        seen.push(...page.items.map(({ id }) => id))
        if (page.nextCursor === null) break
        // The cursor is the last line of the page.
        expect(page.nextCursor).toBe(page.items.at(-1)?.id)
        cursor = page.nextCursor
      }

      expect(seen).toEqual(newestFirst)
      expect(sizes).toEqual([4, 2])
    })

    it('ends with a page that is exactly full', async () => {
      const { workspaceId, newestFirst } = await history()

      const first = await listUsageHistory(db, workspaceId, { limit: 3 })
      const second = await listUsageHistory(db, workspaceId, {
        limit: 3,
        cursor: first.nextCursor!,
      })

      expect(first.items.map(({ id }) => id)).toEqual(newestFirst.slice(0, 3))
      // The undo is a cursor as good as a task that took credits.
      expect(first.nextCursor).toBe(newestFirst[2])
      expect(second.items.map(({ id }) => id)).toEqual(newestFirst.slice(3))
      expect(second.nextCursor).toBeNull()
    })

    it('orders lines of the same moment by id and pages through them', async () => {
      const { workspaceId } = await funded()
      const blog = await site(workspaceId, 'Blog')
      const ids: string[] = []
      for (let index = 0; index < 3; index += 1) {
        ids.push((await charged(workspaceId, blog.id, NOW)).taskId)
      }
      const newestFirst = [...ids].sort().reverse()

      const first = await listUsageHistory(db, workspaceId, { limit: 2 })
      const second = await listUsageHistory(db, workspaceId, {
        limit: 2,
        cursor: first.nextCursor!,
      })

      expect([...first.items, ...second.items].map(({ id }) => id)).toEqual(newestFirst)
      expect(second.nextCursor).toBeNull()
    })

    it('gives an empty page for a cursor that is no line of the period', async () => {
      const { workspaceId } = await history()

      expect(await listUsageHistory(db, workspaceId, { cursor: randomUUID() })).toEqual(noHistory)
    })

    it('gives the summary the first twenty lines and the cursor of the next page', async () => {
      const { workspaceId } = await funded({
        tariff: 1000,
        plan: { creditsPerMonth: 1000 },
      })
      const blog = await site(workspaceId, 'Блог')
      const ids: string[] = []
      for (let minute = 0; minute < 22; minute += 1) {
        const { id } = await task(workspaceId, blog.id)
        await place(workspaceId, id, { now: minutesAfter(minute) })
        ids.push(id)
      }
      const newestFirst = [...ids].reverse()

      const { history: firstPage, tariff } = await summaryAt(workspaceId)

      expect(firstPage.items.map(({ id }) => id)).toEqual(newestFirst.slice(0, 20))
      expect(firstPage.nextCursor).toBe(newestFirst[19])
      // 22 reserves of 45 credits.
      expect(tariff?.credits).toEqual({
        granted: 1000,
        charged: 0,
        held: 990,
        expired: 0,
        left: 10,
        heldEarlier: 0,
      })
      const rest = await listUsageHistory(db, workspaceId, { cursor: firstPage.nextCursor! })
      expect(rest.items.map(({ id }) => id)).toEqual(newestFirst.slice(20))
      expect(rest.nextCursor).toBeNull()
    })
  })
})
