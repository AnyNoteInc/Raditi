import { randomUUID } from 'node:crypto'

import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import { taskCharge } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  creditRateAt,
  creditRateStatus,
  requireUsableCreditRate,
  taskRawCredits,
} from './credit-rate.ts'
import {
  inRolledBackTransaction,
  writeCreditRate,
  writeModelCall,
  writeModelPool,
  writeModelPrice,
  type TestModelPool,
} from './testing.ts'

const databaseUrl = process.env.DATABASE_URL

type Tx = Prisma.TransactionClient

// The suite lives in 2001 and commits nothing. A row of `credit_rates` is the rate of the whole
// database, so every row here is written inside a transaction that is rolled back: no other
// suite sees it and no database keeps it. And nothing real starts before the suite's moments —
// neither a rate nor a price of a model somebody switched on —, so what the functions read is
// what the test wrote, on a developer's database as on a disposable one.
const T1 = new Date('2001-03-01T09:00:00.000Z')
const T2 = new Date('2001-04-01T09:00:00.000Z')
const T3 = new Date('2001-05-01T09:00:00.000Z')
const BEFORE = new Date('2001-02-01T09:00:00.000Z')
const HOUR = 3_600_000
const after = (moment: Date, ms = HOUR) => new Date(moment.getTime() + ms)

