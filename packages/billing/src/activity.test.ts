import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import type { CreditAccountKind } from '@repo/domain'
import { Decimal } from 'decimal.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import { ensureAccounts, lockCreditAccount } from './accounts.ts'
import { getUsageActivity } from './activity.ts'
import { post } from './ledger.ts'
import { billingFixtures } from './testing.ts'

const databaseUrl = process.env.DATABASE_URL
const WORKSPACE = '0199a000-0000-7000-8000-0000000000a1'
/** 15:00 in Moscow on 15 November 2026. */
const NOW = new Date('2026-11-15T12:00:00.000Z')

describe('usage activity input', () => {
  const db = {} as Parameters<typeof getUsageActivity>[0]

  it('refuses a span the page does not offer and a workspace id that is not one', async () => {
    for (const broken of [
      { workspaceId: WORKSPACE, days: 14 as 7, now: NOW },
      { workspaceId: 'ws', days: 7 as const, now: NOW },
      { workspaceId: WORKSPACE, days: 7 as const, now: new Date(Number.NaN) },
    ]) {
      await expect(getUsageActivity(db, broken)).rejects.toBeInstanceOf(ZodError)
    }
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL usage activity', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(() => fixtures.cleanup())
  afterAll(() => db.$disconnect())

  async function request(taskId: string, at: Date, kind = 'answer') {
    await db.taskEvent.create({
      data: {
        taskId,
        type: 'feed.request',
        clientVisible: true,
        payload: { v: 1, kind, authorId: randomUUID(), requestId: randomUUID(), text: 'Привет' },
        createdAt: at,
      },
    })
  }

  /** Moves credits on one account of the workspace: a grant positive, a charge negative. */
  async function move(
    workspaceId: string,
    kind: CreditAccountKind,
    ledger: 'grant' | 'charge',
    amount: number,
    at: Date,
    taskId: string | null = null,
  ) {
    await db.$transaction(async (tx) => {
      await ensureAccounts(tx, workspaceId)
      const account = await lockCreditAccount(tx, workspaceId, kind)
      if (account === null) throw new Error('No account')
      await post(tx, {
        account,
        kind: ledger,
        amount: new Decimal(amount),
        orderId: null,
        taskId,
        idempotencyKey: `activity-test:${randomUUID()}`,
        createdAt: at,
      })
    })
  }

  it('counts the requests and the charged credits of the workspace by the days of Moscow', async () => {
    const { workspaceId } = await fixtures.workspace()
    const { taskId } = await fixtures.task(workspaceId)
    // 00:30 of 10 November in Moscow, though 9 November by UTC.
    await request(taskId, new Date('2026-11-09T21:30:00.000Z'))
    await request(taskId, new Date('2026-11-10T09:00:00.000Z'), 'command')
    await request(taskId, new Date('2026-11-15T08:00:00.000Z'))
    // Older than the week: not in it.
    await request(taskId, new Date('2026-11-08T20:59:00.000Z'))
    // Not a request of the customer.
    await db.taskEvent.create({
      data: { taskId, type: 'feed.result', clientVisible: true, payload: { v: 1 } },
    })
    const granted = new Date('2026-11-01T09:00:00.000Z')
    for (const kind of ['tariff', 'gift', 'pack'] as const) {
      await move(workspaceId, kind, 'grant', 100, granted)
    }
    await move(workspaceId, 'tariff', 'charge', -7, new Date('2026-11-09T21:10:00.000Z'), taskId)
    await move(workspaceId, 'tariff', 'charge', -5, new Date('2026-11-10T12:00:00.000Z'), taskId)
    await move(workspaceId, 'gift', 'charge', -3, new Date('2026-11-10T13:00:00.000Z'), taskId)
    await move(workspaceId, 'pack', 'charge', -2, new Date('2026-11-15T10:00:00.000Z'), taskId)
    // Someone else's chat and charge are not counted.
    const other = await fixtures.workspace()
    const { taskId: otherTask } = await fixtures.task(other.workspaceId)
    await request(otherTask, new Date('2026-11-10T09:00:00.000Z'))
    await move(other.workspaceId, 'tariff', 'grant', 10, granted)
    await move(other.workspaceId, 'tariff', 'charge', -4, new Date('2026-11-10T09:00:00.000Z'))

    const { days } = await getUsageActivity(db, { workspaceId, days: 7, now: NOW })

    expect(days.map(({ date }) => date)).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ])
    expect(days.map(({ actions }) => actions)).toEqual([0, 2, 0, 0, 0, 0, 1])
    // The grants are not spending; the charge at 00:10 of 10 November in Moscow is of that day.
    expect(days.map(({ credits }) => credits)).toEqual([
      { tariff: 0, gift: 0, pack: 0 },
      { tariff: 12, gift: 3, pack: 0 },
      { tariff: 0, gift: 0, pack: 0 },
      { tariff: 0, gift: 0, pack: 0 },
      { tariff: 0, gift: 0, pack: 0 },
      { tariff: 0, gift: 0, pack: 0 },
      { tariff: 0, gift: 0, pack: 2 },
    ])
  })

  it('reads a month of days for a workspace without anything', async () => {
    const { workspaceId } = await fixtures.workspace()
    const { days } = await getUsageActivity(db, { workspaceId, days: 30, now: NOW })
    expect(days).toHaveLength(30)
    expect(days[0]?.date).toBe('2026-10-17')
    expect(days.at(-1)?.date).toBe('2026-11-15')
    expect(days.every(({ actions }) => actions === 0)).toBe(true)
  })
})
