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
/** The end of the period of the fixtures' subscription. */
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

  /** A reserve by the step of before 10.11.2026 (`placeReserveByStep` of the fixtures). */
  const placedBefore = (workspaceId: string, taskId: string, options: PlacementOptions = {}) =>
    booked(workspaceId, () => fixtures.reserveByStep(placement(workspaceId, taskId, options)))
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

  /** What the workspace owes: `billing_accounts.debt` of its pack account. */
  const debtOf = async (workspaceId: string) =>
    (
      await db.billingAccount.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: creditAccountUnits.pack } },
      })
    ).debt.toNumber()

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
  /**
   * «Старт» of the decision of 17.10.2026: 300 tariff credits a month, of them 50 a day. A plan
   * of its own: no published plan has a day since 06.11.2026 (plan 63, Ц6), and the limit stays
   * in the code for a plan that sets one.
   */
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
  const notEnough = (reason: string, spendable: number, held = 0, needed = 1) =>
    refusal('BILLING_NOT_ENOUGH_CREDITS', 402, { reason, spendable, held, needed })
  const creditsHeld = (spendable: number, held: number, needed = 1) =>
    refusal('BILLING_CREDITS_HELD', 409, { reason: 'held', spendable, held, needed })
  const needsTariff = (reason: string, spendable: number, held = 0, needed = 1) =>
    refusal('BILLING_TASK_NEEDS_SUBSCRIPTION', 402, { reason, spendable, held, needed })
  /**
   * A refusal by the day: what the accounts hold and what is set aside, what the task could take
   * now and the day — its limit and what it took.
   */
  const dailyLimit = (
    spendable: number,
    held: number,
    day: { limit: number; used: number },
    { spendableNow = 0, needed = 1 }: { spendableNow?: number; needed?: number } = {},
  ) =>
    refusal('BILLING_DAILY_LIMIT_REACHED', 409, {
      reason: 'daily_limit',
      spendable,
      held,
      needed,
      spendableNow,
      day,
    })
  const rateMissing = (spendable: number, held = 0, needed = 1) =>
    refusal('BILLING_CREDIT_RATE_MISSING', 503, { reason: 'rate_missing', spendable, held, needed })

  // Owner's decision of 10.11.2026 (docs/spec.md §20, «Только кредиты», КР5–КР8): an attempt sets
  // one credit aside — the mark that it is in work —, whatever the class of its model; what a pass
  // spends is not bounded by it.
  describe('a reserve', () => {
    it('sets one credit of a new task aside on the tariff, and moves no balance', async () => {
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)

      const placed = await place(workspaceId, taskId)

      expect(placed).toMatchObject({ applied: true, reserved: 1 })
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
      expect(placed.holds[0]?.amount.toFixed(2)).toBe('1.00')
      expect(await db.creditHold.findMany({ where: { taskId } })).toEqual(placed.holds)
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(300, 1),
        gift: account(0),
        pack: account(0),
      })
      // A reserve writes no ledger row.
      expect(await ledger(workspaceId)).toEqual(rows('tariff grant 300 → 300'))
      // Nor a claim of the site.
      expect(await db.giftSiteClaim.count({ where: { workspaceId } })).toBe(0)
    })

    it.each(['light', 'standard', 'heavy'] as const)(
      'sets aside the same one credit for the class %s: there is no step of a class',
      async (modelClass) => {
        const { workspaceId } = await funded()
        const taskId = await task(workspaceId, { modelClass })

        expect(await place(workspaceId, taskId)).toMatchObject({ applied: true, reserved: 1 })
        expect(await reserve(taskId)).toEqual(['#1 tariff 1 active'])
      },
    )

    it.each([
      ['the tariff', { tariff: 5, gift: 35, pack: 100 }, '#1 tariff 1 active'],
      [
        'the gift, when the tariff has nothing free',
        { tariff: 0, gift: 10, pack: 100 },
        '#1 gift 1 active',
      ],
      [
        'the pack, when the tariff and the gift have nothing free',
        { tariff: 0, gift: 0, pack: 100 },
        '#1 pack 1 active',
      ],
    ] as const)('stands on the first account with a free credit: %s', async (_name, funds, row) => {
      const { workspaceId } = await funded(funds)
      const taskId = await task(workspaceId)

      expect((await place(workspaceId, taskId)).reserved).toBe(1)
      expect(await reserve(taskId)).toEqual([row])
    })

    it('sets aside the last credit a workspace has', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: 0, pack: 1 })
      const taskId = await task(workspaceId)

      expect(await place(workspaceId, taskId)).toMatchObject({ applied: true, reserved: 1 })
      expect(await accounts(workspaceId)).toMatchObject({ pack: account(1, 1) })
    })

    it('never takes what another task holds', async () => {
      const { workspaceId } = await funded({ tariff: 2 })
      const [first, second, third] = await tasks(workspaceId, 3)

      expect((await place(workspaceId, first!)).reserved).toBe(1)
      expect((await place(workspaceId, second!)).reserved).toBe(1)
      expect(await refused(workspaceId, third!)).toMatchObject(creditsHeld(0, 2))
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(2, 2) })
    })

    it.each(['none', 'past_due', 'cancelled', 'expired', 'trial'] as const)(
      'stands on gift and pack credits while the tariff is not paid: %s',
      async (state) => {
        const { workspaceId } = await funded({
          tariff: 300,
          gift: 35,
          pack: 100,
          subscription: state === 'none' ? null : { status: state },
        })
        const taskId = await taskOn(workspaceId, 'https://www.Gift-Only.example.ru')

        const placed = await place(workspaceId, taskId)

        // The tariff credits wait for the payment; the gift goes first — one credit is one credit.
        expect(placed).toMatchObject({ applied: true, reserved: 1 })
        expect(await reserve(taskId)).toEqual(['#1 gift 1 active'])
        expect(placed.holds[0]).toMatchObject({ createdAt: NOW, placedAt: NOW })
        expect(await accounts(workspaceId)).toEqual({
          tariff: account(300),
          gift: account(35, 1),
          pack: account(100),
        })
        // No site claims its gift: nothing but credits bounds a task.
        expect(await db.giftSiteClaim.findMany({ where: { workspaceId } })).toEqual([])
      },
    )

    it('stands on the pack while the tariff is not paid and the gift is spent', async () => {
      const { workspaceId } = await funded({ tariff: 300, pack: 100, subscription: null })
      const taskId = await task(workspaceId)

      expect(await place(workspaceId, taskId)).toMatchObject({ applied: true, reserved: 1 })
      expect(await reserve(taskId)).toEqual(['#1 pack 1 active'])
    })

    it('places one reserve for an attempt, however often it is asked', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)

      const first = await place(workspaceId, taskId)
      const again = await place(workspaceId, taskId, { now: LATER })

      expect(again).toEqual({ ...first, applied: false })
      expect(await reserve(taskId)).toEqual(['#1 tariff 1 active'])
      expect(await accounts(workspaceId)).toMatchObject({
        tariff: account(5, 1),
        pack: account(100),
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
      expect(await reserve(taskId)).toEqual(['#1 tariff 1 active'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300, 1) })
      await expectBooksToBalance(workspaceId)
    })

    it('returns the reserve of an attempt as it became, whatever became of the tariff', async () => {
      const t = await subscribed({ tariff: 40, pack: 100 })
      const taskId = await task(t.workspaceId)
      await place(t.workspaceId, taskId)
      await release(taskId)
      await endPeriod(t, 'cancelled')

      const again = await place(t.workspaceId, taskId)

      expect(again).toMatchObject({ applied: false, reserved: 1 })
      expect(again.holds.map((hold) => hold.status)).toEqual(['released'])
      expect(await reserve(taskId)).toEqual(['#1 tariff 1 released'])
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

      expect(await written(workspaceId)).toEqual(before)
      // The attempt is free: the retry places its reserve.
      expect(await place(workspaceId, taskId)).toMatchObject({ applied: true, reserved: 1 })
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
      expect(await today(workspaceId, NOW)).toBe('0 + 1')
      // Rows of this period: their credits come back.
      expect(await release(taskId)).toMatchObject({ applied: true, expiries: [] })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(5), pack: account(100) })
    })

    it('stamps a tariff row placed after its period ended with that period, and the others with the moment', async () => {
      // The renewal is not settled yet: the tariff is still active, its credits are of the
      // period that ended.
      const late = minutesAfter(2, PERIOD_END)
      const lastMoment = new Date(PERIOD_END.getTime() - 1)
      const onTariff = await funded({ tariff: 5, gift: 35, pack: 100 })
      const onGift = await funded({ tariff: 0, gift: 35, pack: 100 })

      const tariffRow = await place(onTariff.workspaceId, await task(onTariff.workspaceId), {
        now: late,
      })
      const giftRow = await place(onGift.workspaceId, await task(onGift.workspaceId), { now: late })

      expect(
        tariffRow.holds.map((hold) => [kindOf(hold.unit), hold.createdAt, hold.placedAt]),
      ).toEqual([['tariff', lastMoment, late]])
      expect(
        giftRow.holds.map((hold) => [kindOf(hold.unit), hold.createdAt, hold.placedAt]),
      ).toEqual([['gift', late, late]])
    })
  })

  // The windows of 5 hours and of the week (docs/plan/71-usage-limits.md, scenarios 5 and 6): the
  // gateway opens a window with the first call; here the window and the calls are written as it
  // leaves them, and the placement reads what they took at the private rate of 6 ₽.
  describe('the windows of the workspace', () => {
    // Only the calls of a plan fill the windows: the provider of the model has plan rates
    // (owner's answer of 13.11.2026 — a call of the API is bounded by credits alone).
    const planRates: string[] = []
    afterEach(async () => {
      await db.llmPlanRate.deleteMany({ where: { id: { in: planRates.splice(0) } } })
    })
    const planModelPool = async () => {
      const model = await modelPool()
      const { providerId, providerModelId } = await db.llmModel.findUniqueOrThrow({
        where: { id: model.pool.modelId },
        select: { providerId: true, providerModelId: true },
      })
      const rate = await db.llmPlanRate.create({
        data: {
          providerId,
          model: providerModelId ?? 'synthetic',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          inputUncachedPer10k: '6.9',
          cacheReadPer10k: '1.7',
          outputPer10k: '24',
          offPeakShare: '0.5',
          peak: { timeZone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], fromHour: 0, toHour: 24 },
          sourceUrl: 'https://rates.invalid/plan',
        },
      })
      planRates.push(rate.id)
      return model
    }
    const window = (workspaceId: string, kind: '5h' | 'week', startedAt: Date) =>
      db.workspaceUsageWindow.create({
        data: {
          workspaceId,
          kind,
          startedAt,
          endsAt: new Date(startedAt.getTime() + (kind === '5h' ? 5 : 7 * 24) * 3_600_000),
        },
      })

    it('refuses a new task, and a retry, of «Бизнес» whose week took 210 credits (scenario 5)', async () => {
      const { workspaceId } = await funded({
        plan: { creditsPer5h: 70, creditsPerWeek: 210 },
      })
      const started = minutesAfter(-3 * 24 * 60)
      await window(workspaceId, 'week', started)
      const model = await planModelPool()
      const busy = await task(workspaceId)
      // 1 260 ₽ at 6 ₽ a credit: 210 credits two days ago, outside every window of 5 hours.
      await worked(model, busy, '1260', { occurredAt: minutesAfter(-2 * 24 * 60) })
      const taskId = await task(workspaceId)

      const error = await refused(workspaceId, taskId)
      expect(error).toMatchObject({
        code: 'BILLING_WINDOW_LIMIT_REACHED',
        httpStatus: 429,
        details: {
          reason: 'window_limit',
          window: {
            kind: 'week',
            limit: 210,
            used: 210,
            resetsAt: new Date(started.getTime() + 7 * 24 * 3_600_000).toISOString(),
          },
        },
      })
    })

    it('places the reserve on the pack and the gift once the week is spent (owner, 14.11.2026)', async () => {
      const { workspaceId } = await funded({
        tariff: 300,
        gift: 3,
        pack: 40,
        plan: { creditsPer5h: null, creditsPerWeek: 210 },
      })
      await window(workspaceId, 'week', minutesAfter(-3 * 24 * 60))
      const model = await planModelPool()
      await worked(model, await task(workspaceId), '1260', {
        occurredAt: minutesAfter(-2 * 24 * 60),
      })
      const placed = await place(workspaceId, await task(workspaceId))
      expect(placed).toMatchObject({ applied: true })
      // Gift, then pack, in the order credits are spent; never the tariff.
      expect(placed.holds.map((hold) => kindOf(hold.unit))).not.toContain('tariff')
      expect(placed.holds.length).toBeGreaterThan(0)
    })

    it('takes a task while the window has room, and refuses it by the 5 hours once it is spent', async () => {
      const { workspaceId } = await funded({ plan: { creditsPer5h: 20, creditsPerWeek: 55 } })
      await window(workspaceId, '5h', minutesAfter(-60))
      await window(workspaceId, 'week', minutesAfter(-60))
      const model = await planModelPool()
      const busy = await task(workspaceId)
      await worked(model, busy, '60', { occurredAt: minutesAfter(-30) })
      expect(await place(workspaceId, await task(workspaceId))).toMatchObject({ applied: true })
      await worked(model, busy, '60', { occurredAt: minutesAfter(-20), attempt: 2 })
      expect(await refused(workspaceId, await task(workspaceId))).toMatchObject({
        details: { reason: 'window_limit', window: { kind: '5h', limit: 20, used: 20 } },
      })
    })

    it('reads the limit of the tariff at once when it changes, inside the open window (scenario 6)', async () => {
      const { workspaceId } = await funded({ plan: { creditsPer5h: 20, creditsPerWeek: 55 } })
      await window(workspaceId, '5h', minutesAfter(-60))
      const model = await planModelPool()
      const busy = await task(workspaceId)
      await worked(model, busy, '150', { occurredAt: minutesAfter(-30) })
      const taskId = await task(workspaceId)
      expect(await refused(workspaceId, taskId)).toMatchObject({
        details: { reason: 'window_limit' },
      })
      const subscription = await db.subscription.findFirstOrThrow({ where: { workspaceId } })
      await db.plan.update({
        where: { id: subscription.planId },
        data: { creditsPer5h: 70, creditsPerWeek: 210 },
      })
      expect(await place(workspaceId, taskId)).toMatchObject({ applied: true })
    })

    it('counts nothing of a call through the API paid by the token (owner, 13.11.2026)', async () => {
      const { workspaceId } = await funded({ plan: { creditsPer5h: 20, creditsPerWeek: 55 } })
      await window(workspaceId, '5h', minutesAfter(-60))
      // A provider without plan rates: the API, bounded by the credits alone.
      const model = await modelPool()
      await worked(model, await task(workspaceId), '600', { occurredAt: minutesAfter(-30) })
      expect(await place(workspaceId, await task(workspaceId))).toMatchObject({ applied: true })
    })

    it('counts nothing the platform failed (Л7)', async () => {
      const { workspaceId } = await funded({ plan: { creditsPer5h: 20, creditsPerWeek: 55 } })
      await window(workspaceId, '5h', minutesAfter(-60))
      const model = await planModelPool()
      const busy = await task(workspaceId)
      await fixtures.modelCall({
        taskId: busy,
        pool: model.pool,
        priceId: model.priceId,
        costRub: '600',
        occurredAt: minutesAfter(-30),
        estimateReason: 'aborted_platform',
      })
      expect(await place(workspaceId, await task(workspaceId))).toMatchObject({ applied: true })
    })
  })

  describe('a refusal', () => {
    it('needs a usable credit rate before anything else', async () => {
      const { workspaceId } = await funded({ tariff: 0 })
      const taskId = await task(workspaceId)

      // No rate at all — and no credits either: the rate is what is said.
      expect(await refused(workspaceId, taskId, { rate: false })).toMatchObject(rateMissing(0))
      // With a rate the same task is told about its credits.
      expect(await refused(workspaceId, taskId)).toMatchObject(notEnough('empty', 0))
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
      ).toBe(1)
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

      expect(placed).toMatchObject({ applied: true, reserved: 1 })
      expect(placed.holds[0]?.placedAt).toEqual(start)
    })

    it('tells a paid tariff that its credits ran out, and takes a task on one credit', async () => {
      const empty = await funded({ tariff: 0 })
      expect(await refused(empty.workspaceId, await task(empty.workspaceId))).toMatchObject(
        notEnough('empty', 0),
      )
      // One credit that can be spent starts a task (КР5): there is no «too few».
      await grant(empty.workspaceId, 'pack', 1)
      expect(await place(empty.workspaceId, await task(empty.workspaceId))).toMatchObject({
        applied: true,
        reserved: 1,
      })
    })

    it('tells that the credits are held when other tasks in work have them set aside', async () => {
      const { workspaceId } = await funded({ tariff: 1 })
      const [working, waiting] = await tasks(workspaceId, 2)
      await place(workspaceId, working!)

      // Nothing is free, one credit is held: with what comes back there would be enough.
      expect(await refused(workspaceId, waiting!)).toMatchObject(creditsHeld(0, 1))

      // Without a paid tariff the gift is set aside for the task in work.
      const trial = await funded({ tariff: 0, gift: 1, subscription: null })
      const [first, second] = await tasks(trial.workspaceId, 2)
      await place(trial.workspaceId, first!)
      expect(await refused(trial.workspaceId, second!)).toMatchObject(creditsHeld(0, 1))
    })

    it('tells a workspace without a tariff that the gift is spent, and takes a task on one credit', async () => {
      const spent = await funded({ tariff: 0, subscription: null })
      expect(await refused(spent.workspaceId, await task(spent.workspaceId))).toMatchObject(
        needsTariff('gift_spent', 0),
      )
      await grant(spent.workspaceId, 'gift', 1)
      expect(await place(spent.workspaceId, await task(spent.workspaceId))).toMatchObject({
        applied: true,
        reserved: 1,
      })
    })

    it('tells an overdue tariff to be paid, and spends a pack once the tariff has ended', async () => {
      // The quota is there, and it is not a task's to take.
      const overdue = await funded({
        tariff: 300,
        subscription: { status: 'past_due', pastDueSince: PERIOD_END },
      })
      expect(await refused(overdue.workspaceId, await task(overdue.workspaceId))).toMatchObject(
        needsTariff('past_due', 0),
      )

      for (const status of ['cancelled', 'expired'] as const) {
        const ended = await funded({ tariff: 0, pack: 40, subscription: { status } })
        const taskId = await task(ended.workspaceId)
        expect(await place(ended.workspaceId, taskId)).toMatchObject({
          applied: true,
          reserved: 1,
        })
        expect(await reserve(taskId)).toEqual(['#1 pack 1 active'])
      }
    })

    it('holds a paid tariff to the tariff credits of its day, with credits still free', async () => {
      const { workspaceId } = await funded({ plan: startDay })
      const [first, second, third] = await tasks(workspaceId, 3)
      expect(await place(workspaceId, first!)).toMatchObject({ reserved: 1 })
      // The first pass took 49 credits of the day: one is left of the fifty.
      await settle(first!, 49, { now: minutesAfter(5) })
      expect(await place(workspaceId, second!, { now: minutesAfter(6) })).toMatchObject({
        reserved: 1,
      })
      expect(await reserve(second!)).toEqual(['#1 tariff 1 active'])

      expect(await refused(workspaceId, third!, { now: minutesAfter(7) })).toMatchObject(
        dailyLimit(250, 1, { limit: 50, used: 50 }),
      )

      // The next day in Moscow takes it.
      const tomorrow = new Date('2026-10-04T21:00:00.000Z')
      expect(await place(workspaceId, third!, { now: tomorrow })).toMatchObject({
        applied: true,
        reserved: 1,
      })
    })

    // «Если кредиты закончились, можно докупить»: a pack is outside the day.
    it('lets a pack bought the same day carry the tasks the day of the tariff no longer can', async () => {
      const { workspaceId } = await funded({ plan: startDay })
      const [first, second, third] = await tasks(workspaceId, 3)
      await place(workspaceId, first!)
      await settle(first!, 49, { now: minutesAfter(1) })
      await place(workspaceId, second!, { now: minutesAfter(2) })
      expect(await refused(workspaceId, third!, { now: minutesAfter(3) })).toMatchObject(
        dailyLimit(250, 1, { limit: 50, used: 50 }),
      )

      await grant(workspaceId, 'pack', 100)

      expect(await place(workspaceId, third!, { now: minutesAfter(5) })).toMatchObject({
        reserved: 1,
      })
      expect(await reserve(third!)).toEqual(['#1 pack 1 active'])
      expect(await today(workspaceId)).toBe('49 + 1')
    })

    it('has no limit of the day on a plan without one', async () => {
      const { workspaceId } = await funded()
      for (const taskId of await tasks(workspaceId, 6)) {
        expect(await place(workspaceId, taskId)).toMatchObject({ applied: true, reserved: 1 })
      }
      // The day is still counted: there is just nothing to compare it with.
      expect(await today(workspaceId)).toBe('0 + 6')
    })

    // Without a tariff there is no day: the gift of the registration is the bound.
    it('lets a workspace without a tariff spend its whole gift in one day, and then not', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: 35, subscription: null })
      // Each pass is charged five credits: seven of them spend the gift.
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

    // Owner's decision of 10.11.2026: «удали лимиты пробных задач … зависимость только от
    // кредитов». Failed work costs the customer nothing and bounds nothing.
    it('takes new tasks of a paid tariff however much work ended without a charge', async () => {
      const { workspaceId } = await funded({ plan: { creditsPerMonth: 100 } })
      const model = await modelPool()
      const [failed, asked] = await tasks(workspaceId, 2)
      await place(workspaceId, failed!)
      await worked(model, failed!, '5000')
      await release(failed!)

      expect(await place(workspaceId, asked!, { now: minutesAfter(10) })).toMatchObject({
        applied: true,
        reserved: 1,
      })
    })

    it.each([null, 'past_due', 'cancelled', 'expired'] as const)(
      'takes new tasks of a workspace without a paid tariff (%s) however much work ended without a charge',
      async (status) => {
        const { workspaceId } = await funded({
          tariff: 0,
          gift: 35,
          subscription: status === null ? null : { status },
        })
        const model = await modelPool()
        const [failed, next] = await tasks(workspaceId, 2)
        await place(workspaceId, failed!)
        await worked(model, failed!, '5000')
        await release(failed!)

        expect(await place(workspaceId, next!, { now: minutesAfter(10) })).toMatchObject({
          applied: true,
          reserved: 1,
        })
      },
    )

    it('lets one site spend gift credits in any workspace: a site claims nothing', async () => {
      const first = await funded({ tariff: 0, gift: 35, subscription: null })
      const second = await funded({ tariff: 0, gift: 35, subscription: null })
      const mine = await taskOn(first.workspaceId, 'https://shop.example.ru')
      const theirs = await taskOn(second.workspaceId, 'http://www.shop.example.ru')

      expect(await place(first.workspaceId, mine)).toMatchObject({ applied: true, reserved: 1 })
      expect(await place(second.workspaceId, theirs)).toMatchObject({ applied: true, reserved: 1 })
      expect(await db.giftSiteClaim.count({ where: { hostKey: 'shop.example.ru' } })).toBe(0)
    })

    it('asks nothing about a site of a chat without one: nothing to claim (plan 61, К17)', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: 35, subscription: null })
      const chat = await db.task.create({
        data: {
          id: '0196abcd-0000-7000-8000-000000000b17',
          workspaceId,
          siteId: null,
          needsRepository: false,
          needsBrowser: true,
          modelClass: 'standard',
        },
      })
      expect(await place(workspaceId, chat.id)).toMatchObject({ applied: true })
      expect(await db.giftSiteClaim.count({ where: { workspaceId } })).toBe(0)
    })

    it('asks nothing about the site of a paid tariff, gift credits or not', async () => {
      const trial = await funded({ tariff: 0, gift: 35, subscription: null })
      await place(trial.workspaceId, await taskOn(trial.workspaceId, 'https://paid.example.ru'))
      const paying = await funded({ tariff: 5, gift: 35 })
      const taskId = await taskOn(paying.workspaceId, 'https://paid.example.ru')

      expect(await place(paying.workspaceId, taskId)).toMatchObject({ applied: true, reserved: 1 })

      expect(await reserve(taskId)).toEqual(['#1 tariff 1 active'])
      expect(await db.giftSiteClaim.count({ where: { workspaceId: paying.workspaceId } })).toBe(0)
    })

    it('refuses by the rate, then the credits, then the day', async () => {
      const { workspaceId } = await funded({
        tariff: 45,
        plan: { creditsPerMonth: 50, creditsPerDay: 45 },
      })
      const model = await modelPool()
      const [failed, asked] = await tasks(workspaceId, 2)
      // A task of the day failed after 300 RUB of work. Its reserve came back, and with it the
      // day; the failed work bounds nothing.
      await place(workspaceId, failed!)
      await worked(model, failed!, '300')
      await release(failed!)
      // A task queued earlier today holds every credit, and the 45 of the day.
      const inWork = await fixtures.hold(workspaceId, 'tariff', 45)
      await db.creditHold.update({
        where: { id: inWork.id },
        data: { createdAt: NOW, placedAt: NOW },
      })

      expect(await refused(workspaceId, asked!, { rate: false })).toMatchObject(rateMissing(0, 45))
      expect(await refused(workspaceId, asked!)).toMatchObject(creditsHeld(0, 45))
      // The credits are there now: the day is what refuses.
      await grant(workspaceId, 'tariff', 10)
      expect(await refused(workspaceId, asked!)).toMatchObject(
        dailyLimit(10, 45, { limit: 45, used: 45 }),
      )
      // Tomorrow the day is free: the task is taken.
      const tomorrow = new Date('2026-10-04T21:00:00.000Z')
      expect(await place(workspaceId, asked!, { now: tomorrow })).toMatchObject({
        applied: true,
        reserved: 1,
      })
    })

    it('refuses a workspace without a tariff by its credits alone — never by a day', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: 15, subscription: null })
      const model = await modelPool()
      // Three tasks of today, each done for five credits after 170 RUB of work.
      for (const minute of [0, 10, 20]) {
        const taskId = await task(workspaceId)
        await place(workspaceId, taskId, { now: minutesAfter(minute) })
        await worked(model, taskId, '170', { occurredAt: minutesAfter(minute + 1) })
        await settle(taskId, 5, { now: minutesAfter(minute + 5) })
      }
      const asked = await task(workspaceId)
      const at = minutesAfter(30)

      // The gift is spent.
      expect(await refused(workspaceId, asked, { now: at })).toMatchObject(
        needsTariff('gift_spent', 0),
      )
      // One credit of a pack is enough: the task is taken.
      await grant(workspaceId, 'pack', 1)
      expect(await place(workspaceId, asked, { now: at })).toMatchObject({
        applied: true,
        reserved: 1,
      })
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
    it('needs one credit that can be spent for a new task, a retry and a continuation alike', async () => {
      const { workspaceId } = await funded({ tariff: 1 })
      const [retried, continued, fresh] = await tasks(workspaceId, 3)
      await place(workspaceId, retried!)
      await release(retried!)
      await place(workspaceId, continued!, { now: minutesAfter(1) })

      // Nothing is free, one credit is held: neither a new task nor a retry starts…
      expect(await refused(workspaceId, fresh!)).toMatchObject(creditsHeld(0, 1))
      expect(await refused(workspaceId, retried!, { attempt: 2, retry: true })).toMatchObject(
        creditsHeld(0, 1),
      )
      // …and the task in work is told that the credits ran out: its own reserve is not «tasks
      // in work» to wait for.
      expect(
        await refused(workspaceId, continued!, { attempt: 2, now: minutesAfter(30) }),
      ).toMatchObject(notEnough('empty', 0, 0, 1))
      await grant(workspaceId, 'pack', 1)
      expect(
        await place(workspaceId, continued!, { attempt: 2, now: minutesAfter(30) }),
      ).toMatchObject({ applied: true, reserved: 1 })
      expect(await reserve(continued!)).toEqual(['#1 tariff 1 active', '#2 pack 1 active'])
    })

    it('starts a retry on five credits, in the class the task has by then', async () => {
      const { workspaceId } = await funded({ tariff: 50 })
      const taskId = await task(workspaceId)
      await placedBefore(workspaceId, taskId)
      await release(taskId)
      // «Попробовать ещё» runs in the stronger mode.
      await db.task.update({ where: { id: taskId }, data: { modelClass: 'heavy', attempt: 2 } })

      const retry = await placedBefore(workspaceId, taskId, {
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
      await placedBefore(workspaceId, taskId)
      await release(taskId)
      await placedBefore(workspaceId, taskId, { attempt: 2, now: minutesAfter(30), retry: true })

      // «Продолжить» at the step of the retry: the rows of the failed attempt hold nothing.
      const third = await placedBefore(workspaceId, taskId, { attempt: 3, now: minutesAfter(60) })

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
      const first = await placedBefore(workspaceId, taskId)
      expect(first.holds.map((hold) => hold.expiresAt)).toEqual([new Date(NOW.getTime() + DAY_MS)])
      const later = minutesAfter(120)
      const expiresAt = new Date(later.getTime() + 3 * DAY_MS)

      const second = await placedBefore(workspaceId, taskId, { attempt: 2, now: later, expiresAt })

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
      expect(
        await placedBefore(workspaceId, taskId, { attempt: 2, now: later, expiresAt }),
      ).toEqual({
        ...second,
        applied: false,
      })
      const again = await placedBefore(workspaceId, taskId)
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
        expect(await placedBefore(workspaceId, taskId, { attempt })).toMatchObject({
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
      expect(await placedBefore(workspaceId, taskId, { attempt: 4, retry: true })).toMatchObject({
        applied: true,
        reserved: 45,
      })
      expect(await taskChainAttempts(db, taskId)).toEqual([4])
      // And a continuation of it is the second attempt of its chain.
      expect(await placedBefore(workspaceId, taskId, { attempt: 5 })).toMatchObject({
        applied: true,
      })
      expect(await taskChainAttempts(db, taskId)).toEqual([4, 5])
    })

    it('takes no reserve for a charged task, nor for an attempt below one that holds a reserve', async () => {
      const { workspaceId } = await funded()
      const [done, skipped] = await tasks(workspaceId, 2)
      await placedBefore(workspaceId, done!)
      await settle(done!, 17)
      expect(await refused(workspaceId, done!, { attempt: 2 })).toMatchObject(conflict)
      // The attempt that was charged is still answered with its reserve, as it became.
      const again = await placedBefore(workspaceId, done!)
      expect(again).toMatchObject({ applied: false, reserved: 45 })
      expect(again.holds.map((hold) => hold.status)).toEqual(['captured'])

      // The second attempt was placed first: the first cannot come after it.
      await placedBefore(workspaceId, skipped!, { attempt: 2, retry: true })
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
      await placedBefore(workspaceId, taskId!)
      // The chain still holds its reserve: the next attempt is «Продолжить».
      expect(await refused(workspaceId, taskId!, { attempt: 2, retry: true })).toMatchObject(
        notARetry,
      )
      await release(taskId!)
      // Given back: only a retry places the next attempt.
      expect(await refused(workspaceId, taskId!, { attempt: 2 })).toMatchObject(onlyARetry)
      expect(await placedBefore(workspaceId, taskId!, { attempt: 2, retry: true })).toMatchObject({
        applied: true,
        reserved: 45,
      })
      // A repeat answers with the rows of the first call, whatever it says.
      expect(await placedBefore(workspaceId, taskId!, { attempt: 2 })).toMatchObject({
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
      await placedBefore(workspaceId, taskId!)
      // The chain is active: the words go on with it, no new chain.
      expect(await refused(workspaceId, taskId!, { attempt: 2, follows: 'message' })).toMatchObject(
        goesOn,
      )
      await settle(taskId!, 17)
      expect(
        await placedBefore(workspaceId, taskId!, { attempt: 2, follows: 'message' }),
      ).toMatchObject({
        applied: true,
        reserved: 45,
      })
      await settle(taskId!, 6)
      expect(
        await placedBefore(workspaceId, taskId!, { attempt: 3, follows: 'continue' }),
      ).toMatchObject({
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
      await placedBefore(workspaceId, given!)
      await release(given!)
      expect(await refused(workspaceId, given!, { attempt: 2, follows: 'continue' })).toMatchObject(
        notCharged,
      )
      expect(
        await placedBefore(workspaceId, given!, { attempt: 2, follows: 'message' }),
      ).toMatchObject({
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

      const placed = await placedBefore(workspaceId, late!, { now: afterMidnight })

      // The credits are of the period that ended: the row is stamped with its last millisecond,
      // which is still the 17th in Moscow…
      const lastMoment = new Date(end.getTime() - 1)
      expect(placed.holds[0]).toMatchObject({ createdAt: lastMoment, placedAt: afterMidnight })
      // …and the reserve takes credits of the 18th.
      expect(await today(workspaceId, minutesAfter(5, end))).toBe('0 + 45')
      expect(await today(workspaceId, lastMoment)).toBe('0 + 0')
      // So the new day has five left of its fifty.
      expect(await placedBefore(workspaceId, next!, { now: minutesAfter(5, end) })).toMatchObject({
        reserved: 5,
      })
      expect(await refused(workspaceId, third!, { now: minutesAfter(6, end) })).toMatchObject(
        dailyLimit(250, 50, { limit: 50, used: 50 }),
      )
    })

    it('gives the day back what a returned reserve held, and keeps what a charged one paid', async () => {
      const { workspaceId } = await funded({ plan: startDay })
      const [failed, done, lapsed, next] = await tasks(workspaceId, 4)

      await placedBefore(workspaceId, failed!)
      expect(await placedBefore(workspaceId, done!, { now: minutesAfter(1) })).toMatchObject({
        reserved: 5,
      })
      expect(await today(workspaceId)).toBe('0 + 50')
      // Failed: its 45 come back to the day at once.
      await release(failed!, { now: minutesAfter(2) })
      expect(await today(workspaceId)).toBe('0 + 5')
      expect(await placedBefore(workspaceId, lapsed!, { now: minutesAfter(3) })).toMatchObject({
        reserved: 45,
      })
      // Done for 5: the day keeps 5. Stuck past its expiry: its 45 come back too.
      await settle(done!, 5, { now: minutesAfter(4) })
      await expire(lapsed!, { now: minutesAfter(3 + 24 * 60) })
      expect(await today(workspaceId, NOW)).toBe('5 + 0')
      expect(await placedBefore(workspaceId, next!, { now: minutesAfter(5) })).toMatchObject({
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
      await placedBefore(workspaceId, working!)
      await placedBefore(workspaceId, failed!, { now: minutesAfter(1) })
      await worked(model, failed!, '6')
      await release(failed!, { now: minutesAfter(2) })
      expect(await today(workspaceId)).toBe('0 + 45')
      // «Попробовать ещё» takes its whole step, though the day has five left…
      expect(
        await placedBefore(workspaceId, failed!, { attempt: 2, now: minutesAfter(5), retry: true }),
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
        await placedBefore(workspaceId, working!, { attempt: 2, now: minutesAfter(11) }),
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
      await placedBefore(workspaceId, taskId)
      await worked(model, taskId, '6', { occurredAt: minutesAfter(1) })
      expect(
        await placedBefore(workspaceId, taskId, { attempt: 2, now: minutesAfter(2) }),
      ).toMatchObject({
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
        await placedBefore(workspaceId, taskId, { attempt: 3, now: minutesAfter(4), retry: true }),
      ).toMatchObject({ applied: true, reserved: 45 })
      expect(await today(workspaceId)).toBe('0 + 45')

      // The retry fails before any model call and is tried again: still one reserve on the day.
      await release(taskId, { now: minutesAfter(5) })
      expect(
        await placedBefore(workspaceId, taskId, { attempt: 4, now: minutesAfter(6), retry: true }),
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
      await placedBefore(workspaceId, night!, { now: new Date('2026-10-03T22:00:00.000Z') })
      // 23:30 on 4 October in Moscow: five are left of the day.
      expect(
        await placedBefore(workspaceId, evening!, { now: new Date('2026-10-04T20:30:00.000Z') }),
      ).toMatchObject({ reserved: 5 })
      expect(await today(workspaceId, '2026-10-04T20:59:59.999Z')).toBe('0 + 50')
      expect(
        await refused(workspaceId, late!, { now: new Date('2026-10-04T20:59:59.999Z') }),
      ).toMatchObject(dailyLimit(250, 50, { limit: 50, used: 50 }))

      // Midnight in Moscow, the same date in UTC and half an hour after the last reserve: a new
      // day, while yesterday's reserves are still active.
      expect(await today(workspaceId, '2026-10-04T21:00:00.000Z')).toBe('0 + 0')
      expect(
        await placedBefore(workspaceId, late!, { now: new Date('2026-10-04T21:00:00.000Z') }),
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
        const placed = await placedBefore(workspaceId, taskId, { now })
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
      await placedBefore(workspaceId, before!, { now: minutesAfter(-60) })
      await renew({ ...subscription, planId: subscription.plan.id })

      // The new period gives 300 credits; the day it began in has five of its fifty left.
      expect(await placedBefore(workspaceId, after!, { now: minutesAfter(60) })).toMatchObject({
        reserved: 5,
      })
      expect(await today(workspaceId, minutesAfter(60))).toBe('0 + 50')
    })

    it('keeps the day of each workspace apart', async () => {
      const one = await funded({ plan: startDay })
      const other = await funded({ plan: startDay })
      await placedBefore(one.workspaceId, await task(one.workspaceId))
      await placedBefore(other.workspaceId, await task(other.workspaceId))
      expect(await placedBefore(other.workspaceId, await task(other.workspaceId))).toMatchObject({
        reserved: 5,
      })
      expect(await refused(other.workspaceId, await task(other.workspaceId))).toMatchObject(
        dailyLimit(250, 50, { limit: 50, used: 50 }),
      )
      expect(await placedBefore(one.workspaceId, await task(one.workspaceId))).toMatchObject({
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
      await placedBefore(workspaceId, onPack!)
      expect(await reserve(onPack!)).toEqual(['#1 pack 45 active'])
      await grant(workspaceId, 'tariff', 300)
      await placedBefore(workspaceId, onTariff!, { now: minutesAfter(1) })
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
      await placedBefore(workspaceId, first!)
      await placedBefore(workspaceId, second!, { now: minutesAfter(1) })
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

      await placedBefore(workspaceId, done!)
      expect(await day(workspaceId, NOW)).toBe('0 + 45')
      await placedBefore(workspaceId, failed!, { now: minutesAfter(1) })
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
      await placedBefore(workspaceId, taskId, { now: evening })
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
      await placedBefore(workspaceId, late!, { now: new Date('2026-10-04T20:59:59.999Z') })
      await placedBefore(workspaceId, early!, { now: new Date('2026-10-04T21:00:00.000Z') })

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
      await placedBefore(workspaceId, taskId)
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
      await placedBefore(workspaceId, taskId)
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
      await placedBefore(workspaceId, taskId)
      await grant(workspaceId, 'tariff', 300)
      // The pack row is charged from free tariff credits: 17 on the day of the charge.
      await settle(taskId, 17, { now: morning })
      const evening = new Date(morning.getTime() + DAY_MS)
      await placedBefore(workspaceId, taskId, { attempt: 2, now: evening, follows: 'message' })
      await settle(taskId, 9, { now: evening })

      expect(await day(workspaceId, morning)).toBe('17 + 0')
      // The next day: its own row placed and charged that day, nothing of the morning before.
      expect(await day(workspaceId, evening)).toBe('9 + 0')
    })

    it('counts a charge settled the day it was placed once: the row and the transfer together', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)
      await placedBefore(workspaceId, taskId)
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
      await placedBefore(workspaceId, taskId, {
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
      await placedBefore(workspaceId, first!)
      await placedBefore(workspaceId, second!, { now: minutesAfter(1) })
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
      await placedBefore(one.workspaceId, await task(one.workspaceId))
      const settled = await task(other.workspaceId)
      await placedBefore(other.workspaceId, settled)
      await settle(settled, 20)
      expect(await day(one.workspaceId, NOW)).toBe('0 + 45')
      expect(await day(other.workspaceId, NOW)).toBe('20 + 0')
      expect(await day(randomUUID(), NOW)).toBe('0 + 0')
    })
  })

  describe('at once', () => {
    it('never sets aside more than is free when twenty tasks are queued', async () => {
      const { workspaceId } = await funded({ tariff: 2, pack: 1 })
      const queued = await tasks(workspaceId, 20)

      const results = await Promise.allSettled(
        queued.map((taskId) => fixtures.reserve(placement(workspaceId, taskId))),
      )

      // One credit each: three tasks start on the three credits there are.
      const placed = fulfilled(results)
      expect(placed.map((result) => result.reserved)).toEqual([1, 1, 1])
      expect(placed.every((result) => result.applied)).toBe(true)
      expect(rejected(results)).toEqual(Array(17).fill(expect.objectContaining(creditsHeld(0, 3))))
      expect(await accounts(workspaceId)).toMatchObject({
        tariff: account(2, 2),
        pack: account(1, 1),
      })
      await expectBooksToBalance(workspaceId)
    })

    it('never passes the limit of the day when twenty tasks are queued', async () => {
      // A day of three credits, two of them spent already by a pass charged today.
      const { workspaceId } = await funded({ plan: { creditsPerMonth: 300, creditsPerDay: 3 } })
      const [spent, ...queued] = await tasks(workspaceId, 21)
      await place(workspaceId, spent!)
      await settle(spent!, 2)

      const results = await Promise.allSettled(
        queued.map((taskId) =>
          fixtures.reserve(placement(workspaceId, taskId, { now: minutesAfter(30) })),
        ),
      )

      // The one credit the day had left goes to one of them.
      expect(fulfilled(results).map((result) => result.reserved)).toEqual([1])
      expect(rejected(results)).toEqual(
        Array(19).fill(expect.objectContaining(dailyLimit(297, 1, { limit: 3, used: 3 }))),
      )
      expect(await today(workspaceId, minutesAfter(30))).toBe('2 + 1')
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(298, 1) })
      await expectBooksToBalance(workspaceId)
    })

    it('gives the gift of a workspace without a tariff to one of the tasks queued together', async () => {
      // No subscription row to lock first: the accounts are what the placements queue for.
      const { workspaceId } = await funded({ tariff: 0, gift: 1, subscription: null })
      const queued = await tasks(workspaceId, 10)

      const results = await Promise.allSettled(
        queued.map((taskId) => fixtures.reserve(placement(workspaceId, taskId))),
      )

      expect(fulfilled(results)).toMatchObject([{ applied: true, reserved: 1 }])
      expect(rejected(results)).toEqual(Array(9).fill(expect.objectContaining(creditsHeld(0, 1))))
      expect(await accounts(workspaceId)).toMatchObject({ gift: account(1, 1) })
      await expectBooksToBalance(workspaceId)
    })

    it('gives the gift to both of two workspaces that ask together about one site', async () => {
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

      expect(fulfilled(results)).toMatchObject([
        { applied: true, reserved: 1 },
        { applied: true, reserved: 1 },
      ])
      expect(await db.giftSiteClaim.count({ where: { hostKey: host } })).toBe(0)
      for (const { workspaceId } of pair) await expectBooksToBalance(workspaceId)
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
      await placedBefore(workspaceId, taskId)

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
      // The reserve waited for the new period, took its credit from the new quota and is
      // stamped with it, though the clock that queued the task still showed the old period.
      expect(NOW.getTime()).toBeLessThan(periodEnd.getTime())
      expect(placed).toMatchObject({ applied: true, reserved: 1 })
      expect(placed.holds[0]).toMatchObject({
        unit: 'credit_tariff',
        createdAt: periodEnd,
        placedAt: periodEnd,
      })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300, 1) })

      // So its credits come back into the new period.
      const at = new Date(periodEnd.getTime() + DAY_MS)
      expect(await release(taskId, { now: at })).toMatchObject({ applied: true, expiries: [] })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it('gives a reserve back either wholly before a renewal or wholly after it', async () => {
      const { workspaceId, plan, subscriptionId, periodEnd } = await subscribed()
      const taskId = await task(workspaceId)
      await placedBefore(workspaceId, taskId)
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
      await placedBefore(workspaceId, waiting!)
      await grant(workspaceId, 'tariff', 45)
      await placedBefore(workspaceId, other!, { now: minutesAfter(1) })
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
      await placedBefore(workspaceId, done!)
      await settle(done!, 17)
      await placedBefore(workspaceId, failed!)
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
      await placedBefore(workspaceId, taskId)
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
      await placedBefore(workspaceId, taskId)
      const firstExpiry = new Date(NOW.getTime() + DAY_MS)
      const later = minutesAfter(180)
      await placedBefore(workspaceId, taskId, { attempt: 2, now: later })
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
      await placedBefore(workspaceId, taskId)
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
      await placedBefore(t.workspaceId, taskId, {
        expiresAt: new Date(t.periodEnd.getTime() + DAY_MS),
      })
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
      await placedBefore(workspaceId, taskId)

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
      await placedBefore(workspaceId, taskId)

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
      await placedBefore(workspaceId, taskId)
      await placedBefore(workspaceId, taskId, { attempt: 2, now: minutesAfter(60) })

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
      await placedBefore(t.workspaceId, taskId)
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
      await placedBefore(t.workspaceId, taskId, { now: minutesAfter(2, t.periodEnd) })

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
      await placedBefore(t.workspaceId, taskId, { now: minutesAfter(2, t.periodEnd) })
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
        await placedBefore(t.workspaceId, taskId)
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
      await placedBefore(workspaceId, done!)
      await settle(done!, 17)
      await placedBefore(workspaceId, failed!)
      await release(failed!)
      await placedBefore(workspaceId, lapsed!)
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
      await placedBefore(workspaceId, taskId)
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
      await placedBefore(workspaceId, a!)
      await placedBefore(workspaceId, b!, { now: minutesAfter(1) })
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
      await placedBefore(workspaceId, a!)
      await placedBefore(workspaceId, b!, { now: minutesAfter(1) })

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
      await placedBefore(workspaceId, taskId)

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
      await placedBefore(workspaceId, taskId)
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
      await placedBefore(t.workspaceId, taskId, {
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
      await placedBefore(t.workspaceId, taskId, {
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
        await placedBefore(t.workspaceId, small!)
        await grant(t.workspaceId, 'tariff', 40)
        await placedBefore(t.workspaceId, large!, { now: minutesAfter(1) })
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
      await placedBefore(workspaceId, taskId)
      await placedBefore(workspaceId, taskId, { attempt: 2, now: minutesAfter(60) })
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
      await placedBefore(workspaceId, taskId)
      await release(taskId)
      await db.task.update({ where: { id: taskId }, data: { modelClass: 'heavy', attempt: 2 } })
      await placedBefore(workspaceId, taskId, { attempt: 2, now: minutesAfter(30), retry: true })

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
      await placedBefore(workspaceId, taskId)
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
      await placedBefore(t.workspaceId, taskId, {
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
      await placedBefore(t.workspaceId, taskId, {
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
      await placedBefore(workspaceId, taskId)
      const first = await settle(taskId, 17)
      await placedBefore(workspaceId, taskId, { attempt: 2, follows: 'message' })
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

    // Owner's decision of 10.11.2026 (docs/spec.md §20, «Только кредиты», КР5–КР8): a pass is
    // charged its work, not its reserve.
    it('charges above the reserve from the free credits, in the order credits are spent', async () => {
      const { workspaceId } = await funded({ tariff: 5, pack: 100 })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)

      expect(await settle(taskId, 46)).toMatchObject({
        credits: 46,
        from: { tariff: 5, gift: 0, pack: 41 },
        debt: 0,
      })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(0), pack: account(59) })
      expect(await debtOf(workspaceId)).toBe(0)
      await expectBooksToBalance(workspaceId)
    })

    it('makes what the accounts cannot pay the debt of the workspace, on its pack account', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: 2, subscription: null })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)

      const charged = await settle(taskId, 10)

      // Two credits of the gift pay; eight are owed.
      expect(charged).toMatchObject({ credits: 10, from: { tariff: 0, gift: 2, pack: 0 }, debt: 8 })
      expect(await accounts(workspaceId)).toMatchObject({ gift: account(0), pack: account(0) })
      expect(await debtOf(workspaceId)).toBe(8)
      // The ledger has what was paid; the debt is not a movement of a balance.
      expect(await ledger(workspaceId)).toEqual(rows('gift grant 2 → 2', 'gift charge -2 → 0'))
      expect(await reserve(taskId)).toEqual(['#1 gift 1 captured'])
      await expectBooksToBalance(workspaceId)
      // A repeat names what was posted: the debt is not in the ledger.
      expect(await settle(taskId, 2)).toMatchObject({ credits: 2, applied: false, debt: 0 })

      // While the debt is above what can be spent, no task starts.
      await grant(workspaceId, 'gift', 5)
      expect(await refused(workspaceId, await task(workspaceId))).toMatchObject(
        needsTariff('gift_spent', 0),
      )
      // A credit more than the debt is one that can be spent.
      await grant(workspaceId, 'gift', 4)
      expect(await place(workspaceId, await task(workspaceId))).toMatchObject({
        applied: true,
        reserved: 1,
      })
    })

    it('adds every debt up, pass by pass', async () => {
      const { workspaceId } = await funded({ tariff: 1 })
      const [first, second] = await tasks(workspaceId, 2)
      await place(workspaceId, first!)
      await settle(first!, 4)
      expect(await debtOf(workspaceId)).toBe(3)
      // The workspace is in debt: nothing can be spent, a new task is refused.
      expect(await refused(workspaceId, second!)).toMatchObject(notEnough('empty', 0))
      await grant(workspaceId, 'pack', 10)
      await place(workspaceId, second!, { now: minutesAfter(5) })
      await settle(second!, 20, { now: minutesAfter(6) })
      // Ten of the pack paid; ten more are owed.
      expect(await debtOf(workspaceId)).toBe(13)
    })

    it('keeps credits held through the end of the period and charges them without touching the new quota', async () => {
      const t = await subscribed()
      const taskId = await task(t.workspaceId)
      await placedBefore(t.workspaceId, taskId, {
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
        await placedBefore(t.workspaceId, taskId!, { ...long, now: minutesAfter(index) })
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
