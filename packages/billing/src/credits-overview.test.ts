import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import { isDomainError, taskRefusalDetailsSchema, type TaskRefusalReason } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import { creditsOverviewSchema } from './dto.ts'
import { firstTaskCheck, newTaskCheck, releaseTask, settleTaskCharge } from './holds.ts'
import { grantPackCredits, grantSignupGift, grantTariffCredits } from './ledger.ts'
import { getCreditsOverview, getPromisedCreditsOverview } from './read-models.ts'
import { billingFixtures, underPrivateCreditRate } from './testing.ts'

// Whether a new task would be taken, as the settings pages read it: every reason of a refusal,
// its numbers, and that the queue answers the same task the same way.

const databaseUrl = process.env.DATABASE_URL
const WORKSPACE = '0199a000-0000-7000-8000-0000000000b7'
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
/** 15:00 in Moscow on 4 October 2026, inside the period of the fixtures' subscription. */
const NOW = new Date('2026-10-04T12:00:00.000Z')
const minutesAfter = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE_MS)

const ACCOUNT = { balance: 0, held: 0, available: 0 }
const overview = {
  tariff: { balance: 300, held: 45, available: 255 },
  gift: { balance: 35, held: 0, available: 35, granted: true },
  pack: ACCOUNT,
  totalAvailable: 290,
  spendable: 290,
  spendableNow: 40,
  setAside: 45,
  minToStart: 5,
  today: { limit: 50, charged: 0, held: 45, used: 45, room: 5, left: 5 },
  newTask: { allowed: true, reason: null },
}
const DAY = overview.today

describe('credits overview DTO', () => {
  it('accepts the three accounts with the answer about a new task', () => {
    expect(creditsOverviewSchema.parse(overview)).toEqual(overview)
  })

  it('accepts a day without a limit, a day past its limit and no day at all', () => {
    for (const today of [
      { limit: null, charged: 400, held: 45, used: 445, room: null, left: 255 },
      { limit: 50, charged: 120, held: 0, used: 120, room: 0, left: 0 },
      // the month has less than the day: the tariff gives what it has
      { limit: 50, charged: 0, held: 0, used: 0, room: 50, left: 20 },
      null,
    ]) {
      expect(creditsOverviewSchema.parse({ ...overview, today }).today).toEqual(today)
    }
  })

  it.each([
    ['a total that is not the sum of the accounts', { totalAvailable: 289 }],
    [
      'an account whose free credits are not its balance less what is held',
      { pack: { ...ACCOUNT, available: 1 }, totalAvailable: 291 },
    ],
    ['an overview that does not say what a task could spend', { spendable: undefined }],
    ['an overview that does not say what is set aside', { setAside: undefined }],
    ['a new task that needs no credits', { minToStart: 0 }],
    ['an overview that does not say what a task could take now', { spendableNow: undefined }],
    ['an overview without the day a task is checked by', { today: undefined }],
    ['a day of tasks', { today: { used: 0, limit: 5 } }],
    ['a daily limit of no credits', { today: { ...DAY, limit: 0, room: 0, left: 0 } }],
    ['a day whose parts do not add up', { today: { ...DAY, used: 44 } }],
    ['a room that is not what is left of the day', { today: { ...DAY, room: 6 } }],
    ['a limit without a room', { today: { ...DAY, room: null } }],
    ['a room without a limit', { today: { ...DAY, limit: null } }],
    ['more left for today than the day has', { today: { ...DAY, left: 6 } }],
    ['a day of fractions', { today: { ...DAY, held: 44.5, used: 44.5 } }],
    ['an overview without the answer about a new task', { newTask: undefined }],
    ['a task that is taken for a reason', { newTask: { allowed: true, reason: 'held' } }],
    ['a task that is refused without a reason', { newTask: { allowed: false, reason: null } }],
    ['a reason no task is refused by', { newTask: { allowed: false, reason: 'no_credits' } }],
  ])('refuses %s', (_case, patch) => {
    expect(creditsOverviewSchema.safeParse({ ...overview, ...patch }).success).toBe(false)
  })
})