describe.skipIf(!databaseUrl)('the credit rate with PostgreSQL', () => {
  let db: PrismaClient

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  const rolledBack = <T>(work: (tx: Tx) => Promise<T>) => inRolledBackTransaction(db, work)

  /** A workspace with one site, uncommitted. */
  async function workspaceIn(tx: Tx): Promise<{ workspaceId: string; siteId: string }> {
    const workspace = await tx.workspace.create({ data: { name: 'Credit rate verification' } })
    const site = await tx.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Credit rate verification',
        url: `https://${randomUUID()}.example.ru`,
        stack: 'wordpress',
      },
    })
    return { workspaceId: workspace.id, siteId: site.id }
  }

  /** A task of a workspace of its own, or of the one given. */
  async function taskIn(
    tx: Tx,
    data: Partial<Prisma.TaskUncheckedCreateInput> = {},
    workspace?: { workspaceId: string; siteId: string },
  ): Promise<{ taskId: string; workspaceId: string; siteId: string }> {
    const { workspaceId, siteId } = workspace ?? (await workspaceIn(tx))
    const task = await tx.task.create({ data: { workspaceId, siteId, ...data } })
    return { taskId: task.id, workspaceId, siteId }
  }

  /** A model with one price row that starts at `from`. */
  async function pricedPool(
    tx: Tx,
    from: Date,
    enabled = false,
  ): Promise<{ pool: TestModelPool; priceId: string }> {
    const pool = await writeModelPool(tx, { enabled })
    const price = await writeModelPrice(tx, pool, { effectiveFrom: from })
    return { pool, priceId: price.id }
  }

  describe('creditRateAt', () => {
    it('answers null while no rate has started', async () => {
      await rolledBack(async (tx) => {
        expect(await creditRateAt(tx, BEFORE)).toBeNull()
        await writeCreditRate(tx, { effectiveFrom: T1 })
        expect(await creditRateAt(tx, new Date(T1.getTime() - 1))).toBeNull()
      })
    })

    it('answers the row with the greatest start that is not later than the moment', async () => {
      await rolledBack(async (tx) => {
        const first = await writeCreditRate(tx, { effectiveFrom: T1, rubPerCredit: '6.000000' })
        const second = await writeCreditRate(tx, { effectiveFrom: T2, rubPerCredit: '7.5' })

        // The start itself belongs to the rate.
        expect(await creditRateAt(tx, T1)).toEqual({
          id: first.id,
          effectiveFrom: T1,
          rubPerCredit: '6.000000',
          basis: 'Billing verification',
        })
        expect((await creditRateAt(tx, new Date(T2.getTime() - 1)))?.id).toBe(first.id)
        expect(await creditRateAt(tx, T2)).toMatchObject({
          id: second.id,
          // As the column prints it, with its six decimals.
          rubPerCredit: '7.500000',
        })
        expect((await creditRateAt(tx, T3))?.id).toBe(second.id)
      })
    })

    it('refuses a moment that is not a date', async () => {
      await expect(creditRateAt(db, new Date(Number.NaN))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
    })
  })

  describe('the usable rate', () => {
    const refused = { code: 'BILLING_CREDIT_RATE_MISSING', httpStatus: 503 }

    it('is missing while no rate is in force, and a reserve gets the typed error', async () => {
      await rolledBack(async (tx) => {
        expect(await creditRateStatus(tx, T2)).toEqual({ verdict: 'missing', rate: null })
        await expect(requireUsableCreditRate(tx, T2)).rejects.toMatchObject(refused)

        // A rate that starts later is not in force yet.
        await writeCreditRate(tx, { effectiveFrom: T3 })
        expect(await creditRateStatus(tx, T2)).toEqual({ verdict: 'missing', rate: null })
        await expect(requireUsableCreditRate(tx, T2)).rejects.toMatchObject(refused)
      })
    })

    it('is usable with a rate in force and no enabled model', async () => {
      await rolledBack(async (tx) => {
        const rate = await writeCreditRate(tx, { effectiveFrom: T1 })
        // A model that is not switched on does not count, whatever its prices are.
        await pricedPool(tx, T2, false)

        expect(await creditRateStatus(tx, T3)).toMatchObject({
          verdict: 'usable',
          rate: { id: rate.id, rubPerCredit: '6.000000' },
        })
        expect(await requireUsableCreditRate(tx, T3)).toMatchObject({ id: rate.id })
      })
    })

    it('is usable when the rate started with the newest price of the enabled models or later', async () => {
      await rolledBack(async (tx) => {
        const { pool } = await pricedPool(tx, T1, true)
        // One instant for the prices and the rate, as `approveCreditRate` writes them.
        const rate = await writeCreditRate(tx, { effectiveFrom: T1 })
        expect(await requireUsableCreditRate(tx, T1)).toMatchObject({ id: rate.id })

        // A price that starts later is not in force yet: the rate stays usable until it is.
        await writeModelPrice(tx, pool, { effectiveFrom: T3 })
        expect((await creditRateStatus(tx, new Date(T3.getTime() - 1))).verdict).toBe('usable')
      })
    })

    it('is stale once a price of an enabled model has started after the rate', async () => {
      await rolledBack(async (tx) => {
        const rate = await writeCreditRate(tx, { effectiveFrom: T1 })
        const { pool } = await pricedPool(tx, T1, true)
        await writeModelPrice(tx, pool, { effectiveFrom: T2 })

        // The rate in force is told with the verdict: it is there, and it is too old.
        expect(await creditRateStatus(tx, T2)).toMatchObject({
          verdict: 'stale',
          rate: { id: rate.id },
        })
        await expect(requireUsableCreditRate(tx, T2)).rejects.toMatchObject(refused)

        // A rate with the instant of that price makes credits reservable again.
        const next = await writeCreditRate(tx, { effectiveFrom: T2, rubPerCredit: '5.000000' })
        expect(await requireUsableCreditRate(tx, T2)).toMatchObject({
          id: next.id,
          rubPerCredit: '5.000000',
        })
      })
    })

    it('stays stale when the model also has a price that has not started yet', async () => {
      await rolledBack(async (tx) => {
        await writeCreditRate(tx, { effectiveFrom: T1 })
        const { pool } = await pricedPool(tx, T1, true)
        // In force and newer than the rate — and one more row that starts later still.
        await writeModelPrice(tx, pool, { effectiveFrom: T2 })
        await writeModelPrice(tx, pool, { effectiveFrom: T3 })

        // The row that is not in force yet does not hide the one that is.
        expect((await creditRateStatus(tx, new Date(T3.getTime() - 1))).verdict).toBe('stale')
        expect((await creditRateStatus(tx, new Date(T2.getTime() - 1))).verdict).toBe('usable')
      })
    })

    it('reads the switch of the model, not of anything else', async () => {
      await rolledBack(async (tx) => {
        await writeCreditRate(tx, { effectiveFrom: T1 })
        const { pool } = await pricedPool(tx, T2, false)
        expect((await creditRateStatus(tx, T3)).verdict).toBe('usable')

        // Switched on, the same price row makes the rate stale; the provider stays off.
        await tx.llmModel.update({ where: { id: pool.modelId }, data: { enabled: true } })
        expect((await creditRateStatus(tx, T3)).verdict).toBe('stale')
      })
    })
  })

  describe('taskRawCredits', () => {
    it('converts each call at the rate of its own start across a change of the rate', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, T1)
        await writeCreditRate(tx, { effectiveFrom: T1, rubPerCredit: '6.000000' })
        await writeCreditRate(tx, { effectiveFrom: T2, rubPerCredit: '5.000000' })
        const call = { taskId, pool, priceId, costRub: '60' }
        await writeModelCall(tx, { ...call, occurredAt: after(T1) })
        await writeModelCall(tx, { ...call, occurredAt: after(T2) })

        const raw = await taskRawCredits(tx, { taskId, attempts: [1] })

        // 60 ÷ 6 + 60 ÷ 5: one attempt that worked under two rates.
        if (!raw.convertible) throw new Error('The calls must be convertible')
        expect(raw.credits.toFixed(10)).toBe('22.0000000000')
        expect(raw.costRub).toBe('120.0000000000')
        expect(raw.attempts.map((entry) => [entry.attempt, entry.costRub])).toEqual([
          [1, '120.0000000000'],
        ])
        expect(raw.attempts[0]?.credits.toFixed(4)).toBe('22.0000')
        // Not what one rate for the whole attempt would give: 120 ÷ 6 = 20, 120 ÷ 5 = 24.
        expect(taskCharge({ used: raw.credits }).credits).toBe(22)
      })
    })

    it('gives the call that starts at the instant of a new rate the new rate', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, T1)
        await writeCreditRate(tx, { effectiveFrom: T1, rubPerCredit: '6.000000' })
        await writeCreditRate(tx, { effectiveFrom: T2, rubPerCredit: '3.000000' })
        const call = { taskId, pool, priceId, costRub: '6' }

        await writeModelCall(tx, { ...call, occurredAt: new Date(T2.getTime() - 1) })
        const earlier = await taskRawCredits(tx, { taskId, attempts: [1] })
        expect(earlier.convertible && earlier.credits.toFixed(2)).toBe('1.00')

        await writeModelCall(tx, { ...call, occurredAt: T2 })
        const both = await taskRawCredits(tx, { taskId, attempts: [1] })
        expect(both.convertible && both.credits.toFixed(2)).toBe('3.00')
      })
    })

    it('rounds nothing: three calls of 14, 14 and 17 RUB at 6.00 are 7.5 credits', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, T1)
        await writeCreditRate(tx, { effectiveFrom: T1 })
        for (const [index, costRub] of ['14', '14', '17'].entries()) {
          await writeModelCall(tx, {
            taskId,
            pool,
            priceId,
            costRub,
            occurredAt: after(T1, index + 1),
          })
        }

        const raw = await taskRawCredits(tx, { taskId, attempts: [1] })

        if (!raw.convertible) throw new Error('The calls must be convertible')
        // Divided one by one they would add up to 7.4999…9; summed first they are 7.5, charged 8.
        expect(raw.credits.eq('7.5')).toBe(true)
        expect(taskCharge({ used: raw.credits }).credits).toBe(8)
      })
    })

    it('keeps the ten decimals of the recorded cost', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, T1)
        await writeCreditRate(tx, { effectiveFrom: T1 })
        await writeModelCall(tx, {
          taskId,
          pool,
          priceId,
          costRub: '22.0875000001',
          occurredAt: after(T1),
        })

        const raw = await taskRawCredits(tx, { taskId, attempts: [1] })

        if (!raw.convertible) throw new Error('The calls must be convertible')
        expect(raw.costRub).toBe('22.0875000001')
        expect(raw.credits.toFixed(12)).toBe('3.681250000017')
      })
    })

    it('leaves out the rows that are not billable and counts the estimates that are', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, T1)
        await writeCreditRate(tx, { effectiveFrom: T1 })
        const call = { taskId, pool, priceId, occurredAt: after(T1) }
        await writeModelCall(tx, { ...call, costRub: '60' })
        // The platform's fault: recorded, never charged.
        const lost = await writeModelCall(tx, { ...call, costRub: '48', estimateReason: 'lost' })
        const aborted = await writeModelCall(tx, {
          ...call,
          costRub: '36',
          estimateReason: 'aborted_platform',
        })
        // Estimates that are the client's or the provider's stay billable.
        const cut = await writeModelCall(tx, {
          ...call,
          costRub: '12',
          estimateReason: 'aborted_client',
        })
        const silent = await writeModelCall(tx, {
          ...call,
          costRub: '6',
          estimateReason: 'no_usage',
        })
        expect([lost.billable, aborted.billable, cut.billable, silent.billable]).toEqual([
          false,
          false,
          true,
          true,
        ])

        const raw = await taskRawCredits(tx, { taskId, attempts: [1] })

        // (60 + 12 + 6) ÷ 6.
        expect(raw).toMatchObject({ convertible: true, costRub: '78.0000000000' })
        expect(raw.convertible && raw.credits.toFixed(2)).toBe('13.00')
      })
    })

    it('leaves out the rows of a key whose turn ended lost', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, T1)
        await writeCreditRate(tx, { effectiveFrom: T1 })
        const call = { taskId, pool, priceId, occurredAt: after(T1) }
        // Billable rows, both: only the turn says that the first was the platform's loss.
        const first = await writeModelCall(tx, {
          ...call,
          turnNo: 1,
          costRub: '90',
          turnStatus: 'lost',
        })
        await writeModelCall(tx, { ...call, turnNo: 1, costRub: '30' })
        await writeModelCall(tx, { ...call, turnNo: 2, costRub: '60', turnStatus: 'completed' })
        await writeModelCall(tx, { ...call, turnNo: 3, costRub: '24', turnStatus: 'failed' })
        // A key without a turn row, as every key before the task queue writes turns.
        await writeModelCall(tx, { ...call, turnNo: 4, costRub: '6' })
        expect(first.billable).toBe(true)

        const raw = await taskRawCredits(tx, { taskId, attempts: [1] })

        // (60 + 24 + 6) ÷ 6: the two calls of the lost turn are out.
        expect(raw).toMatchObject({ convertible: true, costRub: '90.0000000000' })
        expect(raw.convertible && raw.credits.toFixed(2)).toBe('15.00')

        // The same rows count once the turn is not lost.
        await tx.taskTurn.updateMany({
          where: { taskId, turnNo: 1 },
          data: { status: 'completed' },
        })
        const counted = await taskRawCredits(tx, { taskId, attempts: [1] })
        expect(counted.convertible && counted.credits.toFixed(2)).toBe('35.00')
      })
    })

    // docs/plan/53, «Попробовать ещё (18.10)»: the pass ended in a `feed.failure`.
    it('leaves out the rows of a key whose turn was rejected, whatever its status', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, T1)
        await writeCreditRate(tx, { effectiveFrom: T1 })
        const call = { taskId, pool, priceId, occurredAt: after(T1) }
        await writeModelCall(tx, { ...call, turnNo: 1, costRub: '60', turnStatus: 'completed' })
        await writeModelCall(tx, {
          ...call,
          turnNo: 2,
          costRub: '90',
          turnStatus: 'completed',
          turnRejected: true,
        })
        await writeModelCall(tx, {
          ...call,
          turnNo: 3,
          costRub: '30',
          turnStatus: 'failed',
          turnRejected: true,
        })

        const raw = await taskRawCredits(tx, { taskId, attempts: [1] })
        // 60 ÷ 6: the turns the platform refused are out.
        expect(raw).toMatchObject({ convertible: true, costRub: '60.0000000000' })
        expect(raw.convertible && raw.credits.toFixed(2)).toBe('10.00')
      })
    })

    it('sums the attempts it is asked for, each apart and all together', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const other = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, T1)
        await writeCreditRate(tx, { effectiveFrom: T1 })
        const call = { taskId, pool, priceId, occurredAt: after(T1) }
        await writeModelCall(tx, { ...call, attempt: 1, turnNo: 1, costRub: '225' })
        await writeModelCall(tx, { ...call, attempt: 2, turnNo: 2, costRub: '72' })
        // Another task of another workspace: never in the sum.
        await writeModelCall(tx, { ...call, taskId: other.taskId, costRub: '600' })

        const chain = await taskRawCredits(tx, { taskId, attempts: [1, 2] })
        if (!chain.convertible) throw new Error('The calls must be convertible')
        // The walk of the design: 225 RUB under the first reserve, 72 under the second.
        expect(chain.credits.toFixed(2)).toBe('49.50')
        expect(chain.costRub).toBe('297.0000000000')
        expect(
          chain.attempts.map((entry) => [entry.attempt, entry.costRub, entry.credits.toFixed(2)]),
        ).toEqual([
          [1, '225.0000000000', '37.50'],
          [2, '72.0000000000', '12.00'],
        ])
        expect(taskCharge({ used: chain.credits }).credits).toBe(50)

        // A retry after a failure is charged for itself alone.
        const retry = await taskRawCredits(tx, { taskId, attempts: [2] })
        expect(retry.convertible && retry.credits.toFixed(2)).toBe('12.00')

        // An attempt without calls is told with zeros, in the order asked.
        const none = await taskRawCredits(tx, { taskId, attempts: [3, 1] })
        if (!none.convertible) throw new Error('The calls must be convertible')
        expect(
          none.attempts.map((entry) => [entry.attempt, entry.costRub, entry.credits.toFixed(2)]),
        ).toEqual([
          [3, '0.0000000000', '0.00'],
          [1, '225.0000000000', '37.50'],
        ])
        expect(none.credits.toFixed(2)).toBe('37.50')
      })
    })

    it('answers zero for a task without calls', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const raw = await taskRawCredits(tx, { taskId, attempts: [1] })
        expect(raw).toMatchObject({ convertible: true, costRub: '0.0000000000' })
        expect(raw.convertible && raw.credits.isZero()).toBe(true)
      })
    })

    it('does not convert a call whose price row is newer than the rate in force at its start', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, T1)
        await writeCreditRate(tx, { effectiveFrom: T1 })
        // New prices written without a rate: what `billing:rates` never does.
        const repriced = await writeModelPrice(tx, pool, { effectiveFrom: T2 })
        const call = { taskId, pool, costRub: '60' }
        await writeModelCall(tx, { ...call, priceId, occurredAt: after(T1) })
        await writeModelCall(tx, { ...call, priceId: repriced.id, occurredAt: after(T2) })
        await writeModelCall(tx, { ...call, priceId: repriced.id, occurredAt: after(T2, 2 * HOUR) })

        // A typed answer, not 20 or 30 credits with the two calls silently left out or in.
        expect(await taskRawCredits(tx, { taskId, attempts: [1] })).toEqual({
          convertible: false,
          callsWithoutRate: 0,
          callsWithStaleRate: 2,
        })

        // The rate that should have come with those prices makes the task chargeable.
        await writeCreditRate(tx, { effectiveFrom: T2, rubPerCredit: '5.000000' })
        const raw = await taskRawCredits(tx, { taskId, attempts: [1] })
        expect(raw.convertible && raw.credits.toFixed(2)).toBe('34.00')
      })
    })

    it('does not convert a call that started while no rate was in force', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, BEFORE)
        await writeCreditRate(tx, { effectiveFrom: T1 })
        const call = { taskId, pool, priceId, costRub: '60' }
        await writeModelCall(tx, { ...call, occurredAt: after(BEFORE) })
        await writeModelCall(tx, { ...call, occurredAt: after(T1) })

        expect(await taskRawCredits(tx, { taskId, attempts: [1] })).toEqual({
          convertible: false,
          callsWithoutRate: 1,
          callsWithStaleRate: 0,
        })
      })
    })

    it('is not stopped by a call it does not count', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, BEFORE)
        await writeCreditRate(tx, { effectiveFrom: T1 })
        const call = { taskId, pool, priceId, costRub: '60' }
        // Before any rate, and each left out for its own reason: not billable, a lost turn,
        // another attempt.
        await writeModelCall(tx, { ...call, occurredAt: after(BEFORE), estimateReason: 'lost' })
        await writeModelCall(tx, {
          ...call,
          occurredAt: after(BEFORE),
          turnNo: 2,
          turnStatus: 'lost',
        })
        await writeModelCall(tx, { ...call, occurredAt: after(BEFORE), attempt: 2, turnNo: 3 })
        await writeModelCall(tx, { ...call, occurredAt: after(T1), turnNo: 4 })

        const raw = await taskRawCredits(tx, { taskId, attempts: [1] })
        expect(raw.convertible && raw.credits.toFixed(2)).toBe('10.00')
      })
    })

    it.each([
      ['no attempt', { attempts: [] }],
      ['an attempt named twice', { attempts: [1, 1] }],
      ['an attempt of zero', { attempts: [0] }],
      ['a fraction of an attempt', { attempts: [1.5] }],
      ['a task that is not an id', { taskId: 'task' }],
    ])('refuses %s', async (_, patch) => {
      const query = { taskId: randomUUID(), attempts: [1], ...patch }
      await expect(taskRawCredits(db, query)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    })
  })

  describe('the fixture of a model call', () => {
    it('keeps a turn to one attempt and a key to one state, and says so', async () => {
      await rolledBack(async (tx) => {
        const { taskId } = await taskIn(tx)
        const { pool, priceId } = await pricedPool(tx, T1)
        const call = { taskId, pool, priceId, costRub: '60', occurredAt: after(T1) }
        const first = await writeModelCall(tx, call)
        const keys = () =>
          tx.llmKey.findMany({
            where: { taskId },
            orderBy: { turnNo: 'asc' },
            select: { id: true, taskAttempt: true, turnNo: true, usageClosedAt: true },
          })

        // Usage of attempt 2 on the key of attempt 1 is a row the gateway never writes.
        await expect(
          writeModelCall(tx, { ...call, attempt: 2, turnStatus: 'lost' }),
        ).rejects.toThrow(
          'Turn 1 of the task belongs to attempt 1: give the call of attempt 2 a turn of its own',
        )
        // The key of the turn is closed already: an open one cannot be asked for after the fact.
        await expect(writeModelCall(tx, { ...call, usageClosed: false })).rejects.toThrow(
          'The key of turn 1 is already closed: usageClosed is set by the first call of a turn',
        )
        // A refused call wrote nothing: no usage, no key, and no turn row that would have taken
        // the first call out of the charge as the call of a lost turn.
        expect(await tx.tokenUsage.count({ where: { taskId } })).toBe(1)
        expect(await tx.taskTurn.count({ where: { taskId } })).toBe(0)
        expect(await keys()).toMatchObject([{ id: first.keyId, taskAttempt: 1, turnNo: 1 }])

        // With a turn of its own the second attempt gets its own key, open as asked.
        const second = await writeModelCall(tx, {
          ...call,
          attempt: 2,
          turnNo: 2,
          usageClosed: false,
        })
        expect(await keys()).toEqual([
          { id: first.keyId, taskAttempt: 1, turnNo: 1, usageClosedAt: expect.any(Date) },
          { id: second.keyId, taskAttempt: 2, turnNo: 2, usageClosedAt: null },
        ])
        await expect(
          writeModelCall(tx, { ...call, attempt: 2, turnNo: 2, usageClosed: true }),
        ).rejects.toThrow('The key of turn 2 is already open')

        // The next calls of a turn share its key: unsaid, or said as it is.
        const again = await writeModelCall(tx, { ...call, attempt: 2, turnNo: 2 })
        const same = await writeModelCall(tx, {
          ...call,
          attempt: 2,
          turnNo: 2,
          usageClosed: false,
        })
        expect([again.keyId, same.keyId]).toEqual([second.keyId, second.keyId])
        expect(
          await tx.tokenUsage.groupBy({
            by: ['keyId', 'taskAttempt'],
            where: { taskId },
            _count: true,
            orderBy: { taskAttempt: 'asc' },
          }),
        ).toEqual([
          { keyId: first.keyId, taskAttempt: 1, _count: 1 },
          { keyId: second.keyId, taskAttempt: 2, _count: 3 },
        ])
      })
    })
  })
})
