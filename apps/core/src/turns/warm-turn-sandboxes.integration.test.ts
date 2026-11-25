import { randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { openRunnerTasks } from './warm-turn-sandboxes.ts'

// The open tasks of a runner's warm containers (docs/plan/93): only tasks a turn of that runner
// ran, and only while they may still run a turn.
const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('the open tasks of a runner with PostgreSQL', () => {
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

  async function runnerTurn(runnerId: string) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id)
    await db.turnAssignment.create({
      data: {
        taskId,
        siteId: taskId,
        sessionId: `session-${taskId}`,
        turnNo: 1,
        executor: 'runner',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + 60_000),
        runnerId,
        runnerSession: randomUUID(),
        claimedAt: new Date(),
        finishedAt: new Date(),
        outcome: 'completed',
      },
    })
    return taskId
  }

  it('answers of the tasks of this runner that are still open', async () => {
    const own = await runnerTurn('sandbox-1')
    const other = await runnerTurn('sandbox-2')
    const ended = await runnerTurn('sandbox-1')
    await db.task.update({ where: { id: ended }, data: { status: 'done' } })
    await db.task.update({ where: { id: own }, data: { status: 'awaiting_user' } })
    expect(await openRunnerTasks(db, 'sandbox-1', [own, other, ended, randomUUID()])).toEqual([own])
    expect(await openRunnerTasks(db, 'sandbox-2', [own, other])).toEqual([other])
    expect(await openRunnerTasks(db, 'sandbox-2', [own])).toEqual([])
  })
})
