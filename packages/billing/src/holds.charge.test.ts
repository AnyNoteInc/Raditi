import { randomInt, randomUUID } from 'node:crypto'

import { createPrismaClient, type Prisma, type PrismaClient, type TaskStatus } from '@repo/db'
import { creditAccountKinds, creditAccountUnits, Money, type CreditAccountKind } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import { ensureAccounts, lockCreditAccount, type BillingTx } from './accounts.ts'
import {
  attemptCreditBudget,
  chargeTask,
  expireTaskHolds,
  modelClassPriced,
  releaseTask,
  taskChargeAuditActions,
  taskChargeRefusals,
  type CreditHoldPlacement,
} from './holds.ts'
import { expireTariffRemainder, grantTariffCredits, ledgerKeys, post } from './ledger.ts'
import {
  billingFixtures,
  inRolledBackTransaction,
  underPrivateCreditRate,
  type TestCreditRateData,
  type TestEstimateReason,
  type TestModelPool,
  type TestModelPoolData,
  type TestModelPriceData,
} from './testing.ts'

// The charge of a done task from its token usage, and the numbers of a turn key's budget. The
// model calls are written by the token fixture, the way the subscription gateway leaves them;
// every number expected below is computed by hand at the credit rate the test names — 6.00 RUB
// of accounting cost in a credit unless it says otherwise.

const databaseUrl = process.env.DATABASE_URL
const TASK = '0199a000-0000-7000-8000-0000000000d4'
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
const PERIOD_MS = 30 * DAY_MS
/** 15:00 in Moscow on 4 October 2026, inside the period of the fixtures' subscription. */
const NOW = new Date('2026-10-04T12:00:00.000Z')
/** When a task ends: later the same day. */
const LATER = new Date('2026-10-04T12:20:00.000Z')
const minutesAfter = (minutes: number, from = NOW) => new Date(from.getTime() + minutes * MINUTE_MS)
/** The start of every price row of the tests: before the credit rates they are counted by. */
const PRICES_FROM = new Date('2026-01-01T00:00:00.000Z')

