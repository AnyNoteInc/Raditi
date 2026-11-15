import { type FeedRow } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import {
  cancelWaitingTask,
  claimQueuedPass,
  claimQueuedTask,
  redoDialog,
  redoTurn,
  rejectTurn,
  rewindDialog,
  settleTurn,
  undoTurn,
} from './task-settle.ts'

const databaseUrl = process.env.DATABASE_URL
const TASK = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'

const result = (turn: number): FeedRow => ({
  type: 'feed.result',
  payload: {
    v: 1,
    turn,
    message: 'Телефон в шапке заменён.',
    site: 'unchanged',
    next: 'done',
    filesChanged: 1,
    changeType: 'code',
    needsApproval: false,
    risk: 'low',
  },
})

describe('turn settlement input', () => {
  it('refuses a move the task machine does not have, before querying', async () => {
    const $queryRaw = vi.fn()
    const db = { $queryRaw, taskEvent: { create: vi.fn() } }
    await expect(
      settleTurn(db as never, {
        taskId: TASK,
        attempt: 1,
        expectedTurnNo: 1,
        from: ['running'],
        to: 'queued',
        turn: null,
        feed: [],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    // Only a queued task waits, and the way back to the queue writes no feed row.
    await expect(
      settleTurn(db as never, {
        taskId: TASK,
        attempt: 1,
        expectedTurnNo: 0,
        from: ['preparing'],
        to: 'failed',
        waiting: 'site',
        turn: null,
        feed: [],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      settleTurn(db as never, {
        taskId: TASK,
        attempt: 1,
        expectedTurnNo: 0,
        from: ['preparing'],
        to: 'queued',
        turn: null,
        feed: [result(1)],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect($queryRaw).not.toHaveBeenCalled()
  })

  it('refuses a feed row the write schema does not take, before querying', async () => {
    const $queryRaw = vi.fn()
    await expect(
      settleTurn({ $queryRaw, taskEvent: { create: vi.fn() } } as never, {
        taskId: TASK,
        attempt: 1,
        expectedTurnNo: 1,
        from: ['running'],
        to: 'done',
        turn: 1,
        feed: [{ type: 'feed.result', payload: { v: 1, turn: 1 } } as never],
      }),
    ).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL turn settlement', () => {
  let schema: MigratedSchema
  let db: PrismaClient
  const workspaces: string[] = []
  const image = `registry.invalid/raditi/opencode@sha256:${'a'.repeat(64)}`

  beforeAll(async () => {
    // A turn needs the `opencode` row of agent_drivers. In a schema of its own the test neither
    // depends on the seeds of the database it was given nor leaves that row in it.
    schema = await createMigratedSchema(databaseUrl ?? '', 'task_settle')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
    await db.agentDriver.upsert({
      where: { id: 'opencode' },
      update: {},
      create: { id: 'opencode', image, capabilities: {}, enabled: true },
    })
  }, 60_000)
  afterEach(async () => {
    const ids = workspaces.splice(0)
    const of = { task: { workspaceId: { in: ids } } }
    await db.turnAssignment.deleteMany({ where: of })
    await db.task.deleteMany({ where: { workspaceId: { in: ids } } })
    await db.workspace.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  }, 60_000)

  async function task(data: { status?: 'queued' | 'preparing' | 'running'; turnNo?: number } = {}) {
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic settlement verification', dataClass: 'synthetic' },
    })
    workspaces.push(workspace.id)
    const row = await db.task.create({
      data: {
        workspaceId: workspace.id,
        status: data.status ?? 'queued',
        turnNo: data.turnNo ?? 0,
        modelClass: 'standard',
      },
    })
    if (row.turnNo > 0)
      await db.taskTurn.create({
        data: {
          taskId: row.id,
          turnNo: row.turnNo,
          status: 'completed',
          driverId: 'opencode',
          image,
        },
      })
    return row
  }

  // docs/plan/53, «Попробовать ещё (18.10)».
  it('marks the turn of a failed pass once, and keeps the first moment', async () => {
    const row = await task({ status: 'running', turnNo: 1 })
    expect(await rejectTurn(db, { taskId: row.id, turnNo: 2 })).toBe(false)
    expect(await rejectTurn(db, { taskId: row.id, turnNo: 1 })).toBe(true)
    const first = await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id, turnNo: 1 } })
    expect(first.rejectedAt).toBeInstanceOf(Date)
    expect(first.status).toBe('completed')
    expect(await rejectTurn(db, { taskId: row.id, turnNo: 1 })).toBe(true)
    const again = await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id, turnNo: 1 } })
    expect(again.rejectedAt).toEqual(first.rejectedAt)
    await expect(rejectTurn(db, { taskId: row.id, turnNo: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('moves a chat with the repository to what stands after `/undo`, with the turn undone', async () => {
    for (const [from, to] of [
      ['awaiting_approval', 'awaiting_user'],
      ['awaiting_user', 'awaiting_approval'],
      ['awaiting_approval', 'awaiting_approval'],
    ] as const) {
      const row = await task({ status: 'running', turnNo: 1 })
      const turn = await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id } })
      await db.task.update({ where: { id: row.id }, data: { status: from } })
      expect(await rewindDialog(db, { taskId: row.id, turnNo: 2, to })).toBeNull()
      expect(await rewindDialog(db, { taskId: row.id, turnNo: 1, to })).toBe(turn.id)
      const after = await db.task.findUniqueOrThrow({ where: { id: row.id } })
      expect(after.status).toBe(to)
      expect(after.waiting).toBeNull()
      expect(
        (await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id } })).undoneAt,
      ).toBeInstanceOf(Date)
    }
  })

  it('moves a chat with the repository to what stands after `/redo`, with the turn counted', async () => {
    for (const [from, to] of [
      ['awaiting_approval', 'awaiting_user'],
      ['awaiting_user', 'awaiting_approval'],
      ['awaiting_approval', 'awaiting_approval'],
    ] as const) {
      const row = await task({ status: 'running', turnNo: 1 })
      const turn = await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id } })
      await undoTurn(db, { taskId: row.id, turnNo: 1 })
      await db.task.update({ where: { id: row.id }, data: { status: from } })
      expect(await redoDialog(db, { taskId: row.id, turnNo: 2, to })).toBeNull()
      expect(await redoDialog(db, { taskId: row.id, turnNo: 1, to })).toBe(turn.id)
      const after = await db.task.findUniqueOrThrow({ where: { id: row.id } })
      expect(after.status).toBe(to)
      expect(after.waiting).toBeNull()
      expect(
        (await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id } })).undoneAt,
      ).toBeNull()
    }
  })

  it('moves no chat that went elsewhere for `/redo`, and none whose turn is not undone', async () => {
    const running = await task({ status: 'running', turnNo: 1 })
    await undoTurn(db, { taskId: running.id, turnNo: 1 })
    expect(await redoDialog(db, { taskId: running.id, turnNo: 1, to: 'awaiting_user' })).toBeNull()
    expect((await db.task.findUniqueOrThrow({ where: { id: running.id } })).status).toBe('running')
    expect(
      (await db.taskTurn.findFirstOrThrow({ where: { taskId: running.id } })).undoneAt,
    ).toBeInstanceOf(Date)

    const standing = await task({ status: 'running', turnNo: 1 })
    await db.task.update({ where: { id: standing.id }, data: { status: 'awaiting_approval' } })
    await expect(
      redoDialog(db, { taskId: standing.id, turnNo: 1, to: 'awaiting_user' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('moves no chat that does not wait, and none whose turn is refused', async () => {
    const running = await task({ status: 'running', turnNo: 1 })
    expect(
      await rewindDialog(db, { taskId: running.id, turnNo: 1, to: 'awaiting_user' }),
    ).toBeNull()
    expect((await db.task.findUniqueOrThrow({ where: { id: running.id } })).status).toBe('running')

    const refused = await task({ status: 'running', turnNo: 1 })
    await rejectTurn(db, { taskId: refused.id, turnNo: 1 })
    await db.task.update({ where: { id: refused.id }, data: { status: 'awaiting_approval' } })
    await expect(
      rewindDialog(db, { taskId: refused.id, turnNo: 1, to: 'awaiting_user' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('moves no chat with a turn assigned: `/undo` is not theirs to take', async () => {
    const assigned = await task({ status: 'running', turnNo: 1 })
    await db.task.update({ where: { id: assigned.id }, data: { status: 'awaiting_user' } })
    await db.turnAssignment.create({
      data: {
        taskId: assigned.id,
        siteId: assigned.id,
        sessionId: assigned.id,
        turnNo: 1,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + 60_000),
      },
    })
    expect(
      await rewindDialog(db, { taskId: assigned.id, turnNo: 1, to: 'awaiting_user' }),
    ).toBeNull()
    expect(
      (await db.taskTurn.findFirstOrThrow({ where: { taskId: assigned.id } })).undoneAt,
    ).toBeNull()
  })

  it('takes a completed turn back once, never one whose result was refused', async () => {
    const row = await task({ status: 'running', turnNo: 1 })
    const turn = await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id } })
    expect(await undoTurn(db, { taskId: row.id, turnNo: 2 })).toBeNull()
    expect(await undoTurn(db, { taskId: row.id, turnNo: 1 })).toBe(turn.id)
    const undone = await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id } })
    expect(undone.undoneAt).toBeInstanceOf(Date)
    expect(undone.rejectedAt).toBeNull()
    expect(undone.status).toBe('completed')
    expect(await undoTurn(db, { taskId: row.id, turnNo: 1 })).toBeNull()
    expect((await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id } })).undoneAt).toEqual(
      undone.undoneAt,
    )

    const refused = await task({ status: 'running', turnNo: 1 })
    await rejectTurn(db, { taskId: refused.id, turnNo: 1 })
    expect(await undoTurn(db, { taskId: refused.id, turnNo: 1 })).toBeNull()

    const failed = await task({ status: 'running', turnNo: 1 })
    await db.taskTurn.updateMany({ where: { taskId: failed.id }, data: { status: 'failed' } })
    expect(await undoTurn(db, { taskId: failed.id, turnNo: 1 })).toBeNull()
    await expect(undoTurn(db, { taskId: row.id, turnNo: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('brings back only a turn `/undo` took, and only once', async () => {
    const row = await task({ status: 'running', turnNo: 1 })
    const turn = await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id } })
    expect(await redoTurn(db, { taskId: row.id, turnNo: 1 })).toBeNull()
    await undoTurn(db, { taskId: row.id, turnNo: 1 })
    expect(await redoTurn(db, { taskId: row.id, turnNo: 2 })).toBeNull()
    expect(await redoTurn(db, { taskId: row.id, turnNo: 1 })).toBe(turn.id)
    const back = await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id } })
    expect(back.undoneAt).toBeNull()
    expect(back.status).toBe('completed')
    expect(await redoTurn(db, { taskId: row.id, turnNo: 1 })).toBeNull()

    const refused = await task({ status: 'running', turnNo: 1 })
    await undoTurn(db, { taskId: refused.id, turnNo: 1 })
    await rejectTurn(db, { taskId: refused.id, turnNo: 1 })
    expect(await redoTurn(db, { taskId: refused.id, turnNo: 1 })).toBeNull()
    expect(
      (await db.taskTurn.findFirstOrThrow({ where: { taskId: refused.id } })).undoneAt,
    ).toBeInstanceOf(Date)

    const failed = await task({ status: 'running', turnNo: 1 })
    await undoTurn(db, { taskId: failed.id, turnNo: 1 })
    await db.taskTurn.updateMany({ where: { taskId: failed.id }, data: { status: 'failed' } })
    expect(await redoTurn(db, { taskId: failed.id, turnNo: 1 })).toBeNull()
    await expect(redoTurn(db, { taskId: row.id, turnNo: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('claims exactly as many passes of a workspace as its limit, of nine at once', async () => {
    // docs/plan/70-turn-without-time-limit.md, ВР13: none goes past the limit, none gives way
    // for nothing.
    const first = await task()
    const { workspaceId } = await db.task.findUniqueOrThrow({ where: { id: first.id } })
    const others = await Promise.all(
      Array.from({ length: 8 }, () =>
        db.task.create({
          data: { workspaceId, modelClass: 'standard' },
        }),
      ),
    )
    const ids = [first.id, ...others.map((row) => row.id)]
    const claims = await Promise.all(
      ids.map((taskId) => claimQueuedPass(db, { taskId, attempt: 1, workspaceLimit: 8 })),
    )
    expect(claims.filter((claim) => claim === 'full')).toHaveLength(1)
    expect(claims.filter((claim) => claim !== null && claim !== 'full')).toHaveLength(8)
    expect(await db.task.count({ where: { workspaceId, status: 'preparing' } })).toBe(8)
    // The one kept back stays queued under its attempt, untouched.
    const kept = ids[claims.indexOf('full')]!
    expect(await db.task.findUniqueOrThrow({ where: { id: kept } })).toMatchObject({
      status: 'queued',
      attempt: 1,
    })
    // A pass of another attempt, or one already taken, is no claim at all.
    expect(await claimQueuedPass(db, { taskId: kept, attempt: 2, workspaceLimit: 8 })).toBeNull()
    // One ends: the kept one goes.
    await db.task.update({
      where: { id: ids.find((id) => id !== kept)! },
      data: { status: 'done' },
    })
    expect(
      await claimQueuedPass(db, { taskId: kept, attempt: 1, workspaceLimit: 8 }),
    ).toMatchObject({ turnNo: 0 })
  })

  it('claims a queued pass of its attempt once, and clears why it waited', async () => {
    const row = await task()
    await db.task.update({ where: { id: row.id }, data: { waiting: 'site' } })

    expect(await claimQueuedTask(db, { taskId: row.id, attempt: 2 })).toBeNull()
    expect(await claimQueuedTask(db, { taskId: row.id, attempt: 1 })).toEqual({
      turnNo: 0,
      modelClass: 'standard',
      billable: true,
    })
    expect(await claimQueuedTask(db, { taskId: row.id, attempt: 1 })).toBeNull()
    expect(await db.task.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'preparing',
      waiting: null,
    })
  })

  it('ends a pass once, with its feed rows on its turn, only when no turn is assigned', async () => {
    const row = await task({ status: 'running', turnNo: 1 })
    const turn = await db.taskTurn.findFirstOrThrow({ where: { taskId: row.id } })
    const assignment = await db.turnAssignment.create({
      data: {
        taskId: row.id,
        siteId: row.id,
        sessionId: row.id,
        turnNo: 1,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + 60_000),
      },
    })
    const input = {
      taskId: row.id,
      attempt: 1,
      expectedTurnNo: 1,
      from: ['running' as const],
      to: 'done' as const,
      turn: 1,
      feed: [result(1)],
      summary: 'Поменял телефон',
      changeType: 'code' as const,
    }

    // Recovery may still finish the turn: nothing is written while it is assigned.
    expect(await settleTurn(db, input)).toEqual({ moved: false, eventIds: [], turnId: null })
    await db.turnAssignment.update({
      where: { id: assignment.id },
      data: { finishedAt: new Date(), outcome: 'completed' },
    })
    // Another turn number, another attempt: not this pass.
    expect((await settleTurn(db, { ...input, expectedTurnNo: 2 })).moved).toBe(false)
    expect((await settleTurn(db, { ...input, attempt: 2 })).moved).toBe(false)

    const settled = await settleTurn(db, input)
    expect(settled.moved).toBe(true)
    expect(settled.turnId).toBe(turn.id)
    expect(await settleTurn(db, input)).toMatchObject({ moved: false })

    const after = await db.task.findUniqueOrThrow({ where: { id: row.id } })
    expect(after).toMatchObject({ status: 'done', summary: 'Поменял телефон', changeType: 'code' })
    expect(after.finishedAt).not.toBeNull()
    const rows = await db.taskEvent.findMany({ where: { taskId: row.id } })
    expect(rows.map((event) => [event.id, event.type, event.turnId, event.clientVisible])).toEqual([
      [settled.eventIds[0], 'feed.result', turn.id, true],
    ])
  })

  it('sends a busy pass back to the queue with the reason it waits', async () => {
    const row = await task({ status: 'preparing' })
    const back = await settleTurn(db, {
      taskId: row.id,
      attempt: 1,
      expectedTurnNo: 0,
      from: ['preparing'],
      to: 'queued',
      waiting: 'agents',
      turn: null,
      feed: [],
    })
    expect(back).toEqual({ moved: true, eventIds: [], turnId: null })
    expect(await db.task.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'queued',
      waiting: 'agents',
      finishedAt: null,
    })
  })

  it('cancels a waiting dialog once, under its attempt, with its feed row', async () => {
    const row = await task({ status: 'running', turnNo: 1 })
    await db.task.update({ where: { id: row.id }, data: { status: 'awaiting_user' } })
    const input = { taskId: row.id, from: 'awaiting_user' as const, attempt: 1, feed: [] }
    expect((await cancelWaitingTask(db, { ...input, attempt: 2 })).moved).toBe(false)
    expect((await cancelWaitingTask(db, input)).moved).toBe(true)
    expect((await cancelWaitingTask(db, input)).moved).toBe(false)
    expect(await db.task.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'cancelled',
      finishedAt: expect.any(Date),
    })
  })
})
