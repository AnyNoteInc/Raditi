import { randomUUID } from 'node:crypto'

import {
  createPrismaClient,
  type Prisma,
  type PrismaClient,
  type SubscriptionStatus,
} from '@repo/db'
import { creditAccountKinds, creditAccountUnits, Money, type CreditAccountKind } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import { ensureAccounts, lockCreditAccount, type BillingTx } from './accounts.ts'
import {
  expireTaskHolds,
  extendTaskHolds,
  placeCreditHold,
  releaseTask,
  settleTaskCharge,
  tariffCreditsOfDay,
  taskChainAttempts,
  type CreditHoldPlacement,
} from './holds.ts'
import { expireTariffRemainder, grantTariffCredits, ledgerKeys, post } from './ledger.ts'
import {
  billingFixtures,
  inRolledBackTransaction,
  underPrivateCreditRate,
  writeCreditRate,
  writeModelPool,
  writeModelPrice,
  type TestModelPool,
} from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const WORKSPACE = '0199a000-0000-7000-8000-0000000000a1'
const TASK = '0199a000-0000-7000-8000-0000000000d4'
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
const PERIOD_MS = 30 * DAY_MS
/** The period of the fixtures' subscription. */
const PERIOD_START = new Date('2026-09-18T09:00:00.000Z')
const PERIOD_END = new Date('2026-10-18T09:00:00.000Z')
/** 15:00 in Moscow on 4 October 2026, inside that period. */
const NOW = new Date('2026-10-04T12:00:00.000Z')
/** When a task of a reserve ends: later the same day. */
const LATER = new Date('2026-10-04T12:20:00.000Z')
const minutesAfter = (minutes: number, from = NOW) => new Date(from.getTime() + minutes * MINUTE_MS)

