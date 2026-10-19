import { createHash, randomUUID } from 'node:crypto'

import {
  canonicalDbPlanJson,
  type CandidateFacts,
  type DbPlan,
  type DbPlanView,
  type FeedRow,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import {
  cancelWaitingTask,
  claimQueuedTask,
  excludeTurnDbOperations,
  finishEmptiedDialog,
  nextCandidateRevision,
  recordCandidate,
  rejectTurn,
  requestPreviewSync,
  settleTurn,
  supersedeStandingCandidate,
  type CandidateRecordInput,
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

const facts: CandidateFacts = {
  changeType: 'code',
  risk: 'low',
  addedFiles: 1,
  modifiedFiles: 0,
  deletedFiles: 0,
  mediaFiles: 0,
  dbObjects: 0,
  newFunctionality: false,
}

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
    for (const preview of await db.previewEnvironment.findMany({ where: of, select: { id: true } }))
      await db.outboxEvent.deleteMany({
        where: { dedupeKey: { startsWith: `preview.sync:${preview.id}:` } },
      })
    await db.siteRelease.deleteMany({ where: of })
    await db.candidateCheck.deleteMany({ where: { candidate: of } })
    await db.previewEnvironment.deleteMany({ where: of })
    await db.taskCandidate.deleteMany({ where: of })
    await db.turnAssignment.deleteMany({ where: of })
    await db.task.deleteMany({ where: { workspaceId: { in: ids } } })
    await db.site.deleteMany({ where: { workspaceId: { in: ids } } })
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
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Settlement test',
        url: `https://${randomUUID()}.example.invalid`,
        stack: 'wordpress',
      },
    })
    const row = await db.task.create({
      data: {
        workspaceId: workspace.id,
        siteId: site.id,
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
    return { ...row, siteRow: site }
  }

  const candidate = (taskId: string, revision: number): CandidateRecordInput => ({
    taskId,
    revision,
    turnNo: 1,
    baseSha: 'a'.repeat(40),
    baseTree: 'b'.repeat(40),
    baseVersion: null,
    headSha: 'c'.repeat(40),
    files: [
      { path: 'wp-content/themes/t/a.php', change: 'added', sizeBytes: 3, executable: false },
    ],
    media: [],
    dbPlan: [],
    dbPlanSha256: createHash('sha256').update('[]').digest('hex'),
    proposedBump: 'minor',
    proposedVersion: 'v0.1.0',
    facts,
    checks: ['php_lint', 'preview_smoke'],
    installed: null,
  })

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
        siteId: row.siteId,
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

  it('records the next revision of a candidate over the one that stood, with pending checks', async () => {
    const row = await task({ status: 'running', turnNo: 1 })
    expect(await nextCandidateRevision(db, row.id)).toBe(1)
    const first = await db.$transaction((tx) => recordCandidate(tx, candidate(row.id, 1)))
    expect(first).toMatchObject({ revision: 1, supersededId: null })
    await db.taskCandidate.update({ where: { id: first.id }, data: { status: 'stale' } })

    expect(await nextCandidateRevision(db, row.id)).toBe(2)
    const second = await db.$transaction((tx) => recordCandidate(tx, candidate(row.id, 2)))
    expect(second).toMatchObject({ revision: 2, supersededId: first.id })

    const rows = await db.taskCandidate.findMany({
      where: { taskId: row.id },
      orderBy: { revision: 'asc' },
      include: { checks: { orderBy: { kind: 'asc' } } },
    })
    expect(
      rows.map((c) => [c.revision, c.status, c.previewRevision, c.supersededAt !== null]),
    ).toEqual([
      [1, 'superseded', 1, true],
      [2, 'current', 2, false],
    ])
    expect(rows[1]!.checks.map((check) => [check.kind, check.status, check.revision])).toEqual([
      ['php_lint', 'pending', 2],
      ['preview_smoke', 'pending', 2],
    ])
    // A revision taken by another writer fails on its UNIQUE and writes nothing.
    await expect(
      db.$transaction((tx) => recordCandidate(tx, candidate(row.id, 2))),
    ).rejects.toThrow()
    expect(await db.taskCandidate.count({ where: { taskId: row.id, status: 'current' } })).toBe(1)

    expect(await db.$transaction((tx) => supersedeStandingCandidate(tx, row.id))).toBe(second.id)
    expect(await db.taskCandidate.count({ where: { taskId: row.id, status: 'current' } })).toBe(0)
  })

  it('keeps the description of a plan with its revision, and drops it with the revision', async () => {
    const row = await task({ status: 'running', turnNo: 1 })
    const side = (name: string) => ({
      key: `tasks/${row.id}/db/${name}.json`,
      sha256: 'e'.repeat(64),
      sizeBytes: 90,
    })
    const dbPlan: DbPlan = [
      {
        kind: 'option_update',
        objectRef: 'option:blogname',
        fields: ['value'],
        beforeHash: 'a'.repeat(64),
        afterHash: 'b'.repeat(64),
        before: side('1/before'),
        after: side('1/after'),
      },
    ]
    const dbPlanSha256 = createHash('sha256').update(canonicalDbPlanJson(dbPlan)).digest('hex')
    const dbView: DbPlanView = {
      v: 1,
      planSha256: dbPlanSha256,
      operations: [
        {
          kind: 'option_update',
          index: 0,
          objectRef: 'option:blogname',
          label: 'Название сайта',
          before: 'Цветы',
          after: 'Цветы у дома',
          truncated: false,
        },
      ],
      truncated: false,
      oversize: false,
    }
    const input = { ...candidate(row.id, 1), dbPlan, dbPlanSha256, dbView }
    // A description of another plan, or of none, is no description of this revision.
    for (const broken of [
      { ...input, dbView: { ...dbView, planSha256: 'f'.repeat(64) } },
      { ...candidate(row.id, 1), dbView },
    ])
      await expect(db.$transaction((tx) => recordCandidate(tx, broken))).rejects.toThrow(
        'Invalid candidate',
      )
    const first = await db.$transaction((tx) => recordCandidate(tx, input))
    const stored = await db.taskCandidate.findUniqueOrThrow({ where: { id: first.id } })
    expect(stored.dbView).toEqual(dbView)
    expect(stored.dbViewSha256).toBe(
      createHash('sha256').update(JSON.stringify(dbView)).digest('hex'),
    )
    await db.$transaction((tx) => recordCandidate(tx, candidate(row.id, 2)))
    expect(
      await db.taskCandidate.findUniqueOrThrow({
        where: { id: first.id },
        select: { status: true, dbView: true, dbViewSha256: true },
      }),
    ).toEqual({ status: 'superseded', dbView: null, dbViewSha256: null })

    // A variable set after the builder read the values: the description was not checked for its
    // value, so the revision is recorded without one (Р13); with the versions it read, it is kept.
    await db.siteEnvVar.create({ data: { siteId: row.siteId, name: 'API_TOKEN', keyVersion: 2 } })
    const late = await db.$transaction((tx) =>
      recordCandidate(tx, {
        ...input,
        revision: 3,
        dbViewVariables: [{ name: 'API_TOKEN', keyVersion: 1 }],
      }),
    )
    expect(
      await db.taskCandidate.findUniqueOrThrow({
        where: { id: late.id },
        select: { dbView: true, dbViewSha256: true },
      }),
    ).toEqual({ dbView: null, dbViewSha256: null })
    const checked = await db.$transaction((tx) =>
      recordCandidate(tx, {
        ...input,
        revision: 4,
        dbViewVariables: [{ name: 'API_TOKEN', keyVersion: 2 }],
      }),
    )
    expect(
      (await db.taskCandidate.findUniqueOrThrow({ where: { id: checked.id } })).dbView,
    ).toEqual(dbView)
  })

  it('records a candidate `stale` when its base is not what the site has installed (Р15)', async () => {
    const row = await task({ status: 'running', turnNo: 1 })
    const installed = { sha: 'd'.repeat(40), tree: 'b'.repeat(40) }
    await db.site.update({
      where: { id: row.siteId },
      data: { installedVersion: 'v1.0.0', installedSha: installed.sha, installedAt: new Date() },
    })
    const recordOf = (revision: number, overrides: Partial<CandidateRecordInput>) =>
      db.$transaction((tx) => recordCandidate(tx, { ...candidate(row.id, revision), ...overrides }))
    // The base has the tree of the installed version: it stands on what the site holds.
    expect(await recordOf(1, { installed })).toMatchObject({ status: 'current' })
    // A revision built on the base of a dialog that began before a release of another one: the
    // release installed meanwhile, and its markers ran before this row existed.
    expect(await recordOf(2, { installed, baseTree: 'e'.repeat(40) })).toMatchObject({
      status: 'stale',
    })
    // The builder saw nothing installed, or another version: a release installed after it read.
    expect(await recordOf(3, { installed: null })).toMatchObject({ status: 'stale' })
    expect(
      await recordOf(4, { installed: { sha: 'f'.repeat(40), tree: 'b'.repeat(40) } }),
    ).toMatchObject({ status: 'stale' })
    const rows = await db.taskCandidate.findMany({
      where: { taskId: row.id },
      orderBy: { revision: 'asc' },
      select: { revision: true, status: true },
    })
    expect(rows.map((c) => [c.revision, c.status])).toEqual([
      [1, 'superseded'],
      [2, 'superseded'],
      [3, 'superseded'],
      [4, 'stale'],
    ])
  })

  it('asks the preview manager for a revision only when the dialog has a preview', async () => {
    const row = await task({ status: 'running', turnNo: 1 })
    expect(
      await db.$transaction((tx) => requestPreviewSync(tx, { taskId: row.id, revision: 1 })),
    ).toBe(false)
    const preview = await db.previewEnvironment.create({
      data: {
        siteId: row.siteId,
        taskId: row.id,
        hostname: `site-${row.siteRow.alias}-chat-${row.alias}.localhost`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    expect(
      await db.$transaction((tx) => requestPreviewSync(tx, { taskId: row.id, revision: 1 })),
    ).toBe(true)
    expect(
      await db.$transaction((tx) => requestPreviewSync(tx, { taskId: row.id, revision: 1 })),
    ).toBe(true)
    const jobs = await db.outboxEvent.findMany({
      where: { topic: 'previews', dedupeKey: { startsWith: `preview.sync:${preview.id}` } },
      orderBy: { dedupeKey: 'asc' },
    })
    // A second request for the same revision is a new job: the counter of the row moved.
    expect(jobs.map((job) => job.dedupeKey)).toEqual([
      `preview.sync:${preview.id}:1:2`,
      `preview.sync:${preview.id}:1:3`,
    ])
    expect(await excludeTurnDbOperations(db, { taskId: row.id, turnNo: 1 })).toBe(0)
  })

  it('cancels a waiting dialog only while no release of it is in work', async () => {
    const row = await task({ status: 'running', turnNo: 1 })
    await db.task.update({ where: { id: row.id }, data: { status: 'awaiting_approval' } })
    const recorded = await db.$transaction((tx) => recordCandidate(tx, candidate(row.id, 1)))
    const release = await db.siteRelease.create({
      data: {
        siteId: row.siteId,
        taskId: row.id,
        candidateId: recorded.id,
        candidateRevision: 1,
        attempt: 1,
        releaseKey: 'f'.repeat(64),
        version: 'v0.1.0',
        tag: 'v0.1.0',
        bump: 'minor',
        mainBeforeSha: 'a'.repeat(40),
        committedAt: new Date(),
        approvedAt: new Date(),
      },
    })
    const cancelled: FeedRow = {
      type: 'feed.cancelled',
      payload: { v: 1, turn: 1, by: 'no_answer', site: 'unchanged', credits: 'returned' },
    }
    const input = {
      taskId: row.id,
      from: 'awaiting_approval' as const,
      attempt: 1,
      feed: [cancelled],
    }

    expect((await cancelWaitingTask(db, input)).moved).toBe(false)
    await db.siteRelease.update({ where: { id: release.id }, data: { status: 'failed' } })
    const moved = await cancelWaitingTask(db, input)
    expect(moved.moved).toBe(true)
    expect(await db.task.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'cancelled',
    })
    expect(await db.taskEvent.count({ where: { taskId: row.id, type: 'feed.cancelled' } })).toBe(1)
    expect((await cancelWaitingTask(db, input)).moved).toBe(false)
  })

  it('ends a dialog «Обновить» emptied only while it waits for approval, with no release in work', async () => {
    const row = await task({ status: 'running', turnNo: 1 })
    await db.task.update({ where: { id: row.id }, data: { status: 'awaiting_approval' } })
    const recorded = await db.$transaction((tx) => recordCandidate(tx, candidate(row.id, 1)))
    const release = await db.siteRelease.create({
      data: {
        siteId: row.siteId,
        taskId: row.id,
        candidateId: recorded.id,
        candidateRevision: 1,
        attempt: 1,
        releaseKey: 'e'.repeat(64),
        version: 'v0.1.0',
        tag: 'v0.1.0',
        bump: 'minor',
        mainBeforeSha: 'a'.repeat(40),
        committedAt: new Date(),
        approvedAt: new Date(),
      },
    })
    const input = { taskId: row.id, attempt: 1, turnNo: 1 }

    expect(await finishEmptiedDialog(db, input)).toBe(false)
    await db.siteRelease.update({ where: { id: release.id }, data: { status: 'failed' } })
    // Another turn number or attempt is another dialog's moment.
    expect(await finishEmptiedDialog(db, { ...input, turnNo: 2 })).toBe(false)
    expect(await finishEmptiedDialog(db, { ...input, attempt: 2 })).toBe(false)
    expect(await finishEmptiedDialog(db, input)).toBe(true)
    const done = await db.task.findUniqueOrThrow({ where: { id: row.id } })
    expect(done.status).toBe('done')
    expect(done.finishedAt).not.toBeNull()
    expect(await finishEmptiedDialog(db, input)).toBe(false)
  })
})