describe('the check of a new task without a database', () => {
  // A refused input never reaches the database: this client would throw a TypeError there.
  const db = {} as Parameters<typeof newTaskCheck>[0]

  it('refuses a workspace that is not one, a moment that is not one and an unknown field', async () => {
    const input = { workspaceId: WORKSPACE, now: NOW }
    for (const broken of [
      { ...input, workspaceId: 'ws' },
      { ...input, now: new Date(Number.NaN) },
      { ...input, taskId: WORKSPACE },
    ]) {
      await expect(newTaskCheck(db, broken)).rejects.toBeInstanceOf(ZodError)
    }
    for (const broken of [
      { giftCredits: -1, now: NOW },
      { giftCredits: 0.5, now: NOW },
      { giftCredits: 35, now: NOW, workspaceId: WORKSPACE },
    ]) {
      await expect(firstTaskCheck(db, broken)).rejects.toBeInstanceOf(ZodError)
    }
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL credits overview', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  const patient = { maxWait: 15_000, timeout: 30_000 }
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /**
   * A workspace on a tariff of 300 credits a month without a daily limit unless told otherwise
   * (`plan: { creditsPerDay }`), active for September 2026 unless told otherwise —
   * `subscription: null` for none —, with `tariff`, `gift` and `pack` credits on its accounts.
   */
  async function funded(
    options: {
      tariff?: number
      gift?: boolean
      pack?: number
      plan?: Partial<Prisma.PlanUncheckedCreateInput>
      subscription?: Partial<Parameters<typeof fixtures.subscription>[0]> | null
    } = {},
  ) {
    const { tariff = 300, gift = false, pack = 0 } = options
    const { userId, workspaceId } = await fixtures.workspace()
    const plan = await fixtures.plan({ creditsPerMonth: 300, ...options.plan })
    const subscription =
      options.subscription === null
        ? null
        : await fixtures.subscription({ workspaceId, planId: plan.id, ...options.subscription })
    if (tariff > 0) {
      const order = await fixtures.order({ workspaceId, planId: plan.id })
      await db.$transaction((tx) =>
        grantTariffCredits(tx, { workspaceId, orderId: order.id, credits: tariff }),
      )
    }
    if (gift) await db.$transaction((tx) => grantSignupGift(tx, { userId, workspaceId }))
    if (pack > 0) {
      const packPlan = await fixtures.plan({
        kind: 'pack',
        price: '1990.00',
        creditsPerMonth: null,
        maxSites: null,
        packCredits: pack,
      })
      const order = await fixtures.order({
        workspaceId,
        planId: packPlan.id,
        kind: 'pack',
        amount: '1990.00',
      })
      await db.$transaction((tx) =>
        grantPackCredits(tx, { workspaceId, orderId: order.id, credits: pack }),
      )
    }
    return { userId, workspaceId, subscription }
  }

  const task = async (workspaceId: string) => (await fixtures.task(workspaceId)).taskId
  const placement = (workspaceId: string, taskId: string, now: Date) => ({
    workspaceId,
    taskId,
    attempt: 1,
    now,
    expiresAt: new Date(now.getTime() + DAY_MS),
  })
  const place = (workspaceId: string, taskId: string, now = NOW) =>
    fixtures.reserve(placement(workspaceId, taskId, now))
  const charge = (taskId: string, credits: number, now = minutesAfter(5)) =>
    db.$transaction((tx) => settleTaskCharge(tx, { taskId, credits, now }))
  const release = (taskId: string, now = minutesAfter(5)) =>
    db.$transaction((tx) => releaseTask(tx, { taskId, now }))
  /** A task that is queued at `now` and done for `credits` five minutes later. */
  async function done(workspaceId: string, credits: number, now = NOW) {
    const taskId = await task(workspaceId)
    await place(workspaceId, taskId, now)
    await charge(taskId, credits, new Date(now.getTime() + 5 * MINUTE_MS))
  }
  /** A failed task whose model calls cost `costRub`: work that was never charged. */
  async function failedAfter(workspaceId: string, costRub: string, now = NOW) {
    const taskId = await task(workspaceId)
    await place(workspaceId, taskId, now)
    const pool = await fixtures.modelPool()
    const price = await fixtures.modelPrice(pool, {
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    })
    await fixtures.modelCall({
      taskId,
      pool,
      priceId: price.id,
      costRub,
      occurredAt: new Date(now.getTime() + MINUTE_MS),
    })
    await release(taskId, new Date(now.getTime() + 2 * MINUTE_MS))
  }

  /** The overview as a page reads it, with a credit rate in force that nobody else sees. */
  const overviewAt = (workspaceId: string, now = minutesAfter(30)) =>
    db.$transaction(
      (tx) => underPrivateCreditRate(tx, () => getCreditsOverview(tx, { workspaceId, now })),
      patient,
    )

  /**
   * What the queue answers to a new task of the workspace at the same moment: «taken», or the
   * reason and the numbers of its refusal. The reserve it places is given back at once.
   */
  async function queueAt(workspaceId: string, now = minutesAfter(30)) {
    const taskId = await task(workspaceId)
    try {
      await place(workspaceId, taskId, now)
    } catch (error) {
      if (!isDomainError(error)) throw error
      return taskRefusalDetailsSchema.parse(error.details)
    }
    await release(taskId, now)
    return 'taken' as const
  }

  /**
   * The page and the queue say the same of a new task: both take it, or refuse by one reason.
   * `spendableNow` is what a task could take now — `spendable` unless the day of the tariff
   * holds it back —, and `day` what a refusal by the day tells of it.
   */
  async function expectAgreement(
    workspaceId: string,
    expected: {
      reason: TaskRefusalReason | null
      spendable: number
      setAside: number
      spendableNow?: number
      day?: { limit: number; used: number }
    },
    now = minutesAfter(30),
  ) {
    const { day, ...numbers } = expected
    const spendableNow = expected.spendableNow ?? expected.spendable
    const read = await overviewAt(workspaceId, now)
    expect({
      reason: read.newTask.reason,
      allowed: read.newTask.allowed,
      spendable: read.spendable,
      spendableNow: read.spendableNow,
      setAside: read.setAside,
      minToStart: read.minToStart,
    }).toEqual({ ...numbers, spendableNow, allowed: expected.reason === null, minToStart: 5 })
    const answered = await queueAt(workspaceId, now)
    if (expected.reason === null) {
      expect(answered).toBe('taken')
    } else {
      expect(answered).toEqual({
        reason: expected.reason,
        spendable: expected.spendable,
        held: expected.setAside,
        needed: 5,
        ...(expected.reason === 'daily_limit' ? { spendableNow, day } : {}),
      })
    }
    return read
  }

  describe('on a paid tariff', () => {
    it('takes a task while credits can be spent: those of the tariff, the gift and a pack', async () => {
      const { workspaceId } = await funded({ gift: true, pack: 100 })

      const read = await expectAgreement(workspaceId, { reason: null, spendable: 435, setAside: 0 })

      expect(read).toEqual({
        tariff: { balance: 300, held: 0, available: 300 },
        gift: { balance: 35, held: 0, available: 35, granted: true },
        pack: { balance: 100, held: 0, available: 100 },
        totalAvailable: 435,
        spendable: 435,
        spendableNow: 435,
        setAside: 0,
        minToStart: 5,
        // a plan without a daily limit: the day is counted, and nothing caps it
        today: { limit: null, charged: 0, held: 0, used: 0, room: null, left: 300 },
        newTask: { allowed: true, reason: null },
      })
    })

    it('tells that the credits ran out: nothing is left on any account', async () => {
      const { workspaceId } = await funded({ tariff: 0 })

      await expectAgreement(workspaceId, { reason: 'empty', spendable: 0, setAside: 0 })
    })

    it('tells that fewer credits are left than a new task needs', async () => {
      const { workspaceId } = await funded({ tariff: 3 })

      await expectAgreement(workspaceId, { reason: 'below_start', spendable: 3, setAside: 0 })
    })

    it('tells that the credits are set aside for tasks in work, and how many', async () => {
      const { workspaceId } = await funded({ tariff: 47 })
      await place(workspaceId, await task(workspaceId))

      // 45 set aside, 2 free: not enough for a new task, and enough once the task in work ends.
      await expectAgreement(workspaceId, { reason: 'held', spendable: 2, setAside: 45 })
    })

    it('tells that the tariff credits of the day are taken', async () => {
      const { workspaceId } = await funded({ plan: { creditsPerDay: 10 } })
      // The first sets the ten of the day aside and is charged five; the second takes the five
      // left.
      await done(workspaceId, 5, minutesAfter(0))
      await done(workspaceId, 5, minutesAfter(10))

      const read = await expectAgreement(workspaceId, {
        reason: 'daily_limit',
        spendable: 290,
        setAside: 0,
        spendableNow: 0,
        day: { limit: 10, used: 10 },
      })
      expect(read.today).toEqual({ limit: 10, charged: 10, held: 0, used: 10, room: 0, left: 0 })

      // Tomorrow, by the Moscow calendar, a task is taken again.
      const tomorrow = new Date('2026-10-04T21:00:00.000Z')
      const next = await expectAgreement(
        workspaceId,
        { reason: null, spendable: 290, setAside: 0, spendableNow: 10 },
        tomorrow,
      )
      expect(next.today).toEqual({ limit: 10, charged: 0, held: 0, used: 0, room: 10, left: 10 })
    })

    it('takes a task on a pack when the tariff credits of the day are taken', async () => {
      const { workspaceId } = await funded({ pack: 100, plan: { creditsPerDay: 10 } })
      await done(workspaceId, 10, minutesAfter(0))

      const read = await expectAgreement(workspaceId, {
        reason: null,
        spendable: 390,
        setAside: 0,
        spendableNow: 100,
      })
      expect(read.today).toEqual({ limit: 10, charged: 10, held: 0, used: 10, room: 0, left: 0 })
    })

    it('tells that too much work of the period ended without a charge', async () => {
      // A tariff of 50 credits a month: 300 RUB of work at 6 RUB a credit.
      const { workspaceId } = await funded({ plan: { creditsPerMonth: 50 } })
      await failedAfter(workspaceId, '300')

      const read = await expectAgreement(workspaceId, {
        reason: 'unpaid_limit',
        spendable: 300,
        setAside: 0,
      })
      // The failed attempt gave its reserve back, and the day with it.
      expect(read.today).toEqual({
        limit: null,
        charged: 0,
        held: 0,
        used: 0,
        room: null,
        left: 300,
      })
    })

    it('says the credits first, then the day, then the unpaid work', async () => {
      const { workspaceId } = await funded({
        tariff: 9,
        plan: { creditsPerMonth: 50, creditsPerDay: 5 },
      })
      // A task of the day failed after 300 RUB of work — 50 credits, the bound of this tariff —
      // and gave its reserve back; another, queued earlier today, holds one credit of the day:
      // four are left of it. The day is said before the unpaid work.
      await failedAfter(workspaceId, '300')
      const inWork = await fixtures.hold(workspaceId, 'tariff', 1)
      await db.creditHold.update({
        where: { id: inWork.id },
        data: { createdAt: NOW, placedAt: NOW },
      })
      await expectAgreement(workspaceId, {
        reason: 'daily_limit',
        spendable: 8,
        setAside: 1,
        spendableNow: 4,
        day: { limit: 5, used: 1 },
      })
      // Tomorrow the day is free, and the unpaid work is what refuses.
      const tomorrow = new Date('2026-10-04T21:00:00.000Z')
      await expectAgreement(
        workspaceId,
        { reason: 'unpaid_limit', spendable: 8, setAside: 1, spendableNow: 5 },
        tomorrow,
      )

      // With three credits free on the account, the credits are said before either.
      await db.billingAccount.updateMany({
        where: { workspaceId, unit: 'credit_tariff' },
        data: { balance: 4 },
      })
      await expectAgreement(workspaceId, {
        reason: 'below_start',
        spendable: 3,
        setAside: 1,
        spendableNow: 3,
      })
      await expectAgreement(
        workspaceId,
        { reason: 'below_start', spendable: 3, setAside: 1, spendableNow: 3 },
        tomorrow,
      )
    })
  })

  describe('without a paid tariff', () => {
    it('takes a task on the gift of the registration', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: true, subscription: null })

      await expectAgreement(workspaceId, { reason: null, spendable: 35, setAside: 0 })
    })

    it('tells that the gift is used up, and that less of it is left than a task needs', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: true, subscription: null })
      await done(workspaceId, 32)

      await expectAgreement(workspaceId, { reason: 'gift_below_start', spendable: 3, setAside: 0 })

      // Once the last three are gone as well — the account is set to what that leaves.
      await db.billingAccount.updateMany({
        where: { workspaceId, unit: 'credit_gift' },
        data: { balance: 0 },
      })
      const read = await expectAgreement(workspaceId, {
        reason: 'gift_spent',
        spendable: 0,
        setAside: 0,
      })
      // Granted and gone: the page tells it apart from a gift that never was.
      expect(read.gift).toEqual({ balance: 0, held: 0, available: 0, granted: true })
    })

    it('answers «used up» for a workspace the gift was never granted to; the page tells them apart by the account', async () => {
      const { workspaceId } = await funded({ tariff: 0, subscription: null })

      const read = await expectAgreement(workspaceId, {
        reason: 'gift_spent',
        spendable: 0,
        setAside: 0,
      })

      expect(read.gift).toEqual({ balance: 0, held: 0, available: 0, granted: false })
    })

    it('tells that the gift is set aside for the task in work', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: true, subscription: null })
      await place(workspaceId, await task(workspaceId))

      await expectAgreement(workspaceId, { reason: 'held', spendable: 0, setAside: 35 })
    })

    it('has no day: tasks are taken while the gift lasts', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: true, subscription: null })
      for (const minute of [0, 10, 20, 30]) await done(workspaceId, 5, minutesAfter(minute))

      const read = await expectAgreement(workspaceId, { reason: null, spendable: 15, setAside: 0 })
      expect(read.today).toBeNull()
    })

    it('tells that the trial is over: 70 credits of work ended without a charge', async () => {
      const { workspaceId } = await funded({ tariff: 0, gift: true, subscription: null })
      // The bound is counted from the creation of the workspace.
      await db.workspace.update({
        where: { id: workspaceId },
        data: { createdAt: new Date('2026-10-01T00:00:00.000Z') },
      })
      await failedAfter(workspaceId, '420')

      await expectAgreement(workspaceId, {
        reason: 'trial_unpaid_limit',
        spendable: 35,
        setAside: 0,
      })
    })

    it('tells that the tariff is not paid, while the gift cannot carry a task', async () => {
      const { workspaceId } = await funded({ pack: 100, subscription: { status: 'past_due' } })

      // Credits of an unpaid tariff and of a pack are not spent, and are not «in work» either.
      const read = await expectAgreement(workspaceId, {
        reason: 'past_due',
        spendable: 0,
        setAside: 0,
      })
      expect(read.totalAvailable).toBe(400)
      // An overdue tariff takes tasks as a workspace without one does: no day, the gift.
      expect(read.today).toBeNull()
    })

    it('takes a task on the gift while the tariff is not paid', async () => {
      const { workspaceId } = await funded({ gift: true, subscription: { status: 'past_due' } })

      await expectAgreement(workspaceId, { reason: null, spendable: 35, setAside: 0 })
    })

    it('tells that credits of a pack wait for a tariff once the tariff has ended', async () => {
      const { workspaceId } = await funded({
        tariff: 0,
        pack: 40,
        subscription: { status: 'cancelled' },
      })

      await expectAgreement(workspaceId, { reason: 'ended', spendable: 0, setAside: 0 })
    })
  })

  describe('the credit rate', () => {
    it('refuses every task while no rate is in force, whatever the credits are', async () => {
      const { workspaceId } = await funded({ gift: true })

      // Read as the page reads it, on a database that has no rate.
      const read = await getCreditsOverview(db, { workspaceId, now: NOW })

      expect(read).toMatchObject({
        spendable: 335,
        setAside: 0,
        minToStart: 5,
        newTask: { allowed: false, reason: 'rate_missing' },
      })
      expect(await newTaskCheck(db, { workspaceId, now: NOW })).toEqual({
        spendable: 335,
        spendableNow: 335,
        held: 0,
        needed: 5,
        allowed: false,
        reason: 'rate_missing',
        today: { limit: null, charged: 0, held: 0, used: 0, room: null, left: 300 },
      })
    })

    it('says the rate before the credits', async () => {
      const { workspaceId } = await funded({ tariff: 0 })

      const read = await getCreditsOverview(db, { workspaceId, now: NOW })

      expect(read.newTask).toEqual({ allowed: false, reason: 'rate_missing' })
    })
  })

  describe('a user without a workspace', () => {
    const promisedAt = (giftGranted: boolean) =>
      db.$transaction(
        (tx) =>
          underPrivateCreditRate(tx, () =>
            getPromisedCreditsOverview(tx, { giftGranted, now: NOW }),
          ),
        patient,
      )

    it('is promised the gift, and the first task would be taken on it', async () => {
      expect(await promisedAt(false)).toEqual({
        tariff: ACCOUNT,
        gift: { balance: 35, held: 0, available: 35, granted: false },
        pack: ACCOUNT,
        totalAvailable: 35,
        spendable: 35,
        spendableNow: 35,
        setAside: 0,
        minToStart: 5,
        today: null,
        newTask: { allowed: true, reason: null },
      })
    })

    it('is promised nothing once the gift stands in the ledger', async () => {
      expect(await promisedAt(true)).toMatchObject({
        gift: { balance: 0, held: 0, available: 0, granted: false },
        spendable: 0,
        newTask: { allowed: false, reason: 'gift_spent' },
      })
    })

    it('is told that no task is taken while no rate is in force', async () => {
      expect(await getPromisedCreditsOverview(db, { giftGranted: false, now: NOW })).toMatchObject({
        spendable: 35,
        newTask: { allowed: false, reason: 'rate_missing' },
      })
    })
  })

  it('writes nothing: a workspace without accounts is read as it is', async () => {
    const { workspaceId } = await funded({ tariff: 0, subscription: null })

    await overviewAt(workspaceId)

    // A placement would make the three accounts; a page that asks leaves none.
    expect(await db.billingAccount.count({ where: { workspaceId } })).toBe(0)
  })
})
