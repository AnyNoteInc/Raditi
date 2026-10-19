import { randomUUID } from 'node:crypto'

import type { AgentDriverRegistry } from '@repo/agent-drivers'
import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import { createPrismaClient, insertFeedEvent, recordCandidate, type PrismaClient } from '@repo/db'
import type { TurnEvidence } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import { TaskEventTurnJournal } from '../turns/turn-journal.ts'
import type { CandidateBuilder } from './candidate-builder.ts'
import { LivePasses } from './live-passes.ts'
import { PassSettlement } from './pass-settlement.ts'
import { ORPHAN_PREPARING_MS, TaskSweep } from './task-sweep.ts'

// The sweep reads every task of the database: only on a disposable one (RADITI_GATEWAY_DB_TESTS).
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const HEAD = 'b'.repeat(40)
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
const candidates = {
  context: vi.fn(async (task: { id: string }) => ({
    taskId: task.id,
    repo: { provider: 'gitea', owner: 'sites', name: 'site' },
    addOnlyPaths: [],
    base: 'a'.repeat(40),
    standing: null,
    installedVersion: null,
    releasedVersions: [],
    revision: 1,
  })),
  build: vi.fn(async () => ({ kind: 'empty' as const })),
} as unknown as CandidateBuilder

describe.skipIf(!enabled)('the sweep of dialogs with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  const queue = { enqueue: vi.fn(async () => {}) }

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await db.outboxEvent.deleteMany({ where: { dedupeKey: { startsWith: 'preview.sync:' } } })
    await db.siteRelease.deleteMany({})
    await fixtures.cleanup()
    vi.clearAllMocks()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  const sweep = (now = new Date()) =>
    new TaskSweep({
      db,
      settlement: new PassSettlement({ db, candidates, logger: quiet, now: () => now }),
      live: new LivePasses(),
      journal: new TaskEventTurnJournal(db),
      drivers: { has: () => false } as unknown as AgentDriverRegistry,
      queue,
      logger: quiet,
      now: () => now,
    })

  async function dialog(
    status: string,
    turnNo: number,
    expiresAt = new Date(Date.now() + 3_600_000),
  ) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, { status: 'queued' })
    const placedAt = new Date(expiresAt.getTime() - 3_600_000)
    await fixtures.reserve({
      workspaceId: workspace.id,
      taskId,
      attempt: 1,
      now: placedAt,
      expiresAt,
    })
    if (turnNo > 0)
      await db.taskTurn.create({
        data: {
          taskId,
          turnNo,
          status: 'completed',
          driverId: sampleDriverId,
          image,
          headSha: HEAD,
        },
      })
    await db.$executeRaw`UPDATE tasks SET status = ${status}::"TaskStatus", turn_no = ${turnNo}
      WHERE id = ${taskId}::uuid`
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId }, include: { site: true } })
    return { taskId, task, userId }
  }

  const firstWords = (taskId: string, userId: string) =>
    insertFeedEvent(db, {
      taskId,
      row: {
        type: 'feed.request',
        payload: { v: 1, kind: 'first', authorId: userId, requestId: randomUUID(), text: 'Слова' },
      },
    })
  const press = (taskId: string, userId: string, command: 'reset' | 'update') =>
    insertFeedEvent(db, {
      taskId,
      row: {
        type: 'feed.request',
        payload: { v: 1, kind: 'command', command, authorId: userId, requestId: randomUUID() },
      },
    })

  it('puts back in the queue a pass whose handler died before it opened a turn', async () => {
    const { taskId, userId } = await dialog('preparing', 0)
    const words = await firstWords(taskId, userId)
    await press(taskId, userId, 'reset')
    const now = new Date()
    expect(await sweep(now).settleOrphans()).toBe(0)
    expect(await sweep(new Date(now.getTime() + ORPHAN_PREPARING_MS + 1000)).settleOrphans()).toBe(
      1,
    )
    expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      status: 'queued',
      waiting: null,
    })
    // Its job answers the words that queued it, not the press after them.
    expect(queue.enqueue).toHaveBeenCalledWith(
      'agent-turns',
      'turn.run',
      { taskId, attempt: 1, requestEventId: words.toString() },
      { jobId: expect.stringContaining(':retry:orphan-') },
    )
    expect(await db.taskEvent.count({ where: { taskId, type: 'feed.failure' } })).toBe(0)
  })

  it('ends from its journal a turn the pass itself opened and that closed before it ran', async () => {
    const { taskId, task } = await dialog('preparing', 1)
    const opened = new Date(Date.now() - 10 * 60_000)
    await db.turnAssignment.create({
      data: {
        taskId,
        siteId: task.siteId,
        sessionId: taskId,
        turnNo: 1,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + 60_000),
        createdAt: opened,
        finishedAt: new Date(opened.getTime() + 2_000),
        outcome: 'failed',
      },
    })
    await db.taskEvent.create({
      data: {
        taskId,
        type: 'turn.lifecycle',
        payload: {
          fence: { siteId: task.siteId, taskId, operation: 'turn', epoch: 1 },
          sessionId: taskId,
          turn: 1,
          sequence: 1,
          phase: 'failed',
          reason: 'snapshot_credential',
        },
      },
    })
    // The open stamped the task a moment after the assignment row was created — by core's clock.
    await db.$executeRaw`UPDATE tasks SET updated_at = ${new Date(opened.getTime() + 500)}
      WHERE id = ${taskId}::uuid`

    expect(await sweep().settleOrphans()).toBe(1)
    expect(
      (await db.taskEvent.findMany({ where: { taskId, type: 'feed.failure' } })).map(
        (r) => r.payload,
      ),
    ).toEqual([
      {
        v: 1,
        turn: 1,
        code: 'secret_found',
        site: 'unchanged',
        credits: 'returned',
        next: 'failed',
      },
    ])
  })

  it('goes on past a row that fails, and leaves a pass that must wait alone for a while', async () => {
    const first = await dialog('running', 1)
    const second = await dialog('running', 1)
    for (const { taskId, task } of [first, second])
      await db.turnAssignment.create({
        data: {
          taskId,
          siteId: task.siteId,
          sessionId: taskId,
          turnNo: 1,
          executor: 'local',
          plan: {},
          firstEpoch: 1,
          leaseEpoch: 1,
          deadlineAt: new Date(Date.now() + 60_000),
          finishedAt: new Date(),
          outcome: 'failed',
        },
      })
    const settle = vi.fn(async (ref: { taskId: string }) => {
      if (ref.taskId === first.taskId) throw new Error('storage is down')
      return 'later' as const
    })
    const stubbed = new TaskSweep({
      db,
      settlement: { settle } as unknown as PassSettlement,
      live: new LivePasses(),
      journal: new TaskEventTurnJournal(db),
      drivers: { has: () => false } as unknown as AgentDriverRegistry,
      queue,
      logger: quiet,
    })

    expect(await stubbed.settleOrphans()).toBe(0)
    expect(settle.mock.calls.map(([ref]) => ref.taskId).sort()).toEqual(
      [first.taskId, second.taskId].sort(),
    )
    // The pass that answered `later` is left alone now; the one that threw is asked again.
    settle.mockClear()
    await stubbed.settleOrphans()
    expect(settle.mock.calls.map(([ref]) => ref.taskId)).toEqual([first.taskId])
  })

  it('ends a turn recovery closed, from the result its journal kept', async () => {
    const { taskId, task } = await dialog('running', 1)
    await db.turnAssignment.create({
      data: {
        taskId,
        siteId: task.siteId,
        sessionId: taskId,
        turnNo: 1,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 2,
        deadlineAt: new Date(Date.now() + 60_000),
        finishedAt: new Date(),
        outcome: 'completed',
      },
    })
    const entry = (sequence: number, phase: TurnEvidence['phase'], extra = {}) => ({
      fence: { siteId: task.siteId, taskId, operation: 'turn', epoch: 2 },
      sessionId: taskId,
      turn: 1,
      sequence,
      phase,
      ...extra,
    })
    for (const payload of [
      entry(1, 'running'),
      entry(2, 'completed', {
        result: {
          summary: 'Ответил',
          change_type: 'none',
          client_message: 'Менять ничего не нужно.',
          files_changed: [],
          questions: [],
          needs_approval: false,
          risk: 'low',
        },
      }),
    ])
      await db.taskEvent.create({ data: { taskId, type: 'turn.lifecycle', payload } })

    expect(await sweep().settleOrphans()).toBe(1)
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('done')
    expect(await db.taskEvent.count({ where: { taskId, type: 'feed.result' } })).toBe(1)
  })

  it('cancels a dialog whose reserve ran out while it waited, never one with a release in work', async () => {
    const past = new Date(Date.now() - 60_000)
    const waiting = await dialog('awaiting_user', 1, past)
    const releasing = await dialog('awaiting_approval', 1, past)
    const recorded = await db.$transaction((tx) =>
      recordCandidate(tx, {
        taskId: releasing.taskId,
        revision: 1,
        turnNo: 1,
        baseSha: 'a'.repeat(40),
        baseTree: 'c'.repeat(40),
        baseVersion: null,
        headSha: HEAD,
        files: [],
        media: [],
        dbPlan: [],
        dbPlanSha256: '0'.repeat(64),
        proposedBump: 'patch',
        proposedVersion: 'v0.0.1',
        facts: {
          changeType: 'content',
          risk: 'low',
          addedFiles: 0,
          modifiedFiles: 0,
          deletedFiles: 0,
          mediaFiles: 0,
          dbObjects: 0,
          newFunctionality: false,
        },
        checks: [],
        installed: null,
      }),
    )
    await db.siteRelease.create({
      data: {
        siteId: releasing.task.siteId,
        taskId: releasing.taskId,
        candidateId: recorded.id,
        candidateRevision: 1,
        attempt: 1,
        releaseKey: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        version: 'v0.0.1',
        tag: 'v0.0.1',
        bump: 'patch',
        mainBeforeSha: 'a'.repeat(40),
        committedAt: new Date(),
        approvedAt: new Date(),
      },
    })

    expect(await sweep().expireHolds()).toBe(1)

    expect((await db.task.findUniqueOrThrow({ where: { id: waiting.taskId } })).status).toBe(
      'cancelled',
    )
    expect(
      (
        await db.taskEvent.findMany({ where: { taskId: waiting.taskId, type: 'feed.cancelled' } })
      ).map((row) => row.payload),
    ).toEqual([{ v: 1, turn: 1, by: 'no_answer', site: 'unchanged', credits: 'returned' }])
    expect(
      (await db.creditHold.findMany({ where: { taskId: waiting.taskId } })).every(
        (hold) => hold.status === 'expired',
      ),
    ).toBe(true)
    expect((await db.task.findUniqueOrThrow({ where: { id: releasing.taskId } })).status).toBe(
      'awaiting_approval',
    )
  })

  it('keeps the reserve of a dialog that waits with a candidate while its preview lives', async () => {
    const soon = new Date(Date.now() + 60_000)
    const { taskId, task } = await dialog('awaiting_approval', 1, soon)
    await db.$transaction((tx) =>
      recordCandidate(tx, {
        taskId,
        revision: 1,
        turnNo: 1,
        baseSha: 'a'.repeat(40),
        baseTree: 'c'.repeat(40),
        baseVersion: null,
        headSha: HEAD,
        files: [],
        media: [],
        dbPlan: [],
        dbPlanSha256: '0'.repeat(64),
        proposedBump: 'patch',
        proposedVersion: 'v0.0.1',
        facts: {
          changeType: 'content',
          risk: 'low',
          addedFiles: 0,
          modifiedFiles: 0,
          deletedFiles: 0,
          mediaFiles: 0,
          dbObjects: 0,
          newFunctionality: false,
        },
        checks: [],
        installed: null,
      }),
    )
    const lives = new Date(Date.now() + 48 * 3_600_000)
    await db.previewEnvironment.create({
      data: {
        siteId: task.siteId,
        taskId,
        status: 'ready',
        hostname: `site-${task.site.alias}-chat-${task.alias}.localhost`,
        expiresAt: lives,
      },
    })

    expect(await sweep().extendHolds()).toBe(1)
    for (const hold of await db.creditHold.findMany({ where: { taskId } }))
      expect(hold.expiresAt.getTime()).toBe(lives.getTime())
    expect(await sweep().extendHolds()).toBe(0)

    // The client pressed «Попробовать ещё» (or wrote) between the selection and its transaction:
    // the new reserve keeps the expiry of its queue, the preview's would cut it short.
    await db.previewEnvironment.update({
      where: { taskId },
      data: { expiresAt: new Date(lives.getTime() + 3_600_000) },
    })
    const pressed = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== '$transaction') return Reflect.get(target, key, receiver)
        return async (...args: Parameters<typeof db.$transaction>) => {
          await db.task.update({ where: { id: taskId }, data: { status: 'queued' } })
          return (target.$transaction as (...a: unknown[]) => unknown)(...args)
        }
      },
    })
    const raced = new TaskSweep({
      db: pressed,
      settlement: new PassSettlement({ db, candidates, logger: quiet }),
      live: new LivePasses(),
      journal: new TaskEventTurnJournal(db),
      drivers: { has: () => false } as unknown as AgentDriverRegistry,
      queue,
      logger: quiet,
    })
    expect(await raced.extendHolds()).toBe(0)
    for (const hold of await db.creditHold.findMany({ where: { taskId } }))
      expect(hold.expiresAt.getTime()).toBe(lives.getTime())
  })

  it('puts again the lost job of a queued pass that waits for nothing', async () => {
    const { taskId, userId } = await dialog('queued', 0)
    const words = await firstWords(taskId, userId)
    await press(taskId, userId, 'update')
    await db.$executeRaw`UPDATE tasks SET updated_at = now() - interval '6 minutes'
      WHERE id = ${taskId}::uuid`
    const fresh = await dialog('queued', 0)
    await firstWords(fresh.taskId, fresh.userId)

    expect(await sweep().requeueLost()).toBe(1)
    expect(queue.enqueue).toHaveBeenCalledWith(
      'agent-turns',
      'turn.run',
      { taskId, attempt: 1, requestEventId: words.toString() },
      { jobId: expect.stringContaining(':retry:sweep-') },
    )
  })

  it('puts again a pass whose retry got lost', async () => {
    const { taskId, userId } = await dialog('queued', 0)
    const request = await insertFeedEvent(db, {
      taskId,
      row: {
        type: 'feed.request',
        payload: { v: 1, kind: 'first', authorId: userId, requestId: randomUUID(), text: 'Слова' },
      },
    })
    await db.$executeRaw`UPDATE tasks SET waiting = 'site', updated_at = now() - interval '1 hour'
      WHERE id = ${taskId}::uuid`

    expect(await sweep().requeueLost()).toBe(1)
    expect(queue.enqueue).toHaveBeenCalledWith(
      'agent-turns',
      'turn.run',
      { taskId, attempt: 1, requestEventId: request.toString() },
      { jobId: expect.stringContaining(':retry:sweep-') },
    )
  })
})
