import { randomUUID } from 'node:crypto'

import type { AgentDriverRegistry } from '@repo/agent-drivers'
import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  applyPageVersion,
  bindAttachments,
  createAttachment,
  createPrismaClient,
  insertFeedEvent,
  markAttachmentReady,
  openBrowserSession,
  reserveMemoryChange,
  reservePageChange,
  reservePagePublication,
  reserveScheduleChange,
  upsertBrowserCheckpoint,
  type PrismaClient,
} from '@repo/db'
import {
  BROWSER_ONLY,
  toTurnPlan,
  type AgentDriver,
  type AgentEvent,
  type TurnAction,
  type TurnEvidence,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import { TaskEventTurnJournal } from '../turns/turn-journal.ts'
import { LivePasses } from './live-passes.ts'
import { MEMORY_OUTSIDE_EVENT, MemoryChanges } from './memory-changes.ts'
import { PageChanges } from './page-changes.ts'
import { CHARGE_LATER_EVENT, PassSettlement } from './pass-settlement.ts'
import { ScheduleChanges } from './schedule-changes.ts'
import { ORPHAN_PREPARING_MS, TaskSweep } from './task-sweep.ts'

// The sweep reads every task of the database: only on a disposable one (RADITI_GATEWAY_DB_TESTS).
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
describe.skipIf(!enabled)('the sweep of dialogs with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  const queue = { enqueue: vi.fn(async () => {}) }

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await fixtures.cleanup()
    vi.clearAllMocks()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  const sweep = (now = new Date()) =>
    new TaskSweep({
      db,
      settlement: new PassSettlement({ db, logger: quiet, now: () => now }),
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
      needsBrowser: browser,
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
        },
      })
    await db.$executeRaw`UPDATE tasks SET status = ${status}::"TaskStatus", turn_no = ${turnNo}
      WHERE id = ${taskId}::uuid`
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
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
    const { taskId } = await dialog('preparing', 1)
    const opened = new Date(Date.now() - 10 * 60_000)
    await db.turnAssignment.create({
      data: {
        taskId,
        siteId: taskId,
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
          fence: { siteId: taskId, taskId, operation: 'turn', epoch: 1 },
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
        site: 'none',
        credits: 'returned',
        next: 'awaiting_user',
      },
    ])
  })

  it('puts back in the queue a pass whose core died between the slot of a runner and the prepare', async () => {
    const { taskId, userId } = await dialog('preparing', 1)
    const words = await firstWords(taskId, userId)
    const opened = new Date(Date.now() - 2 * 60_000)
    // What recovery leaves of it: the assignment no runner claimed, given up `lost` (spec §8).
    const assignment = {
      taskId,
      siteId: taskId,
      sessionId: taskId,
      turnNo: 1,
      executor: 'runner' as const,
      plan: {},
      firstEpoch: 1,
      leaseEpoch: 1,
      deadlineAt: new Date(Date.now() + 60_000),
      createdAt: opened,
      finishedAt: new Date(opened.getTime() + 60_000),
      outcome: 'lost' as const,
    }
    await db.turnAssignment.create({ data: assignment })
    await db.$executeRaw`UPDATE tasks SET updated_at = ${new Date(opened.getTime() + 500)}
      WHERE id = ${taskId}::uuid`

    expect(await sweep().settleOrphans()).toBe(1)
    expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      status: 'queued',
      waiting: null,
    })
    expect(queue.enqueue).toHaveBeenCalledWith(
      'agent-turns',
      'turn.run',
      { taskId, attempt: 1, requestEventId: words.toString() },
      { jobId: expect.stringContaining(':retry:orphan-') },
    )
    expect(await db.taskEvent.count({ where: { taskId, type: 'feed.failure' } })).toBe(0)
    // Its reserve waits with it.
    expect(
      (await db.creditHold.findMany({ where: { taskId } })).map((hold) => hold.status),
    ).toEqual(['active'])

    // One a runner claimed may have run: it is ended from its journal, as before.
    const claimed = await dialog('preparing', 1)
    await db.turnAssignment.create({
      data: {
        ...assignment,
        taskId: claimed.taskId,
        siteId: claimed.taskId,
        sessionId: claimed.taskId,
        runnerId: 'runner-1',
        runnerSession: randomUUID(),
        claimedAt: opened,
      },
    })
    await db.$executeRaw`UPDATE tasks SET updated_at = ${new Date(opened.getTime() + 500)}
      WHERE id = ${claimed.taskId}::uuid`
    expect(await sweep().settleOrphans()).toBe(1)
    expect(
      await db.taskEvent.count({ where: { taskId: claimed.taskId, type: 'feed.failure' } }),
    ).toBe(1)
  })

  it('goes on past a row that fails, and leaves a pass that must wait alone for a while', async () => {
    const first = await dialog('running', 1)
    const second = await dialog('running', 1)
    for (const { taskId } of [first, second])
      await db.turnAssignment.create({
        data: {
          taskId,
          siteId: taskId,
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
    const { taskId } = await dialog('running', 1)
    await db.turnAssignment.create({
      data: {
        taskId,
        siteId: taskId,
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
      fence: { siteId: taskId, taskId, operation: 'turn', epoch: 2 },
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

  it('cancels a dialog whose reserve ran out while it waited', async () => {
    const past = new Date(Date.now() - 60_000)
    const waiting = await dialog('awaiting_user', 1, past)
    const fresh = await dialog('awaiting_user', 1)

    expect(await sweep().expireHolds()).toBe(1)

    expect((await db.task.findUniqueOrThrow({ where: { id: waiting.taskId } })).status).toBe(
      'cancelled',
    )
    expect(
      (
        await db.taskEvent.findMany({ where: { taskId: waiting.taskId, type: 'feed.cancelled' } })
      ).map((row) => row.payload),
    ).toEqual([{ v: 1, turn: 1, by: 'no_answer', site: 'none', credits: 'returned' }])
    expect(
      (await db.creditHold.findMany({ where: { taskId: waiting.taskId } })).every(
        (hold) => hold.status === 'expired',
      ),
    ).toBe(true)
    expect((await db.task.findUniqueOrThrow({ where: { id: fresh.taskId } })).status).toBe(
      'awaiting_user',
    )
  })

  // A task is charged pass by pass (owner's answer of 26.10.2026); a pass whose usage was open
  // when it ended left its chain active and a row for the sweep.
  it('charges the chain a pass could not charge when it ended, and leaves a task at work alone', async () => {
    const waiting = await dialog('awaiting_user', 1)
    const working = await dialog('running', 1)
    for (const { taskId } of [waiting, working])
      await db.taskEvent.create({
        data: { taskId, type: CHARGE_LATER_EVENT, payload: { v: 1, attempt: 1 } },
      })

    expect(await sweep().chargeLater()).toBe(1)

    const statuses = async (taskId: string) =>
      (await db.creditHold.findMany({ where: { taskId } })).map((hold) => hold.status)
    // Settled: no recorded work, so nothing is charged and the chain is given back (КР5–КР8).
    expect(new Set(await statuses(waiting.taskId))).toEqual(new Set(['released']))
    expect(new Set(await statuses(working.taskId))).toEqual(new Set(['active']))
    // Settled: the next tick finds nothing more to do.
    expect(await sweep().chargeLater()).toBe(0)
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

  it('puts again the lost job of `/init`: it is a pass, not a press (docs/plan/61, §5.2)', async () => {
    const { taskId, userId } = await dialog('queued', 0)
    await firstWords(taskId, userId)
    const init = await insertFeedEvent(db, {
      taskId,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'agent_command',
          command: 'init',
          authorId: userId,
          requestId: randomUUID(),
        },
      },
    })
    await db.$executeRaw`UPDATE tasks SET updated_at = now() - interval '6 minutes'
      WHERE id = ${taskId}::uuid`

    expect(await sweep().requeueLost()).toBe(1)
    expect(queue.enqueue).toHaveBeenCalledWith(
      'agent-turns',
      'turn.run',
      { taskId, attempt: 1, requestEventId: init.toString() },
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

  // What was done in a browser stays, with a site or without one (docs/plan/61, К18, Б28).
  it.each([['a chat whose browser acted', { browser: true }, 'elsewhere']] as const)(
    'tells %s what it left',
    async (_, kind, site) => {
      const past = new Date(Date.now() - 60_000)
      const { taskId } = await dialog('awaiting_user', 1, past, kind)
      const { workspaceId } = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      await db.browserSession.create({
        data: {
          taskId,
          workspaceId,
          status: 'ready',
          readyAt: new Date(),
          expiresAt: new Date(Date.now() + 3_600_000),
          wroteAt: new Date(),
          lastWroteAt: new Date(),
        },
      })

      expect(await sweep().expireHolds()).toBe(1)

      expect(
        (await db.taskEvent.findMany({ where: { taskId, type: 'feed.cancelled' } })).map(
          (row) => row.payload,
        ),
      ).toEqual([{ v: 1, turn: 1, by: 'no_answer', site, credits: 'returned' }])
    },
  )

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
    const planOf = (task: { id: string; workspaceId: string }) =>
      toTurnPlan(
        {
          sandbox: {
            image,
            labels: {
              workspaceId: task.workspaceId,
              siteId: task.id,
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

    async function closedTurn(
      phases: Array<[TurnEvidence['phase'], object?]>,
      action?: TurnAction,
      repository?: Record<string, unknown>,
    ) {
      const created = await dialog('running', 1, undefined, { browser: true })
      const { taskId, task } = created
      const base = planOf(task)
      // A plan of a turn with a repository: the same, with the block its schema requires.
      const plan = (
        repository
          ? { ...base, requirements: { repository: true, browser: true }, repository }
          : base
      ) as typeof base
      await db.turnAssignment.create({
        data: {
          taskId,
          siteId: taskId,
          sessionId: taskId,
          turnNo: 1,
          executor: 'local',
          plan: action ? { ...plan, input: { ...plan.input, action } } : plan,
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
              fence: { siteId: taskId, taskId, operation: 'turn', epoch: 2 },
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
      extra: Partial<ConstructorParameters<typeof TaskSweep>[0]> = {},
    ) =>
      new TaskSweep({
        ...extra,
        db,
        settlement: new PassSettlement({ db, logger: quiet }),
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
      // The answer leaves the dialog open, as with the repository (owner's answer of 26.10.2026).
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
        'awaiting_user',
      )
      const [row] = await db.taskEvent.findMany({ where: { taskId, type: 'feed.result' } })
      expect(row!.payload).toMatchObject({
        next: 'awaiting_user',
        objects: [{ status: 'draft', title: 'Новость' }],
      })
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

      // Nothing confirmed on the site: the agent's answer stands all the same, and the dialog
      // stays open (owner's answer of 26.10.2026: no result needs confirming).
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
        'awaiting_user',
      )
      const [row] = await db.taskEvent.findMany({ where: { taskId, type: 'feed.result' } })
      expect(row!.payload).toMatchObject({ next: 'awaiting_user', site: 'none' })
    })

    it('ends a turn whose publication recovery finished: the answer, and the card of its commit (ПР12)', async () => {
      const events: AgentEvent[] = [
        { type: 'started', nativeSessionId: 'native1' },
        { type: 'message', text: JSON.stringify(turnResult) },
        { type: 'completed' },
      ]
      const repository = {
        projectId: randomUUID(),
        projectRepositoryId: randomUUID(),
        provider: 'gitlab',
        baseSha: 'a'.repeat(40),
        sandboxBaseSha: 'b'.repeat(40),
        branch: 'raditi/chat-1',
        mode: 'write',
        expectedRef: null,
        bundleSha256: 'c'.repeat(64),
        bundleBytes: 100,
        hiddenPaths: [],
      }
      const recovered = { baseSha: 'a'.repeat(40), candidateHeadSha: 'd'.repeat(40) }
      const { taskId } = await closedTurn(
        [
          ['running'],
          ['output', { cursor: { stdout: 10, stderr: 0 }, events }],
          ['checkpointing'],
          ['checkpointed', recovered],
          ['destroyed', recovered],
          ['publishing', recovered],
          ['publication_recovered', recovered],
        ],
        undefined,
        repository,
      )
      const patch = Buffer.from('diff --git a/hours.md b/hours.md\n')
      const buildSettingsChange = vi.fn(async () => ({ paths: [], patch, config: null }))
      const apply = vi.fn(async () => {})
      const swept = new TaskSweep({
        db,
        settlement: new PassSettlement({ db, logger: quiet }),
        live: new LivePasses(),
        journal: new TaskEventTurnJournal(db),
        drivers: { has: () => true, get: () => driver } as unknown as AgentDriverRegistry,
        queue,
        browser: { verify: vi.fn(async () => false), sweep: vi.fn() } as never,
        repositories: { workspace: { buildSettingsChange }, changes: { apply } },
        logger: quiet,
      })

      expect(await swept.settleOrphans()).toBe(1)

      // The answer reaches the client, as after any turn: the publication was not a failure.
      expect(await db.taskEvent.count({ where: { taskId, type: 'feed.failure' } })).toBe(0)
      expect(await db.taskEvent.count({ where: { taskId, type: 'feed.result' } })).toBe(1)
      // The head stands from the settlement itself (ревью C1), not only from the card.
      expect(
        await db.taskTurn.findFirstOrThrow({
          where: { taskId, turnNo: 1 },
          select: { baseSha: true, headSha: true },
        }),
      ).toEqual({ baseSha: recovered.baseSha, headSha: recovered.candidateHeadSha })
      expect(buildSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          projectRepositoryId: repository.projectRepositoryId,
          from: recovered.baseSha,
          to: recovered.candidateHeadSha,
        }),
      )
      expect(apply).toHaveBeenCalledExactlyOnceWith(
        taskId,
        1,
        { baseSha: recovered.baseSha, headSha: recovered.candidateHeadSha, patch, buildPaths: [] },
        {
          projectRepositoryId: repository.projectRepositoryId,
          branch: 'raditi/chat-1',
          mode: 'write',
        },
      )
    })

    it('ends a compaction that recovery finished by the line of the platform: its text is no result', async () => {
      const events: AgentEvent[] = [
        { type: 'started', nativeSessionId: 'native1' },
        { type: 'message', text: 'Краткий пересказ для следующего хода' },
        { type: 'completed' },
      ]
      const phases: Array<[TurnEvidence['phase'], object?]> = [
        ['running'],
        ['output', { cursor: { stdout: 10, stderr: 0 }, events }],
        ['checkpointing'],
        ['checkpoint_recovered'],
      ]
      const { taskId } = await closedTurn(phases, 'compact')

      expect(await browserSweep({ verify: vi.fn(async () => false) }).settleOrphans()).toBe(1)

      expect(await db.taskEvent.count({ where: { taskId, type: 'feed.failure' } })).toBe(0)
      const [row] = await db.taskEvent.findMany({ where: { taskId, type: 'feed.result' } })
      expect(row!.payload).toMatchObject({
        message: 'Готово: переписка сжата. Агент продолжит с её кратким пересказом.',
        next: 'awaiting_user',
      })
    })

    // docs/plan/84-projects.md, §10 «Открытое после ревью»: a turn whose end recovery reached
    // applies what a live end applies — pages, scheduled tasks, memory — with the same checks.
    describe('the changes of a turn whose end recovery reached', () => {
      const VALUE = 'синтетическое-значение-переменной'
      const turnKey = `sk-rdt-${'Q'.repeat(43)}`
      const repository = {
        projectId: randomUUID(),
        projectRepositoryId: randomUUID(),
        provider: 'gitlab',
        baseSha: 'a'.repeat(40),
        sandboxBaseSha: 'b'.repeat(40),
        branch: 'raditi/chat-1',
        mode: 'write',
        expectedRef: null,
        bundleSha256: 'c'.repeat(64),
        bundleBytes: 100,
        hiddenPaths: [],
      }
      const recovered = { baseSha: 'a'.repeat(40), candidateHeadSha: 'd'.repeat(40) }
      const kinds = {
        checkpoint_recovered: {
          phases: [['checkpointing'], ['checkpoint_recovered']],
          repository: undefined,
        },
        publication_recovered: {
          phases: [
            ['checkpointing'],
            ['checkpointed', recovered],
            ['destroyed', recovered],
            ['publishing', recovered],
            ['publication_recovered', recovered],
          ],
          repository,
        },
      } as const

      async function recoveredTurn(
        kind: keyof typeof kinds,
        tools: string[] = ['raditi_memory_save'],
      ) {
        const events: AgentEvent[] = [
          { type: 'started', nativeSessionId: 'native1' },
          ...tools.map((tool) => ({ type: 'tool_call' as const, tool, ok: true })),
          { type: 'message', text: JSON.stringify(turnResult) },
          { type: 'completed' },
        ]
        const { phases, repository: withRepository } = kinds[kind]
        const created = await closedTurn(
          [
            ['running'],
            ['output', { cursor: { stdout: 10, stderr: 0 }, events }],
            ...(phases as unknown as Array<[TurnEvidence['phase'], object?]>),
          ],
          undefined,
          withRepository,
        )
        // The chat of its author: only he manages the pages and the memory of it.
        await db.task.update({
          where: { id: created.taskId },
          data: { createdById: created.userId },
        })
        return created
      }

      async function reserveAll(taskId: string, workspaceId: string, userId: string) {
        const scope = { workspaceId, userId, projectId: null }
        for (const text of ['Цены — только из прайса', `Склад: ${VALUE}`])
          await reserveMemoryChange(db, {
            taskId,
            turnNo: 1,
            scope,
            change: { kind: 'save', entryKind: 'fact', text },
          })
        // A key of a turn the reservation let through (the role checks its form too): the end of
        // a recovered turn, which no longer holds the key, refuses it by the form.
        await db.memoryReservation.create({
          data: {
            id: randomUUID(),
            workspaceId,
            taskId,
            turnNo: 1,
            kind: 'save',
            payload: { projectId: null, kind: 'fact', text: `Адрес: ${turnKey}` },
          },
        })
        for (const instructions of ['Откройте главную.', `Войдите с паролем ${VALUE}.`])
          await reserveScheduleChange(db, {
            workspaceId,
            taskId,
            turnNo: 1,
            now: new Date(),
            change: {
              kind: 'create',
              name: instructions === 'Откройте главную.' ? 'Проверка сайта' : 'Вход',
              instructions,
              triggers: [{ kind: 'daily', time: '09:00' }],
            },
          })
        // A page the turn published, renamed and then given a title with a value.
        const home = await reservePagePublication(db, {
          workspaceId,
          taskId,
          turnNo: 1,
          title: 'Главная',
          target: { fileName: `${randomUUID()}.html` },
        })
        const publication = await db.pageReservation.findFirstOrThrow({
          where: { pageId: home.pageId, outcome: null },
        })
        await applyPageVersion(db, {
          pageId: home.pageId,
          bytes: new TextEncoder().encode('<p>Главная</p>'),
          source: 'outbox',
          reservationId: publication.id,
        })
        await reservePageChange(db, {
          workspaceId,
          taskId,
          turnNo: 1,
          change: { kind: 'update', pageId: home.pageId, expectedVersion: 1, title: 'О нас' },
        })
        await reservePageChange(db, {
          workspaceId,
          taskId,
          turnNo: 1,
          change: { kind: 'update', pageId: home.pageId, expectedVersion: 1, title: VALUE },
        })
        return home
      }

      const changesSweep = (siteValues: () => Promise<string[]>) =>
        new TaskSweep({
          db,
          settlement: new PassSettlement({ db, logger: quiet }),
          live: new LivePasses(),
          journal: new TaskEventTurnJournal(db),
          drivers: { has: () => true, get: () => driver } as unknown as AgentDriverRegistry,
          queue,
          browser: { verify: vi.fn(async () => false), sweep: vi.fn() } as never,
          memory: new MemoryChanges({ db, logger: quiet }),
          schedules: new ScheduleChanges({ db, logger: quiet }),
          pageChanges: new PageChanges({ db, logger: quiet }),
          values: { siteValues: vi.fn(siteValues) },
          logger: quiet,
        })

      const feed = async (taskId: string) =>
        (
          await db.taskEvent.findMany({
            where: { taskId, type: { startsWith: 'feed.' } },
            orderBy: { id: 'asc' },
            select: { type: true, payload: true },
          })
        ).map((row) => [row.type, row.payload] as const)

      async function removeChanges(workspaceId: string) {
        await db.memoryEntry.deleteMany({ where: { workspaceId } })
        await db.scheduledTask.deleteMany({ where: { workspaceId } })
        await db.pageTree.deleteMany({ where: { workspaceId } })
      }

      for (const kind of ['checkpoint_recovered', 'publication_recovered'] as const)
        it(`applies them after the answer of a turn ending ${kind}, refusing a value and a key`, async () => {
          const { taskId, task, userId } = await recoveredTurn(kind)
          try {
            const home = await reserveAll(taskId, task.workspaceId, userId)

            expect(await changesSweep(async () => [VALUE]).settleOrphans()).toBe(1)

            const rows = await feed(taskId)
            const types = rows.map(([type]) => type)
            // After the answer, in the order of the live end: pages, scheduled tasks, memory.
            expect(types.indexOf('feed.result')).toBeLessThan(types.indexOf('feed.page_change'))
            expect(types.indexOf('feed.page_change')).toBeLessThan(
              types.indexOf('feed.schedule_change'),
            )
            expect(types.indexOf('feed.schedule_change')).toBeLessThan(
              types.indexOf('feed.memory_change'),
            )
            expect(rows.filter(([type]) => type === 'feed.page_change')).toEqual([
              [
                'feed.page_change',
                expect.objectContaining({ pageId: home.pageId, title: 'О нас', change: 'updated' }),
              ],
            ])
            expect(rows.filter(([type]) => type === 'feed.page_left')).toEqual([
              ['feed.page_left', { v: 1, pageId: home.pageId, reason: 'refused', of: 'change' }],
            ])
            expect(
              await db.page.findUniqueOrThrow({
                where: { id: home.pageId },
                select: { title: true },
              }),
            ).toEqual({ title: 'О нас' })
            // The scheduled task is made; the one with the value is refused and told.
            expect(
              (
                await db.scheduledTask.findMany({
                  where: { sourceTaskId: taskId },
                  select: { name: true },
                })
              ).map(({ name }) => name),
            ).toEqual(['Проверка сайта'])
            expect(rows.filter(([type]) => type === 'feed.schedule_left')).toHaveLength(1)
            // The note is kept, only «Предложено»: the client's words were not read again.
            expect(
              await db.memoryEntry.findMany({
                where: { sourceTaskId: taskId },
                select: { text: true, status: true },
              }),
            ).toEqual([{ text: 'Цены — только из прайса', status: 'proposed' }])
            expect(rows.filter(([type]) => type.startsWith('feed.memory_'))).toEqual([
              [
                'feed.memory_change',
                expect.objectContaining({ action: 'proposed', text: 'Цены — только из прайса' }),
              ],
              ['feed.memory_left', { v: 1, action: 'save', reason: 'secret' }],
              ['feed.memory_left', { v: 1, action: 'save', reason: 'secret' }],
            ])
            // Nothing of the turn is left open for the sweeps to close as failed.
            expect(await db.memoryReservation.count({ where: { taskId, outcome: null } })).toBe(0)
            expect(await db.scheduleReservation.count({ where: { taskId, outcome: null } })).toBe(0)
            expect(await db.pageReservation.count({ where: { taskId, outcome: null } })).toBe(0)
            // Nothing outside came into this turn: no mark that keeps later notes proposed.
            expect(
              await db.taskEvent.count({ where: { taskId, type: MEMORY_OUTSIDE_EVENT } }),
            ).toBe(0)
          } finally {
            await removeChanges(task.workspaceId)
          }
        })

      it('marks the chat when its recovered turn took in something from outside', async () => {
        const { taskId, task, userId } = await recoveredTurn('checkpoint_recovered', ['webfetch'])
        try {
          await reserveAll(taskId, task.workspaceId, userId)
          expect(await changesSweep(async () => []).settleOrphans()).toBe(1)
          expect(await db.taskEvent.count({ where: { taskId, type: MEMORY_OUTSIDE_EVENT } })).toBe(
            1,
          )
        } finally {
          await removeChanges(task.workspaceId)
        }
      })

      it('without the values, closes the memory failed and told, and leaves pages and tasks to their sweeps', async () => {
        const { taskId, task, userId } = await recoveredTurn('publication_recovered')
        try {
          await reserveAll(taskId, task.workspaceId, userId)

          expect(
            await changesSweep(async () => {
              throw new Error('Vault is away')
            }).settleOrphans(),
          ).toBe(1)

          expect(await db.taskEvent.count({ where: { taskId, type: 'feed.result' } })).toBe(1)
          expect(await db.memoryEntry.count({ where: { sourceTaskId: taskId } })).toBe(0)
          expect((await feed(taskId)).filter(([type]) => type === 'feed.memory_left')).toEqual(
            Array.from({ length: 3 }, () => [
              'feed.memory_left',
              { v: 1, action: 'save', reason: 'failed' },
            ]),
          )
          // Unchecked, never applied: their own sweeps close and tell them.
          expect(await db.scheduledTask.count({ where: { sourceTaskId: taskId } })).toBe(0)
          expect(await db.scheduleReservation.count({ where: { taskId, outcome: null } })).toBe(2)
          expect(await db.pageReservation.count({ where: { taskId, outcome: null } })).toBe(2)
        } finally {
          await removeChanges(task.workspaceId)
        }
      })
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

    it('checks the writes in artifacts of a turn it ends before the answer, or drops them (plan 88, Ар16)', async () => {
      const outcome = { checked: 0, refused: 0, dropped: 0 }
      type Call = (taskId: string, turn: number | null, refuses: unknown) => Promise<typeof outcome>
      const artifacts = {
        settle: vi.fn<Call>(async () => outcome),
        fail: vi.fn<Call>(async () => outcome),
        sweep: vi.fn(async () => 0),
      }
      const values = { siteValues: vi.fn(async () => ['synthetic-value-0003']) }
      const done = await closedTurn([['running'], ['completed', { result: turnResult }]])
      const statuses: string[] = []
      artifacts.settle.mockImplementation(async (taskId: string) => {
        statuses.push((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status)
        return outcome
      })
      const sweep = browserSweep({ verify: vi.fn(async () => true) }, new LivePasses(), {
        artifacts,
        values: values as never,
      })
      await sweep.settleOrphans()
      expect(artifacts.settle).toHaveBeenCalledOnce()
      expect(artifacts.settle.mock.calls[0]?.[0]).toBe(done.taskId)
      const refuses = artifacts.settle.mock.calls[0]?.[2] as unknown as (text: string) => unknown
      expect(refuses('синтетика synthetic-value-0003')).toBe('client_value')
      // Before the answer: the client reads the answer after the writes are settled.
      expect(statuses).toEqual(['running'])

      const lost = await closedTurn([['running']])
      await sweep.settleOrphans()
      expect(artifacts.fail.mock.calls.map((call) => call[0])).toContain(lost.taskId)
    })

    it('runs the collector of artifacts every tick, never taking a live pass for lost', async () => {
      const live = new LivePasses()
      live.enter('0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60')
      const artifacts = {
        settle: vi.fn(),
        fail: vi.fn(),
        sweep: vi.fn(async (_options: { busy: (id: string) => boolean }) => 0),
      }
      await browserSweep({ verify: vi.fn(), sweep: vi.fn() }, live, { artifacts }).tick()
      expect(artifacts.sweep).toHaveBeenCalledOnce()
      const { busy } = artifacts.sweep.mock.calls[0]![0]
      expect(busy('0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60')).toBe(true)
      expect(busy('0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61')).toBe(false)
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
    const binding = { taskId, userId, workspaceId: task.workspaceId }
    expect(await bindAttachments(db, { ...binding, ids: [sent.id] })).toBe(true)
    await db.$executeRaw`UPDATE attachments SET expires_at = clock_timestamp() - interval '2 hours'
      WHERE id = ANY(${[uploading.id, ready.id, sent.id]}::uuid[])`
    const mine = new Set([uploading, ready, sent, fresh].map((one) => one.s3Key))
    const statusOf = async (key: string) =>
      (await db.attachment.findUniqueOrThrow({ where: { s3Key: key } })).status
    const collector = (inbox: { delete: (bucket: 'inbox', key: string) => Promise<void> }) =>
      new TaskSweep({
        db,
        settlement: new PassSettlement({ db, logger: quiet }),
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