describe('charge and budget input', () => {
  // A refused input never reaches the database: this client would throw a TypeError there.
  const tx = {} as BillingTx
  const charge = { taskId: TASK, now: LATER }
  const query = { taskId: TASK, attempt: 1, now: LATER }

  it('refuses a charge that names no task, no moment or anything else, before any query', async () => {
    await expect(chargeTask(tx, { ...charge, taskId: 'task' })).rejects.toBeInstanceOf(ZodError)
    for (const now of [new Date(Number.NaN), '2026-10-04' as unknown as Date]) {
      await expect(chargeTask(tx, { ...charge, now })).rejects.toBeInstanceOf(ZodError)
    }
    // What a task costs is read from its usage: nobody names the sum.
    await expect(
      chargeTask(tx, { ...charge, credits: 17 } as unknown as typeof charge),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      chargeTask(tx, { ...charge, attempt: 1 } as unknown as typeof charge),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it.each([0, -1, 1.5, Number.NaN, 2 ** 31, '1'])(
    'refuses a budget of attempt %s before any query',
    async (value) => {
      const attempt = value as number
      await expect(attemptCreditBudget(tx, { ...query, attempt })).rejects.toBeInstanceOf(ZodError)
    },
  )

  it('refuses a budget that names no task, no moment or anything else, before any query', async () => {
    await expect(attemptCreditBudget(tx, { ...query, taskId: 'task' })).rejects.toBeInstanceOf(
      ZodError,
    )
    for (const now of [new Date(Number.NaN), '2026-10-04' as unknown as Date]) {
      await expect(attemptCreditBudget(tx, { ...query, now })).rejects.toBeInstanceOf(ZodError)
    }
    await expect(
      attemptCreditBudget(tx, { ...query, workspaceId: TASK } as unknown as typeof query),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('names the audit action and the reasons a charge is refused with', () => {
    expect(taskChargeAuditActions).toEqual({ charge: 'billing.task.charge' })
    expect(taskChargeRefusals).toEqual(['not_done', 'no_reserve', 'usage_open', 'not_convertible'])
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL charge from token usage', () => {
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
   * told otherwise (`creditsPerDay`), active for the period of the fixtures unless told
   * otherwise; `subscription: null` for none.
   */
  async function funded(
    options: {
      tariff?: number
      gift?: number
      pack?: number
      creditsPerDay?: number
      subscription?: Partial<Parameters<typeof fixtures.subscription>[0]> | null
    } = {},
  ) {
    const { tariff = 300, gift = 0, pack = 0, creditsPerDay = null } = options
    const { workspaceId } = await fixtures.workspace()
    const plan = await fixtures.plan({ creditsPerMonth: 300, creditsPerDay })
    const subscription =
      options.subscription === null
        ? null
        : await fixtures.subscription({ workspaceId, planId: plan.id, ...options.subscription })
    await db.$transaction((tx) => ensureAccounts(tx, workspaceId))
    if (tariff > 0) await grant(workspaceId, 'tariff', tariff)
    if (gift > 0) await grant(workspaceId, 'gift', gift)
    if (pack > 0) await grant(workspaceId, 'pack', pack)
    return { workspaceId, plan, subscription }
  }

  /** A queued task of the workspace on a site of its own; `standard` unless told otherwise. */
  const task = async (workspaceId: string, data: Partial<Prisma.TaskUncheckedCreateInput> = {}) =>
    (await fixtures.task(workspaceId, data)).taskId
  const workspaceOf = async (taskId: string) =>
    (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { workspaceId: true } }))
      .workspaceId
  /** The queue moved the task to its end. */
  const ended = (taskId: string, status: TaskStatus = 'done') =>
    db.task.update({ where: { id: taskId }, data: { status } })

  /**
   * What every call must leave behind: each credit account holds exactly what its ledger rows
   * add up to, `held` is exactly its active reserve rows, and never more than the balance.
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

  interface PlacementOptions {
    now?: Date
    attempt?: number
    expiresAt?: Date
    /** K the reserve is placed under; it does not change what is set aside. */
    rate?: Partial<TestCreditRateData>
    /** «Попробовать ещё»: what the retry of a dialog says, after it gave the chain back. */
    retry?: true
    /** A new chain after a charged pass: the client's next words or «Продолжить». */
    follows?: 'message' | 'continue'
  }
  /** Places a reserve the way the queue will, under a credit rate nobody else sees. */
  async function place(
    workspaceId: string,
    taskId: string,
    { now = NOW, attempt = 1, expiresAt, rate = {}, retry, follows }: PlacementOptions = {},
  ) {
    const placement: CreditHoldPlacement = {
      workspaceId,
      taskId,
      attempt,
      now,
      expiresAt: expiresAt ?? new Date(now.getTime() + DAY_MS),
      ...(retry === undefined ? {} : { retry }),
      ...(follows === undefined ? {} : { follows }),
    }
    const placed = await fixtures.reserve(placement, rate)
    await expectBooksToBalance(workspaceId)
    return placed
  }
  /**
   * A reserve by the step of before 10.11.2026 (`placeReserveByStep` of the fixtures): rows of
   * any size stand in the database, and the charge settles them as it settles a credit.
   */
  async function placedBefore(
    workspaceId: string,
    taskId: string,
    { now = NOW, attempt = 1, expiresAt, rate = {}, retry, follows }: PlacementOptions = {},
  ) {
    const placed = await fixtures.reserveByStep(
      {
        workspaceId,
        taskId,
        attempt,
        now,
        expiresAt: expiresAt ?? new Date(now.getTime() + DAY_MS),
        ...(retry === undefined ? {} : { retry }),
        ...(follows === undefined ? {} : { follows }),
      },
      rate,
    )
    await expectBooksToBalance(workspaceId)
    return placed
  }
  /** What the workspace owes: `billing_accounts.debt` of its pack account. */
  const debtOf = async (workspaceId: string) =>
    (
      await db.billingAccount.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: creditAccountUnits.pack } },
      })
    ).debt.toNumber()

  /** A model of its own with a price row: GPT-6 Sol at 4.65 RUB a Codex credit, not enabled. */
  async function modelPool(
    data: TestModelPoolData = {},
    price: Partial<TestModelPriceData> = {},
  ): Promise<{ pool: TestModelPool; priceId: string }> {
    const pool = await fixtures.modelPool(data)
    const row = await fixtures.modelPrice(pool, { effectiveFrom: PRICES_FROM, ...price })
    return { pool, priceId: row.id }
  }
  type Model = Awaited<ReturnType<typeof modelPool>>

  interface CallOptions {
    attempt?: number
    /** The turn of the key; the attempt's own unless given. */
    turnNo?: number
    occurredAt?: Date
    estimateReason?: TestEstimateReason
    turnStatus?: 'completed' | 'lost' | 'failed'
    /** The pass of the turn ended in a `feed.failure` (`task_turns.rejected_at`). */
    turnRejected?: boolean
    usageClosed?: boolean
    priceId?: string
  }
  /** A recorded model call of an attempt: each attempt works in a turn of its own. */
  const worked = (
    model: Model,
    taskId: string,
    costRub: string,
    { attempt = 1, turnNo = attempt, occurredAt = minutesAfter(5), ...rest }: CallOptions = {},
  ) =>
    fixtures.modelCall({
      taskId,
      pool: model.pool,
      priceId: model.priceId,
      costRub,
      occurredAt,
      attempt,
      turnNo,
      ...rest,
    })

  /** A call of the key that is still on its way: its reserve stands, its usage is not known. */
  const openCall = (model: Model, keyId: string, reservedRub: string) =>
    db.llmCall.create({
      data: {
        keyId,
        subscriptionAccountId: model.pool.accountId,
        modelId: model.pool.modelId,
        route: 'POST /verification',
        state: 'open',
        reservedRub,
        requestBytes: 600,
      },
    })

  /**
   * The credit rates a transaction counts by: K = 6.00 from a millisecond of 1 January 2026
   * that no other transaction stands on, unless told otherwise. They are gone when the
   * transaction commits, so the database is left without a rate.
   */
  type Rates = readonly Partial<TestCreditRateData>[]
  const ONE_RATE: Rates = [{}]
  /** A second rate that starts ten minutes into the task: 7.50 RUB in a credit. */
  const rateChange = (): Rates => [
    {},
    { effectiveFrom: new Date(minutesAfter(10).getTime() + randomInt(1000)), rubPerCredit: '7.5' },
  ]
  const underRates = <T>(tx: BillingTx, rates: Rates, work: () => Promise<T>): Promise<T> =>
    rates.reduceRight<() => Promise<T>>(
      (inner, rate) => () => underPrivateCreditRate(tx, inner, rate),
      work,
    )()

  interface ChargeOptions {
    now?: Date
    rates?: Rates
  }
  /** Charges a task the way the queue will, and asks the books of its workspace afterwards. */
  async function charge(taskId: string, { now = LATER, rates = ONE_RATE }: ChargeOptions = {}) {
    const workspaceId = await workspaceOf(taskId)
    try {
      return await db.$transaction(
        (tx) => underRates(tx, rates, () => chargeTask(tx, { taskId, now })),
        patient,
      )
    } finally {
      await expectBooksToBalance(workspaceId)
    }
  }

  const auditOf = (taskId: string) =>
    db.auditLog.findMany({ where: { targetType: 'task', targetId: taskId } })
  /** The details of the one audit row of the charge of a task. */
  /** The meta of the charge of a task; `index` — of its n-th charge, when it has several. */
  async function chargeMeta(taskId: string, index?: number) {
    const rows = await auditOf(taskId)
    if (index === undefined) expect(rows).toHaveLength(1)
    return rows[index ?? 0]?.meta as Record<string, unknown>
  }

  /** Everything a charge could write for a workspace, row by row. */
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
    audit: await db.auditLog.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
    tasks: await db.task.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
  })

  /**
   * The error a charge is refused with — and the proof that the refusal wrote nothing: the
   * transaction that caught it is committed, and not a row of the workspace differs after it.
   */
  async function refused(
    taskId: string,
    { now = LATER, rates = ONE_RATE }: ChargeOptions = {},
  ): Promise<unknown> {
    const workspaceId = await workspaceOf(taskId)
    const before = await written(workspaceId)
    const caught = await db.$transaction(
      (tx) =>
        underRates(tx, rates, async () => {
          try {
            await chargeTask(tx, { taskId, now })
          } catch (error) {
            return { error }
          }
          return null
        }),
      patient,
    )
    if (caught === null) throw new Error('The charge was not refused')
    expect(await written(workspaceId)).toEqual(before)
    await expectBooksToBalance(workspaceId)
    return caught.error
  }

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
  const rows = (...lines: string[]) => [...lines].sort()
  /** The ledger of the workspace, one line per row with the balance the row left behind. */
  const ledger = async (workspaceId: string) => {
    const entries = await db.creditLedger.findMany({ where: { account: { workspaceId } } })
    return rows(
      ...entries.map(
        (entry) =>
          `${kindOf(entry.unit)} ${entry.kind} ${entry.amount.toFixed(0)} → ${entry.balanceAfter.toFixed(0)}`,
      ),
    )
  }

  const conflict = (reason: string) => ({
    name: 'DomainError',
    code: 'CONFLICT',
    httpStatus: 409,
    details: { charge: reason },
  })
  const notFound = { name: 'DomainError', code: 'NOT_FOUND', httpStatus: 404 }

  /**
   * A funded workspace with a task that holds its reserve, and a model to record calls of. With
   * `byStep`, the reserve is one of before 10.11.2026, by the step of the class.
   */
  async function taskInWork(options: Parameters<typeof funded>[0] & { byStep?: boolean } = {}) {
    const { byStep = false, ...funds } = options
    const model = await modelPool()
    const { workspaceId, plan, subscription } = await funded(funds)
    const taskId = await task(workspaceId)
    const placed = byStep
      ? await placedBefore(workspaceId, taskId)
      : await place(workspaceId, taskId)
    return { model, workspaceId, taskId, plan, subscription, reserved: placed.reserved }
  }

  describe('the charge of a done task', () => {
    it('charges what the calls of the task came to, rounded once, and writes how', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      // A new block: 101.37 RUB of accounting cost in three calls; 101.37 ÷ 6.00 = 16.895.
      await worked(model, taskId, '60')
      await worked(model, taskId, '40.5', { occurredAt: minutesAfter(8) })
      await worked(model, taskId, '0.87', { occurredAt: minutesAfter(11) })
      await ended(taskId)

      const charged = await charge(taskId)

      expect(charged).toMatchObject({
        credits: 17,
        reserved: 1,
        from: { tariff: 17, gift: 0, pack: 0 },
        expired: 0,
        debt: 0,
        applied: true,
      })
      expect(
        charged.entries.map((entry) => [entry.idempotencyKey, entry.amount.toFixed(0)]),
      ).toEqual([[ledgerKeys.taskCharge(taskId, 1, await accountId(workspaceId, 'tariff')), '-17']])
      // The charge and its rows carry the moment the caller named.
      expect(charged.holds.map((hold) => [hold.status, hold.settledAt])).toEqual([
        ['captured', LATER],
      ])
      expect(charged.entries.map((entry) => entry.createdAt)).toEqual([LATER])
      expect(await reserve(taskId)).toEqual(['#1 tariff 1 captured'])
      // The reserve row paid its credit, the free tariff credits the rest.
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(283) })
      expect(await ledger(workspaceId)).toEqual(
        rows('tariff grant 300 → 300', 'tariff charge -17 → 283'),
      )

      // One audit row says how the number came about.
      expect(await auditOf(taskId)).toMatchObject([
        {
          actorType: 'system',
          actorId: 'billing',
          workspaceId,
          action: 'billing.task.charge',
          targetType: 'task',
          targetId: taskId,
          ip: null,
        },
      ])
      expect(await chargeMeta(taskId)).toEqual({
        // The first charge of the task.
        first: true,
        attempts: 1,
        // No attempt of the task gave its reserve back to «Попробовать ещё».
        givenBack: 0,
        firstAttempt: 1,
        lastAttempt: 1,
        reserved: 1,
        charged: 17,
        fromTariff: 17,
        fromGift: 0,
        fromPack: 0,
        expired: 0,
        // Nothing was owed: the accounts paid all of it.
        debt: 0,
        // A plan without a daily limit; sixteen of the credits were free on the tariff.
        tariffRoom: null,
        freeTariff: 16,
        costRub: '101.3700000000',
        rawCredits: '16.895',
      })
      // The cost of the task in roubles is the queue's to write.
      const row = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(row.costRub.toFixed(2)).toBe('0.00')
      expect(row.billedRub).toBeNull()
    })

    // The worked examples of the design, §1.5: the accounting cost of the calls and what the
    // task is charged — its work rounded up, no minimum (owner's decision of 10.11.2026, КР5).
    it.each([
      ['a small edit', 300, ['22.09'], 4, /^3\.6816+7$/],
      ['a new block', 300, ['101.37'], 17, /^16\.895$/],
      ['a big task rounds up below the half', 300, ['176.70'], 30, /^29\.45$/],
      ['the block after a clarification', 300, ['101.37', '25.34'], 22, /^21\.1183+$/],
      ['three small edits in one message', 300, ['22.09', '22.09', '22.08'], 12, /^11\.043+$/],
      ['thirds and sixths that add up to a half', 300, ['14', '14', '17'], 8, /^7\.5$/],
      ['work of whole credits is not rounded', 300, ['30'], 5, /^5$/],
      ['a hair of work above a credit', 300, ['6.01'], 2, /^1\.0016+7$/],
      ['work far above the reserve of one credit', 300, ['270'], 45, /^45$/],
      ['work equal to all the customer had', 12, ['72'], 12, /^12$/],
    ] as const)('charges by the work: %s', async (_name, tariff, costs, credits, rawCredits) => {
      const { model, workspaceId, taskId } = await taskInWork({ tariff })
      for (const [index, costRub] of costs.entries()) {
        await worked(model, taskId, costRub, { occurredAt: minutesAfter(5 + index) })
      }
      await ended(taskId)

      expect(await charge(taskId)).toMatchObject({ credits, reserved: 1, debt: 0, applied: true })

      const meta = await chargeMeta(taskId)
      expect(meta).toMatchObject({ reserved: 1, charged: credits, debt: 0 })
      expect(meta.rawCredits).toMatch(rawCredits)
      expect(meta.costRub).toBe(
        costs.reduce((sum, cost) => sum.plus(cost), new Money(0)).toFixed(10),
      )
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(tariff - credits) })
    })

    // The charge moves the task towards the tariff only within what is left of the day of the
    // charge, and the audit row keeps both: what was left, and what free tariff credits paid.
    it('writes what was left of the day and what free tariff credits paid', async () => {
      const model = await modelPool()
      const { workspaceId } = await funded({ tariff: 0, pack: 100, creditsPerDay: 10 })
      const [onPack, onTariff] = await Promise.all([task(workspaceId), task(workspaceId)])
      // The tariff was empty when the first was queued; then the quota came, and the second
      // set one of the ten of the day aside.
      await place(workspaceId, onPack)
      await grant(workspaceId, 'tariff', 300)
      await place(workspaceId, onTariff, { now: minutesAfter(1) })
      expect(await reserve(onPack)).toEqual(['#1 pack 1 active'])
      // 180 RUB of work: 30 credits.
      await worked(model, onPack, '180')
      await ended(onPack)

      // Nine credits of the day are left for the tariff; the pack pays the rest.
      expect(await charge(onPack)).toMatchObject({
        credits: 30,
        from: { tariff: 9, gift: 0, pack: 21 },
      })
      expect(await chargeMeta(onPack)).toMatchObject({
        reserved: 1,
        charged: 30,
        fromTariff: 9,
        fromPack: 21,
        tariffRoom: 9,
        freeTariff: 9,
      })
      expect(await accounts(workspaceId)).toMatchObject({
        tariff: account(291, 1),
        pack: account(79),
      })
    })

    // Above the reserve the charge is still the work (КР5): the free credits pay, and what they
    // cannot is owed (КР7): 297 ÷ 6.00 = 49.5 → 50 of 300; 80 ÷ 6.00 = 13.3 → 14 of 12.
    it.each([
      ['calls ran over a step of before', 300, '297', 50, 0, /^49\.5$/],
      ['the task used more than all the customer had', 12, '80', 12, 2, /^13\.3+$/],
    ] as const)(
      'charges all the work above the reserve: %s',
      async (_name, tariff, costRub, paid, debt, rawCredits) => {
        const { model, workspaceId, taskId } = await taskInWork({ tariff })
        await worked(model, taskId, costRub)
        await ended(taskId)

        const credits = paid + debt
        expect(await charge(taskId)).toMatchObject({ credits, reserved: 1, debt, applied: true })

        const meta = await chargeMeta(taskId)
        expect(meta).toMatchObject({ reserved: 1, charged: credits, fromTariff: paid, debt })
        expect(meta.rawCredits).toMatch(rawCredits)
        expect(await accounts(workspaceId)).toMatchObject({ tariff: account(tariff - paid) })
        expect(await debtOf(workspaceId)).toBe(debt)
      },
    )

    it('charges the work of a chain whatever its reserve: a credit of work on a row of three', async () => {
      const model = await modelPool()
      const { workspaceId } = await funded()
      const hold = await fixtures.hold(workspaceId, 'tariff', 3)
      await worked(model, hold.taskId, '6')
      await ended(hold.taskId)

      expect(await charge(hold.taskId)).toMatchObject({ credits: 1, reserved: 3 })
      expect(await chargeMeta(hold.taskId)).toMatchObject({ charged: 1, rawCredits: '1' })
    })

    it('charges nothing for a done task whose only calls were the fault of the platform, and gives its reserve back', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      // Estimates the platform caused are not billable; a turn that ended lost is never billed.
      await worked(model, taskId, '30', { estimateReason: 'aborted_platform' })
      await worked(model, taskId, '20', { estimateReason: 'lost', occurredAt: minutesAfter(6) })
      await worked(model, taskId, '40', { turnNo: 2, turnStatus: 'lost' })
      await ended(taskId)

      // No minimum (КР5): nothing billable is nothing charged.
      expect(await charge(taskId)).toMatchObject({ credits: 0, reserved: 1, entries: [] })
      expect(await auditOf(taskId)).toEqual([])
      expect(await reserve(taskId)).toEqual(['#1 tariff 1 released'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it('leaves the calls that are not billable out of a task that also did billable work', async () => {
      const { model, taskId } = await taskInWork()
      await worked(model, taskId, '101.37', { turnStatus: 'completed' })
      await worked(model, taskId, '200', { estimateReason: 'aborted_platform' })
      await worked(model, taskId, '150', { turnNo: 2, turnStatus: 'lost' })
      // The client's abort stays billable.
      await worked(model, taskId, '24', { estimateReason: 'aborted_client', turnNo: 3 })
      await ended(taskId)

      // (101.37 + 24) ÷ 6.00 = 20.895.
      expect(await charge(taskId)).toMatchObject({ credits: 21 })
      expect(await chargeMeta(taskId)).toMatchObject({
        costRub: '125.3700000000',
        rawCredits: '20.895',
      })
    })

    // docs/plan/53, «Попробовать ещё (18.10)»: a dialog kept its candidate after a failed pass
    // and is released without a retry — the failed pass is not the client's to pay.
    it('leaves the calls of a turn whose pass ended in a failure out of the charge', async () => {
      const { model, taskId } = await taskInWork()
      await worked(model, taskId, '60', { turnStatus: 'completed' })
      await worked(model, taskId, '90', { turnNo: 2, turnStatus: 'failed', turnRejected: true })
      await worked(model, taskId, '30', { turnNo: 3, turnStatus: 'completed', turnRejected: true })
      await ended(taskId)

      // 60 ÷ 6.00.
      expect(await charge(taskId)).toMatchObject({ credits: 10 })
      expect(await chargeMeta(taskId)).toMatchObject({
        costRub: '60.0000000000',
        rawCredits: '10',
      })
    })

    it('charges nothing for a task that made no call at all', async () => {
      const { workspaceId, taskId } = await taskInWork()
      await ended(taskId)

      expect(await charge(taskId)).toMatchObject({ credits: 0, reserved: 1 })
      expect(await auditOf(taskId)).toEqual([])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it('turns each call into credits at the rate of its own start when the rate changes inside an attempt', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      // 60 RUB at 6.00 are 10 credits; 60 RUB after the change, at 7.50, are 8.
      await worked(model, taskId, '60', { occurredAt: minutesAfter(5) })
      await worked(model, taskId, '60', { occurredAt: minutesAfter(15) })
      await ended(taskId)

      expect(await charge(taskId, { rates: rateChange() })).toMatchObject({ credits: 18 })

      expect(await chargeMeta(taskId)).toMatchObject({
        charged: 18,
        costRub: '120.0000000000',
        rawCredits: '18',
      })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(282) })
    })

    it('owes what the accounts cannot pay when the calls started under two rates', async () => {
      const { model, workspaceId, taskId } = await taskInWork({ tariff: 12 })
      await worked(model, taskId, '60', { occurredAt: minutesAfter(5) })
      await worked(model, taskId, '60', { occurredAt: minutesAfter(15) })
      await ended(taskId)

      // 10 + 8 credits of work: the 12 there are pay, six are owed.
      expect(await charge(taskId, { rates: rateChange() })).toMatchObject({ credits: 18, debt: 6 })
      expect(await chargeMeta(taskId)).toMatchObject({
        reserved: 1,
        charged: 18,
        fromTariff: 12,
        rawCredits: '18',
        debt: 6,
      })
      expect(await debtOf(workspaceId)).toBe(6)
    })

    // Two attempts are one task with one pool. The work is rounded once: 37.5 + 12.5 make 50,
    // where each attempt rounded up by itself would make 38 + 13. The reserves of before (45 an
    // attempt) do not cap the chain any more: what is above them comes from free credits.
    it.each([
      ['rounds the work of the chain once', '225', '75', 50, '50'],
      ['pays what one attempt ran over from what the other left', '297', '60', 60, '59.5'],
      ['pays above the reserves of the chain from free credits', '297', '270', 95, '94.5'],
    ] as const)(
      'charges two attempts as one task from one pool: %s',
      async (_name, first, second, credits, rawCredits) => {
        const { model, workspaceId, taskId } = await taskInWork({ byStep: true })
        await worked(model, taskId, first)
        // «Продолжить»: the next attempt adds its reserve to the chain.
        await placedBefore(workspaceId, taskId, { attempt: 2, now: minutesAfter(10) })
        await worked(model, taskId, second, { attempt: 2, occurredAt: minutesAfter(12) })
        await ended(taskId)

        const charged = await charge(taskId)

        expect(charged).toMatchObject({ credits, reserved: 90, applied: true })
        expect(charged.entries).toHaveLength(1)
        expect(await reserve(taskId)).toEqual(['#1 tariff 45 captured', '#2 tariff 45 captured'])
        expect(await chargeMeta(taskId)).toMatchObject({
          attempts: 2,
          firstAttempt: 1,
          lastAttempt: 2,
          reserved: 90,
          charged: credits,
          rawCredits,
          debt: 0,
        })
        expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300 - credits) })
      },
    )

    /**
     * «Попробовать ещё» the way `task.retry` does it (docs/plan/53, «Попробовать ещё (18.10)»):
     * the chain of the dialog is given back and the next attempt, in `heavy`, sets its reserve
     * aside. The dialog kept the candidate its earlier turns built.
     */
    async function retried(workspaceId: string, taskId: string, attempt = 2) {
      await db.$transaction((tx) => releaseTask(tx, { taskId, now: minutesAfter(8) }))
      await db.task.update({
        where: { id: taskId },
        data: { status: 'queued', modelClass: 'heavy', attempt },
      })
      return placedBefore(workspaceId, taskId, { attempt, now: minutesAfter(10), retry: true })
    }

    it('charges a retried dialog for the candidate and the retry, not for the pass that failed, whatever that one left open', async () => {
      const { model, workspaceId, taskId } = await taskInWork({ byStep: true })
      // Turn 1 built the candidate: 120 RUB, 20 credits. The pass of turn 2 failed after
      // 150 RUB of calls, and the accounting of its key never closed.
      await worked(model, taskId, '120', { turnNo: 1, turnStatus: 'completed' })
      await worked(model, taskId, '150', {
        turnNo: 2,
        turnStatus: 'failed',
        turnRejected: true,
        usageClosed: false,
      })
      await retried(workspaceId, taskId)
      // The retry replaced turn 2: 90 RUB, 15 credits.
      await worked(model, taskId, '90', { attempt: 2, turnNo: 3, occurredAt: minutesAfter(12) })
      await ended(taskId)

      const charged = await charge(taskId)

      expect(charged).toMatchObject({ credits: 35, reserved: 120, applied: true })
      expect(await reserve(taskId)).toEqual(['#1 tariff 45 released', '#2 tariff 120 captured'])
      // Asked again, the charge answers with what it settled: the reserve of the retry.
      expect(await charge(taskId)).toEqual({ ...charged, applied: false })
      expect(await chargeMeta(taskId)).toMatchObject({
        attempts: 2,
        givenBack: 1,
        firstAttempt: 1,
        lastAttempt: 2,
        reserved: 120,
        charged: 35,
        costRub: '210.0000000000',
        rawCredits: '35',
      })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(265) })
    })

    // A failure the client can bring about on purpose — a change of `.github/` refused, a secret
    // in a file — kept the candidate; the retry fails the same way and keeps it again, and the
    // candidate is released. The work that built it is charged all the same.
    it('charges the work that built the kept candidate when the retry failed as well', async () => {
      const { model, workspaceId, taskId } = await taskInWork({ byStep: true })
      // Turn 1: 240 RUB, 40 credits — the candidate. Turn 2: refused, 30 RUB.
      await worked(model, taskId, '240', { turnNo: 1, turnStatus: 'completed' })
      await worked(model, taskId, '30', { turnNo: 2, turnStatus: 'completed', turnRejected: true })
      await retried(workspaceId, taskId)
      // Turn 3 of the retry: refused again, 60 RUB.
      await worked(model, taskId, '60', {
        attempt: 2,
        turnNo: 3,
        turnStatus: 'completed',
        turnRejected: true,
        occurredAt: minutesAfter(12),
      })
      await ended(taskId)

      // The 40 credits of turn 1, from the reserve of the retry.
      expect(await charge(taskId)).toMatchObject({ credits: 40, reserved: 120 })
      expect(await chargeMeta(taskId)).toMatchObject({
        attempts: 2,
        givenBack: 1,
        charged: 40,
        costRub: '240.0000000000',
        rawCredits: '40',
      })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(260) })
    })

    it('waits for the usage of a given-back attempt whose calls it counts', async () => {
      const { model, workspaceId, taskId } = await taskInWork({ byStep: true })
      const built = await worked(model, taskId, '120', {
        turnNo: 1,
        turnStatus: 'completed',
        usageClosed: false,
      })
      await retried(workspaceId, taskId)
      await worked(model, taskId, '90', { attempt: 2, turnNo: 3, occurredAt: minutesAfter(12) })
      await ended(taskId)

      await expect(charge(taskId)).rejects.toMatchObject(conflict('usage_open'))
      await db.llmKey.update({ where: { id: built.keyId }, data: { usageClosedAt: LATER } })
      expect(await charge(taskId)).toMatchObject({ credits: 35 })
    })

    it('says which accounts paid: the tariff, then the gift, then the pack', async () => {
      const { model, workspaceId, taskId } = await taskInWork({
        tariff: 5,
        gift: 35,
        pack: 100,
        byStep: true,
      })
      expect(await reserve(taskId)).toEqual([
        '#1 tariff 5 active',
        '#1 gift 35 active',
        '#1 pack 5 active',
      ])
      // 258 ÷ 6.00 = 43.
      await worked(model, taskId, '258')
      await ended(taskId)

      const charged = await charge(taskId)

      expect(charged).toMatchObject({ credits: 43, from: { tariff: 5, gift: 35, pack: 3 } })
      expect(charged.entries).toHaveLength(3)
      expect(await chargeMeta(taskId)).toMatchObject({
        // One attempt, on however many accounts its reserve stood.
        attempts: 1,
        firstAttempt: 1,
        lastAttempt: 1,
        reserved: 45,
        charged: 43,
        fromTariff: 5,
        fromGift: 35,
        fromPack: 3,
        expired: 0,
      })
      expect(await accounts(workspaceId)).toEqual({
        tariff: account(0),
        gift: account(0),
        pack: account(97),
      })
    })

    /** What each reserve row of a task paid, by attempt and account: `#1 tariff 5 → 5`. */
    const paidByRow = async (taskId: string) =>
      (await db.creditHold.findMany({ where: { taskId } }))
        .map((row) => ({ row, kind: kindOf(row.unit) as CreditAccountKind }))
        .sort(
          (a, b) =>
            a.row.attempt - b.row.attempt ||
            creditAccountKinds.indexOf(a.kind) - creditAccountKinds.indexOf(b.kind),
        )
        .map(
          ({ row, kind }) =>
            `#${row.attempt} ${kind} ${row.amount.toFixed(0)} ${row.status} → ${row.charged?.toFixed(0) ?? 'null'}`,
        )

    it('records on each reserve row what it paid, and answers with the rows as written', async () => {
      const { model, taskId } = await taskInWork({ tariff: 5, gift: 35, pack: 100, byStep: true })
      // 258 ÷ 6.00 = 43: the tariff row pays its 5, the gift row its 35, the pack row 3 of 5.
      await worked(model, taskId, '258')
      await ended(taskId)

      const charged = await charge(taskId)

      expect(await paidByRow(taskId)).toEqual([
        '#1 tariff 5 captured → 5',
        '#1 gift 35 captured → 35',
        '#1 pack 5 captured → 3',
      ])
      expect(await db.creditHold.findMany({ where: { taskId } })).toEqual(
        expect.arrayContaining(charged.holds),
      )
      expect(charged.holds).toHaveLength(3)
      // Asked again, it reads the same rows back.
      expect((await charge(taskId)).holds).toEqual(expect.arrayContaining(charged.holds))
    })

    it('records the oldest rows of a chain as paying first', async () => {
      // Two attempts of 45 on the tariff; the chain costs 50: the first attempt's row pays all
      // it held, the second's the rest.
      const model = await modelPool()
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)
      await placedBefore(workspaceId, taskId)
      await placedBefore(workspaceId, taskId, { attempt: 2, now: minutesAfter(10) })
      // 300 ÷ 6.00 = 50, over the two attempts.
      await worked(model, taskId, '150')
      await worked(model, taskId, '150', { attempt: 2, occurredAt: minutesAfter(15) })
      await ended(taskId)

      expect(await charge(taskId)).toMatchObject({ credits: 50, from: { tariff: 50 } })
      expect(await paidByRow(taskId)).toEqual([
        '#1 tariff 45 captured → 45',
        '#2 tariff 45 captured → 5',
      ])
    })

    it('records nothing on a row that is given back, released or expired', async () => {
      const { workspaceId } = await funded({ tariff: 5, gift: 35, pack: 100 })
      const [released, expired] = [await task(workspaceId), await task(workspaceId)]
      await placedBefore(workspaceId, released)
      await placedBefore(workspaceId, expired, { now: minutesAfter(1) })

      await db.$transaction((tx) => releaseTask(tx, { taskId: released, now: LATER }))
      await db.$transaction((tx) =>
        expireTaskHolds(tx, { taskId: expired, now: new Date(NOW.getTime() + 2 * DAY_MS) }),
      )

      expect(await paidByRow(released)).toEqual([
        '#1 tariff 5 released → null',
        '#1 gift 35 released → null',
        '#1 pack 5 released → null',
      ])
      expect(await paidByRow(expired)).toEqual(['#1 pack 45 expired → null'])
      await expectBooksToBalance(workspaceId)
    })

    it('charges the reserve of an ended period first and says what expired with it', async () => {
      // 45 tariff credits reserved on the 17th; the period renews on the 18th with 300 new
      // credits; the task is done on the 19th for 17.
      const model = await modelPool()
      const { workspaceId, plan, subscription } = await funded({ tariff: 45 })
      if (subscription === null) throw new Error('The scenario needs a subscription')
      const periodEnd = subscription.currentPeriodEnd
      const taskId = await task(workspaceId)
      const placedAt = new Date(periodEnd.getTime() - DAY_MS)
      await placedBefore(workspaceId, taskId, {
        now: placedAt,
        expiresAt: new Date(periodEnd.getTime() + 2 * DAY_MS),
      })
      await worked(model, taskId, '101.37', { occurredAt: minutesAfter(5, placedAt) })
      const order = await fixtures.order({ workspaceId, planId: plan.id })
      await db.$transaction(async (tx) => {
        await expireTariffRemainder(tx, { workspaceId, subscriptionId: subscription.id, periodEnd })
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            currentPeriodStart: periodEnd,
            currentPeriodEnd: new Date(periodEnd.getTime() + PERIOD_MS),
          },
        })
        await grantTariffCredits(tx, { workspaceId, orderId: order.id, credits: 300 })
      })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(345, 45) })
      await ended(taskId)

      const charged = await charge(taskId, { now: new Date(periodEnd.getTime() + DAY_MS) })

      expect(charged).toMatchObject({
        credits: 17,
        reserved: 45,
        from: { tariff: 17, gift: 0, pack: 0 },
        expired: 28,
      })
      // The row paid 17: what expired with it is not what it paid.
      expect(await paidByRow(taskId)).toEqual(['#1 tariff 45 captured → 17'])
      expect(await chargeMeta(taskId)).toMatchObject({
        reserved: 45,
        charged: 17,
        fromTariff: 17,
        expired: 28,
      })
      // The new period is exactly its quota.
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
      // Asked again, the charge is told apart from what expired with it.
      expect(await charge(taskId, { now: new Date(periodEnd.getTime() + 2 * DAY_MS) })).toEqual({
        ...charged,
        applied: false,
      })
    })

    it('charges in the transaction that moves the task to done, and takes the move back when it refuses', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      const call = await worked(model, taskId, '101.37', { usageClosed: false })
      const finish = () =>
        db.$transaction(
          (tx) =>
            underPrivateCreditRate(tx, async () => {
              await tx.task.update({ where: { id: taskId }, data: { status: 'done' } })
              return chargeTask(tx, { taskId, now: LATER })
            }),
          patient,
        )

      // The accounting of the turn key is still open: the task is not done yet either.
      await expect(finish()).rejects.toMatchObject(conflict('usage_open'))
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
      })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300, 1) })

      await db.llmKey.update({ where: { id: call.keyId }, data: { usageClosedAt: LATER } })
      expect(await finish()).toMatchObject({ credits: 17, applied: true })
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'done',
      })
    })
  })

  // The owner, 26.10.2026: «любой успешный запрос от LLM должен тарифицироваться» — a pass is
  // charged when it ends, the dialog stays open, and its next words open a new chain.
  describe('a task charged pass by pass', () => {
    it('charges each pass of a task that waits its work, rounded up — the first as any other', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      // 6 RUB ÷ 6.00 = 1 credit: no minimum for the first charge (КР5).
      await worked(model, taskId, '6')
      await ended(taskId, 'awaiting_user')
      expect(await charge(taskId)).toMatchObject({ credits: 1, applied: true })

      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(20), follows: 'message' })
      // 12.6 RUB = 2.1 credits, rounded up.
      await worked(model, taskId, '12.6', { attempt: 2, occurredAt: minutesAfter(22) })
      await ended(taskId, 'awaiting_approval')
      expect(await charge(taskId)).toMatchObject({ credits: 3, applied: true })

      expect(await reserve(taskId)).toEqual(['#1 tariff 1 captured', '#2 tariff 1 captured'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(296, 0) })
      // The task is done later: nothing is active, and the call answers what was charged.
      await ended(taskId, 'done')
      expect(await charge(taskId)).toMatchObject({ credits: 4, applied: false })
    })

    it('charges a pass too small for a credit one credit: an answered request is never free', async () => {
      // The owner, 26.10.2026: «любой успешный запрос от LLM должен тарифицироваться».
      const { model, workspaceId, taskId } = await taskInWork()
      await worked(model, taskId, '30')
      await ended(taskId, 'awaiting_user')
      expect(await charge(taskId)).toMatchObject({ credits: 5 })
      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(20), follows: 'message' })
      // 1.2 RUB = 0.2 of a credit: rounded up, the pass costs one credit.
      await worked(model, taskId, '1.2', { attempt: 2, occurredAt: minutesAfter(22) })
      await ended(taskId, 'awaiting_user')
      expect(await charge(taskId)).toMatchObject({ credits: 1, applied: true })
      expect(await reserve(taskId)).toEqual(['#1 tariff 1 captured', '#2 tariff 1 captured'])
      expect(await chargeMeta(taskId, 1)).toMatchObject({
        first: false,
        attempts: 1,
        givenBack: 0,
        firstAttempt: 2,
        lastAttempt: 2,
        charged: 1,
      })
      // The work charged before is not counted again: 6 RUB is one credit.
      await place(workspaceId, taskId, { attempt: 3, now: minutesAfter(30), follows: 'message' })
      await worked(model, taskId, '6', { attempt: 3, occurredAt: minutesAfter(32) })
      await ended(taskId, 'awaiting_user')
      expect(await charge(taskId)).toMatchObject({ credits: 1, applied: true })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(293, 0) })
    })
  })

  describe('a charge that is refused', () => {
    // A pass is charged when it ends: the task waits for the client or is done (26.10.2026).
    it.each([
      'queued',
      'preparing',
      'running',
      'deploying',
      'verifying',
      'failed',
      'rolled_back',
      'cancelled',
    ] as const)('charges no task that is %s: only one that waits or is done', async (status) => {
      const { model, workspaceId, taskId } = await taskInWork()
      await worked(model, taskId, '101.37')
      await ended(taskId, status)

      const error = await refused(taskId)

      expect(error).toMatchObject({
        ...conflict('not_done'),
        message: 'A task at work is not charged',
      })
      expect(await reserve(taskId)).toEqual(['#1 tariff 1 active'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300, 1) })
    })

    it('waits until the accounting of every turn key of the chain is closed', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      // The first attempt left a key open; the second is closed.
      const open = await worked(model, taskId, '60', { usageClosed: false })
      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(10) })
      await worked(model, taskId, '41.37', { attempt: 2, occurredAt: minutesAfter(12) })
      await ended(taskId)

      const error = await refused(taskId)

      expect(error).toMatchObject({
        ...conflict('usage_open'),
        message: 'The usage of the task is not closed yet',
      })
      expect(await reserve(taskId)).toEqual(['#1 tariff 1 active', '#2 tariff 1 active'])

      // The key closes — within minutes, the gateway does it —, and the same call goes through.
      await db.llmKey.update({ where: { id: open.keyId }, data: { usageClosedAt: LATER } })
      expect(await charge(taskId)).toMatchObject({ credits: 17, reserved: 2, applied: true })
    })

    it('does not wait for an open turn key of another task', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      // A second task of the workspace still runs: the key of its first attempt is open.
      const running = await task(workspaceId)
      await place(workspaceId, running, { now: minutesAfter(1) })
      await worked(model, running, '5', { usageClosed: false })
      await worked(model, taskId, '101.37')
      await ended(taskId)

      expect(await charge(taskId)).toMatchObject({ credits: 17, reserved: 1, applied: true })

      // The key holds up the task it belongs to, and nothing else.
      expect(await reserve(running)).toEqual(['#1 tariff 1 active'])
      await ended(running)
      expect(await refused(running)).toMatchObject(conflict('usage_open'))
    })

    it('waits for a key that is open although it recorded no call yet', async () => {
      const { model, taskId } = await taskInWork()
      const call = await worked(model, taskId, '60', { usageClosed: false })
      // The call is still on its way: the key has no usage row at all.
      await db.tokenUsage.delete({ where: { id: call.usageId } })
      await ended(taskId)

      expect(await refused(taskId)).toMatchObject(conflict('usage_open'))
    })

    it('does not charge while a call started without a credit rate in force', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      await worked(model, taskId, '60')
      // Before the first rate of the transaction started.
      await worked(model, taskId, '41.37', { occurredAt: new Date('2025-12-31T23:59:59.999Z') })
      await ended(taskId)

      const error = await refused(taskId)

      expect(error).toMatchObject({
        ...conflict('not_convertible'),
        message: 'A model call of the task has no credit rate to count by',
      })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300, 1) })
      // Without any rate at all it is the same refusal.
      expect(await refused(taskId, { rates: [] })).toMatchObject(conflict('not_convertible'))
    })

    it('does not charge while a call was costed with a price newer than the credit rate at its start', async () => {
      const { model, taskId } = await taskInWork()
      // A price approved without its rate: the rate in force is older than the price.
      const price = await fixtures.modelPrice(model.pool, {
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      })
      await worked(model, taskId, '60')
      await worked(model, taskId, '41.37', { priceId: price.id, occurredAt: minutesAfter(6) })
      await ended(taskId)

      expect(await refused(taskId)).toMatchObject(conflict('not_convertible'))

      // A rate approved with that price covers it: the calls are counted, each by its own rate.
      const rates = [{}, { effectiveFrom: new Date('2026-06-01T00:00:00.000Z') }]
      expect(await charge(taskId, { rates })).toMatchObject({ credits: 17 })
    })

    it('is not lifted by a credit rate approved afterwards: a call counts by the rate of its own start', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      const price = await fixtures.modelPrice(model.pool, {
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      })
      await worked(model, taskId, '101.37', { priceId: price.id })
      await ended(taskId)

      expect(await refused(taskId)).toMatchObject(conflict('not_convertible'))

      // An approval writes no rate in the past: the newest one it can add starts after the call.
      // It covers the price, and the call that is already recorded is as it was.
      const approvedLater = new Date(minutesAfter(15).getTime() + randomInt(1000))
      const rates = [{}, { effectiveFrom: approvedLater }]
      expect(await refused(taskId, { rates })).toMatchObject(conflict('not_convertible'))
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300, 1) })
    })

    it('refuses a task with no reserve and no charge: never a silent zero', async () => {
      const model = await modelPool()
      const { workspaceId } = await funded()
      // Never reserved; reserved and given back; not billable at all.
      const never = await task(workspaceId)
      const returned = await task(workspaceId)
      await place(workspaceId, returned)
      await db.$transaction((tx) => releaseTask(tx, { taskId: returned, now: minutesAfter(8) }))
      const free = await task(workspaceId, { billable: false })
      for (const taskId of [never, returned, free]) {
        await worked(model, taskId, '101.37')
        await ended(taskId)

        expect(await refused(taskId)).toMatchObject({
          ...conflict('no_reserve'),
          message: 'The task has no active reserve to charge',
        })
      }
      expect(await reserve(returned)).toEqual(['#1 tariff 1 released'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(300) })
    })

    it('finds no unknown task', async () => {
      await expect(
        db.$transaction((tx) => chargeTask(tx, { taskId: randomUUID(), now: LATER })),
      ).rejects.toMatchObject(notFound)
    })
  })

  describe('a repeated charge', () => {
    it('returns what the first call did and writes nothing', async () => {
      const { model, workspaceId, taskId } = await taskInWork({ tariff: 5, pack: 100 })
      await worked(model, taskId, '101.37')
      await ended(taskId)
      const first = await charge(taskId)
      expect(first).toMatchObject({
        credits: 17,
        reserved: 1,
        from: { tariff: 5, gift: 0, pack: 12 },
        applied: true,
      })
      const before = await written(workspaceId)

      // Asked again later, and without any credit rate: the charge is read back, not recounted.
      const again = await charge(taskId, { now: minutesAfter(90), rates: [] })

      expect(again).toEqual({ ...first, applied: false })
      expect(await written(workspaceId)).toEqual(before)
      expect(await auditOf(taskId)).toHaveLength(1)
    })

    it('answers the same whatever became of the usage since', async () => {
      const { model, taskId } = await taskInWork()
      const call = await worked(model, taskId, '101.37')
      await ended(taskId)
      const first = await charge(taskId)

      // Nothing recorded after the charge moves it: a late call, a key found open again.
      await worked(model, taskId, '300', { turnNo: 2, occurredAt: minutesAfter(30) })
      await db.llmKey.update({ where: { id: call.keyId }, data: { usageClosedAt: null } })

      expect(await charge(taskId)).toEqual({ ...first, applied: false })
    })

    it('reads back the charge of the task asked about, not of another task of the workspace', async () => {
      const { model, workspaceId, taskId: block } = await taskInWork()
      const edit = await task(workspaceId)
      await place(workspaceId, edit, { now: minutesAfter(1) })
      await worked(model, block, '101.37')
      // A small edit: 22.09 ÷ 6.00 = 3.68, rounded up.
      await worked(model, edit, '22.09')
      await ended(block)
      await ended(edit)
      const charged = { block: await charge(block), edit: await charge(edit) }
      expect(charged).toMatchObject({ block: { credits: 17 }, edit: { credits: 4 } })

      const again = { now: minutesAfter(90) }
      expect(await charge(block, again)).toEqual({ ...charged.block, applied: false })
      expect(await charge(edit, again)).toEqual({ ...charged.edit, applied: false })

      // A done task beside them that never held a reserve has no charge to read back.
      const never = await task(workspaceId, { status: 'done' })
      expect(await refused(never)).toMatchObject(conflict('no_reserve'))
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(279) })
    })

    it('charges a task once when it is reported done twice at once', async () => {
      const { model, workspaceId, taskId } = await taskInWork({ tariff: 5, pack: 100 })
      await worked(model, taskId, '101.37')
      await ended(taskId)

      const results = await Promise.all([charge(taskId), charge(taskId)])

      expect(results.map((result) => result.applied).sort()).toEqual([false, true])
      expect(results[0]).toEqual({ ...results[1], applied: results[0]?.applied })
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(0), pack: account(88) })
      expect(await db.creditLedger.count({ where: { taskId } })).toBe(2)
      expect(await auditOf(taskId)).toHaveLength(1)
    })

    it('gives nothing back of a chain it charged: the charge stays', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      await worked(model, taskId, '101.37')
      await ended(taskId)
      await charge(taskId)

      const returned = await db.$transaction((tx) =>
        releaseTask(tx, { taskId, now: minutesAfter(40) }),
      )

      expect(returned).toMatchObject({ holds: [], expiries: [], applied: false })
      expect(await reserve(taskId)).toEqual(['#1 tariff 1 captured'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(283, 0) })
    })
  })

  describe('the budget of a turn key', () => {
    interface BudgetOptions {
      now?: Date
      rates?: Rates
      /** The models switched on for the question; the rest of the catalogue stays as it is. */
      enabled?: readonly Model[]
      /** What else is true only while the question is asked. */
      given?: (tx: Prisma.TransactionClient) => Promise<void>
    }
    /**
     * The numbers of an attempt, asked in a transaction that is never committed: the rates and
     * the switch of a model belong to the whole database, and nobody else sees these.
     */
    const budget = (
      model: Model,
      taskId: string,
      attempt = 1,
      { now = LATER, rates = ONE_RATE, enabled = [model], given }: BudgetOptions = {},
    ) =>
      inRolledBackTransaction(db, (tx) =>
        underRates(tx, rates, async () => {
          await tx.llmModel.updateMany({
            where: { id: { in: enabled.map(({ pool }) => pool.modelId) } },
            data: { enabled: true },
          })
          await given?.(tx)
          const numbers = await attemptCreditBudget(tx, { taskId, attempt, now })
          return { ...numbers, used: numbers.used.toFixed() }
        }),
      )

    // The reserve of a first call of the tests' model: 40 000 tokens of input at 232.50 RUB a
    // million and 32 000 of output at 1 162.50 — 9.30 + 37.20.
    const FINISH = '46.5000000000'
    const NOTHING = '0.0000000000'

    // Owner's decision of 10.11.2026 (docs/spec.md §20, «Только кредиты», КР5–КР8): no step of
    // an attempt. The customer's side is everything the customer can still pay for — the reserve
    // of the chain and every credit the workspace could spend now, less its debt and the work of
    // the chain —; nothing else bounds the key, no step and no limit of a pass (КР6).
    it('gives a fresh attempt all the customer has: 300 credits are 1 800 RUB', async () => {
      const { model, taskId } = await taskInWork()

      expect(await budget(model, taskId)).toEqual({
        attempt: 1,
        chainAttempts: 1,
        reserved: 1,
        used: '0',
        spendableNow: 299,
        debt: 0,
        // (1 + 299) × 6.00.
        customerLeftRub: '1800.0000000000',
        finishRub: FINISH,
        openReservedRub: NOTHING,
        // 1800 + 46.50.
        budgetRub: '1846.50',
      })
    })

    it.each(['light', 'standard', 'heavy'] as const)(
      'has no step of the class %s: the same customer, the same budget',
      async (modelClass) => {
        const model = await modelPool({ modelClass })
        const { workspaceId } = await funded()
        const taskId = await task(workspaceId, { modelClass })
        await place(workspaceId, taskId)

        expect(await budget(model, taskId)).toMatchObject({
          reserved: 1,
          budgetRub: '1846.50',
        })
      },
    )

    it('bounds the key of a customer with 12 credits by those and one first call', async () => {
      const { model, taskId } = await taskInWork({ tariff: 12 })

      expect(await budget(model, taskId)).toMatchObject({
        reserved: 1,
        spendableNow: 11,
        customerLeftRub: '72.0000000000',
        // 72 + 46.50.
        budgetRub: '118.50',
      })
    })

    it('goes on past what a step was while the customer has credits', async () => {
      const { model, taskId } = await taskInWork()
      // 225 RUB of billable calls are 37.5 credits: the whole step of before, and more is left.
      await worked(model, taskId, '225')

      expect(await budget(model, taskId)).toEqual({
        attempt: 1,
        chainAttempts: 1,
        reserved: 1,
        used: '37.5',
        spendableNow: 299,
        debt: 0,
        // (300 − 37.5) × 6.00.
        customerLeftRub: '1575.0000000000',
        finishRub: FINISH,
        openReservedRub: NOTHING,
        budgetRub: '1621.50',
      })
    })

    it('case C: the credits ran out, what the customer has binds', async () => {
      const { model, taskId } = await taskInWork({ tariff: 12 })
      // The ended key held 118.50 and spent 60 of it: 58.50 were left.
      await worked(model, taskId, '60')

      expect(await budget(model, taskId)).toEqual({
        attempt: 1,
        chainAttempts: 1,
        reserved: 1,
        used: '10',
        spendableNow: 11,
        debt: 0,
        // (12 − 10) × 6.00.
        customerLeftRub: '12.0000000000',
        finishRub: FINISH,
        openReservedRub: NOTHING,
        // No more than the ended key had left: a new key would be refused the same call.
        budgetRub: '58.50',
      })
    })

    // No limit of a pass (owner's answer of 10.11.2026, КР6): only the credits of the customer.
    it('lets a long pass go on while the customer can pay', async () => {
      const { model, taskId } = await taskInWork({ tariff: 1000 })
      // 2 880 RUB of work: 480 credits.
      await worked(model, taskId, '2880')

      expect(await budget(model, taskId)).toMatchObject({
        used: '480',
        // (1000 − 480) × 6.00.
        customerLeftRub: '3120.0000000000',
        // 3120 + 46.50.
        budgetRub: '3166.50',
      })
    })

    it('gives no key once the customer has nothing left', async () => {
      const { model, taskId } = await taskInWork({ tariff: 12 })
      // 80 RUB are 13.33 credits of the 12 there are.
      await worked(model, taskId, '80')

      expect(await budget(model, taskId)).toMatchObject({
        reserved: 1,
        customerLeftRub: NOTHING,
        finishRub: FINISH,
        budgetRub: '0.00',
      })
    })

    it('takes the debt of the workspace off what the customer has', async () => {
      const { model, workspaceId, taskId } = await taskInWork({ tariff: 20 })
      await db.billingAccount.update({
        where: { workspaceId_unit: { workspaceId, unit: creditAccountUnits.pack } },
        data: { debt: 5 },
      })

      expect(await budget(model, taskId)).toMatchObject({
        reserved: 1,
        // 19 free less the 5 owed.
        spendableNow: 14,
        debt: 5,
        // (1 + 19 − 5) × 6.00.
        customerLeftRub: '90.0000000000',
        budgetRub: '136.50',
      })
      // A debt above everything leaves nothing to spend: no key.
      await db.billingAccount.update({
        where: { workspaceId_unit: { workspaceId, unit: creditAccountUnits.pack } },
        data: { debt: 25 },
      })
      expect(await budget(model, taskId)).toMatchObject({
        spendableNow: 0,
        customerLeftRub: NOTHING,
        budgetRub: '0.00',
      })
    })

    it('case K: a key holds everything the customer can pay, whatever it comes to', async () => {
      const model = await modelPool({ modelClass: 'heavy' })
      const { workspaceId } = await funded({ tariff: 1000 })
      const taskId = await task(workspaceId, { modelClass: 'heavy' })
      await place(workspaceId, taskId)
      const rates: Rates = [{ rubPerCredit: '7.5' }]

      expect(await budget(model, taskId, 1, { rates })).toMatchObject({
        reserved: 1,
        customerLeftRub: '7500.0000000000',
        // 7500 + 46.50: no limit of 750 or 3 000 RUB any more.
        budgetRub: '7546.50',
      })

      // The pass spent 2 850 RUB.
      await worked(model, taskId, '2850')

      expect(await budget(model, taskId, 1, { rates })).toMatchObject({
        // 2850 ÷ 7.50.
        used: '380',
        // (1000 − 380) × 7.50.
        customerLeftRub: '4650.0000000000',
        budgetRub: '4696.50',
      })
    })

    it('case T: the third attempt of a chain', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      await worked(model, taskId, '225')
      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(10) })
      await worked(model, taskId, '225', { attempt: 2, occurredAt: minutesAfter(12) })
      await place(workspaceId, taskId, { attempt: 3, now: minutesAfter(20) })
      await worked(model, taskId, '225', { attempt: 3, occurredAt: minutesAfter(22) })

      expect(await budget(model, taskId, 3, { now: minutesAfter(30) })).toEqual({
        attempt: 3,
        chainAttempts: 3,
        reserved: 3,
        // Three times 37.5.
        used: '112.5',
        spendableNow: 297,
        debt: 0,
        // (3 + 297 − 112.5) × 6.00.
        customerLeftRub: '1125.0000000000',
        finishRub: FINISH,
        openReservedRub: NOTHING,
        budgetRub: '1171.50',
      })
    })

    it('treats the reserves of a chain as one pool: what the first attempt left is the second one’s', async () => {
      // A balance of 50: the task stops at 37, the customer continues — 13 credits are left.
      const { model, workspaceId, taskId } = await taskInWork({ tariff: 50 })
      await worked(model, taskId, '222')
      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(10) })

      expect(await budget(model, taskId, 2)).toMatchObject({
        attempt: 2,
        reserved: 2,
        used: '37',
        spendableNow: 48,
        // (2 + 48 − 37) × 6.00.
        customerLeftRub: '78.0000000000',
        // 78 + 46.50.
        budgetRub: '124.50',
      })
      // The first attempt, asked again, is bounded by the same customer.
      expect(await budget(model, taskId, 1)).toMatchObject({
        attempt: 1,
        customerLeftRub: '78.0000000000',
        budgetRub: '124.50',
      })
    })

    it('does not count calls the customer is not charged for against the customer', async () => {
      const { model, taskId } = await taskInWork()
      await worked(model, taskId, '60')
      await worked(model, taskId, '20', { estimateReason: 'aborted_platform' })
      await worked(model, taskId, '12', { turnNo: 2, turnStatus: 'lost' })
      // A turn whose pass ended in a failure (docs/plan/53, «Попробовать ещё (18.10)»).
      await worked(model, taskId, '10', { turnNo: 3, turnStatus: 'failed', turnRejected: true })

      expect(await budget(model, taskId)).toMatchObject({
        used: '10',
        // (300 − 10) × 6.00.
        customerLeftRub: '1740.0000000000',
        // 1740 + 46.50: a lost call and a rejected turn are not the customer's.
        budgetRub: '1786.50',
      })
    })

    it('takes nothing of the customer for a call the platform lost', async () => {
      const { model, taskId } = await taskInWork()
      await worked(model, taskId, '60')
      await worked(model, taskId, '2950', { estimateReason: 'aborted_platform' })

      expect(await budget(model, taskId)).toMatchObject({
        // (300 − 10) × 6.00: the lost call is not billable.
        customerLeftRub: '1740.0000000000',
        budgetRub: '1786.50',
      })
    })

    it('takes the reserves of the calls of the attempt that are still open off the key', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      const call = await worked(model, taskId, '60', { usageClosed: false })
      await openCall(model, call.keyId, '50')
      await openCall(model, call.keyId, '0.505')
      // An open call of another task and one of another attempt are not this attempt's.
      const other = await task(workspaceId)
      await place(workspaceId, other, { now: minutesAfter(1) })
      const elsewhere = await worked(model, other, '5', { usageClosed: false })
      await openCall(model, elsewhere.keyId, '70')

      expect(await budget(model, taskId)).toMatchObject({
        // The other task holds one credit: (1 + 298 − 10) × 6.00.
        customerLeftRub: '1734.0000000000',
        openReservedRub: '50.5050000000',
        // 1734 + 46.50 − 50.505 = 1729.995, rounded down to kopecks.
        budgetRub: '1729.99',
      })

      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(10) })
      expect(await budget(model, taskId, 2)).toMatchObject({
        openReservedRub: NOTHING,
      })
    })

    it('gives nothing when the open calls hold more than is left', async () => {
      const { model, taskId } = await taskInWork()
      const call = await worked(model, taskId, '225', { usageClosed: false })
      await openCall(model, call.keyId, '1700')

      expect(await budget(model, taskId)).toMatchObject({
        openReservedRub: '1700.0000000000',
        // 1575 + 46.50 − 1700 is below nothing.
        budgetRub: '0.00',
      })
    })

    it('takes the open calls off what the customer can pay', async () => {
      const model = await modelPool({ modelClass: 'heavy' })
      const { workspaceId } = await funded({ tariff: 1000 })
      const taskId = await task(workspaceId, { modelClass: 'heavy' })
      await place(workspaceId, taskId)
      const call = await worked(model, taskId, '0', { usageClosed: false })
      await openCall(model, call.keyId, '100')

      expect(await budget(model, taskId, 1, { rates: [{ rubPerCredit: '7.5' }] })).toMatchObject({
        openReservedRub: '100.0000000000',
        // 7500 + 46.50 − 100.
        budgetRub: '7446.50',
      })
    })

    it('rounds the budget down to kopecks', async () => {
      const { model, taskId } = await taskInWork()
      await worked(model, taskId, '100.005')

      expect(await budget(model, taskId)).toMatchObject({
        used: '16.6675',
        customerLeftRub: '1699.9950000000',
        // 1699.995 + 46.50.
        budgetRub: '1746.49',
      })
    })

    it('counts the work at the rate of each call and what is left at the rate of now', async () => {
      const { model, taskId } = await taskInWork()
      await worked(model, taskId, '60', { occurredAt: minutesAfter(5) })
      await worked(model, taskId, '60', { occurredAt: minutesAfter(15) })

      expect(await budget(model, taskId, 1, { rates: rateChange() })).toMatchObject({
        // 60 ÷ 6.00 + 60 ÷ 7.50.
        used: '18',
        // (300 − 18) × 7.50.
        customerLeftRub: '2115.0000000000',
        // 2115 + 46.50.
        budgetRub: '2161.50',
      })
      // Asked about a moment before the change, what is left is worth the old rate.
      expect(
        await budget(model, taskId, 1, { rates: rateChange(), now: minutesAfter(9) }),
      ).toMatchObject({
        used: '18',
        customerLeftRub: '1692.0000000000',
        budgetRub: '1738.50',
      })
    })

    it('counts as spendable now what a next attempt could take: gift and pack credits always, the tariff while it is paid', async () => {
      const model = await modelPool()
      // The accounts of another workspace are nobody's to count.
      await funded({ tariff: 300, gift: 7, pack: 9 })
      const numbers = async (status: 'active' | 'past_due' | null) => {
        const subscription = status === null ? null : { status, pastDueSince: NOW }
        const { workspaceId } = await funded({ tariff: 0, gift: 50, pack: 40, subscription })
        const taskId = await task(workspaceId)
        const { reserved } = await place(workspaceId, taskId)
        const { spendableNow } = await budget(model, taskId)
        return { reserved, spendableNow }
      }

      // The reserve stands on the gift; 49 of it are left free, and the pack.
      expect(await numbers('active')).toEqual({ reserved: 1, spendableNow: 89 })
      // No tariff, and one that is not paid: the pack is spent like the gift.
      expect(await numbers(null)).toEqual({ reserved: 1, spendableNow: 89 })
      expect(await numbers('past_due')).toEqual({ reserved: 1, spendableNow: 89 })

      // A tariff that ended before the one that is paid now says nothing about this one.
      const { workspaceId, plan } = await funded({
        tariff: 0,
        gift: 50,
        pack: 40,
        subscription: null,
      })
      await fixtures.subscription({
        workspaceId,
        planId: plan.id,
        status: 'expired',
        currentPeriodStart: new Date('2026-08-18T09:00:00Z'),
        currentPeriodEnd: new Date('2026-09-18T09:00:00Z'),
      })
      await fixtures.subscription({ workspaceId, planId: plan.id })
      const taskId = await task(workspaceId)
      await place(workspaceId, taskId)
      expect(await budget(model, taskId)).toMatchObject({ reserved: 1, spendableNow: 89 })
    })

    // What «Продолжить» would be allowed: P12 chooses between the question and «кредиты
    // закончились» by it, so it counts the day as a placement does.
    it('counts as spendable now no more tariff credits than the day has left', async () => {
      const model = await modelPool()
      const { workspaceId } = await funded({ creditsPerDay: 50 })
      const [first, second] = await Promise.all([task(workspaceId), task(workspaceId)])
      await place(workspaceId, first)
      expect(await budget(model, first)).toMatchObject({ reserved: 1, spendableNow: 49 })
      await place(workspaceId, second, { now: minutesAfter(1) })
      expect(await budget(model, first)).toMatchObject({ reserved: 1, spendableNow: 48 })
      // The next day in Moscow gives its fifty again.
      expect(
        await budget(model, first, 1, { now: new Date('2026-10-04T21:00:00.000Z') }),
      ).toMatchObject({ spendableNow: 50 })
    })

    it('answers a task that holds no reserve with nothing to spend', async () => {
      const model = await modelPool()
      const { workspaceId } = await funded()
      // Never reserved; given back; charged; not billable.
      const never = await task(workspaceId)
      const returned = await task(workspaceId)
      await place(workspaceId, returned)
      await worked(model, returned, '60')
      await db.$transaction((tx) => releaseTask(tx, { taskId: returned, now: minutesAfter(8) }))
      const charged = await task(workspaceId)
      await place(workspaceId, charged, { now: minutesAfter(1) })
      await worked(model, charged, '6')
      await ended(charged)
      await charge(charged)
      const free = await task(workspaceId, { billable: false })

      for (const taskId of [never, returned, charged, free]) {
        expect(await budget(model, taskId)).toMatchObject({
          reserved: 0,
          used: '0',
          customerLeftRub: NOTHING,
          finishRub: FINISH,
          budgetRub: '0.00',
        })
      }
    })

    it('refuses an attempt that holds no reserve of a task that holds one', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      const outside = { name: 'DomainError', code: 'CONFLICT', httpStatus: 409 }

      await expect(budget(model, taskId, 2)).rejects.toMatchObject({
        ...outside,
        message: 'The attempt holds no reserve of the task',
      })

      // After a retry the chain is the second attempt alone.
      await db.$transaction((tx) => releaseTask(tx, { taskId, now: minutesAfter(8) }))
      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(10), retry: true })
      await expect(budget(model, taskId, 1)).rejects.toMatchObject(outside)
      expect(await budget(model, taskId, 2)).toMatchObject({ attempt: 2, reserved: 1 })
    })

    // docs/plan/53, «Попробовать ещё (18.10)»: the work that built the kept candidate is charged
    // with the dialog, from the reserve of the retry, so it bounds the keys of the retry.
    it('bounds the keys of a retry by the work the kept candidate was built with', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      // A model of the class the retry runs in, at the price of the tests' model.
      const heavy = await modelPool({ modelClass: 'heavy' })
      // Turn 1 built the candidate for 240 RUB, 40 credits; the pass of turn 2 failed.
      await worked(model, taskId, '240', { turnNo: 1, turnStatus: 'completed' })
      await worked(model, taskId, '90', { turnNo: 2, turnStatus: 'failed', turnRejected: true })
      await db.$transaction((tx) => releaseTask(tx, { taskId, now: minutesAfter(8) }))
      await db.task.update({ where: { id: taskId }, data: { modelClass: 'heavy', attempt: 2 } })
      await place(workspaceId, taskId, { attempt: 2, now: minutesAfter(10), retry: true })

      expect(await budget(model, taskId, 2, { enabled: [heavy] })).toMatchObject({
        attempt: 2,
        chainAttempts: 1,
        reserved: 1,
        // Turn 1 alone: the failed pass is not the client's to pay.
        used: '40',
        // (1 + 299 − 40) × 6.00.
        customerLeftRub: '1560.0000000000',
        // 1560 + 46.50.
        budgetRub: '1606.50',
      })
    })

    it('takes the first call of the dearest enabled model of the class that has a price', async () => {
      const { model, workspaceId, taskId } = await taskInWork({ tariff: 12 })
      // 40 000 × 300 + 32 000 × 1 500, per million: 12 + 48.
      const dearer = await modelPool({}, { inputPer1m: '300', outputPer1m: '1500' })
      const heavy = await modelPool(
        { modelClass: 'heavy' },
        { inputPer1m: '900', outputPer1m: '4500' },
      )
      // Its price starts tomorrow: not in force at the moment asked about.
      const later = await modelPool(
        {},
        {
          effectiveFrom: new Date(LATER.getTime() + DAY_MS),
          inputPer1m: '900',
          outputPer1m: '4500',
        },
      )

      const one = await budget(model, taskId)
      expect(one).toMatchObject({ finishRub: FINISH, budgetRub: '118.50' })
      // A model that is switched off, one of another class and one without a price in force
      // change nothing.
      expect(await budget(model, taskId, 1, { enabled: [model, heavy, later] })).toEqual(one)
      expect(await budget(model, taskId, 1, { enabled: [model, dearer] })).toMatchObject({
        finishRub: '60.0000000000',
        // 72 + 60.
        budgetRub: '132.00',
      })
      expect(
        await budget(model, taskId, 1, { enabled: [dearer, model, heavy, later] }),
      ).toMatchObject({
        finishRub: '60.0000000000',
      })

      // The newest price in force is the one a call is costed with; the output reserved is the
      // model's own.
      const repriced: BudgetOptions = {
        given: async (tx) => {
          await tx.llmModelPrice.create({
            data: {
              modelId: model.pool.modelId,
              effectiveFrom: new Date('2026-01-01T12:00:00.000Z'),
              inputPer1m: '100',
              outputPer1m: '1000',
              vatRate: '0.2200',
              sourceUrl: 'https://rates.invalid/billing-verification',
            },
          })
          await tx.llmModel.update({
            where: { id: model.pool.modelId },
            data: { reserveOutputTokens: 16_000 },
          })
        },
        // A rate that covers the newer price.
        rates: [{ effectiveFrom: new Date('2026-01-02T00:00:00.000Z') }],
      }
      expect(await budget(model, taskId, 1, repriced)).toMatchObject({
        // 40 000 × 100 + 16 000 × 1 000, per million: 4 + 16.
        finishRub: '20.0000000000',
        budgetRub: '92.00',
      })
      expect(await reserve(taskId)).toEqual(['#1 tariff 1 active'])
      expect(await accounts(workspaceId)).toMatchObject({ tariff: account(12, 1) })
    })

    it('issues no number without a model of the class that has a price in force', async () => {
      const { model, taskId } = await taskInWork()
      const missing = { name: 'DomainError', code: 'LLM_PRICE_MISSING', httpStatus: 503 }
      const heavy = await modelPool({ modelClass: 'heavy' })
      const later = await modelPool({}, { effectiveFrom: new Date(LATER.getTime() + DAY_MS) })

      // No model is switched on; only one of another class; only one whose price starts later.
      await expect(budget(model, taskId, 1, { enabled: [] })).rejects.toMatchObject(missing)
      await expect(budget(model, taskId, 1, { enabled: [heavy] })).rejects.toMatchObject(missing)
      await expect(budget(model, taskId, 1, { enabled: [later] })).rejects.toMatchObject(missing)
    })

    // «Попробовать ещё» moves a dialog to `heavy`: the press asks first what the planner will
    // ask for its profile (docs/plan/53).
    it('says whether a pass of a class could run: the profile of the planner, with a price in force', async () => {
      const heavy = await modelPool({ modelClass: 'heavy' })
      const later = await modelPool(
        { modelClass: 'heavy' },
        { effectiveFrom: new Date(LATER.getTime() + DAY_MS) },
      )
      const backends = [heavy.pool.provider, later.pool.provider]
      /** The models switched on, with a provider model id, under providers switched on. */
      const priced = (
        enabled: readonly Model[],
        options: { providers?: readonly Model[]; providerModelId?: string | null } = {},
      ) =>
        inRolledBackTransaction(db, async (tx) => {
          const { providers = enabled, providerModelId = 'glm-5.3' } = options
          await tx.llmModel.updateMany({
            where: { id: { in: enabled.map(({ pool }) => pool.modelId) } },
            data: { enabled: true, providerModelId },
          })
          await tx.llmProvider.updateMany({
            where: { id: { in: providers.map(({ pool }) => pool.providerId) } },
            data: { enabled: true },
          })
          return modelClassPriced(tx, { modelClass: 'heavy', backends, now: LATER })
        })
      expect(await priced([heavy])).toBe(true)
      expect(await priced([later])).toBe(false)
      expect(await priced([])).toBe(false)
      // A price is not enough: the planner would refuse the pass `unavailable`.
      expect(await priced([heavy], { providers: [] })).toBe(false)
      expect(await priced([heavy], { providerModelId: null })).toBe(false)
      expect(
        await inRolledBackTransaction(db, async (tx) => {
          await tx.llmModel.update({
            where: { id: heavy.pool.modelId },
            data: { enabled: true, providerModelId: 'glm-5.3' },
          })
          await tx.llmProvider.update({
            where: { id: heavy.pool.providerId },
            data: { enabled: true },
          })
          // The provider is not a backend the caller runs.
          return modelClassPriced(tx, {
            modelClass: 'heavy',
            backends: ['billing-elsewhere'],
            now: LATER,
          })
        }),
      ).toBe(false)
    })

    it('issues no number without a usable credit rate', async () => {
      const { model, taskId } = await taskInWork()
      const missing = { name: 'DomainError', code: 'BILLING_CREDIT_RATE_MISSING', httpStatus: 503 }

      // No rate at all; a rate that has not started by the moment asked about.
      await expect(budget(model, taskId, 1, { rates: [] })).rejects.toMatchObject(missing)
      await expect(
        budget(model, taskId, 1, { rates: [{ effectiveFrom: minutesAfter(30) }] }),
      ).rejects.toMatchObject(missing)
      // A rate older than a price in force of an enabled model: its calls could not be counted.
      await expect(
        budget(model, taskId, 1, {
          given: async (tx) => {
            await tx.llmModelPrice.create({
              data: {
                modelId: model.pool.modelId,
                effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
                inputPer1m: '232.5',
                outputPer1m: '1162.5',
                vatRate: '0.2200',
                sourceUrl: 'https://rates.invalid/billing-verification',
              },
            })
          },
        }),
      ).rejects.toMatchObject(missing)
    })

    it('has no number while a call of the chain cannot be turned into credits', async () => {
      const { model, taskId } = await taskInWork()
      await worked(model, taskId, '60', { occurredAt: new Date('2025-12-31T23:59:59.999Z') })

      await expect(budget(model, taskId)).rejects.toMatchObject({
        ...conflict('not_convertible'),
        message: 'A model call of the task has no credit rate to count by',
      })
    })

    it('has no budget for a task without a class of its model, and finds no unknown task', async () => {
      const model = await modelPool()
      const { workspaceId } = await funded()
      const classless = await task(workspaceId, { modelClass: null })
      const service = await task(workspaceId, { modelClass: 'service' })

      for (const taskId of [classless, service]) {
        await expect(budget(model, taskId)).rejects.toMatchObject({
          code: 'CONFLICT',
          message: 'A task without a class of its model has no budget',
        })
      }
      await expect(budget(model, randomUUID())).rejects.toMatchObject(notFound)
    })

    it('leaves a hold of the rouble wallet alone', async () => {
      const model = await modelPool()
      const { workspaceId } = await funded()
      const taskId = await task(workspaceId)
      const wallet = await db.billingAccount.create({
        data: { workspaceId, unit: 'rub', balance: '600.00', held: '600.00' },
      })
      await db.creditHold.create({
        data: {
          accountId: wallet.id,
          unit: 'rub',
          taskId,
          amount: '600.00',
          expiresAt: new Date(NOW.getTime() + DAY_MS),
        },
      })

      await expect(budget(model, taskId)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'The hold of the task is not a hold of credits',
      })
    })

    it('only reads: it waits for no lock and writes nothing', async () => {
      const { model, workspaceId, taskId } = await taskInWork()
      await worked(model, taskId, '60')
      const before = await written(workspaceId)

      // Another transaction holds every lock a placement or a charge takes.
      const numbers = await db.$transaction(async (holder) => {
        await holder.$queryRaw`
          SELECT id FROM subscriptions WHERE workspace_id = ${workspaceId}::uuid FOR UPDATE`
        for (const kind of creditAccountKinds) await lockCreditAccount(holder, workspaceId, kind)
        await holder.$queryRaw`SELECT id FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`
        await holder.$queryRaw`SELECT id FROM credit_holds WHERE task_id = ${taskId}::uuid FOR UPDATE`
        return budget(model, taskId)
      }, patient)

      expect(numbers).toMatchObject({ reserved: 1, used: '10', budgetRub: '1786.50' })
      expect(await written(workspaceId)).toEqual(before)
    })
  })
})