describe('reserve input', () => {
  // A refused input never reaches the database: this client would throw a TypeError there.
  const tx = {} as BillingTx
  const placement = {
    workspaceId: WORKSPACE,
    taskId: TASK,
    attempt: 1,
    now: NOW,
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  }
  const ending = { taskId: TASK, now: LATER }
  const charge = { taskId: TASK, credits: 17, now: LATER }
  const extension = { taskId: TASK, expiresAt: new Date(NOW.getTime() + DAY_MS) }

  it.each([0, -1, 1.5, Number.NaN, 2 ** 31, '1'])(
    'refuses attempt %s before any query',
    async (value) => {
      const attempt = value as number
      await expect(placeCreditHold(tx, { ...placement, attempt })).rejects.toBeInstanceOf(ZodError)
    },
  )

  it.each([0, -1, 16.5, Number.NaN, '17', null])(
    'refuses a charge of %s credits before any query',
    async (value) => {
      const credits = value as number
      await expect(settleTaskCharge(tx, { ...charge, credits })).rejects.toBeInstanceOf(ZodError)
    },
  )

  it('refuses an id that is not a UUID and an unknown field', async () => {
    await expect(placeCreditHold(tx, { ...placement, workspaceId: 'ws' })).rejects.toBeInstanceOf(
      ZodError,
    )
    await expect(placeCreditHold(tx, { ...placement, taskId: 'task' })).rejects.toBeInstanceOf(
      ZodError,
    )
    await expect(
      placeCreditHold(tx, { ...placement, amount: 45 } as unknown as typeof placement),
    ).rejects.toBeInstanceOf(ZodError)
    for (const end of [releaseTask, expireTaskHolds]) {
      await expect(end(tx, { ...ending, taskId: 'task' })).rejects.toBeInstanceOf(ZodError)
      // A reserve is given back per task, not per attempt.
      await expect(
        end(tx, { ...ending, attempt: 1 } as unknown as typeof ending),
      ).rejects.toBeInstanceOf(ZodError)
    }
    await expect(settleTaskCharge(tx, { ...charge, taskId: 'task' })).rejects.toBeInstanceOf(
      ZodError,
    )
    await expect(
      settleTaskCharge(tx, { ...charge, workspaceId: WORKSPACE } as unknown as typeof charge),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(extendTaskHolds(tx, { ...extension, taskId: 'task' })).rejects.toBeInstanceOf(
      ZodError,
    )
    await expect(
      extendTaskHolds(tx, { ...extension, now: NOW } as unknown as typeof extension),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(tariffCreditsOfDay(tx, { workspaceId: 'ws', now: NOW })).rejects.toBeInstanceOf(
      ZodError,
    )
    await expect(
      tariffCreditsOfDay(tx, { workspaceId: WORKSPACE, now: NOW, taskId: TASK } as never),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('refuses a moment that is not one', async () => {
    const never = new Date(Number.NaN)
    const text = '2026-10-04' as unknown as Date
    for (const now of [never, text]) {
      await expect(placeCreditHold(tx, { ...placement, now })).rejects.toBeInstanceOf(ZodError)
      await expect(settleTaskCharge(tx, { ...charge, now })).rejects.toBeInstanceOf(ZodError)
      await expect(releaseTask(tx, { ...ending, now })).rejects.toBeInstanceOf(ZodError)
      await expect(expireTaskHolds(tx, { ...ending, now })).rejects.toBeInstanceOf(ZodError)
      await expect(tariffCreditsOfDay(tx, { workspaceId: WORKSPACE, now })).rejects.toBeInstanceOf(
        ZodError,
      )
      await expect(extendTaskHolds(tx, { ...extension, expiresAt: now })).rejects.toBeInstanceOf(
        ZodError,
      )
    }
    await expect(placeCreditHold(tx, { ...placement, expiresAt: never })).rejects.toBeInstanceOf(
      ZodError,
    )
  })

  it('refuses a reserve that expires no later than it is placed', async () => {
    for (const expiresAt of [NOW, new Date(NOW.getTime() - 1)]) {
      await expect(placeCreditHold(tx, { ...placement, expiresAt })).rejects.toBeInstanceOf(
        ZodError,
      )
    }
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL reserves in credits', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(() => fixtures.cleanup())
  afterAll(async () => {
    await db.$disconnect()
  })

  // Twenty transactions queue for the ten connections of the pool and then for one row lock.
  const patient = { maxWait: 15_000, timeout: 30_000 }

  /** Credits on an account, written the way every grant is: the balance and its journal row. */
  const grant = (workspaceId: string, kind: CreditAccountKind, credits: number) =>
    db.$transaction(async (tx) => {
      await ensureAccounts(tx, workspaceId)
      const account = await lockCreditAccount(tx, workspaceId, kind)
      if (account === null) throw new Error('The workspace has no credit account')
      await post(tx, {
        account,
        kind: 'grant',
        amount: new Money(credits),
        orderId: null,
        idempotencyKey: `test:${randomUUID()}`,
      })
    })

  /**
   * A workspace with its three credit accounts — `tariff` credits (300 unless told otherwise),
   * `gift` and `pack` ones — on a tariff of 300 credits a month without a daily limit unless
   * told otherwise (`plan: { creditsPerDay }`), active for the period of the fixtures unless
   * told otherwise; `subscription: null` for none.
   */
  async function funded(
    options: {
      tariff?: number
      gift?: number
      pack?: number
      plan?: Partial<Prisma.PlanUncheckedCreateInput>
      subscription?: Partial<Parameters<typeof fixtures.subscription>[0]> | null
    } = {},
  ) {
    const { tariff = 300, gift = 0, pack = 0 } = options
    const { userId, workspaceId } = await fixtures.workspace()
    const plan = await fixtures.plan({ creditsPerMonth: 300, ...options.plan })
    const subscription =
      options.subscription === null
        ? null
        : await fixtures.subscription({ workspaceId, planId: plan.id, ...options.subscription })
    await db.$transaction((tx) => ensureAccounts(tx, workspaceId))
    if (tariff > 0) await grant(workspaceId, 'tariff', tariff)
    if (gift > 0) await grant(workspaceId, 'gift', gift)
    if (pack > 0) await grant(workspaceId, 'pack', pack)
    return { userId, workspaceId, plan, subscription }
  }

  /** `funded` for the tests that go on to end or renew the period of the subscription. */
  async function subscribed(options: Parameters<typeof funded>[0] = {}) {
    const { subscription, ...rest } = await funded(options)
    if (subscription === null) throw new Error('The scenario needs a subscription')
    return { ...rest, subscriptionId: subscription.id, periodEnd: subscription.currentPeriodEnd }
  }

  /** A queued task of the workspace on a site of its own; `standard` unless told otherwise. */
  const task = async (workspaceId: string, data: Partial<Prisma.TaskUncheckedCreateInput> = {}) =>
    (await fixtures.task(workspaceId, data)).taskId

  const tasks = (workspaceId: string, count: number) =>
    Promise.all(Array.from({ length: count }, () => task(workspaceId)))

  /** A task on a site of the given address: what the gift of a site is claimed by. */
  async function taskOn(workspaceId: string, url: string) {
    const site = await db.site.create({
      data: { workspaceId, name: 'Billing verification', url, stack: 'wordpress' },
    })
    const row = await db.task.create({
      data: { workspaceId, siteId: site.id, modelClass: 'standard' },
    })
    return row.id
  }

  /**
   * What every call must leave behind: each credit account holds exactly what its ledger rows
   * add up to, `held` is exactly its active reserve rows, and never more than the balance. Read
   * as of one instant, so that it may be asked while other transactions commit.
   */
  async function expectBooksToBalance(workspaceId: string) {
    const books = await db.$transaction(
      (tx) =>
        tx.billingAccount.findMany({
          where: { workspaceId, unit: { in: Object.values(creditAccountUnits) } },
          include: { entries: true, holds: { where: { status: 'active' } } },
        }),
      { ...patient, isolationLevel: 'RepeatableRead' },
    )
    for (const row of books) {
      const posted = row.entries.reduce((total, entry) => total.plus(entry.amount), new Money(0))
      const held = row.holds.reduce((total, hold) => total.plus(hold.amount), new Money(0))
      expect(`${row.unit} balance ${row.balance.toFixed(2)}`).toBe(
        `${row.unit} balance ${posted.toFixed(2)}`,
      )
      expect(`${row.unit} held ${row.held.toFixed(2)}`).toBe(`${row.unit} held ${held.toFixed(2)}`)
      expect(row.held.lte(row.balance)).toBe(true)
    }
  }

  /** Runs a call and then asks the books of the workspace, whether the call went through or not. */
  async function booked<T>(workspaceId: string | undefined, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } finally {
      if (workspaceId !== undefined) await expectBooksToBalance(workspaceId)
    }
  }
  const workspaceOf = async (taskId: string) =>
    (await db.task.findUnique({ where: { id: taskId }, select: { workspaceId: true } }))
      ?.workspaceId

  interface PlacementOptions {
    now?: Date
    attempt?: number
    expiresAt?: Date
    /** «Попробовать ещё»: what the retry of a dialog says, after it gave the chain back. */
    retry?: true
    /** A new chain after a charged pass: the client's next words or «Продолжить». */
    follows?: 'message' | 'continue'
  }
  const placement = (
    workspaceId: string,
    taskId: string,
    {
      now = NOW,
      attempt = 1,
      expiresAt = new Date(now.getTime() + DAY_MS),
      retry,
      follows,
    }: PlacementOptions = {},
  ): CreditHoldPlacement => ({
    workspaceId,
    taskId,
    attempt,
    now,
    expiresAt,
    ...(retry === undefined ? {} : { retry }),
    ...(follows === undefined ? {} : { follows }),
  })

  /** Places a reserve the way the queue will, under a credit rate nobody else sees. */
  const place = (workspaceId: string, taskId: string, options: PlacementOptions = {}) =>
    booked(workspaceId, () => fixtures.reserve(placement(workspaceId, taskId, options)))
  const settle = async (taskId: string, credits: number, { now = LATER } = {}) =>
    booked(await workspaceOf(taskId), () =>
      db.$transaction((tx) => settleTaskCharge(tx, { taskId, credits, now }), patient),
    )
  const release = async (taskId: string, { now = LATER } = {}) =>
    booked(await workspaceOf(taskId), () =>
      db.$transaction((tx) => releaseTask(tx, { taskId, now }), patient),
    )
  /** What cron does to the reserve of a stuck task; `place` lets a reserve expire a day after it. */
  const expire = async (taskId: string, { now = new Date(NOW.getTime() + DAY_MS) } = {}) =>
    booked(await workspaceOf(taskId), () =>
      db.$transaction((tx) => expireTaskHolds(tx, { taskId, now }), patient),
    )
  const extend = async (taskId: string, expiresAt: Date) =>
    booked(await workspaceOf(taskId), () =>
      db.$transaction((tx) => extendTaskHolds(tx, { taskId, expiresAt }), patient),
    )

  /** Everything a placement could write for a workspace, row by row. */
  const written = async (workspaceId: string) => ({
    accounts: await db.billingAccount.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
    holds: await db.creditHold.findMany({
      where: { account: { workspaceId } },
      orderBy: { id: 'asc' },
    }),
    ledger: await db.creditLedger.findMany({
      where: { account: { workspaceId } },
      orderBy: { id: 'asc' },
    }),
    claims: await db.giftSiteClaim.findMany({
      where: { workspaceId },
      orderBy: { hostKey: 'asc' },
    }),
  })

  /**
   * The error a placement is refused with — and the proof that the refusal wrote nothing: the
   * transaction that caught it is committed, and not a row of the workspace differs after it.
   * `rate: false` asks without any credit rate.
   */
  async function refused(
    workspaceId: string,
    taskId: string,
    { rate = true, ...options }: PlacementOptions & { rate?: boolean } = {},
  ): Promise<unknown> {
    const before = await written(workspaceId)
    const caught = await db.$transaction(async (tx) => {
      const asked = async () => {
        try {
          await placeCreditHold(tx, placement(workspaceId, taskId, options))
        } catch (error) {
          return { error }
        }
        return null
      }
      return rate ? underPrivateCreditRate(tx, asked) : asked()
    }, patient)
    if (caught === null) throw new Error('The placement was not refused')
    expect(await written(workspaceId)).toEqual(before)
    await expectBooksToBalance(workspaceId)
    return caught.error
  }

  /**
   * What a renewal does in one transaction: the remainder goes, the subscription moves to its
   * next period, the new quota comes. `between` runs while the transaction holds its locks.
   */
  async function renew(
    renewal: { workspaceId: string; subscriptionId: string; periodEnd: Date; planId: string },
    { credits = 300, between }: { credits?: number; between?: () => Promise<void> } = {},
  ) {
    const { workspaceId, subscriptionId, periodEnd, planId } = renewal
    const order = await fixtures.order({ workspaceId, planId })
    return db.$transaction(async (tx) => {
      const expired = await expireTariffRemainder(tx, { workspaceId, subscriptionId, periodEnd })
      await between?.()
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          currentPeriodStart: periodEnd,
          currentPeriodEnd: new Date(periodEnd.getTime() + PERIOD_MS),
        },
      })
      await grantTariffCredits(tx, { workspaceId, orderId: order.id, credits })
      return expired
    }, patient)
  }

  /** The period ends without a renewal: the remainder goes and the subscription is over. */
  const endPeriod = (
    ended: { workspaceId: string; subscriptionId: string; periodEnd: Date },
    status: Extract<SubscriptionStatus, 'cancelled' | 'expired'>,
  ) =>
    db.$transaction(async (tx) => {
      const { workspaceId, subscriptionId, periodEnd } = ended
      await expireTariffRemainder(tx, { workspaceId, subscriptionId, periodEnd })
      await tx.subscription.update({ where: { id: subscriptionId }, data: { status } })
    })

  /**
   * The charge of the renewal is declined: the subscription is past due from then on, and its
   * period and its quota stay as they are. The remainder goes only when the grace runs out or
   * the customer pays.
   */
  const declineRenewal = (declined: { subscriptionId: string; periodEnd: Date }) =>
    db.subscription.update({
      where: { id: declined.subscriptionId },
      data: { status: 'past_due', pastDueSince: declined.periodEnd },
    })

  /** The tariff stops taking tasks, one way or another. */
  async function stopTariff(
    stopped: { workspaceId: string; subscriptionId: string; periodEnd: Date },
    state: 'past_due' | 'cancelled' | 'expired',
  ) {
    if (state === 'past_due') await declineRenewal(stopped)
    else await endPeriod(stopped, state)
  }

  const fulfilled = <T>(results: PromiseSettledResult<T>[]) =>
    results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  const rejected = (results: PromiseSettledResult<unknown>[]) =>
    results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []))

  const account = (balance: number, held = 0) => ({ balance, held })

  const accounts = async (workspaceId: string) => {
    const rows = await db.billingAccount.findMany({ where: { workspaceId } })
    const of = (kind: CreditAccountKind) => {
      const row = rows.find((candidate) => candidate.unit === creditAccountUnits[kind])
      return row ? account(row.balance.toNumber(), row.held.toNumber()) : null
    }
    return { tariff: of('tariff'), gift: of('gift'), pack: of('pack') }
  }

  const kindOf = (unit: string) =>
    creditAccountKinds.find((kind) => creditAccountUnits[kind] === unit) ?? unit
  const accountId = async (workspaceId: string, kind: CreditAccountKind) =>
    (
      await db.billingAccount.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: creditAccountUnits[kind] } },
      })
    ).id

  /** The reserve rows of a task by attempt and account: `#1 tariff 5 active`. */
  const reserve = async (taskId: string) =>
    (await db.creditHold.findMany({ where: { taskId } }))
      .map((row) => ({ row, kind: kindOf(row.unit) }))
      .sort(
        (a, b) =>
          a.row.attempt - b.row.attempt ||
          creditAccountKinds.indexOf(a.kind as CreditAccountKind) -
            creditAccountKinds.indexOf(b.kind as CreditAccountKind),
      )
      .map(({ row, kind }) => `#${row.attempt} ${kind} ${row.amount.toFixed(0)} ${row.status}`)

  const holdOf = (taskId: string, kind: CreditAccountKind, attempt = 1) =>
    db.creditHold.findFirstOrThrow({
      where: { taskId, attempt, unit: creditAccountUnits[kind] },
    })

  /**
   * The ledger of the workspace, one line per row with the balance the row left behind. Sorted,
   * as `rows` sorts what a test expects: two rows of one transaction have no order of their own.
   */
  const ledger = async (workspaceId: string) => {
    const entries = await db.creditLedger.findMany({ where: { account: { workspaceId } } })
    return rows(
      ...entries.map(
        (entry) =>
          `${kindOf(entry.unit)} ${entry.kind} ${entry.amount.toFixed(0)} → ${entry.balanceAfter.toFixed(0)}`,
      ),
    )
  }
  const rows = (...lines: string[]) => [...lines].sort()
  const entryOf = (idempotencyKey: string) =>
    db.creditLedger.findUniqueOrThrow({ where: { idempotencyKey } })

  /** The tariff credits the Moscow day of `now` took, as `charged + held`. */
  const today = async (workspaceId: string, now: Date | string = LATER) => {
    const { charged, held } = await tariffCreditsOfDay(db, { workspaceId, now: new Date(now) })
    return `${charged} + ${held}`
  }
  /** «Старт» of the decision of 17.10.2026: 300 tariff credits a month, of them 50 a day. */
  const startDay = { creditsPerMonth: 300, creditsPerDay: 50 }

  /** A model of its own with a price row: what a recorded model call needs. */
  async function modelPool() {
    const pool = await fixtures.modelPool()
    const price = await fixtures.modelPrice(pool, {
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    })
    return { pool, priceId: price.id }
  }
  type Model = Awaited<ReturnType<typeof modelPool>>
  /** A recorded model call of an attempt: each attempt works in a turn of its own. */
  const worked = (
    model: Model,
    taskId: string,
    costRub: string,
    { attempt = 1, occurredAt = minutesAfter(5) }: { attempt?: number; occurredAt?: Date } = {},
  ) =>
    fixtures.modelCall({
      taskId,
      pool: model.pool,
      priceId: model.priceId,
      costRub,
      occurredAt,
      attempt,
      turnNo: attempt,
    })

  const refusal = (
    code: string,
    httpStatus: number,
    details?: { reason: string; spendable: number; held: number; needed: number } & Record<
      string,
      unknown
    >,
  ) => ({ name: 'DomainError', code, httpStatus, ...(details === undefined ? {} : { details }) })
  const conflict = refusal('CONFLICT', 409)
  const notFound = refusal('NOT_FOUND', 404)
  const badRequest = refusal('BAD_REQUEST', 400)
  const notEnough = (reason: string, spendable: number, held = 0, needed = 5) =>
    refusal('BILLING_NOT_ENOUGH_CREDITS', 402, { reason, spendable, held, needed })
  const creditsHeld = (spendable: number, held: number, needed = 5) =>
    refusal('BILLING_CREDITS_HELD', 409, { reason: 'held', spendable, held, needed })
  const needsTariff = (reason: string, spendable: number, held = 0, needed = 5) =>
    refusal('BILLING_TASK_NEEDS_SUBSCRIPTION', 402, { reason, spendable, held, needed })
  /**
   * A refusal by the day: what the accounts hold and what is set aside, what the task could take
   * now and the day — its limit and what it took.
   */
  const dailyLimit = (
    spendable: number,
    held: number,
    day: { limit: number; used: number },
    { spendableNow = 0, needed = 5 }: { spendableNow?: number; needed?: number } = {},
  ) =>
    refusal('BILLING_DAILY_LIMIT_REACHED', 409, {
      reason: 'daily_limit',
      spendable,
      held,
      needed,
      spendableNow,
      day,
    })
  const unpaidLimit = (spendable: number, held = 0) =>
    refusal('BILLING_UNPAID_WORK_LIMIT', 409, {
      reason: 'unpaid_limit',
      spendable,
      held,
      needed: 5,
    })
  const rateMissing = (spendable: number, held = 0, needed = 5) =>
    refusal('BILLING_CREDIT_RATE_MISSING', 503, { reason: 'rate_missing', spendable, held, needed })

  describe('a reserve', () => {
    it('sets the step of a new task aside on the tariff, and moves no balance', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)

      const placed = await place(workspaceId, taskId)

      expect(placed).toMatchObject({ applied: true, reserved: 45 })
      expect(placed.holds).toHaveLength(1)
      expect(placed.holds[0]).toMatchObject({
        accountId: await accountId(workspaceId, 'tariff'),
        unit: 'credit_tariff',
        taskId,
        attempt: 1,
        status: 'active',
        createdAt: NOW,
        placedAt: NOW,
        expiresAt: new Date(NOW.getTime() + DAY_MS),
        settledAt: null,
      })
      expect(placed.holds[0]?.amount.toFixed(2)).toBe('45.00')
      expect(await db.creditHold.findMany({ where: { taskId } })).toEqual(placed.holds)
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(300, 45),
        gift: account(0),
        pack: account(0),
      })
      // A reserve writes no ledger row.
      expect(await ledger(workspaceId)).toEqual(rows('tariff grant 300 → 300'))
      // Nor a claim of the site: the tariff is paid.
      expect(await db.giftSiteClaim.count({ where: { workspaceId } })).toBe(0)
    })

    it.each([
      ['light', 20],
      ['standard', 45],
      ['heavy', 120],
    ] as const)('sets aside the step of the class %s: %i credits', async (modelClass, step) => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId, { modelClass })

      expect(await place(workspaceId, taskId)).toMatchObject({ applied: true, reserved: step })
      expect(await reserve(taskId)).toEqual([`#1 tariff ${step} active`])
    })

    it('stands on two accounts when the tariff does not cover the step: the tariff, then the pack', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)

      const placed = await place(workspaceId, taskId)

      expect(placed.reserved).toBe(45)
      // One row per account, in the order credits are spent, with one moment of placing.
      expect(placed.holds.map((hold) => [hold.unit, hold.amount.toFixed(0)])).toEqual([
        ['credit_tariff', '5'],
        ['credit_pack', '40'],
      ])
      expect(new Set(placed.holds.map((hold) => hold.placedAt.getTime()))).toEqual(
        new Set([NOW.getTime()]),
      )
      expect(await reserve(taskId)).toEqual(['#1 tariff 5 active', '#1 pack 40 active'])
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(5, 5),
        gift: account(0),
        pack: account(100, 40),
      })
    })

    it('stands on three accounts: the tariff, then the gift, then the pack', async () => {
      const { workspaceId } = await funded({ tariff: 5, gift: 35, pack: 100 })
      const taskId = await task(workspaceId)

      expect((await place(workspaceId, taskId)).reserved).toBe(45)

      expect(await reserve(taskId)).toEqual([
        '#1 tariff 5 active',
        '#1 gift 35 active',
        '#1 pack 5 active',
      ])
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(5, 5),
        gift: account(35, 35),
        pack: account(100, 5),
      })
    })

    it('skips an account that has nothing free', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: 10, pack: 100 })
      const taskId = await task(workspaceId)

      await place(workspaceId, taskId)

      expect(await reserve(taskId)).toEqual(['#1 gift 10 active', '#1 pack 35 active'])
    })

    it('sets aside everything that can be spent when that is less than the step', async () => {
      const { workspaceId } = await funded({ tariff: 4, gift: 2, pack: 6 })
      const taskId = await task(workspaceId)

      expect(await place(workspaceId, taskId)).toMatchObject({ applied: true, reserved: 12 })

      expect(await reserve(taskId)).toEqual([
        '#1 tariff 4 active',
        '#1 gift 2 active',
        '#1 pack 6 active',
      ])
    })

    it('never takes what another task holds', async () => {
      const { workspaceId } = await funded({ tariff: 50 })
      const [first, second, third] = await tasks(workspaceId, 3)

      expect((await place(workspaceId, first!)).reserved).toBe(45)
      // Five credits are free: a second task starts on them alone.
      expect((await place(workspaceId, second!)).reserved).toBe(5)
      expect(await refused(workspaceId, third!)).toMatchObject(creditsHeld(0, 50))
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(50, 50) })
    })

    it.each(['none', 'past_due', 'cancelled', 'expired', 'trial'] as const)(
      'stands on gift credits alone while the tariff is not paid: %s',
      async (state) => {
        const { workspaceId } = await funded({
          tariff: 300,
          gift: 35,
          pack: 100,
          subscription: state === 'none' ? null : { status: state },
        })
        const taskId = await taskOn(workspaceId, 'https://www.Gift-Only.example.ru')

        const placed = await place(workspaceId, taskId)

        // The step is 45; the gift is all a task may take without a paid tariff.
        expect(placed).toMatchObject({ applied: true, reserved: 35 })
        expect(await reserve(taskId)).toEqual(['#1 gift 35 active'])
        expect(placed.holds[0]).toMatchObject({ createdAt: NOW, placedAt: NOW })
        expect(await accounts(workspaceId)).toEqual({
          tariff: account(300),
          gift: account(35, 35),
          pack: account(100),
        })
        // The site spends its gift in this workspace from now on.
        expect(await db.giftSiteClaim.findMany({ where: { workspaceId } })).toMatchObject([
          { hostKey: 'gift-only.example.ru', workspaceId },
        ])
      },
    )

    it('places one reserve for an attempt, however often it is asked', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)

      const first = await place(workspaceId, taskId)
      const again = await place(workspaceId, taskId, { now: LATER })

      expect(again).toEqual({ ...first, applied: false })
      expect(await reserve(taskId)).toEqual(['#1 tariff 5 active', '#1 pack 40 active'])
      expect(await accounts(workspaceId)).toMatchObject({
        tariff: account(5, 5),
        pack: account(100, 40),
      })
    })

    it('places one reserve when twenty calls ask for the same attempt at once', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)

      const results = await Promise.all(
        Array.from({ length: 20 }, () => fixtures.reserve(placement(workspaceId, taskId))),
      )

      expect(results.filter((result) => result.applied)).toHaveLength(1)
      expect(new Set(results.map((result) => result.holds[0]?.id)).size).toBe(1)
      expect(await reserve(taskId)).toEqual(['#1 tariff 45 active'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300, 45) })
      await expectBooksToBalance(workspaceId)
    })

    it('returns the reserve of an attempt as it became, whatever became of the tariff', async () => {
      const t = await subscribed({ tariff: 40, pack: 100 })
      const taskId = await task(t.workspaceId)
      await place(t.workspaceId, taskId)
      await release(taskId)
      await endPeriod(t, 'cancelled')

      const again = await place(t.workspaceId, taskId)

      expect(again).toMatchObject({ applied: false, reserved: 45 })
      expect(again.holds.map((hold) => hold.status)).toEqual(['released', 'released'])
      expect(await reserve(taskId)).toEqual(['#1 tariff 40 released', '#1 pack 5 released'])
    })

    it('leaves no trace of a reserve whose transaction is rolled back', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: 35, subscription: null })
      const taskId = await task(workspaceId)
      const before = await written(workspaceId)

      await expect(
        db.$transaction((tx) =>
          underPrivateCreditRate(tx, async () => {
            await placeCreditHold(tx, placement(workspaceId, taskId))
            throw new Error('the task could not be queued')
          }),
        ),
      ).rejects.toThrow('the task could not be queued')

      // Neither the reserve nor the claim of the site.
      expect(await written(workspaceId)).toEqual(before)
      // The attempt is free: the retry places its reserve.
      expect(await place(workspaceId, taskId)).toMatchObject({ applied: true, reserved: 35 })
    })

    it('stamps a reserve no earlier than the start of the period it is placed in', async () => {
      // The period starts at the moment ЮKassa captured the payment, two seconds ahead of the
      // clock that queues the task.
      const start = new Date(NOW.getTime() + 2_000)
      const { workspaceId } = await funded({
        tariff: 5,
        pack: 100,
        subscription: {
          currentPeriodStart: start,
          currentPeriodEnd: new Date(start.getTime() + PERIOD_MS),
          periodAnchor: start,
        },
      })
      const taskId = await task(workspaceId)

      const placed = await place(workspaceId, taskId)

      for (const hold of placed.holds)
        expect(hold).toMatchObject({ createdAt: start, placedAt: start })
      // The day of the moment the reserve was placed at.
      expect(await today(workspaceId, NOW)).toBe('0 + 5')
      // Rows of this period: their credits come back.
      expect(await release(taskId)).toMatchObject({ applied: true, expiries: [] })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(5), pack: account(100) })
    })

    it('stamps a tariff row placed after its period ended with that period, and the others with the moment', async () => {
      const { workspaceId } = await funded({ tariff: 5, gift: 35, pack: 100 })
      const taskId = await task(workspaceId)
      // The renewal is not settled yet: the tariff is still active, its credits are of the
      // period that ended.
      const late = minutesAfter(2, PERIOD_END)

      const placed = await place(workspaceId, taskId, { now: late })

      const lastMoment = new Date(PERIOD_END.getTime() - 1)
      expect(
        placed.holds.map((hold) => [kindOf(hold.unit), hold.createdAt, hold.placedAt]),
      ).toEqual([
        ['tariff', lastMoment, late],
        ['gift', late, late],
        ['pack', late, late],
      ])
    })
  })

  describe('a refusal', () => {
    it('needs a usable credit rate before anything else', async () => {
      const { workspaceId } = await funded({ tariff: 3 })
      const taskId = await task(workspaceId)

      // No rate at all — and no credits either: the rate is what is said.
      expect(await refused(workspaceId, taskId, { rate: false })).toMatchObject(rateMissing(3))
      // With a rate the same task is told about its credits.
      expect(await refused(workspaceId, taskId)).toMatchObject(notEnough('below_start', 3))
    })

    it('takes no task under a rate that is older than a price of an enabled model, or not in force yet', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)
      const asked = placement(workspaceId, taskId)
      const rateFrom = new Date('2026-09-01T00:00:00.000Z')
      const ask = (
        prepare: (tx: Prisma.TransactionClient, pool: TestModelPool) => Promise<unknown>,
      ) =>
        inRolledBackTransaction(db, async (tx) => {
          await prepare(tx, await writeModelPool(tx, { enabled: true }))
          return placeCreditHold(tx, asked).then(
            (placed) => placed.reserved,
            (error: unknown) => error,
          )
        })

      // A price of an enabled model started after the rate: its calls could not be converted.
      expect(
        await ask(async (tx, pool) => {
          await writeCreditRate(tx, { effectiveFrom: rateFrom })
          await writeModelPrice(tx, pool, { effectiveFrom: new Date('2026-09-02T00:00:00.000Z') })
        }),
      ).toMatchObject(rateMissing(300))
      // A rate that starts tomorrow is not in force today.
      expect(
        await ask((tx) => writeCreditRate(tx, { effectiveFrom: new Date(NOW.getTime() + DAY_MS) })),
      ).toMatchObject(rateMissing(300))
      // The rate approved together with the price is usable.
      expect(
        await ask(async (tx, pool) => {
          await writeCreditRate(tx, { effectiveFrom: rateFrom })
          await writeModelPrice(tx, pool, { effectiveFrom: rateFrom })
        }),
      ).toBe(45)
      // Nothing of the three was committed.
      expect(await reserve(taskId)).toEqual([])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it('asks the rate about the moment the reserve is placed at, not about a clock that is behind it', async () => {
      // The period — and with it the placement — starts two seconds after the clock of the
      // queue; the rate starts between the two.
      const start = new Date(NOW.getTime() + 2_000)
      const { workspaceId } = await funded({
        subscription: {
          currentPeriodStart: start,
          currentPeriodEnd: new Date(start.getTime() + PERIOD_MS),
          periodAnchor: start,
        },
      })
      const taskId = await task(workspaceId)

      const placed = await inRolledBackTransaction(db, async (tx) => {
        await writeCreditRate(tx, { effectiveFrom: new Date(NOW.getTime() + 1_000) })
        return placeCreditHold(tx, placement(workspaceId, taskId))
      })

      expect(placed).toMatchObject({ applied: true, reserved: 45 })
      expect(placed.holds[0]?.placedAt).toEqual(start)
    })

    it('tells a paid tariff that its credits ran out, or that too few are left', async () => {
      const empty = await funded({ tariff: 0 })
      expect(await refused(empty.workspaceId, await task(empty.workspaceId))).toMatchObject(
        notEnough('empty', 0),
      )

      const few = await funded({ tariff: 1, gift: 1, pack: 2 })
      expect(await refused(few.workspaceId, await task(few.workspaceId))).toMatchObject(
        notEnough('below_start', 4),
      )
      // Five that can be spent start a task.
      await grant(few.workspaceId, 'pack', 1)
      expect(await place(few.workspaceId, await task(few.workspaceId))).toMatchObject({
        applied: true,
        reserved: 5,
      })
    })

    it('tells that the credits are held when other tasks in work have them set aside', async () => {
      const { workspaceId } = await funded({ tariff: 45, pack: 3 })
      const [working, waiting] = await tasks(workspaceId, 2)
      await place(workspaceId, working!)

      // Three are free, 45 are held: with what comes back there would be enough.
      expect(await refused(workspaceId, waiting!)).toMatchObject(creditsHeld(3, 45))

      // Without a paid tariff the gift is set aside for the task in work.
      const trial = await funded({ tariff: 0, gift: 35, subscription: null })
      const [first, second] = await tasks(trial.workspaceId, 2)
      await place(trial.workspaceId, first!)
      expect(await refused(trial.workspaceId, second!)).toMatchObject(creditsHeld(0, 35))
    })

    it('tells a workspace without a tariff that the gift is spent, or that too little of it is left', async () => {
      const spent = await funded({ tariff: 0, subscription: null })
      expect(await refused(spent.workspaceId, await task(spent.workspaceId))).toMatchObject(
        needsTariff('gift_spent', 0),
      )

      const few = await funded({ tariff: 0, gift: 4, subscription: null })
      expect(await refused(few.workspaceId, await task(few.workspaceId))).toMatchObject(
        needsTariff('gift_below_start', 4),
      )
      await grant(few.workspaceId, 'gift', 1)
      expect(await place(few.workspaceId, await task(few.workspaceId))).toMatchObject({
        applied: true,
        reserved: 5,
      })
    })

    it('tells an overdue tariff to be paid, and an ended one that its pack waits for a tariff', async () => {
      // The quota and the pack are there, and neither is a task's to take.
      const overdue = await funded({
        tariff: 300,
        gift: 3,
        pack: 100,
        subscription: { status: 'past_due', pastDueSince: PERIOD_END },
      })
      expect(await refused(overdue.workspaceId, await task(overdue.workspaceId))).toMatchObject(
        needsTariff('past_due', 3),
      )

      for (const status of ['cancelled', 'expired'] as const) {
        const ended = await funded({ tariff: 0, pack: 40, subscription: { status } })
        expect(await refused(ended.workspaceId, await task(ended.workspaceId))).toMatchObject(
          needsTariff('ended', 0),
        )
      }
    })

    it('holds a paid tariff to the tariff credits of its day, with credits still free', async () => {
      const { workspaceId } = await funded({ plan: startDay })
      const [first, second, third] = await tasks(workspaceId, 3)
      expect(await place(workspaceId, first!)).toMatchObject({ reserved: 45 })
      // What is left of the day: five of the fifty.
      expect(await place(workspaceId, second!)).toMatchObject({ reserved: 5 })
      expect(await reserve(second!)).toEqual(['#1 tariff 5 active'])

      expect(await refused(workspaceId, third!)).toMatchObject(
        dailyLimit(250, 50, { limit: 50, used: 50 }),
      )

      // The next day in Moscow takes it.
      const tomorrow = new Date('2026-10-04T21:00:00.000Z')
      expect(await place(workspaceId, third!, { now: tomorrow })).toMatchObject({
        applied: true,
        reserved: 45,
      })
    })

    // «Если кредиты закончились, можно докупить»: a pack is outside the day.
    it('lets a pack bought the same day carry the tasks the day of the tariff no longer can', async () => {
      const { workspaceId } = await funded({ plan: startDay })
      const [first, second, third] = await tasks(workspaceId, 3)
      await place(workspaceId, first!)
      await place(workspaceId, second!)
      expect(await refused(workspaceId, third!)).toMatchObject(
        dailyLimit(250, 50, { limit: 50, used: 50 }),
      )

      await grant(workspaceId, 'pack', 100)

      expect(await place(workspaceId, third!, { now: minutesAfter(5) })).toMatchObject({
        reserved: 45,
      })
      expect(await reserve(third!)).toEqual(['#1 pack 45 active'])
      expect(await today(workspaceId)).toBe('0 + 50')
    })

    it('has no limit of the day on a plan without one', async () => {
      const { workspaceId } = await funded()
      for (const taskId of await tasks(workspaceId, 6)) {
        expect(await place(workspaceId, taskId)).toMatchObject({ applied: true, reserved: 45 })
      }
      // The day is still counted: there is just nothing to compare it with.
      expect(await today(workspaceId)).toBe('0 + 270')
    })

    // Without a tariff there is no day: the gift of the registration is the bound.
    it('lets a workspace without a tariff spend its whole gift in one day, and then not', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: 35, subscription: null })
      // The step is larger than the gift, so the tasks go one at a time.
      for (let index = 0; index < 7; index += 1) {
        const taskId = await task(workspaceId)
        await place(workspaceId, taskId, { now: minutesAfter(index * 10) })
        await settle(taskId, 5, { now: minutesAfter(index * 10 + 5) })
      }
      expect(await accounts(workspaceId)).toMatchObject({ gift: account(0) })
      expect(await today(workspaceId, minutesAfter(70))).toBe('0 + 0')

      expect(
        await refused(workspaceId, await task(workspaceId), { now: minutesAfter(70) }),
      ).toMatchObject(needsTariff('gift_spent', 0))
    })

    it('stops new tasks of a paid tariff when the work it got without a charge reaches its monthly credits', async () => {
      // A tariff of 50 credits a month: 300 RUB of work at 6 RUB a credit.
      const { workspaceId } = await funded({ plan: { creditsPerMonth: 50 } })
      const model = await modelPool()
      const [failed, working, asked] = await tasks(workspaceId, 3)
      await place(workspaceId, failed!)
      await worked(model, failed!, '299.99')
      await release(failed!)

      // A hair below the bound: the next task is taken.
      expect(await place(workspaceId, working!, { now: minutesAfter(10) })).toMatchObject({
        applied: true,
      })
      // One kopeck of work more and the bound is reached: work in progress is unpaid until the
      // task is charged.
      await worked(model, working!, '0.01', { occurredAt: minutesAfter(11) })
      expect(await refused(workspaceId, asked!, { now: minutesAfter(12) })).toMatchObject(
        unpaidLimit(255, 45),
      )

      // What the customer paid is not unpaid: charged five credits, the workspace is five below
      // its bound, and the task is taken.
      await settle(working!, 5, { now: minutesAfter(13) })
      expect(await place(workspaceId, asked!, { now: minutesAfter(14) })).toMatchObject({
        applied: true,
        reserved: 45,
      })
    })

    it('counts the unpaid work of a paid tariff from the start of its period', async () => {
      const { workspaceId } = await funded({ plan: { creditsPerMonth: 50 } })
      const model = await modelPool()
      const [before, taskId] = await tasks(workspaceId, 2)
      // A lost call of the period before: it spent the pool then, and bounds nothing now.
      await worked(model, before!, '900', { occurredAt: minutesAfter(-1, PERIOD_START) })

      expect(await place(workspaceId, taskId!)).toMatchObject({ applied: true })
    })

    it('does not take two tasks charged between the end of a period and its renewal for unpaid work of the new period', async () => {
      const t = await subscribed({ plan: { creditsPerMonth: 50 } })
      const model = await modelPool()
      const [first, second, failed, asked] = await tasks(t.workspaceId, 4)
      const tariff = await accountId(t.workspaceId, 'tariff')
      // The period is over and its renewal is not settled yet: the tariff still takes tasks.
      // Each of the two works for 150 RUB after that end and is charged all of it, 25 credits.
      for (const [taskId, minute] of [
        [first!, 2],
        [second!, 6],
      ] as const) {
        await place(t.workspaceId, taskId, { now: minutesAfter(minute, t.periodEnd) })
        await worked(model, taskId, '150', { occurredAt: minutesAfter(minute + 1, t.periodEnd) })
        await settle(taskId, 25, { now: minutesAfter(minute + 3, t.periodEnd) })
        // The stamp of the charge is of the period whose credits paid: before the next one.
        expect((await entryOf(ledgerKeys.taskCharge(taskId, 1, tariff))).createdAt).toEqual(
          new Date(t.periodEnd.getTime() - 1),
        )
      }
      // The renewal is settled: the new period starts at that end, before the work of both.
      await renew({ ...t, planId: t.plan.id }, { credits: 50 })

      // 50 credits of work since the period started, every one of them charged: a task is taken.
      expect(
        await place(t.workspaceId, failed!, { now: minutesAfter(20, t.periodEnd) }),
      ).toMatchObject({ applied: true, reserved: 45 })

      // What nobody paid for still counts: 50 credits of a failed task reach the bound.
      await worked(model, failed!, '300', { occurredAt: minutesAfter(21, t.periodEnd) })
      await release(failed!, { now: minutesAfter(22, t.periodEnd) })
      expect(
        await refused(t.workspaceId, asked!, { now: minutesAfter(23, t.periodEnd) }),
      ).toMatchObject(unpaidLimit(50))
    })

    it.each(['past_due', 'cancelled', 'expired'] as const)(
      'stops a workspace whose tariff is %s at 70 credits of unpaid work, counted from the end of its paid period',
      async (status) => {
        const ended = new Date('2026-10-01T09:00:00.000Z')
        const { workspaceId, plan } = await funded({
          tariff: 0,
          gift: 35,
          subscription: {
            status,
            currentPeriodStart: new Date('2026-09-01T09:00:00.000Z'),
            currentPeriodEnd: ended,
          },
        })
        // A tariff before that one, which ended in August: the last one is what counts.
        await fixtures.subscription({
          workspaceId,
          planId: plan.id,
          status: 'expired',
          currentPeriodStart: new Date('2026-07-01T09:00:00.000Z'),
          currentPeriodEnd: new Date('2026-08-01T09:00:00.000Z'),
        })
        const model = await modelPool()
        const [old, failed, next, last] = await tasks(workspaceId, 4)
        // Work of the tariff that ended is not the trial's.
        await worked(model, old!, '5000', { occurredAt: minutesAfter(-1, ended) })
        await place(workspaceId, failed!)
        // 419.99 RUB: a hair below 70 credits.
        await worked(model, failed!, '419.99')
        await release(failed!)

        expect(await place(workspaceId, next!, { now: minutesAfter(10) })).toMatchObject({
          applied: true,
          reserved: 35,
        })
        await worked(model, next!, '0.01', { occurredAt: minutesAfter(11) })
        await release(next!, { now: minutesAfter(12) })

        // The gift is untouched and no longer starts a task: a tariff is needed.
        expect(await refused(workspaceId, last!, { now: minutesAfter(13) })).toMatchObject(
          needsTariff('trial_unpaid_limit', 35),
        )
        expect(await accounts(workspaceId)).toMatchObject({ gift: account(35) })
      },
    )

    it('counts the unpaid work of a workspace that never had a tariff from its creation', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: 35, subscription: null })
      const created = new Date('2026-10-01T00:00:00.000Z')
      await db.workspace.update({ where: { id: workspaceId }, data: { createdAt: created } })
      const model = await modelPool()
      const [failed, next] = await tasks(workspaceId, 2)
      await place(workspaceId, failed!)
      await worked(model, failed!, '420')
      await release(failed!)

      expect(await refused(workspaceId, next!, { now: minutesAfter(10) })).toMatchObject(
        needsTariff('trial_unpaid_limit', 35),
      )

      // Work from before the workspace was made is nobody's unpaid work.
      await db.workspace.update({
        where: { id: workspaceId },
        data: { createdAt: minutesAfter(8) },
      })
      expect(await place(workspaceId, next!, { now: minutesAfter(10) })).toMatchObject({
        applied: true,
      })
    })

    it('lets a site spend gift credits in one workspace only', async () => {
      const first = await funded({ tariff: 0, gift: 35, subscription: null })
      const second = await funded({ tariff: 0, gift: 35, subscription: null })
      const mine = await taskOn(first.workspaceId, 'https://shop.example.ru')
      // The same site by another scheme and with `www.`.
      const theirs = await taskOn(second.workspaceId, 'http://www.shop.example.ru')
      await place(first.workspaceId, mine)
      const claim = await db.giftSiteClaim.findUniqueOrThrow({
        where: { hostKey: 'shop.example.ru' },
      })
      expect(claim.workspaceId).toBe(first.workspaceId)

      expect(await refused(second.workspaceId, theirs)).toMatchObject(
        needsTariff('gift_site_used', 35),
      )
      expect(
        await db.giftSiteClaim.findUniqueOrThrow({ where: { hostKey: 'shop.example.ru' } }),
      ).toEqual(claim)

      // Another site of the second workspace is its own to claim, and a port is another site.
      const other = await taskOn(second.workspaceId, 'https://shop.example.ru:8443')
      expect(await place(second.workspaceId, other)).toMatchObject({ applied: true, reserved: 35 })
      // The first workspace goes on with its site: the claim is its own.
      await settle(mine, 5)
      const again = await taskOn(first.workspaceId, 'http://shop.example.ru')
      expect(await place(first.workspaceId, again, { now: minutesAfter(30) })).toMatchObject({
        applied: true,
        reserved: 30,
      })
      expect(await db.giftSiteClaim.count({ where: { hostKey: 'shop.example.ru' } })).toBe(1)
    })

    it('asks nothing about the site of a paid tariff, gift credits or not', async () => {
      const trial = await funded({ tariff: 0, gift: 35, subscription: null })
      await place(trial.workspaceId, await taskOn(trial.workspaceId, 'https://paid.example.ru'))
      const paying = await funded({ tariff: 5, gift: 35 })
      const taskId = await taskOn(paying.workspaceId, 'https://paid.example.ru')

      expect(await place(paying.workspaceId, taskId)).toMatchObject({ applied: true, reserved: 40 })

      expect(await reserve(taskId)).toEqual(['#1 tariff 5 active', '#1 gift 35 active'])
      expect(await db.giftSiteClaim.count({ where: { workspaceId: paying.workspaceId } })).toBe(0)
    })

    it('refuses by the rate, then the credits, then the day, then the unpaid work', async () => {
      const { workspaceId } = await funded({
        tariff: 48,
        plan: { creditsPerMonth: 50, creditsPerDay: 45 },
      })
      const model = await modelPool()
      const [failed, asked] = await tasks(workspaceId, 2)
      // A task of the day failed after 300 RUB of work: 50 credits of unpaid work. Its reserve
      // came back, and with it the day.
      await place(workspaceId, failed!)
      await worked(model, failed!, '300')
      await release(failed!)
      // A task queued earlier today holds all but three credits, and the 45 of the day.
      const inWork = await fixtures.hold(workspaceId, 'tariff', 45)
      await db.creditHold.update({
        where: { id: inWork.id },
        data: { createdAt: NOW, placedAt: NOW },
      })

      expect(await refused(workspaceId, asked!, { rate: false })).toMatchObject(rateMissing(3, 45))
      expect(await refused(workspaceId, asked!)).toMatchObject(creditsHeld(3, 45))
      // The credits are there now: the day is what refuses.
      await grant(workspaceId, 'tariff', 10)
      expect(await refused(workspaceId, asked!)).toMatchObject(
        dailyLimit(13, 45, { limit: 45, used: 45 }),
      )
      // Tomorrow the day is free: the unpaid work is what refuses.
      const tomorrow = new Date('2026-10-04T21:00:00.000Z')
      expect(await refused(workspaceId, asked!, { now: tomorrow })).toMatchObject(
        unpaidLimit(13, 45),
      )
    })

    it('refuses a workspace without a tariff by its credits, then its unpaid work, then the site — never by a day', async () => {
      const other = await funded({ tariff: 0, gift: 35, subscription: null })
      await place(other.workspaceId, await taskOn(other.workspaceId, 'https://taken.example.ru'))
      const { workspaceId } = await funded({ tariff: 0, gift: 19, subscription: null })
      await db.workspace.update({
        where: { id: workspaceId },
        data: { createdAt: new Date('2026-10-01T00:00:00.000Z') },
      })
      const model = await modelPool()
      // Three tasks of today, each done for five credits after 170 RUB of work.
      for (const minute of [0, 10, 20]) {
        const taskId = await task(workspaceId)
        await place(workspaceId, taskId, { now: minutesAfter(minute) })
        await worked(model, taskId, '170', { occurredAt: minutesAfter(minute + 1) })
        await settle(taskId, 5, { now: minutesAfter(minute + 5) })
      }
      const asked = await taskOn(workspaceId, 'https://taken.example.ru')
      const at = minutesAfter(30)

      // Four gift credits are left; 85 credits of work with 15 charged are 70 unpaid; the site
      // is another workspace's. The credits are said first.
      expect(await refused(workspaceId, asked, { now: at })).toMatchObject(
        needsTariff('gift_below_start', 4),
      )
      await grant(workspaceId, 'gift', 1)
      expect(await refused(workspaceId, asked, { now: at })).toMatchObject(
        needsTariff('trial_unpaid_limit', 5),
      )
      // Counted from a later moment, the unpaid work is gone: the site is what is left.
      await db.workspace.update({ where: { id: workspaceId }, data: { createdAt: at } })
      expect(await refused(workspaceId, asked, { now: at })).toMatchObject(
        needsTariff('gift_site_used', 5),
      )
    })

    it('makes the three empty accounts of a workspace that has none, and nothing else, when it refuses', async () => {
      // A workspace as the fixtures make it: no account was ever created for it.
      const { workspaceId } = await fixtures.workspace()
      const taskId = await task(workspaceId)
      expect(await accounts(workspaceId)).toEqual({ tariff: null, gift: null, pack: null })

      const error = await db.$transaction((tx) =>
        underPrivateCreditRate(tx, () =>
          placeCreditHold(tx, placement(workspaceId, taskId)).catch((caught: unknown) => caught),
        ),
      )

      expect(error).toMatchObject(needsTariff('gift_spent', 0))
      // The accounts are what a placement locks: they are there from now on, empty.
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(0),
        gift: account(0),
        pack: account(0),
      })
      expect(await written(workspaceId)).toMatchObject({ holds: [], ledger: [], claims: [] })
    })

    it('finds no task of another workspace', async () => {
      const { workspaceId } = await funded()
      const other = await funded()
      const taskId = await task(workspaceId)

      expect(await refused(workspaceId, randomUUID())).toMatchObject(notFound)
      // The task exists, but its credits are not on the accounts of this workspace.
      expect(await refused(other.workspaceId, taskId)).toMatchObject(notFound)
      expect(await reserve(taskId)).toEqual([])
    })

    it('takes no reserve for a task that is not billable or has no class of its model', async () => {
      const { workspaceId } = await funded()
      for (const data of [
        { billable: false },
        { modelClass: null },
        // The class the database still keeps for the old service calls has no step.
        { modelClass: 'service' as const },
      ]) {
        expect(await refused(workspaceId, await task(workspaceId, data))).toMatchObject(conflict)
      }
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it('takes no reserve under a subscription to a plan that has no monthly credits', async () => {
      const { workspaceId, subscription } = await funded()
      const wallet = await fixtures.plan({ kind: 'payg', price: '0.00', creditsPerMonth: null })
      await db.subscription.update({ where: { id: subscription!.id }, data: { planId: wallet.id } })

      expect(await refused(workspaceId, await task(workspaceId))).toMatchObject({
        ...conflict,
        message: 'The plan of the subscription has no monthly credits',
      })
    })

    it('settles no reserve row that stands on an account of another workspace', async () => {
      const { workspaceId } = await funded()
      const other = await funded()
      const taskId = await task(workspaceId)
      // A row nothing here writes: the task of one workspace on the account of another.
      const foreign = await accountId(other.workspaceId, 'tariff')
      await db.$transaction([
        db.creditHold.create({
          data: {
            accountId: foreign,
            unit: 'credit_tariff',
            taskId,
            amount: 45,
            expiresAt: new Date(NOW.getTime() + DAY_MS),
          },
        }),
        db.billingAccount.update({ where: { id: foreign }, data: { held: { increment: 45 } } }),
      ])
      const before = [await written(workspaceId), await written(other.workspaceId)]

      expect(await refused(workspaceId, taskId, { attempt: 2 })).toMatchObject(conflict)
      await expect(settle(taskId, 17)).rejects.toMatchObject(conflict)
      await expect(release(taskId)).rejects.toMatchObject(conflict)
      await expect(expire(taskId)).rejects.toMatchObject(conflict)
      await expect(extend(taskId, minutesAfter(60))).rejects.toMatchObject(conflict)

      expect([await written(workspaceId), await written(other.workspaceId)]).toEqual(before)
    })

    it('leaves a hold of the rouble wallet alone', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)
      const wallet = await db.billingAccount.create({
        data: { workspaceId, unit: 'rub', balance: '500.00', held: '300.00' },
      })
      const hold = await db.creditHold.create({
        data: {
          accountId: wallet.id,
          unit: 'rub',
          taskId,
          amount: '300.00',
          expiresAt: new Date(NOW.getTime() + DAY_MS),
          createdAt: NOW,
          placedAt: NOW,
        },
      })

      // The task has its reserve in roubles: it gets no credits on top, and none of the
      // functions of credits settles it.
      expect(await refused(workspaceId, taskId)).toMatchObject(conflict)
      await expect(settle(taskId, 17)).rejects.toMatchObject(conflict)
      await expect(release(taskId)).rejects.toMatchObject(conflict)
      await expect(expire(taskId)).rejects.toMatchObject(conflict)
      await expect(extend(taskId, minutesAfter(60))).rejects.toMatchObject(conflict)

      expect(await db.creditHold.findUniqueOrThrow({ where: { id: hold.id } })).toEqual(hold)
      expect(await db.billingAccount.findUniqueOrThrow({ where: { id: wallet.id } })).toEqual(
        wallet,
      )
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
      // Placed today and active, it is still nothing of the day: the day counts tariff credits.
      expect(await today(workspaceId)).toBe('0 + 0')
    })
  })

  describe('an attempt', () => {
    it('needs five credits that can be spent for a new task and for a retry, one for a continuation', async () => {
      const { workspaceId } = await funded({ tariff: 49 })
      const [retried, continued, fresh] = await tasks(workspaceId, 3)
      await place(workspaceId, retried!)
      await release(retried!)
      await place(workspaceId, continued!, { now: minutesAfter(1) })

      // Four credits are free: neither a new task nor a retry starts on them…
      expect(await refused(workspaceId, fresh!)).toMatchObject(creditsHeld(4, 45))
      expect(await refused(workspaceId, retried!, { attempt: 2, retry: true })).toMatchObject(
        creditsHeld(4, 45),
      )
      // …and the task in work goes on with them: its own reserve is not «tasks in work».
      expect(
        await place(workspaceId, continued!, { attempt: 2, now: minutesAfter(30) }),
      ).toMatchObject({ applied: true, reserved: 4 })
      expect(await reserve(continued!)).toEqual(['#1 tariff 45 active', '#2 tariff 4 active'])

      // Nothing is free any more: a third attempt has nothing to add, and is told that the
      // credits ran out — not to wait for tasks in work.
      expect(
        await refused(workspaceId, continued!, { attempt: 3, now: minutesAfter(40) }),
      ).toMatchObject(notEnough('empty', 0, 0, 1))
      await grant(workspaceId, 'pack', 1)
      expect(
        await place(workspaceId, continued!, { attempt: 3, now: minutesAfter(40) }),
      ).toMatchObject({ applied: true, reserved: 1 })
      expect(await reserve(continued!)).toEqual([
        '#1 tariff 45 active',
        '#2 tariff 4 active',
        '#3 pack 1 active',
      ])
    })

    it('starts a retry on five credits, in the class the task has by then', async () => {
      const { workspaceId } = await funded({ tariff: 50 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      await release(taskId)
      // «Попробовать ещё» runs in the stronger mode.
      await db.task.update({ where: { id: taskId }, data: { modelClass: 'heavy', attempt: 2 } })

      const retry = await place(workspaceId, taskId, {
        attempt: 2,
        now: minutesAfter(30),
        retry: true,
      })

      // The step is 120; fifty is everything there is.
      expect(retry).toMatchObject({ applied: true, reserved: 50 })
      expect(await reserve(taskId)).toEqual(['#1 tariff 45 released', '#2 tariff 50 active'])
    })

    it('continues a task after a retry: only its rows that are still active are its own reserve', async () => {
      const { workspaceId } = await funded({ tariff: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      await release(taskId)
      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(30), retry: true })

      // «Продолжить» at the step of the retry: the rows of the failed attempt hold nothing.
      const third = await place(workspaceId, taskId, { attempt: 3, now: minutesAfter(60) })

      expect(third).toMatchObject({ applied: true, reserved: 45 })
      expect(await reserve(taskId)).toEqual([
        '#1 tariff 45 released',
        '#2 tariff 45 active',
        '#3 tariff 45 active',
      ])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(100, 90) })
    })

    it('adds the reserve of a continuation to the pool of the task and gives the pool one expiry', async () => {
      const { workspaceId } = await funded({ tariff: 50, gift: 35, pack: 100 })
      const taskId = await task(workspaceId)
      const first = await place(workspaceId, taskId)
      expect(first.holds.map((hold) => hold.expiresAt)).toEqual([new Date(NOW.getTime() + DAY_MS)])
      const later = minutesAfter(120)
      const expiresAt = new Date(later.getTime() + 3 * DAY_MS)

      const second = await place(workspaceId, taskId, { attempt: 2, now: later, expiresAt })

      expect(second).toMatchObject({ applied: true, reserved: 45 })
      expect(await reserve(taskId)).toEqual([
        '#1 tariff 45 active',
        '#2 tariff 5 active',
        '#2 gift 35 active',
        '#2 pack 5 active',
      ])
      // The earlier rows live as long as the new ones.
      const stored = await db.creditHold.findMany({ where: { taskId } })
      expect(stored.map((hold) => hold.expiresAt)).toEqual(Array(4).fill(expiresAt))
      // And keep the moment they were placed at.
      expect((await holdOf(taskId, 'tariff', 1)).placedAt).toEqual(NOW)
      expect((await holdOf(taskId, 'tariff', 2)).placedAt).toEqual(later)
      const reserved = { tariff: account(50, 50), gift: account(35, 35), pack: account(100, 5) }
      expect(await accounts(workspaceId)).toEqual(reserved)

      // Asked again, each attempt answers with its own rows and with what they hold.
      expect(await place(workspaceId, taskId, { attempt: 2, now: later, expiresAt })).toEqual({
        ...second,
        applied: false,
      })
      const again = await place(workspaceId, taskId)
      expect(again).toMatchObject({ applied: false, reserved: 45 })
      expect(again.holds.map((hold) => [hold.id, hold.expiresAt])).toEqual([
        [first.holds[0]?.id, expiresAt],
      ])
      expect(await accounts(workspaceId)).toEqual(reserved)
    })

    it('takes three attempts of a chain and refuses a fourth continuation', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)
      for (const attempt of [1, 2, 3]) {
        expect(await place(workspaceId, taskId, { attempt })).toMatchObject({
          applied: true,
          reserved: 45,
        })
      }
      expect(await taskChainAttempts(db, taskId)).toEqual([1, 2, 3])

      expect(await refused(workspaceId, taskId, { attempt: 4 })).toMatchObject(conflict)
      expect(await reserve(taskId)).toHaveLength(3)
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300, 135) })

      // «Попробовать ещё» after a failure gives the chain back and starts a new one: the
      // attempt in which the agent failed is not counted (spec §20, decision 4 of 11.10.2026).
      await release(taskId)
      expect(await taskChainAttempts(db, taskId)).toEqual([])
      expect(await place(workspaceId, taskId, { attempt: 4, retry: true })).toMatchObject({
        applied: true,
        reserved: 45,
      })
      expect(await taskChainAttempts(db, taskId)).toEqual([4])
      // And a continuation of it is the second attempt of its chain.
      expect(await place(workspaceId, taskId, { attempt: 5 })).toMatchObject({ applied: true })
      expect(await taskChainAttempts(db, taskId)).toEqual([4, 5])
    })

    it('takes no reserve for a charged task, nor for an attempt below one that holds a reserve', async () => {
      const { workspaceId } = await funded()
      const [done, skipped] = await tasks(workspaceId, 2)
      await place(workspaceId, done!)
      await settle(done!, 17)
      expect(await refused(workspaceId, done!, { attempt: 2 })).toMatchObject(conflict)
      // The attempt that was charged is still answered with its reserve, as it became.
      const again = await place(workspaceId, done!)
      expect(again).toMatchObject({ applied: false, reserved: 45 })
      expect(again.holds.map((hold) => hold.status)).toEqual(['captured'])

      // The second attempt was placed first: the first cannot come after it.
      await place(workspaceId, skipped!, { attempt: 2, retry: true })
      expect(await refused(workspaceId, skipped!, { attempt: 1 })).toMatchObject(conflict)
      expect(await reserve(skipped!)).toEqual(['#2 tariff 45 active'])
    })

    // The owner, 19.10.2026: the daily limit does not apply to «Попробовать ещё» — so a retry is
    // what its caller says it is, and the rows must agree with it.
    it('places a retry only after its chain was given back, and a later attempt without a reserve only as a retry', async () => {
      const { workspaceId } = await funded()
      const [taskId, never] = await tasks(workspaceId, 2)
      const notARetry = {
        ...conflict,
        message: 'A retry is a later attempt of a task whose chain was given back',
      }
      const onlyARetry = {
        ...conflict,
        message: 'A later attempt without an active reserve is placed only by a retry',
      }
      // The first attempt is no retry.
      expect(await refused(workspaceId, taskId!, { retry: true })).toMatchObject(notARetry)
      await place(workspaceId, taskId!)
      // The chain still holds its reserve: the next attempt is «Продолжить».
      expect(await refused(workspaceId, taskId!, { attempt: 2, retry: true })).toMatchObject(
        notARetry,
      )
      await release(taskId!)
      // Given back: only a retry places the next attempt.
      expect(await refused(workspaceId, taskId!, { attempt: 2 })).toMatchObject(onlyARetry)
      expect(await place(workspaceId, taskId!, { attempt: 2, retry: true })).toMatchObject({
        applied: true,
        reserved: 45,
      })
      // A repeat answers with the rows of the first call, whatever it says.
      expect(await place(workspaceId, taskId!, { attempt: 2 })).toMatchObject({
        applied: false,
        reserved: 45,
      })
      // Nor is a later attempt of a task that never had a reserve anything but a retry.
      expect(await refused(workspaceId, never!, { attempt: 2 })).toMatchObject(onlyARetry)
    })

    // A task is charged pass by pass (owner's answer of 26.10.2026): after a charge, the next
    // words or «Продолжить» open a new chain — what its caller says, and the rows agree with.
    it('opens a new chain after a charged pass, and after words to a failed one', async () => {
      const { workspaceId } = await funded()
      const [taskId, given] = await tasks(workspaceId, 2)
      const notCharged = {
        ...conflict,
        message: 'A new chain of a task follows a charge of the one before',
      }
      const goesOn = {
        ...conflict,
        message: 'The chain of the task is not charged: its next words go on with it',
      }
      await place(workspaceId, taskId!)
      // The chain is active: the words go on with it, no new chain.
      expect(await refused(workspaceId, taskId!, { attempt: 2, follows: 'message' })).toMatchObject(
        goesOn,
      )
      await settle(taskId!, 17)
      expect(await place(workspaceId, taskId!, { attempt: 2, follows: 'message' })).toMatchObject({
        applied: true,
        reserved: 45,
      })
      await settle(taskId!, 6)
      expect(await place(workspaceId, taskId!, { attempt: 3, follows: 'continue' })).toMatchObject({
        applied: true,
        reserved: 45,
      })
      expect(await reserve(taskId!)).toEqual([
        '#1 tariff 45 captured',
        '#2 tariff 45 captured',
        '#3 tariff 45 active',
      ])
      // A chain given back without a charge before it: «Продолжить» is not a new chain after a
      // charge, but the client's words are — a failure left the dialog open (28.10.2026).
      await place(workspaceId, given!)
      await release(given!)
      expect(await refused(workspaceId, given!, { attempt: 2, follows: 'continue' })).toMatchObject(
        notCharged,
      )
      expect(await place(workspaceId, given!, { attempt: 2, follows: 'message' })).toMatchObject({
        applied: true,
        reserved: 45,
      })
      // A task that never held a reserve has nothing to follow.
      const [never] = await tasks(workspaceId, 1)
      expect(await refused(workspaceId, never!, { attempt: 2, follows: 'message' })).toMatchObject(
        notCharged,
      )
      // A retry and a new chain after a charge are not one call.
      await expect(
        fixtures.reserve({
          ...placement(workspaceId, given!, { attempt: 2, retry: true }),
          follows: 'message',
        }),
      ).rejects.toBeInstanceOf(ZodError)
    })
  })

  // The daily limit in tariff credits (decision of 17.10.2026; docs/plan/37-billing-plan.md,
  // «Дневной лимит в кредитах»): «Старт» gives 50 of its 300 a Moscow day.
  describe('the day', () => {
    it('counts a reserve on the day it was placed, not by the stamp of its period', async () => {
      // The period ends at midnight in Moscow; the renewal is settled a few minutes later.
      const start = new Date('2026-09-17T21:00:00.000Z')
      const end = new Date('2026-10-17T21:00:00.000Z')
      const { workspaceId } = await funded({
        plan: startDay,
        subscription: { currentPeriodStart: start, currentPeriodEnd: end, periodAnchor: start },
      })
      const [late, next, third] = await tasks(workspaceId, 3)
      const afterMidnight = minutesAfter(2, end)

      const placed = await place(workspaceId, late!, { now: afterMidnight })

      // The credits are of the period that ended: the row is stamped with its last millisecond,
      // which is still the 17th in Moscow…
      const lastMoment = new Date(end.getTime() - 1)
      expect(placed.holds[0]).toMatchObject({ createdAt: lastMoment, placedAt: afterMidnight })
      // …and the reserve takes credits of the 18th.
      expect(await today(workspaceId, minutesAfter(5, end))).toBe('0 + 45')
      expect(await today(workspaceId, lastMoment)).toBe('0 + 0')
      // So the new day has five left of its fifty.
      expect(await place(workspaceId, next!, { now: minutesAfter(5, end) })).toMatchObject({
        reserved: 5,
      })
      expect(await refused(workspaceId, third!, { now: minutesAfter(6, end) })).toMatchObject(
        dailyLimit(250, 50, { limit: 50, used: 50 }),
      )
    })

    it('gives the day back what a returned reserve held, and keeps what a charged one paid', async () => {
      const { workspaceId } = await funded({ plan: startDay })
      const [failed, done, lapsed, next] = await tasks(workspaceId, 4)

      await place(workspaceId, failed!)
      expect(await place(workspaceId, done!, { now: minutesAfter(1) })).toMatchObject({
        reserved: 5,
      })
      expect(await today(workspaceId)).toBe('0 + 50')
      // Failed: its 45 come back to the day at once.
      await release(failed!, { now: minutesAfter(2) })
      expect(await today(workspaceId)).toBe('0 + 5')
      expect(await place(workspaceId, lapsed!, { now: minutesAfter(3) })).toMatchObject({
        reserved: 45,
      })
      // Done for 5: the day keeps 5. Stuck past its expiry: its 45 come back too.
      await settle(done!, 5, { now: minutesAfter(4) })
      await expire(lapsed!, { now: minutesAfter(3 + 24 * 60) })
      expect(await today(workspaceId, NOW)).toBe('5 + 0')
      expect(await place(workspaceId, next!, { now: minutesAfter(5) })).toMatchObject({
        reserved: 45,
      })
      expect(await today(workspaceId, NOW)).toBe('5 + 45')
    })

    // «Продолжить» takes credits of the day like a new task: the task waits for the next day or a
    // pack at the question it stopped at, never in the middle of a turn. «Попробовать ещё» does
    // not (the owner, 19.10.2026): its reserve is the step, or what is free, whatever the day, and
    // its charge comes from its own rows — and the day counts both.
    it('holds a continuation to the day and lets a pack carry it, and leaves a retry outside the day', async () => {
      const { workspaceId } = await funded({ plan: startDay })
      const model = await modelPool()
      const [working, failed, fresh] = await tasks(workspaceId, 3)
      await place(workspaceId, working!)
      await place(workspaceId, failed!, { now: minutesAfter(1) })
      await worked(model, failed!, '6')
      await release(failed!, { now: minutesAfter(2) })
      expect(await today(workspaceId)).toBe('0 + 45')
      // «Попробовать ещё» takes its whole step, though the day has five left…
      expect(
        await place(workspaceId, failed!, { attempt: 2, now: minutesAfter(5), retry: true }),
      ).toMatchObject({ applied: true, reserved: 45 })
      expect(await reserve(failed!)).toEqual(['#1 tariff 5 released', '#2 tariff 45 active'])
      // …and the day counts it: nothing is left for a new task, nor for «Продолжить» of the first.
      expect(await today(workspaceId)).toBe('0 + 90')
      expect(await refused(workspaceId, fresh!, { now: minutesAfter(6) })).toMatchObject(
        dailyLimit(210, 90, { limit: 50, used: 90 }),
      )
      expect(
        await refused(workspaceId, working!, { attempt: 2, now: minutesAfter(10) }),
      ).toMatchObject(dailyLimit(210, 45, { limit: 50, used: 90 }, { needed: 1 }))

      // One credit of a pack is enough to continue: the attempt sets aside what it can.
      await grant(workspaceId, 'pack', 1)
      expect(
        await place(workspaceId, working!, { attempt: 2, now: minutesAfter(11) }),
      ).toMatchObject({ applied: true, reserved: 1 })
      expect(await reserve(working!)).toEqual(['#1 tariff 45 active', '#2 pack 1 active'])
      expect(await today(workspaceId)).toBe('0 + 90')

      // The day has nothing left, and the retry is charged in full from its own rows: the day
      // never cuts a charge.
      const settled = await settle(failed!, 45, { now: minutesAfter(20) })
      expect(settled.from).toEqual({ tariff: 45, gift: 0, pack: 0 })
      expect(await today(workspaceId)).toBe('45 + 45')
    })

    // «Попробовать ещё» gives the whole chain of the failed pass back — an attempt in which the
    // agent failed is not counted against the client (spec §20, decision 4 of 11.10.2026) —, and
    // the reserve of the retry takes the day in its place: a failed pass and its retries take the
    // day once, by the reserve that stands.
    it('counts a chain a retry gave back nothing, and the retry by its own reserve', async () => {
      const { workspaceId } = await funded({ plan: startDay })
      const model = await modelPool()
      const taskId = await task(workspaceId)
      // A new task and «Продолжить» that both did work: the continuation takes what the day has.
      await place(workspaceId, taskId)
      await worked(model, taskId, '6', { occurredAt: minutesAfter(1) })
      expect(await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(2) })).toMatchObject({
        applied: true,
        reserved: 5,
      })
      await worked(model, taskId, '6', { attempt: 2, occurredAt: minutesAfter(3) })
      expect(await today(workspaceId)).toBe('0 + 50')

      // The pass of attempt 2 failed and its dialog kept its candidate: the retry gives the chain
      // back and places attempt 3 in the same moment, on the day the chain gave back.
      await release(taskId, { now: minutesAfter(4) })
      expect(await today(workspaceId)).toBe('0 + 0')
      expect(
        await place(workspaceId, taskId, { attempt: 3, now: minutesAfter(4), retry: true }),
      ).toMatchObject({ applied: true, reserved: 45 })
      expect(await today(workspaceId)).toBe('0 + 45')

      // The retry fails before any model call and is tried again: still one reserve on the day.
      await release(taskId, { now: minutesAfter(5) })
      expect(
        await place(workspaceId, taskId, { attempt: 4, now: minutesAfter(6), retry: true }),
      ).toMatchObject({ applied: true, reserved: 45 })
      expect(await today(workspaceId)).toBe('0 + 45')
      expect(await reserve(taskId)).toEqual([
        '#1 tariff 45 released',
        '#2 tariff 5 released',
        '#3 tariff 45 released',
        '#4 tariff 45 active',
      ])
    })

    it('counts the calendar day in Moscow, not in UTC and not the last 24 hours', async () => {
      const { workspaceId } = await funded({ plan: startDay })
      const [night, evening, late] = await tasks(workspaceId, 3)

      // 01:00 on 4 October in Moscow is still 3 October in UTC.
      await place(workspaceId, night!, { now: new Date('2026-10-03T22:00:00.000Z') })
      // 23:30 on 4 October in Moscow: five are left of the day.
      expect(
        await place(workspaceId, evening!, { now: new Date('2026-10-04T20:30:00.000Z') }),
      ).toMatchObject({ reserved: 5 })
      expect(await today(workspaceId, '2026-10-04T20:59:59.999Z')).toBe('0 + 50')
      expect(
        await refused(workspaceId, late!, { now: new Date('2026-10-04T20:59:59.999Z') }),
      ).toMatchObject(dailyLimit(250, 50, { limit: 50, used: 50 }))

      // Midnight in Moscow, the same date in UTC and half an hour after the last reserve: a new
      // day, while yesterday's reserves are still active.
      expect(await today(workspaceId, '2026-10-04T21:00:00.000Z')).toBe('0 + 0')
      expect(
        await place(workspaceId, late!, { now: new Date('2026-10-04T21:00:00.000Z') }),
      ).toMatchObject({ reserved: 45 })
      expect(await today(workspaceId, '2026-10-05T09:00:00.000Z')).toBe('0 + 45')
      expect(await today(workspaceId, '2026-10-04T12:00:00.000Z')).toBe('0 + 50')
    })

    it('checks the day a reserve is stamped into when the clock is behind the period', async () => {
      // ЮKassa captured the payment a second after midnight in Moscow by its clock; the clock
      // that queues the tasks still shows the evening before.
      const start = new Date('2026-10-04T21:00:01.000Z')
      const now = new Date('2026-10-04T20:59:59.000Z')
      const { workspaceId } = await funded({
        plan: startDay,
        subscription: {
          currentPeriodStart: start,
          currentPeriodEnd: new Date(start.getTime() + PERIOD_MS),
          periodAnchor: start,
        },
      })
      const [first, second, third] = await tasks(workspaceId, 3)

      // Both reserves are placed into 5 October…
      for (const [taskId, reserved] of [
        [first!, 45],
        [second!, 5],
      ] as const) {
        const placed = await place(workspaceId, taskId, { now })
        expect(placed).toMatchObject({ reserved })
        expect(placed.holds[0]).toMatchObject({ createdAt: start, placedAt: start })
      }
      // …so it is the day of 5 October that the next task meets.
      expect(await refused(workspaceId, third!, { now })).toMatchObject(
        dailyLimit(250, 50, { limit: 50, used: 50 }),
      )
      expect(await today(workspaceId, now)).toBe('0 + 0')
      expect(await today(workspaceId, start)).toBe('0 + 50')
    })

    it('keeps the day across a renewal in the middle of it', async () => {
      // The period ends at 15:00 in Moscow and renews.
      const start = new Date(NOW.getTime() - PERIOD_MS)
      const subscription = await subscribed({
        plan: startDay,
        subscription: { currentPeriodStart: start, currentPeriodEnd: NOW, periodAnchor: start },
      })
      const { workspaceId } = subscription
      const [before, after] = await tasks(workspaceId, 2)
      await place(workspaceId, before!, { now: minutesAfter(-60) })
      await renew({ ...subscription, planId: subscription.plan.id })

      // The new period gives 300 credits; the day it began in has five of its fifty left.
      expect(await place(workspaceId, after!, { now: minutesAfter(60) })).toMatchObject({
        reserved: 5,
      })
      expect(await today(workspaceId, minutesAfter(60))).toBe('0 + 50')
    })

    it('keeps the day of each workspace apart', async () => {
      const one = await funded({ plan: startDay })
      const other = await funded({ plan: startDay })
      await place(one.workspaceId, await task(one.workspaceId))
      await place(other.workspaceId, await task(other.workspaceId))
      expect(await place(other.workspaceId, await task(other.workspaceId))).toMatchObject({
        reserved: 5,
      })
      expect(await refused(other.workspaceId, await task(other.workspaceId))).toMatchObject(
        dailyLimit(250, 50, { limit: 50, used: 50 }),
      )
      expect(await place(one.workspaceId, await task(one.workspaceId))).toMatchObject({
        reserved: 5,
      })
      expect(await today(one.workspaceId)).toBe('0 + 50')
      expect(await today(randomUUID())).toBe('0 + 0')
    })

    // A charge moves the task towards the tariff only within what is left of the day of the
    // charge (spec §17, «Какие кредиты платят, решает момент списания»).
    it('takes free tariff credits for a charge no more than the day has left', async () => {
      const { workspaceId } = await funded({ tariff: 0, pack: 100, plan: startDay })
      const [onPack, onTariff] = await tasks(workspaceId, 2)
      await place(workspaceId, onPack!)
      expect(await reserve(onPack!)).toEqual(['#1 pack 45 active'])
      await grant(workspaceId, 'tariff', 300)
      await place(workspaceId, onTariff!, { now: minutesAfter(1) })
      expect(await reserve(onTariff!)).toEqual(['#1 tariff 45 active'])

      const settled = await settle(onPack!, 30)

      // Five are left of the day: the tariff pays five, the pack the rest.
      expect(settled.from).toEqual({ tariff: 5, gift: 0, pack: 25 })
      expect(await today(workspaceId)).toBe('5 + 45')
      expect(await accounts(workspaceId)).toMatchObject({
        tariff: account(295, 45),
        pack: account(75),
      })
    })

    it('pays a task from its own tariff rows whatever is left of the day', async () => {
      const { workspaceId } = await funded({ plan: startDay })
      const [first, second] = await tasks(workspaceId, 2)
      await place(workspaceId, first!)
      await place(workspaceId, second!, { now: minutesAfter(1) })
      expect(await today(workspaceId)).toBe('0 + 50')

      const settled = await settle(first!, 45)

      expect(settled.from).toEqual({ tariff: 45, gift: 0, pack: 0 })
      expect(await today(workspaceId)).toBe('45 + 5')
    })
  })

  // What the daily limit in credits is compared with (docs/plan/37-billing-plan.md, «Дневной
  // лимит в кредитах»): the reader itself, on plans without a limit — what it counts does not
  // depend on one.
  describe('the tariff credits of a day', () => {
    const day = today
    /** 23:50 on 4 October in Moscow, and ten minutes after its midnight. */
    const evening = new Date('2026-10-04T20:50:00.000Z')
    const night = new Date('2026-10-04T21:10:00.000Z')
    /** 10:00 on 5 October in Moscow. */
    const morning = new Date('2026-10-05T07:00:00.000Z')

    it('counts a reserve in full while it is active, what it paid once charged, nothing once returned', async () => {
      const { workspaceId } = await funded()
      const [done, failed] = await tasks(workspaceId, 2)
      expect(await day(workspaceId, NOW)).toBe('0 + 0')

      await place(workspaceId, done!)
      expect(await day(workspaceId, NOW)).toBe('0 + 45')
      await place(workspaceId, failed!, { now: minutesAfter(1) })
      expect(await day(workspaceId, NOW)).toBe('0 + 90')

      await release(failed!)
      expect(await day(workspaceId, NOW)).toBe('0 + 45')
      await settle(done!, 17)
      expect(await day(workspaceId, NOW)).toBe('17 + 0')
      expect(await holdOf(done!, 'tariff')).toMatchObject({ status: 'captured' })
      expect((await holdOf(done!, 'tariff')).charged?.toFixed(0)).toBe('17')
      expect((await holdOf(failed!, 'tariff')).charged).toBeNull()
    })

    // §1.6, example 8: the day a reserve counts on is the day it was placed.
    it('leaves a reserve placed late in the evening and charged after midnight on its own day', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId, { now: evening })
      expect(await day(workspaceId, evening)).toBe('0 + 45')
      expect(await day(workspaceId, night)).toBe('0 + 0')

      await settle(taskId, 17, { now: night })

      expect(await day(workspaceId, evening)).toBe('17 + 0')
      expect(await day(workspaceId, night)).toBe('0 + 0')
    })

    it('counts the calendar day in Moscow, not in UTC and not the last 24 hours', async () => {
      const { workspaceId } = await funded()
      const [late, early] = await tasks(workspaceId, 2)
      // The last millisecond of 4 October in Moscow, and its midnight.
      await place(workspaceId, late!, { now: new Date('2026-10-04T20:59:59.999Z') })
      await place(workspaceId, early!, { now: new Date('2026-10-04T21:00:00.000Z') })

      expect(await day(workspaceId, '2026-10-03T21:00:00.000Z')).toBe('0 + 45')
      expect(await day(workspaceId, '2026-10-04T20:59:59.999Z')).toBe('0 + 45')
      expect(await day(workspaceId, '2026-10-04T21:00:00.000Z')).toBe('0 + 45')
      expect(await day(workspaceId, '2026-10-05T20:59:59.999Z')).toBe('0 + 45')
      expect(await day(workspaceId, '2026-10-05T21:00:00.000Z')).toBe('0 + 0')
      expect(await day(workspaceId, '2026-10-03T20:59:59.999Z')).toBe('0 + 0')
    })

    it('counts what a charge took from free tariff credits on the day of the charge', async () => {
      // The day's tariff credits were gone when the task was queued: its reserve stands on the
      // pack. When it is charged the next morning, the tariff has credits again and pays first.
      const { workspaceId } = await funded({ tariff: 0, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      expect(await reserve(taskId)).toEqual(['#1 pack 45 active'])
      await grant(workspaceId, 'tariff', 300)

      const settled = await settle(taskId, 17, { now: morning })

      expect(settled.from).toEqual({ tariff: 17, gift: 0, pack: 0 })
      // The pack row paid nothing: what it held came back.
      expect((await holdOf(taskId, 'pack')).charged?.toFixed(0)).toBe('0')
      expect(await day(workspaceId, NOW)).toBe('0 + 0')
      expect(await day(workspaceId, morning)).toBe('17 + 0')
    })

    it('splits a charge between the day of its own tariff row and the day of the charge', async () => {
      // 5 tariff credits and 40 of the pack set aside on the 4th; the task costs 30 and is
      // charged on the 5th, when the tariff has credits again: its own row pays 5 on the 4th,
      // and 25 more come from free tariff credits on the 5th.
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      expect(await reserve(taskId)).toEqual(['#1 tariff 5 active', '#1 pack 40 active'])
      await grant(workspaceId, 'tariff', 300)

      const settled = await settle(taskId, 30, { now: morning })

      expect(settled.from).toEqual({ tariff: 30, gift: 0, pack: 0 })
      expect(settled.holds.map((hold) => [kindOf(hold.unit), hold.charged?.toFixed(0)])).toEqual([
        ['tariff', '5'],
        ['pack', '0'],
      ])
      expect(await day(workspaceId, NOW)).toBe('5 + 0')
      expect(await day(workspaceId, morning)).toBe('25 + 0')
    })

    // A task is charged pass by pass (owner's answer of 26.10.2026): what each charge took from
    // free tariff credits counts on the day of that charge, never again on the day of the next.
    it('counts each charge of a task on its own day, the transfer of the first not again', async () => {
      const { workspaceId } = await funded({ tariff: 0, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      await grant(workspaceId, 'tariff', 300)
      // The pack row is charged from free tariff credits: 17 on the day of the charge.
      await settle(taskId, 17, { now: morning })
      const evening = new Date(morning.getTime() + DAY_MS)
      await place(workspaceId, taskId, { attempt: 2, now: evening, follows: 'message' })
      await settle(taskId, 9, { now: evening })

      expect(await day(workspaceId, morning)).toBe('17 + 0')
      // The next day: its own row placed and charged that day, nothing of the morning before.
      expect(await day(workspaceId, evening)).toBe('9 + 0')
    })

    it('counts a charge settled the day it was placed once: the row and the transfer together', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      await grant(workspaceId, 'tariff', 300)
      await settle(taskId, 30)
      expect(await day(workspaceId, NOW)).toBe('30 + 0')
    })

    it('counts a tariff row of an ended period on the day it was placed, and its expiry nowhere', async () => {
      // 45 set aside the day before the period ends; the period renews; the task is charged 17
      // the day after: the row pays 17 and 28 expire.
      const subscription = await subscribed({ tariff: 45 })
      const { workspaceId, periodEnd } = subscription
      const taskId = await task(workspaceId)
      const placedAt = new Date(periodEnd.getTime() - DAY_MS)
      const chargedAt = new Date(periodEnd.getTime() + DAY_MS)
      await place(workspaceId, taskId, {
        now: placedAt,
        expiresAt: new Date(periodEnd.getTime() + 2 * DAY_MS),
      })
      await renew({ ...subscription, planId: subscription.plan.id })

      const settled = await settle(taskId, 17, { now: chargedAt })

      expect(settled).toMatchObject({ from: { tariff: 17, gift: 0, pack: 0 }, expired: 28 })
      expect((await holdOf(taskId, 'tariff')).charged?.toFixed(0)).toBe('17')
      expect(await day(workspaceId, placedAt)).toBe('17 + 0')
      expect(await day(workspaceId, chargedAt)).toBe('0 + 0')
      expect(await day(workspaceId, periodEnd)).toBe('0 + 0')
    })

    it('counts only the tariff: gift and pack credits are outside the day', async () => {
      const { workspaceId } = await funded({ tariff: 5, gift: 35, pack: 100 })
      const [first, second] = await tasks(workspaceId, 2)
      await place(workspaceId, first!)
      await place(workspaceId, second!, { now: minutesAfter(1) })
      expect(await reserve(first!)).toEqual([
        '#1 tariff 5 active',
        '#1 gift 35 active',
        '#1 pack 5 active',
      ])
      expect(await reserve(second!)).toEqual(['#1 pack 45 active'])
      expect(await day(workspaceId, NOW)).toBe('0 + 5')

      // The first costs 43: its tariff row pays 5, the gift 35, the pack 3.
      await settle(first!, 43)
      await settle(second!, 20)
      expect(await day(workspaceId, NOW)).toBe('5 + 0')
    })

    it('keeps the day of each workspace apart', async () => {
      const one = await funded()
      const other = await funded()
      await place(one.workspaceId, await task(one.workspaceId))
      const settled = await task(other.workspaceId)
      await place(other.workspaceId, settled)
      await settle(settled, 20)
      expect(await day(one.workspaceId, NOW)).toBe('0 + 45')
      expect(await day(other.workspaceId, NOW)).toBe('20 + 0')
      expect(await day(randomUUID(), NOW)).toBe('0 + 0')
    })
  })

  describe('at once', () => {
    it('never sets aside more than is free when twenty tasks are queued', async () => {
      const { workspaceId } = await funded({ tariff: 60, pack: 40 })
      const queued = await tasks(workspaceId, 20)

      const results = await Promise.allSettled(
        queued.map((taskId) => fixtures.reserve(placement(workspaceId, taskId))),
      )

      const placed = fulfilled(results)
      expect(placed.map((result) => result.reserved).sort((a, b) => b - a)).toEqual([45, 45, 10])
      expect(placed.every((result) => result.applied)).toBe(true)
      expect(rejected(results)).toEqual(
        Array(17).fill(expect.objectContaining(creditsHeld(0, 100))),
      )
      expect(await accounts(workspaceId)).toMatchObject({
        tariff: account(60, 60),
        pack: account(40, 40),
      })
      await expectBooksToBalance(workspaceId)
    })

    it('never passes the limit of the day when twenty tasks are queued', async () => {
      const { workspaceId } = await funded({ plan: startDay })
      const queued = await tasks(workspaceId, 20)

      const results = await Promise.allSettled(
        queued.map((taskId) => fixtures.reserve(placement(workspaceId, taskId))),
      )

      // The step of the first, whichever it was, and the five the day had left.
      expect(
        fulfilled(results)
          .map((result) => result.reserved)
          .sort((a, b) => b - a),
      ).toEqual([45, 5])
      expect(rejected(results)).toEqual(
        Array(18).fill(expect.objectContaining(dailyLimit(250, 50, { limit: 50, used: 50 }))),
      )
      expect(await today(workspaceId)).toBe('0 + 50')
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300, 50) })
      await expectBooksToBalance(workspaceId)
    })

    it('gives the gift of a workspace without a tariff to one of the tasks queued together', async () => {
      // No subscription row to lock first: the accounts are what the placements queue for.
      const { workspaceId } = await funded({ tariff: 0, gift: 35, subscription: null })
      const queued = await tasks(workspaceId, 10)

      const results = await Promise.allSettled(
        queued.map((taskId) => fixtures.reserve(placement(workspaceId, taskId))),
      )

      expect(fulfilled(results)).toMatchObject([{ applied: true, reserved: 35 }])
      expect(rejected(results)).toEqual(Array(9).fill(expect.objectContaining(creditsHeld(0, 35))))
      expect(await accounts(workspaceId)).toMatchObject({ gift: account(35, 35) })
      expect(await db.giftSiteClaim.count({ where: { workspaceId } })).toBe(1)
      await expectBooksToBalance(workspaceId)
    })

    it('gives the gift of a site to one of two workspaces that ask together', async () => {
      for (let round = 0; round < 6; round += 1) {
        const host = `race-${randomUUID()}.example.ru`
        const pair = await Promise.all(
          [`https://${host}`, `http://www.${host}`].map(async (url) => {
            const { workspaceId } = await funded({ tariff: 0, gift: 35, subscription: null })
            return { workspaceId, taskId: await taskOn(workspaceId, url) }
          }),
        )

        const results = await Promise.allSettled(
          pair.map(({ workspaceId, taskId }) => fixtures.reserve(placement(workspaceId, taskId))),
        )

        expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
        expect(rejected(results)).toEqual([
          expect.objectContaining(needsTariff('gift_site_used', 35)),
        ])
        const winner = pair[results[0]?.status === 'fulfilled' ? 0 : 1]!
        const loser = pair[results[0]?.status === 'fulfilled' ? 1 : 0]!
        // One claim, the winner's; the other workspace keeps its gift and holds nothing.
        expect(await db.giftSiteClaim.findMany({ where: { hostKey: host } })).toMatchObject([
          { hostKey: host, workspaceId: winner.workspaceId },
        ])
        expect(await reserve(winner.taskId)).toEqual(['#1 gift 35 active'])
        expect(await reserve(loser.taskId)).toEqual([])
        expect(await accounts(loser.workspaceId)).toMatchObject({ gift: account(35) })
        expect(await db.giftSiteClaim.count({ where: { workspaceId: loser.workspaceId } })).toBe(0)
        for (const { workspaceId } of pair) await expectBooksToBalance(workspaceId)
      }
    })

    it('refuses the gift of a site that another workspace claims while this one waits for it', async () => {
      const first = await funded({ tariff: 0, gift: 35, subscription: null })
      const second = await funded({ tariff: 0, gift: 35, subscription: null })
      const host = `claimed-${randomUUID()}.example.ru`
      const taskId = await taskOn(second.workspaceId, `https://${host}`)
      const order: string[] = []
      const placing: ReturnType<typeof fixtures.reserve>[] = []

      await db.$transaction(async (tx) => {
        // The first workspace has written its claim and not committed it yet.
        await tx.giftSiteClaim.create({ data: { hostKey: host, workspaceId: first.workspaceId } })
        // The second sees no claim, passes every check and waits at its own.
        const started = fixtures.reserve(placement(second.workspaceId, taskId))
        placing.push(started)
        void started.then(
          () => order.push('placed'),
          () => order.push('refused'),
        )
        await new Promise((resolve) => setTimeout(resolve, 300))
        order.push('claimed')
      }, patient)

      await expect(placing[0]).rejects.toMatchObject(needsTariff('gift_site_used', 35))
      expect(order).toEqual(['claimed', 'refused'])
      expect(await db.giftSiteClaim.findMany({ where: { hostKey: host } })).toMatchObject([
        { workspaceId: first.workspaceId },
      ])
      expect(await reserve(taskId)).toEqual([])
      expect(await accounts(second.workspaceId)).toMatchObject({ gift: account(35) })
      await expectBooksToBalance(second.workspaceId)
    })

    it('charges a task once when it is reported done twice at once', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)

      const results = await Promise.all([settle(taskId, 17), settle(taskId, 17)])

      expect(results.map((result) => result.applied).sort()).toEqual([false, true])
      expect(results[0]).toEqual({ ...results[1], applied: results[0]?.applied })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(0), pack: account(88) })
      expect(await db.creditLedger.count({ where: { taskId } })).toBe(2)
    })

    it('lets either the charge or the return of a task win, never both', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)

      const [charged, released] = await Promise.allSettled([settle(taskId, 17), release(taskId)])

      // The charge first: the return after it finds no active chain and gives nothing back. The
      // return first: the charge finds nothing to charge.
      if (charged.status === 'fulfilled') {
        expect(released).toMatchObject({ status: 'fulfilled', value: { applied: false } })
      } else {
        expect(released.status).toBe('fulfilled')
        expect(rejected([charged])).toEqual([expect.objectContaining(conflict)])
      }
      expect(await accounts(workspaceId)).toMatchObject({
        tariff: account(charged.status === 'fulfilled' ? 283 : 300),
      })
      expect(await reserve(taskId)).toEqual([
        `#1 tariff 45 ${charged.status === 'fulfilled' ? 'captured' : 'released'}`,
      ])
    })

    it('places a reserve either wholly before a renewal or wholly after it', async () => {
      const { workspaceId, plan, subscriptionId, periodEnd } = await subscribed({ tariff: 5 })
      const taskId = await task(workspaceId)
      const order: string[] = []
      const placing: ReturnType<typeof place>[] = []

      await renew(
        { workspaceId, subscriptionId, periodEnd, planId: plan.id },
        {
          // The renewal has expired the last credits of the old period and holds its locks.
          between: async () => {
            const started = fixtures.reserve(placement(workspaceId, taskId))
            placing.push(started)
            void started.then(
              () => order.push('placed'),
              () => order.push('refused'),
            )
            await new Promise((resolve) => setTimeout(resolve, 300))
            order.push('renewing')
          },
        },
      )
      const placed = await placing[0]!
      expect(order).toEqual(['renewing', 'placed'])
      // The reserve waited for the new period, took the step from its quota and is stamped with
      // it, though the clock that queued the task still showed the old period.
      expect(NOW.getTime()).toBeLessThan(periodEnd.getTime())
      expect(placed).toMatchObject({ applied: true, reserved: 45 })
      expect(placed.holds[0]).toMatchObject({
        unit: 'credit_tariff',
        createdAt: periodEnd,
        placedAt: periodEnd,
      })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300, 45) })

      // So its credits come back into the new period.
      const at = new Date(periodEnd.getTime() + DAY_MS)
      expect(await release(taskId, { now: at })).toMatchObject({ applied: true, expiries: [] })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it('gives a reserve back either wholly before a renewal or wholly after it', async () => {
      const { workspaceId, plan, subscriptionId, periodEnd } = await subscribed()
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      const order: string[] = []
      const releasing: ReturnType<typeof release>[] = []

      await renew(
        { workspaceId, subscriptionId, periodEnd, planId: plan.id },
        {
          // The renewal has expired the 255 available credits and kept the 45 held ones.
          between: async () => {
            const started = db.$transaction(
              (tx) => releaseTask(tx, { taskId, now: periodEnd }),
              patient,
            )
            releasing.push(started)
            void started.then(
              () => order.push('released'),
              () => order.push('refused'),
            )
            await new Promise((resolve) => setTimeout(resolve, 300))
            order.push('renewing')
          },
        },
      )
      const released = await releasing[0]!
      expect(order).toEqual(['renewing', 'released'])
      // The return waited and saw the new period: the credits of the old one did not slip into it.
      expect(released.expiries).toMatchObject([{ kind: 'expire' }])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
      expect(await ledger(workspaceId)).toEqual(
        rows(
          'tariff grant 300 → 300',
          'tariff expire -255 → 45',
          'tariff grant 300 → 345',
          'tariff expire -45 → 300',
        ),
      )
      await expectBooksToBalance(workspaceId)
    })
  })

  describe('the expiry of a reserve', () => {
    it('moves the expiry of every active row of a task together', async () => {
      const { workspaceId } = await funded({ tariff: 5, gift: 35, pack: 100 })
      const [waiting, other] = await tasks(workspaceId, 2)
      await place(workspaceId, waiting!)
      await grant(workspaceId, 'tariff', 45)
      await place(workspaceId, other!, { now: minutesAfter(1) })
      const until = new Date(NOW.getTime() + 3 * DAY_MS)

      const extended = await extend(waiting!, until)

      expect(extended.map((hold) => [kindOf(hold.unit), hold.expiresAt])).toEqual([
        ['tariff', until],
        ['gift', until],
        ['pack', until],
      ])
      expect(await db.creditHold.findMany({ where: { taskId: waiting! } })).toEqual(
        expect.arrayContaining(extended),
      )
      // The reserve of another task keeps its own.
      expect((await holdOf(other!, 'tariff')).expiresAt).toEqual(
        new Date(minutesAfter(1).getTime() + DAY_MS),
      )
      // Nothing but the expiry moved.
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(50, 50),
        gift: account(35, 35),
        pack: account(100, 5),
      })
    })

    it('has nothing to move for a task whose reserve is charged or given back, and finds no unknown task', async () => {
      const { workspaceId } = await funded()
      const [done, failed, never] = await tasks(workspaceId, 3)
      await place(workspaceId, done!)
      await settle(done!, 17)
      await place(workspaceId, failed!)
      await release(failed!)
      const until = new Date(NOW.getTime() + 3 * DAY_MS)
      const before = await written(workspaceId)

      for (const taskId of [done!, failed!, never!]) expect(await extend(taskId, until)).toEqual([])

      expect(await written(workspaceId)).toEqual(before)
      await expect(extend(randomUUID(), until)).rejects.toMatchObject(notFound)
    })

    it('gives the reserve of a stuck task back once it is past its expiry', async () => {
      const { workspaceId } = await funded({ tariff: 5, gift: 35, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      const expiresAt = new Date(NOW.getTime() + DAY_MS)

      // Until the expiry the reserve answers for a task that may still be done.
      await expect(
        expire(taskId, { now: new Date(expiresAt.getTime() - 1) }),
      ).rejects.toMatchObject(conflict)
      expect(await reserve(taskId)).toHaveLength(3)

      const expired = await expire(taskId, { now: expiresAt })

      expect(expired).toMatchObject({ applied: true, expiries: [] })
      expect(expired.holds.map((hold) => [hold.status, hold.settledAt])).toEqual(
        Array(3).fill(['expired', expiresAt]),
      )
      expect(await reserve(taskId)).toEqual([
        '#1 tariff 5 expired',
        '#1 gift 35 expired',
        '#1 pack 5 expired',
      ])
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(5),
        gift: account(35),
        pack: account(100),
      })
      // A repeat, and a release after it, change nothing.
      expect(await expire(taskId, { now: expiresAt })).toEqual({ ...expired, applied: false })
      expect(await release(taskId)).toEqual({ ...expired, applied: false })
    })

    it('expires the rows of a chain only together: the first attempt lives as long as the second', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      const firstExpiry = new Date(NOW.getTime() + DAY_MS)
      const later = minutesAfter(180)
      await place(workspaceId, taskId, { attempt: 2, now: later })
      const secondExpiry = new Date(later.getTime() + DAY_MS)

      // The first attempt would have expired here on its own.
      await expect(expire(taskId, { now: firstExpiry })).rejects.toMatchObject(conflict)
      expect(await reserve(taskId)).toEqual(['#1 tariff 45 active', '#2 tariff 45 active'])

      expect(await expire(taskId, { now: secondExpiry })).toMatchObject({ applied: true })
      expect(await reserve(taskId)).toEqual(['#1 tariff 45 expired', '#2 tariff 45 expired'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it('expires no row of a task while one of its rows has not reached its expiry', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      const expiresAt = new Date(NOW.getTime() + DAY_MS)
      // Rows written with different expiries, as nothing here writes them.
      const pack = await holdOf(taskId, 'pack')
      const longer = new Date(expiresAt.getTime() + DAY_MS)
      await db.creditHold.update({ where: { id: pack.id }, data: { expiresAt: longer } })
      const before = await written(workspaceId)

      await expect(expire(taskId, { now: expiresAt })).rejects.toMatchObject(conflict)
      expect(await written(workspaceId)).toEqual(before)

      expect(await expire(taskId, { now: longer })).toMatchObject({ applied: true })
      expect(await reserve(taskId)).toEqual(['#1 tariff 5 expired', '#1 pack 40 expired'])
    })

    it('expires the tariff credits of a reserve that lapsed after its period was renewed', async () => {
      const t = await subscribed({ tariff: 40, pack: 100 })
      const taskId = await task(t.workspaceId)
      // The task waits for an answer across the renewal.
      await place(t.workspaceId, taskId, { expiresAt: new Date(t.periodEnd.getTime() + DAY_MS) })
      await renew({ ...t, planId: t.plan.id })
      expect(await accounts(t.workspaceId)).toMatchObject({ tariff: account(340, 40) })

      const expired = await expire(taskId, { now: new Date(t.periodEnd.getTime() + DAY_MS) })

      expect(expired.expiries).toMatchObject([{ kind: 'expire', taskId }])
      expect(expired.expiries[0]?.amount.toFixed(0)).toBe('-40')
      // The new period is exactly its quota; the pack credits are back.
      expect(await accounts(t.workspaceId)).toMatchObject({
        tariff: account(300),
        pack: account(100),
      })
    })
  })

  describe('a release', () => {
    it('returns the credits of a task that failed to the accounts they stood on', async () => {
      const { workspaceId } = await funded({ tariff: 5, gift: 35, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)

      const released = await release(taskId)

      expect(released).toMatchObject({ applied: true, expiries: [] })
      expect(released.holds.map((hold) => [hold.status, hold.settledAt])).toEqual(
        Array(3).fill(['released', LATER]),
      )
      expect(await db.creditHold.findMany({ where: { taskId } })).toEqual(
        expect.arrayContaining(released.holds),
      )
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(5),
        gift: account(35),
        pack: account(100),
      })
      // Returned credits move no balance and write no ledger row.
      expect(await ledger(workspaceId)).toEqual(
        rows('tariff grant 5 → 5', 'gift grant 35 → 35', 'pack grant 100 → 100'),
      )
    })

    it('gives the reserve of a task back once, however often and in whatever way it is asked', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)

      const [first, second] = await Promise.all([release(taskId), release(taskId)])

      expect([first.applied, second.applied].sort()).toEqual([false, true])
      expect(await release(taskId)).toMatchObject({ applied: false, expiries: [] })
      expect(await expire(taskId)).toMatchObject({ applied: false })
      expect(await reserve(taskId)).toEqual(['#1 tariff 45 released'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it('releases every attempt of a chain together', async () => {
      const { workspaceId } = await funded({ tariff: 50, gift: 35, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(60) })

      expect((await release(taskId)).holds).toHaveLength(4)

      expect(await reserve(taskId)).toEqual([
        '#1 tariff 45 released',
        '#2 tariff 5 released',
        '#2 gift 35 released',
        '#2 pack 5 released',
      ])
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(50),
        gift: account(35),
        pack: account(100),
      })
    })

    it('expires tariff credits that come back after their period was renewed, and returns the others', async () => {
      const t = await subscribed({ tariff: 5, gift: 35, pack: 100 })
      const taskId = await task(t.workspaceId)
      await place(t.workspaceId, taskId)
      await renew({ ...t, planId: t.plan.id })
      const tariffRow = await holdOf(taskId, 'tariff')
      const at = new Date(t.periodEnd.getTime() + DAY_MS)

      const released = await release(taskId, { now: at })

      expect(released.expiries).toHaveLength(1)
      expect(released.expiries[0]).toMatchObject({
        kind: 'expire',
        taskId,
        idempotencyKey: ledgerKeys.holdExpiry(tariffRow.id),
        createdAt: at,
      })
      expect(await accounts(t.workspaceId)).toEqual({
        tariff: account(300),
        gift: account(35),
        pack: account(100),
      })
      expect(await ledger(t.workspaceId)).toEqual(
        rows(
          'tariff grant 5 → 5',
          'gift grant 35 → 35',
          'pack grant 100 → 100',
          'tariff grant 300 → 305',
          'tariff expire -5 → 300',
        ),
      )
      // A repeat returns the same expiry and writes nothing.
      expect(await release(taskId, { now: at })).toEqual({ ...released, applied: false })
    })

    it('returns tariff credits reserved after their period ended while the renewal is not settled', async () => {
      const t = await subscribed()
      const taskId = await task(t.workspaceId)
      await place(t.workspaceId, taskId, { now: minutesAfter(2, t.periodEnd) })

      // Still the period the credits are of: they come back.
      expect(await release(taskId, { now: minutesAfter(5, t.periodEnd) })).toMatchObject({
        applied: true,
        expiries: [],
      })
      expect(await accounts(t.workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it('expires tariff credits reserved after their period ended once the renewal is settled', async () => {
      const t = await subscribed()
      const taskId = await task(t.workspaceId)
      await place(t.workspaceId, taskId, { now: minutesAfter(2, t.periodEnd) })
      await renew({ ...t, planId: t.plan.id })

      const released = await release(taskId, { now: minutesAfter(10, t.periodEnd) })

      // The stamp of the row is of the period that ended: its credits are not carried over.
      expect(released.expiries).toHaveLength(1)
      expect(await accounts(t.workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it.each(['past_due', 'cancelled', 'expired'] as const)(
      'expires the tariff credits of a reserve given back to a tariff that is %s',
      async (state) => {
        const t = await subscribed({ tariff: 40, gift: 3, pack: 100 })
        const taskId = await task(t.workspaceId)
        await place(t.workspaceId, taskId)
        expect(await reserve(taskId)).toEqual([
          '#1 tariff 40 active',
          '#1 gift 3 active',
          '#1 pack 2 active',
        ])
        await stopTariff(t, state)

        const released = await release(taskId, { now: minutesAfter(10, t.periodEnd) })

        expect(released.expiries).toHaveLength(1)
        expect(released.expiries[0]?.amount.toFixed(0)).toBe('-40')
        expect(await accounts(t.workspaceId)).toEqual({
          tariff: account(0),
          gift: account(3),
          pack: account(100),
        })
      },
    )

    it('gives nothing back for a task that never had a reserve, and finds no unknown task', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId, { billable: false })
      const before = await written(workspaceId)

      for (const end of [release, expire]) {
        expect(await end(taskId)).toEqual({ holds: [], expiries: [], applied: false })
        await expect(end(randomUUID())).rejects.toMatchObject(notFound)
      }
      expect(await written(workspaceId)).toEqual(before)
    })

    it('gives nothing back of a charged chain, nor charges one that was given back', async () => {
      const { workspaceId } = await funded()
      const [done, failed, lapsed] = await tasks(workspaceId, 3)
      await place(workspaceId, done!)
      await settle(done!, 17)
      await place(workspaceId, failed!)
      await release(failed!)
      await place(workspaceId, lapsed!)
      await expire(lapsed!)
      const before = await written(workspaceId)

      // A task is charged pass by pass: what was charged stays, and there is nothing to return.
      expect(await release(done!)).toMatchObject({ holds: [], applied: false })
      expect(await expire(done!)).toMatchObject({ holds: [], applied: false })
      await expect(settle(failed!, 17)).rejects.toMatchObject(conflict)
      await expect(settle(lapsed!, 17)).rejects.toMatchObject(conflict)

      expect(await written(workspaceId)).toEqual(before)
    })
  })

  describe('the charge of a done task', () => {
    it('walks one task through two accounts: 5 of the tariff and 12 of the pack', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      const tariffAccount = await accountId(workspaceId, 'tariff')
      const packAccount = await accountId(workspaceId, 'pack')
      const gift = { where: { id: await accountId(workspaceId, 'gift') } }
      const giftBefore = await db.billingAccount.findUniqueOrThrow(gift)

      const charged = await settle(taskId, 17)

      expect(charged).toMatchObject({
        credits: 17,
        from: { tariff: 5, gift: 0, pack: 12 },
        expired: 0,
        applied: true,
      })
      // One charge per task and account, linked to the task and stamped with its moment.
      expect(
        charged.entries.map((entry) => [entry.idempotencyKey, entry.amount.toFixed(0)]).sort(),
      ).toEqual(
        [
          [ledgerKeys.taskCharge(taskId, 1, tariffAccount), '-5'],
          [ledgerKeys.taskCharge(taskId, 1, packAccount), '-12'],
        ].sort(),
      )
      for (const entry of charged.entries) {
        expect(entry).toMatchObject({ kind: 'charge', taskId, orderId: null, createdAt: LATER })
      }
      expect(charged.holds.map((hold) => [hold.status, hold.settledAt])).toEqual(
        Array(2).fill(['captured', LATER]),
      )
      expect(await db.creditHold.findMany({ where: { taskId } })).toEqual(
        expect.arrayContaining(charged.holds),
      )
      // What the pack row held above its 12 stopped being held.
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(0),
        gift: account(0),
        pack: account(88),
      })
      // The account the task had nothing on is not written at all.
      expect(await db.billingAccount.findUniqueOrThrow(gift)).toEqual(giftBefore)
      expect(await ledger(workspaceId)).toEqual(
        rows(
          'tariff grant 5 → 5',
          'pack grant 100 → 100',
          'tariff charge -5 → 0',
          'pack charge -12 → 88',
        ),
      )
    })

    it('keeps the order of the owner between two tasks: the tariff pays for the one reserved on the pack', async () => {
      const { workspaceId } = await funded({ tariff: 40, pack: 100 })
      const [a, b] = await tasks(workspaceId, 2)
      await place(workspaceId, a!)
      await place(workspaceId, b!, { now: minutesAfter(1) })
      expect(await reserve(a!)).toEqual(['#1 tariff 40 active', '#1 pack 5 active'])
      expect(await reserve(b!)).toEqual(['#1 pack 45 active'])

      // A is done for 5: the tariff pays from A's own row, the rest of both rows returns.
      expect(await settle(a!, 5)).toMatchObject({ from: { tariff: 5, gift: 0, pack: 0 } })
      expect(await accounts(workspaceId)).toMatchObject({
        tariff: account(35),
        pack: account(100, 45),
      })

      // B is done for 17: the tariff has 35 free and pays it all, though B's reserve stood on
      // the pack.
      const charged = await settle(b!, 17, { now: minutesAfter(30) })

      expect(charged).toMatchObject({ credits: 17, from: { tariff: 17, gift: 0, pack: 0 } })
      expect(charged.entries.map((entry) => entry.idempotencyKey)).toEqual([
        ledgerKeys.taskCharge(b!, 1, await accountId(workspaceId, 'tariff')),
      ])
      expect(await reserve(b!)).toEqual(['#1 pack 45 captured'])
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(18),
        gift: account(0),
        pack: account(100),
      })
    })

    it('takes from the pack what another task still holds on the tariff: the other order', async () => {
      const { workspaceId } = await funded({ tariff: 40, pack: 100 })
      const [a, b] = await tasks(workspaceId, 2)
      await place(workspaceId, a!)
      await place(workspaceId, b!, { now: minutesAfter(1) })

      // B is done first: A holds all 40 tariff credits, and they cannot be given away.
      expect(await settle(b!, 17)).toMatchObject({ from: { tariff: 0, gift: 0, pack: 17 } })
      expect(await accounts(workspaceId)).toMatchObject({
        tariff: account(40, 40),
        pack: account(83, 5),
      })

      // Then A returns 35 tariff credits it did not need.
      expect(await settle(a!, 5, { now: minutesAfter(30) })).toMatchObject({
        from: { tariff: 5, gift: 0, pack: 0 },
      })
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(35),
        gift: account(0),
        pack: account(83),
      })
    })

    it.each([
      [43, { tariff: 5, gift: 35, pack: 3 }, { tariff: 0, gift: 0, pack: 97 }],
      [20, { tariff: 5, gift: 15, pack: 0 }, { tariff: 0, gift: 20, pack: 100 }],
      [5, { tariff: 5, gift: 0, pack: 0 }, { tariff: 0, gift: 35, pack: 100 }],
      // The whole reserve: a charge capped by it.
      [45, { tariff: 5, gift: 35, pack: 5 }, { tariff: 0, gift: 0, pack: 95 }],
    ])('spends three accounts in order: a charge of %i', async (credits, from, left) => {
      const { workspaceId } = await funded({ tariff: 5, gift: 35, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)

      const charged = await settle(taskId, credits)

      expect(charged).toMatchObject({ credits, from, expired: 0, applied: true })
      // An account that pays nothing gets no row.
      expect(charged.entries).toHaveLength(Object.values(from).filter((paid) => paid > 0).length)
      expect(await reserve(taskId)).toEqual([
        '#1 tariff 5 captured',
        '#1 gift 35 captured',
        '#1 pack 5 captured',
      ])
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(left.tariff),
        gift: account(left.gift),
        pack: account(left.pack),
      })
    })

    it('moves the charge to credits that came free since the reserve, towards the front of the order', async () => {
      const { workspaceId } = await funded({ tariff: 5, gift: 35, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      // Tariff credits appear before the task ends.
      await grant(workspaceId, 'tariff', 50)

      expect(await settle(taskId, 43)).toMatchObject({ from: { tariff: 43, gift: 0, pack: 0 } })

      expect(await accounts(workspaceId)).toEqual({
        tariff: account(12),
        gift: account(35),
        pack: account(100),
      })
    })

    it('charges the reserve of an ended period first and expires the rest of it', async () => {
      // 45 tariff credits reserved on the 17th; the period renews on the 18th with 300 new
      // credits; the task is done on the 19th for 17.
      const t = await subscribed({ tariff: 45 })
      const taskId = await task(t.workspaceId)
      await place(t.workspaceId, taskId, {
        expiresAt: new Date(t.periodEnd.getTime() + 2 * DAY_MS),
      })
      await renew({ ...t, planId: t.plan.id })
      expect(await accounts(t.workspaceId)).toMatchObject({ tariff: account(345, 45) })
      const row = await holdOf(taskId, 'tariff')
      const at = new Date(t.periodEnd.getTime() + DAY_MS)

      const charged = await settle(taskId, 17, { now: at })

      expect(charged).toMatchObject({
        credits: 17,
        from: { tariff: 17, gift: 0, pack: 0 },
        expired: 28,
        applied: true,
      })
      // The old row pays under its own key, and what it did not pay expires under the other.
      expect(charged.entries.map((entry) => entry.idempotencyKey)).toEqual([
        ledgerKeys.holdCharge(row.id),
      ])
      expect(await entryOf(ledgerKeys.holdExpiry(row.id))).toMatchObject({
        kind: 'expire',
        taskId,
        createdAt: at,
      })
      // The new period is exactly its quota.
      expect(await accounts(t.workspaceId)).toMatchObject({ tariff: account(300) })
      expect(await ledger(t.workspaceId)).toEqual(
        rows(
          'tariff grant 45 → 45',
          'tariff grant 300 → 345',
          'tariff charge -17 → 328',
          'tariff expire -28 → 300',
        ),
      )
    })

    it('pays from the row of an ended period to its last credit, then from the credits of the new one', async () => {
      const t = await subscribed({ tariff: 10, pack: 100 })
      const taskId = await task(t.workspaceId)
      await place(t.workspaceId, taskId, {
        expiresAt: new Date(t.periodEnd.getTime() + 2 * DAY_MS),
      })
      expect(await reserve(taskId)).toEqual(['#1 tariff 10 active', '#1 pack 35 active'])
      await renew({ ...t, planId: t.plan.id })
      const row = await holdOf(taskId, 'tariff')
      const tariffAccount = await accountId(t.workspaceId, 'tariff')

      const charged = await settle(taskId, 30, { now: new Date(t.periodEnd.getTime() + DAY_MS) })

      // Ten of the old row, twenty of the new quota, nothing of the pack.
      expect(charged).toMatchObject({ from: { tariff: 30, gift: 0, pack: 0 }, expired: 0 })
      expect(
        charged.entries.map((entry) => [entry.idempotencyKey, entry.amount.toFixed(0)]).sort(),
      ).toEqual(
        [
          [ledgerKeys.holdCharge(row.id), '-10'],
          [ledgerKeys.taskCharge(taskId, 1, tariffAccount), '-20'],
        ].sort(),
      )
      expect(await accounts(t.workspaceId)).toMatchObject({
        tariff: account(280),
        pack: account(100),
      })
    })

    it.each(['past_due', 'cancelled', 'expired'] as const)(
      'treats every tariff row as one of an ended period once the tariff is %s',
      async (state) => {
        const t = await subscribed({ tariff: 40, gift: 0, pack: 100 })
        const [small, large] = await tasks(t.workspaceId, 2)
        await place(t.workspaceId, small!)
        await grant(t.workspaceId, 'tariff', 40)
        await place(t.workspaceId, large!, { now: minutesAfter(1) })
        for (const taskId of [small!, large!]) {
          expect(await reserve(taskId)).toEqual(['#1 tariff 40 active', '#1 pack 5 active'])
        }
        await stopTariff(t, state)
        const at = minutesAfter(10, t.periodEnd)

        // The tariff row pays what the task used and expires the rest; the pack row returns.
        expect(await settle(small!, 17, { now: at })).toMatchObject({
          from: { tariff: 17, gift: 0, pack: 0 },
          expired: 23,
        })
        // A task that used more than its tariff row goes on to its own pack row: the free
        // credits of the pack wait for a tariff and pay nothing.
        const charged = await settle(large!, 43, { now: at })
        expect(charged).toMatchObject({ from: { tariff: 40, gift: 0, pack: 3 }, expired: 0 })

        expect(await accounts(t.workspaceId)).toEqual({
          tariff: account(0),
          gift: account(0),
          pack: account(97),
        })
      },
    )

    it('charges the attempts of a chain as one task from one pool', async () => {
      const { workspaceId } = await funded({ tariff: 60, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(60) })
      expect(await reserve(taskId)).toEqual([
        '#1 tariff 45 active',
        '#2 tariff 15 active',
        '#2 pack 30 active',
      ])

      // More than the first reserve alone: what it did not hold comes from the second.
      const charged = await settle(taskId, 50, { now: minutesAfter(90) })

      expect(charged).toMatchObject({ credits: 50, from: { tariff: 50, gift: 0, pack: 0 } })
      // One charge of the task on the account, whatever attempts reserved there.
      expect(charged.entries).toHaveLength(1)
      expect(charged.holds.map((hold) => [hold.attempt, hold.status])).toEqual([
        [1, 'captured'],
        [2, 'captured'],
        [2, 'captured'],
      ])
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(10),
        gift: account(0),
        pack: account(100),
      })
    })

    it('charges only the retry of a task whose first attempt failed', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      await release(taskId)
      await db.task.update({ where: { id: taskId }, data: { modelClass: 'heavy', attempt: 2 } })
      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(30), retry: true })

      const charged = await settle(taskId, 60, { now: minutesAfter(60) })

      expect(charged.holds.map((hold) => hold.attempt)).toEqual([2])
      expect(await reserve(taskId)).toEqual(['#1 tariff 45 released', '#2 tariff 120 captured'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(240) })
      // Asked again, the charge answers with the rows it settled, not with the failed attempt.
      expect(await settle(taskId, 60, { now: minutesAfter(70) })).toEqual({
        ...charged,
        applied: false,
      })
    })

    it('stamps the charge of the tariff inside the period whose credits it takes', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      // Done after the period ended, before its renewal is settled: the tariff is still active
      // and its credits are of the period that ended.
      const late = minutesAfter(3, PERIOD_END)

      await settle(taskId, 17, { now: late })

      const tariff = await entryOf(
        ledgerKeys.taskCharge(taskId, 1, await accountId(workspaceId, 'tariff')),
      )
      const pack = await entryOf(
        ledgerKeys.taskCharge(taskId, 1, await accountId(workspaceId, 'pack')),
      )
      expect(tariff.createdAt).toEqual(new Date(PERIOD_END.getTime() - 1))
      // Pack credits belong to no period: the row keeps the moment.
      expect(pack.createdAt).toEqual(late)
    })

    it('returns what the first call did when it is asked again, and changes nothing', async () => {
      const t = await subscribed({ tariff: 10, gift: 20, pack: 100 })
      const taskId = await task(t.workspaceId)
      await place(t.workspaceId, taskId, {
        expiresAt: new Date(t.periodEnd.getTime() + 2 * DAY_MS),
      })
      expect(await reserve(taskId)).toEqual([
        '#1 tariff 10 active',
        '#1 gift 20 active',
        '#1 pack 15 active',
      ])
      await renew({ ...t, planId: t.plan.id }, { credits: 3 })
      const at = new Date(t.periodEnd.getTime() + DAY_MS)
      // The row of the ended period pays its 10, the new quota its 3, the gift 20, the pack 11.
      const first = await settle(taskId, 44, { now: at })
      expect(first).toMatchObject({
        credits: 44,
        from: { tariff: 13, gift: 20, pack: 11 },
        expired: 0,
        applied: true,
      })
      expect(first.entries).toHaveLength(4)
      const before = await written(t.workspaceId)

      const again = await settle(taskId, 44, { now: new Date(at.getTime() + DAY_MS) })

      expect(again).toEqual({ ...first, applied: false })
      expect(await written(t.workspaceId)).toEqual(before)
      // Asked for another amount, it is not the same charge.
      await expect(settle(taskId, 43)).rejects.toMatchObject(conflict)
      expect(await written(t.workspaceId)).toEqual(before)
    })

    it('reports again what expired with the charge of an ended period', async () => {
      const t = await subscribed({ tariff: 45 })
      const taskId = await task(t.workspaceId)
      await place(t.workspaceId, taskId, {
        expiresAt: new Date(t.periodEnd.getTime() + 2 * DAY_MS),
      })
      await renew({ ...t, planId: t.plan.id })
      const at = new Date(t.periodEnd.getTime() + DAY_MS)
      const first = await settle(taskId, 17, { now: at })

      expect(await settle(taskId, 17, { now: at })).toEqual({ ...first, applied: false })
      expect(first.expired).toBe(28)
    })

    it('refuses a task with no active reserve and no charge: never a silent zero', async () => {
      const { workspaceId } = await funded()
      const never = await task(workspaceId)
      const before = await written(workspaceId)

      await expect(settle(never, 5)).rejects.toMatchObject({
        ...conflict,
        message: 'The task has no active reserve to charge',
      })
      await expect(settle(randomUUID(), 5)).rejects.toMatchObject(notFound)

      expect(await written(workspaceId)).toEqual(before)
    })

    // A task is charged pass by pass (owner's answer of 26.10.2026): a chain placed after a
    // charge is charged on its own, under keys of its own, and the first stays as it was.
    it('charges the next chain of a charged task on its own, under keys of its own', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      const first = await settle(taskId, 17)
      await place(workspaceId, taskId, { attempt: 2, follows: 'message' })
      const tariff = await accountId(workspaceId, 'tariff')

      const second = await settle(taskId, 9)

      expect(first.entries.map((entry) => entry.idempotencyKey)).toEqual([
        ledgerKeys.taskCharge(taskId, 1, tariff),
      ])
      expect(second).toMatchObject({ credits: 9, from: { tariff: 9, gift: 0, pack: 0 } })
      expect(second.entries.map((entry) => entry.idempotencyKey)).toEqual([
        ledgerKeys.taskCharge(taskId, 2, tariff),
      ])
      expect(await reserve(taskId)).toEqual(['#1 tariff 45 captured', '#2 tariff 45 captured'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300 - 17 - 9) })
      // A call that finds nothing active answers what every charge so far did.
      expect(await settle(taskId, 26)).toMatchObject({ credits: 26, applied: false })
      await expect(settle(taskId, 17)).rejects.toMatchObject(conflict)
    })

    it('refuses a charge above the reserve of the task and takes one equal to it', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      const before = await written(workspaceId)

      // Free credits of the pack do not raise what a task may be charged.
      await expect(settle(taskId, 46)).rejects.toMatchObject(badRequest)
      expect(await written(workspaceId)).toEqual(before)

      expect(await settle(taskId, 45)).toMatchObject({ from: { tariff: 5, gift: 0, pack: 40 } })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(0), pack: account(60) })
    })

    it('keeps credits held through the end of the period and charges them without touching the new quota', async () => {
      const t = await subscribed()
      const taskId = await task(t.workspaceId)
      await place(t.workspaceId, taskId, {
        expiresAt: new Date(t.periodEnd.getTime() + 2 * DAY_MS),
      })

      // Only the available 255 expire: the 45 under the reserve stay, or held would exceed the
      // balance.
      const expired = await renew({ ...t, planId: t.plan.id })
      expect(expired?.entry.amount.toFixed(0)).toBe('-255')
      expect(await accounts(t.workspaceId)).toMatchObject({ tariff: account(345, 45) })
      await expectBooksToBalance(t.workspaceId)

      await settle(taskId, 45, { now: new Date(t.periodEnd.getTime() + DAY_MS) })
      expect(await accounts(t.workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it('keeps the books balanced through a month of tasks and its renewal', async () => {
      const t = await subscribed({ tariff: 100, gift: 35, pack: 100 })
      const [a, b, c, d, e] = await tasks(t.workspaceId, 5)
      const long = { expiresAt: new Date(t.periodEnd.getTime() + 2 * DAY_MS) }
      // 45 + 45 + 10 of the tariff, then the gift, then the pack.
      for (const [index, taskId] of [a, b, c, d, e].entries()) {
        await place(t.workspaceId, taskId!, { ...long, now: minutesAfter(index) })
      }
      expect(await accounts(t.workspaceId)).toEqual({
        tariff: account(100, 100),
        gift: account(35, 35),
        pack: account(100, 90),
      })
      expect(await reserve(c!)).toEqual(['#1 tariff 10 active', '#1 gift 35 active'])

      await settle(a!, 17)
      await release(b!)
      await settle(d!, 29)
      // `a` paid 17 of its tariff row; `b` returned 45; `d`, reserved on the pack, was paid by
      // the tariff credits that came free.
      expect(await accounts(t.workspaceId)).toEqual({
        tariff: account(54, 10),
        gift: account(35, 35),
        pack: account(100, 45),
      })

      // What is free on the tariff expires with the period; `c` and `e` are still running.
      await renew({ ...t, planId: t.plan.id })
      expect(await accounts(t.workspaceId)).toMatchObject({ tariff: account(310, 10) })

      const at = new Date(t.periodEnd.getTime() + DAY_MS)
      // `c` is done for 20: its old tariff row pays 10, the new quota the other 10.
      expect(await settle(c!, 20, { now: at })).toMatchObject({
        from: { tariff: 20, gift: 0, pack: 0 },
        expired: 0,
      })
      await release(e!, { now: at })
      expect(await accounts(t.workspaceId)).toEqual({
        tariff: account(290),
        gift: account(35),
        pack: account(100),
      })
      expect(await ledger(t.workspaceId)).toEqual(
        rows(
          'tariff grant 100 → 100',
          'gift grant 35 → 35',
          'pack grant 100 → 100',
          'tariff charge -17 → 83',
          'tariff charge -29 → 54',
          'tariff expire -44 → 10',
          'tariff grant 300 → 310',
          'tariff charge -10 → 300',
          'tariff charge -10 → 290',
        ),
      )
    })
  })
})
