import { randomUUID } from 'node:crypto'

import type { AgentDriverRegistry } from '@repo/agent-drivers'
import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  bindAttachments,
  createAttachment,
  createPrismaClient,
  insertFeedEvent,
  markAttachmentReady,
  openBrowserSession,
  recordCandidate,
  upsertBrowserCheckpoint,
  type PrismaClient,
} from '@repo/db'
import {
  BROWSER_ONLY,
  toTurnPlan,
  type AgentDriver,
  type AgentEvent,
  type TurnEvidence,
} from '@repo/domain'
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
    { browser = false }: { browser?: boolean } = {},
  ) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status: 'queued',
      ...(browser ? { needsRepository: false, needsBrowser: true } : {}),
    })
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
          // A turn without a repository publishes no head (plan 57, Б4).
          headSha: browser ? null : HEAD,
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
    // A pass that changed nothing leaves the dialog open (owner's decision of 26.10.2026).
    expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
      'awaiting_user',
    )
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

  describe('of tasks in the cloud browser (docs/plan/57-browser-tasks.md)', () => {
    const turnResult = {
      summary: 'Сохранил новость',
      change_type: 'content' as const,
      client_message: 'Новость сохранена черновиком.',
      files_changed: [],
      questions: [],
      needs_approval: false,
      risk: 'low' as const,
    }
    const driver = {
      id: sampleDriverId,
      extractResult: (events: readonly AgentEvent[]) =>
        JSON.parse(events.findLast((event) => event.type === 'message')?.text ?? 'null') as unknown,
    } as unknown as AgentDriver

    /** The plan a turn without a repository was assigned with. */
    const planOf = (task: { id: string; siteId: string; workspaceId: string }) =>
      toTurnPlan(
        {
          sandbox: {
            image,
            labels: {
              workspaceId: task.workspaceId,
              siteId: task.siteId,
              taskId: task.id,
              sessionId: task.id,
              turn: 1,
            },
            runtime: 'runc',
            resources: { cpu: 2, memoryMiB: 4096, pids: 512 },
            user: { uid: 10001, gid: 10001 },
            env: {},
            secrets: [],
            network: { mode: 'gateway', routes: ['llm', 'mcp'] },
            hardTimeoutMs: 1_200_000,
          },
          context: {
            taskId: task.id,
            sessionId: task.id,
            turn: 1,
            llm: { baseUrl: 'http://sandbox-gw:8080/llm', model: 'm' },
            mcp: { url: 'http://sandbox-gw:8080/mcp' },
            instructions: 'rules',
          },
          input: { prompt: 'Слова', attachments: [] },
          driverVersion: '1.0.0',
          requirements: BROWSER_ONLY,
          committedAt: new Date().toISOString(),
        },
        sampleDriverId,
      )

    async function closedTurn(phases: Array<[TurnEvidence['phase'], object?]>) {
      const created = await dialog('running', 1, undefined, { browser: true })
      const { taskId, task } = created
      await db.turnAssignment.create({
        data: {
          taskId,
          siteId: task.siteId,
          sessionId: taskId,
          turnNo: 1,
          executor: 'local',
          plan: planOf(task),
          firstEpoch: 1,
          leaseEpoch: 2,
          deadlineAt: new Date(Date.now() + 60_000),
          finishedAt: new Date(),
          outcome: 'completed',
        },
      })
      let sequence = 0
      for (const [phase, extra] of phases)
        await db.taskEvent.create({
          data: {
            taskId,
            type: phase === 'output' ? 'turn.output' : 'turn.lifecycle',
            payload: {
              fence: { siteId: task.siteId, taskId, operation: 'turn', epoch: 2 },
              sessionId: taskId,
              turn: 1,
              sequence: ++sequence,
              phase,
              ...extra,
            },
          },
        })
      return created
    }

    const browserSweep = (
      browser: { verify: ReturnType<typeof vi.fn>; sweep?: ReturnType<typeof vi.fn> },
      live = new LivePasses(),
    ) =>
      new TaskSweep({
        db,
        settlement: new PassSettlement({ db, candidates: null, logger: quiet }),
        live,
        journal: new TaskEventTurnJournal(db),
        drivers: { has: () => true, get: () => driver } as unknown as AgentDriverRegistry,
        queue,
        browser: { verify: browser.verify, sweep: browser.sweep ?? vi.fn() } as never,
        logger: quiet,
      })

    it('ends a closed turn without a head: what the task saved is read on the site first', async () => {
      const { taskId } = await closedTurn([['running'], ['completed', { result: turnResult }]])
      const session = await openBrowserSession(db, { taskId })
      const verify = vi.fn(async () => {
        // The worker records what it found on the site.
        const editUrl = 'https://example.ru/wp-admin/post.php?post=7&action=edit'
        await upsertBrowserCheckpoint(db, {
          taskId,
          sessionId: session.id,
          ref: { kind: 'post', objectId: '7', editUrl },
          state: 'verified',
          verified: {
            kind: 'post',
            objectId: '7',
            title: 'Новость',
            status: 'draft',
            editUrl,
            images: 0,
            files: 0,
            featuredImage: false,
          },
        })
        return true
      })

      expect(await browserSweep({ verify }).settleOrphans()).toBe(1)

      expect(verify).toHaveBeenCalledExactlyOnceWith(taskId)
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('done')
      const [row] = await db.taskEvent.findMany({ where: { taskId, type: 'feed.result' } })
      expect(row!.payload).toMatchObject({ objects: [{ status: 'draft', title: 'Новость' }] })
    })

    it('ends a turn whose checkpoint recovery finished, its result read from the output', async () => {
      const events: AgentEvent[] = [
        { type: 'started', nativeSessionId: 'native1' },
        { type: 'message', text: JSON.stringify(turnResult) },
        { type: 'completed' },
      ]
      const { taskId } = await closedTurn([
        ['running'],
        ['output', { cursor: { stdout: 10, stderr: 0 }, events }],
        ['checkpointing'],
        ['checkpoint_recovered'],
      ])

      expect(await browserSweep({ verify: vi.fn(async () => false) }).settleOrphans()).toBe(1)

      // Nothing confirmed on the site: the client is asked to look, the attempt goes on.
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
        'awaiting_user',
      )
      const [row] = await db.taskEvent.findMany({ where: { taskId, type: 'feed.question' } })
      expect(row!.payload).toMatchObject({ kind: 'browser', reason: 'unconfirmed' })
    })

    it('cancels a waiting task whose reserve ran out, naming what it had saved', async () => {
      const past = new Date(Date.now() - 60_000)
      const { taskId } = await dialog('awaiting_user', 1, past, { browser: true })
      const session = await openBrowserSession(db, { taskId })
      await upsertBrowserCheckpoint(db, {
        taskId,
        sessionId: session.id,
        ref: {
          kind: 'post',
          objectId: '9',
          editUrl: 'https://example.ru/wp-admin/post.php?post=9&action=edit',
        },
        state: 'unverified',
      })

      expect(await sweep().expireHolds()).toBe(1)

      const [row] = await db.taskEvent.findMany({ where: { taskId, type: 'feed.cancelled' } })
      expect(row!.payload).toMatchObject({
        by: 'no_answer',
        objects: [{ kind: 'post', status: 'unconfirmed', title: null }],
      })
    })

    it('compares the browsers with the worker every tick, never taking a live pass for lost', async () => {
      const live = new LivePasses()
      live.enter('0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60')
      const browser = {
        verify: vi.fn(),
        sweep: vi.fn(async (_options: { busy: (taskId: string) => boolean }) => ({
          closed: 0,
          lost: 0,
          orphaned: 0,
        })),
      }

      await browserSweep(browser, live).tick()

      expect(browser.sweep).toHaveBeenCalledOnce()
      const { busy } = browser.sweep.mock.calls[0]![0]
      expect(busy('0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60')).toBe(true)
      expect(busy('0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61')).toBe(false)
    })
  })

  // docs/plan/57-browser-tasks.md, Б26: files nobody sent leave raditi-inbox, then the database.
  it('removes the files nobody sent past their expiry, the object first, never a sent one', async () => {
    const { taskId, task, userId } = await dialog('awaiting_user', 0, undefined, { browser: true })
    const file = async (ready: boolean) => {
      const created = (await createAttachment(db, {
        workspaceId: task.workspaceId,
        siteId: task.siteId,
        uploadedById: userId,
        fileName: 'news.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
      }))!
      if (ready)
        expect(
          await markAttachmentReady(db, {
            id: created.id,
            sizeBytes: 10,
            contentType: 'application/pdf',
          }),
        ).toBe(true)
      return created
    }
    const [uploading, ready, sent, fresh] = [
      await file(false),
      await file(true),
      await file(true),
      await file(true),
    ]
    const binding = { taskId, userId, workspaceId: task.workspaceId, siteId: task.siteId }
    expect(await bindAttachments(db, { ...binding, ids: [sent.id] })).toBe(true)
    await db.$executeRaw`UPDATE attachments SET expires_at = clock_timestamp() - interval '2 hours'
      WHERE id = ANY(${[uploading.id, ready.id, sent.id]}::uuid[])`
    const mine = new Set([uploading, ready, sent, fresh].map((one) => one.s3Key))
    const statusOf = async (key: string) =>
      (await db.attachment.findUniqueOrThrow({ where: { s3Key: key } })).status
    const collector = (inbox: { delete: (bucket: 'inbox', key: string) => Promise<void> }) =>
      new TaskSweep({
        db,
        settlement: new PassSettlement({ db, candidates: null, logger: quiet }),
        live: new LivePasses(),
        journal: new TaskEventTurnJournal(db),
        drivers: { has: () => false } as unknown as AgentDriverRegistry,
        queue,
        inbox,
        logger: quiet,
      })

    // The storage refuses: the rows wait for the next tick.
    const down = { delete: vi.fn(async () => Promise.reject(new Error('S3 is down'))) }
    expect(await collector(down).collectAttachments()).toBe(0)
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining('task sweep attachments'))
    expect(await statusOf(ready.s3Key)).toBe('ready')

    const removed: Array<{ bucket: string; key: string; status: string }> = []
    const inbox = {
      delete: vi.fn(async (bucket: 'inbox', key: string) => {
        if (mine.has(key)) removed.push({ bucket, key, status: await statusOf(key) })
      }),
    }
    expect(await collector(inbox).collectAttachments()).toBeGreaterThanOrEqual(2)
    // The objects of the two files nobody sent, each while its row still names it.
    expect(removed).toEqual(
      expect.arrayContaining([
        { bucket: 'inbox', key: uploading.s3Key, status: 'uploading' },
        { bucket: 'inbox', key: ready.s3Key, status: 'ready' },
      ]),
    )
    expect(removed).toHaveLength(2)
    expect(
      await Promise.all([uploading, ready, sent, fresh].map((one) => statusOf(one.s3Key))),
    ).toEqual(['deleted', 'deleted', 'bound', 'ready'])

    // Once: a next tick finds nothing of them.
    removed.length = 0
    await collector(inbox).collectAttachments()
    expect(removed).toEqual([])
  })
})
