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
  type PrismaClient,
} from '@repo/db'
import {
  siteBusy,
  subscriptionBusy,
  subscriptionWait,
  toTurnPlan,
  type AgentDriver,
  type SnapshotManifest,
  type TurnCredentialPolicy,
  type UnkeyedTurnRequest,
} from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { sampleBackendId, sampleDriverId, sampleModelSlug } from '../testing/ids.ts'
import type { TurnRunHooks, TurnSupervisor } from '../turns/turn-supervisor.ts'
import { LivePasses } from './live-passes.ts'
import { DEFAULT_WORKSPACE_TURN_LIMIT, PassRunner } from './pass-runner.ts'
import { TurnCapacity } from './turn-capacity.ts'
import { PassSettlement } from './pass-settlement.ts'
import { INIT_PROMPT } from './turn-instructions.ts'

// The handler of a pass on PostgreSQL. The first suite runs wherever a database is given: a
// task without a reserve is never run, in every environment (spec §20 «Задачи до биллинга»,
// the second of the two independent checks; the first is tRPC's). The second one switches a
// profile on and commits a credit rate: only on a disposable database (RADITI_GATEWAY_DB_TESTS).
const databaseUrl = process.env.DATABASE_URL
const gateway = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const NOW = new Date('2026-10-17T10:00:00.000Z')
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

const driver = {
  id: sampleDriverId,
  image,
  cliVersion: '1.0.0',
  capabilities: {
    resume: true,
    jsonEvents: true,
    outputSchema: false,
    mcp: true,
    images: false,
    reasoningEvents: false,
    compaction: false,
  },
  prepare: vi.fn(),
  command: vi.fn(),
  parseEvent: vi.fn(),
  sessionState: () => ({ root: `/agent-home/${sampleDriverId}`, include: ['s.db'], exclude: [] }),
  extractResult: vi.fn(),
} satisfies AgentDriver
const drivers = {
  list: () => [driver],
  get: () => driver,
  has: () => true,
} as unknown as AgentDriverRegistry
type Run = (
  request: UnkeyedTurnRequest,
  policy: TurnCredentialPolicy,
  signal?: AbortSignal,
  hooks?: TurnRunHooks,
) => Promise<unknown>

describe.skipIf(!databaseUrl)('the handler of a pass with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>

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

  /**
   * A queued chat of a client with the gift of the registration, and its first words; with
   * `browser`, a chat with the cloud browser (docs/plan/83-remove-projects.md: no chat has a site).
   */
  async function queued({ reserve, browser = false }: { reserve: boolean; browser?: boolean }) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status: 'queued',
      needsBrowser: browser,
    })
    const requestEventId = await insertFeedEvent(db, {
      taskId,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'first',
          authorId: userId,
          requestId: randomUUID(),
          text: 'Поменяйте телефон в шапке',
        },
      },
    })
    if (reserve)
      await fixtures.reserve({
        workspaceId: workspace.id,
        taskId,
        attempt: 1,
        now: NOW,
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      })
    return {
      taskId,
      userId,
      workspaceId: workspace.id,
      job: { taskId, attempt: 1, requestEventId: requestEventId.toString() },
    }
  }

  function runner(
    run: Run | null,
    inspect: () => Promise<unknown> = async () => null,
    options: {
      browser?: { reclaim: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> } | null
      docs?: { settle: ReturnType<typeof vi.fn>; checkLive?: ReturnType<typeof vi.fn> }
      capacity?: TurnCapacity
    } = {},
  ) {
    const queue = { enqueue: vi.fn(async () => {}) }
    const close = vi.fn(async () => {})
    const live = new LivePasses()
    const settlement = new PassSettlement({
      db,
      browser: { close },
      logger: quiet,
      now: () => NOW,
    })
    const supervisor = run ? ({ run: vi.fn(run) } as unknown as TurnSupervisor) : null
    const passes = new PassRunner({
      db,
      supervisor,
      ...(options.browser !== undefined ? { browser: options.browser as never } : {}),
      ...(options.docs ? { docs: options.docs as never } : {}),
      drivers,
      backends: llmBackends,
      leases: { inspect: vi.fn(inspect) as never },
      runtime: 'runc',
      settlement,
      live,
      queue,
      logger: quiet,
      ...(options.capacity ? { capacity: options.capacity } : {}),
      liveDocCheckMs: 5,
      now: () => NOW,
    })
    return { passes, queue, supervisor, close, live }
  }

  const failure = async (taskId: string) =>
    (await db.taskEvent.findMany({ where: { taskId, type: 'feed.failure' } })).map(
      (row) => row.payload,
    )

  it('never runs a task that should hold a reserve and holds none', async () => {
    const dialog = await queued({ reserve: false })
    const run = vi.fn<Run>()
    const { passes } = runner(run)

    await passes.run(dialog.job)

    expect(run).not.toHaveBeenCalled()
    // The dialog stays open (28.10.2026): the client's next words place the reserve it lacked.
    expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
      status: 'awaiting_user',
      turnNo: 0,
    })
    expect(await failure(dialog.taskId)).toEqual([
      {
        v: 1,
        turn: null,
        code: 'unavailable',
        site: 'none',
        credits: null,
        next: 'awaiting_user',
      },
    ])
  })

  // The owner, 06.11 and 12.11.2026: «до 8 сендбоксов на одного клиента» (plan 70, ВР13).
  it('lets a pass wait while its workspace runs eight others, as for a busy pool', async () => {
    const dialog = await queued({ reserve: true })
    const { workspaceId } = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
    for (let i = 0; i < DEFAULT_WORKSPACE_TURN_LIMIT; i++)
      await fixtures.task(workspaceId, { status: i % 2 === 0 ? 'running' : 'preparing' })
    const run = vi.fn<Run>()
    const { passes, queue } = runner(run)

    await passes.run(dialog.job)

    expect(run).not.toHaveBeenCalled()
    expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
      status: 'queued',
      waiting: 'agents',
    })
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    // Its reserve stays: the pass goes as soon as one of the eight ends.
    expect(
      (await db.creditHold.findMany({ where: { taskId: dialog.taskId } })).map((h) => h.status),
    ).toEqual(['active'])
  })

  it('lets a pass wait for a place of the platform, and wakes it when a pass ends', async () => {
    // Plan 70, ВР17: the places of the platform are taken; the pass gives its worker up at once.
    const capacity = new TurnCapacity({ slots: () => 1 })
    const held = capacity.tryAcquire()!
    const dialog = await queued({ reserve: true })
    const run = vi.fn<Run>()
    const { passes, queue } = runner(run, async () => null, { capacity })

    await passes.run(dialog.job)

    expect(run).not.toHaveBeenCalled()
    expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
      status: 'queued',
      waiting: 'agents',
    })
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(
      (await db.creditHold.findMany({ where: { taskId: dialog.taskId } })).map((h) => h.status),
    ).toEqual(['active'])
    held()
    expect(capacity.held).toBe(0)

    // Another pass of its workspace takes the place and ends: the waiting pass is woken. The
    // waiting chat joins the workspace of the other one; nothing settles it afterwards.
    const other = await queued({ reserve: true })
    const { workspaceId } = await db.task.findUniqueOrThrow({ where: { id: other.taskId } })
    await db.task.update({ where: { id: dialog.taskId }, data: { workspaceId } })
    const wakes = await db.outboxEvent.count({
      where: { payload: { path: ['taskId'], equals: dialog.taskId } },
    })
    await runner(vi.fn<Run>(), async () => null, { capacity }).passes.run(other.job)
    expect(capacity.held).toBe(0)
    expect(
      await db.outboxEvent.count({
        where: { payload: { path: ['taskId'], equals: dialog.taskId } },
      }),
    ).toBeGreaterThan(wakes)
  })

  it('takes no pass of another attempt', async () => {
    const dialog = await queued({ reserve: false })
    const { passes } = runner(vi.fn<Run>())

    await passes.run({ ...dialog.job, attempt: 2 })
    expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe(
      'queued',
    )
  })

  it('takes a pass of its attempt only once, however often its job comes', async () => {
    const dialog = await queued({ reserve: false })
    const { passes } = runner(vi.fn<Run>())

    // Two deliveries of one job at once, then a third one after them.
    await Promise.all([passes.run(dialog.job), passes.run(dialog.job)])
    await passes.run(dialog.job)

    // One claim, one ending: the pass without a reserve failed once, with one feed row.
    expect(await failure(dialog.taskId)).toHaveLength(1)
    expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe(
      'awaiting_user',
    )
  })

  it('closes a dialog that waits when its «Отменить» comes after its pass ended', async () => {
    const dialog = await queued({ reserve: true })
    await db.task.update({ where: { id: dialog.taskId }, data: { status: 'awaiting_user' } })
    const press = await insertFeedEvent(db, {
      taskId: dialog.taskId,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'command',
          command: 'cancel',
          authorId: dialog.userId,
          requestId: randomUUID(),
        },
      },
    })
    const { passes } = runner(vi.fn<Run>())

    await passes.cancel({ taskId: dialog.taskId, requestEventId: press.toString() })

    expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe(
      'cancelled',
    )
    expect(
      await db.taskEvent.count({ where: { taskId: dialog.taskId, type: 'feed.cancelled' } }),
    ).toBe(1)
  })

  it('cancels a pass whose handler is gone when the client presses «Отменить»', async () => {
    const dialog = await queued({ reserve: true })
    await db.task.update({ where: { id: dialog.taskId }, data: { status: 'preparing' } })
    const { passes } = runner(vi.fn<Run>())

    await passes.cancel({ taskId: dialog.taskId, requestEventId: dialog.job.requestEventId })

    expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe(
      'cancelled',
    )
    expect(
      (
        await db.taskEvent.findMany({ where: { taskId: dialog.taskId, type: 'feed.cancelled' } })
      ).map((row) => row.payload),
    ).toEqual([{ v: 1, turn: null, by: 'customer', site: 'none', credits: 'returned' }])
  })

  describe.skipIf(!gateway)('with a profile switched on and a credit rate', () => {
    let switched: { providerId: string; modelId: string; priceId: string } | null = null

    beforeAll(async () => {
      const provider = await db.llmProvider.update({
        where: { slug: sampleBackendId },
        data: { enabled: true },
      })
      const model = await db.llmModel.update({
        where: { providerId_slug: { providerId: provider.id, slug: sampleModelSlug } },
        data: { enabled: true },
      })
      const effectiveFrom = new Date('2026-01-01T00:00:00.000Z')
      const price = await fixtures.modelPrice({ modelId: model.id }, { effectiveFrom })
      switched = { providerId: provider.id, modelId: model.id, priceId: price.id }
    })
    afterAll(async () => {
      if (!switched) return
      await db.llmModelPrice.delete({ where: { id: switched.priceId } })
      await db.llmModel.update({ where: { id: switched.modelId }, data: { enabled: false } })
      await db.llmProvider.update({ where: { id: switched.providerId }, data: { enabled: false } })
    })
    const rate = () => fixtures.creditRate({ effectiveFrom: new Date('2026-01-01T00:00:00.000Z') })
    /**
     * One model call of turn 1 of the task, 12 RUB — two credits at the rate of `rate`: a pass is
     * charged its work, with no minimum (КР5–КР8), so a pass that is to be charged records some.
     */
    const worked = async (taskId: string) => {
      const pool = await fixtures.modelPool()
      const price = await fixtures.modelPrice(pool, {
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      })
      await fixtures.modelCall({
        taskId,
        pool,
        priceId: price.id,
        costRub: '12.00',
        occurredAt: NOW,
      })
    }

    it('checks the sections of documents with the turn’s own check before the answer (plan 69, Ст19)', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      const refusesText = () => null
      const seen: string[] = []
      const docs = {
        settle: vi.fn(async (taskId: string) => {
          // Before the pass ends: the client reads the answer after the sections are settled.
          seen.push((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status)
        }),
      }
      const { passes } = runner(
        async () => {
          await db.task.update({
            where: { id: dialog.taskId },
            data: { status: 'running', turnNo: 1 },
          })
          await db.taskTurn.create({
            data: {
              taskId: dialog.taskId,
              turnNo: 1,
              status: 'completed',
              driverId: sampleDriverId,
              image,
            },
          })
          await worked(dialog.taskId)
          return {
            result: {
              summary: 'Готово',
              change_type: 'none',
              client_message: 'Документ готов.',
              files_changed: [],
              questions: [],
              needs_approval: false,
              risk: 'low',
            },
            manifest: {} as SnapshotManifest,
            refusesText,
          }
        },
        undefined,
        { docs },
      )
      await passes.run(dialog.job)
      expect(docs.settle).toHaveBeenCalledWith(dialog.taskId, 1, refusesText)
      expect(seen).toEqual(['running'])
    })

    it('checks the sections while the turn runs once it holds its keys, and stops with it (plan 74, Д2)', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      const refuses = () => null
      const docs = { settle: vi.fn(async () => {}), checkLive: vi.fn(async () => {}) }
      const { passes } = runner(
        async (_request, _policy, _signal, hooks) => {
          await new Promise((resolve) => setTimeout(resolve, 30))
          // Not armed yet: nothing is checked before the turn holds what it checks with.
          expect(docs.checkLive).not.toHaveBeenCalled()
          hooks?.onArmed?.(async () => refuses)
          await vi.waitFor(() => expect(docs.checkLive).toHaveBeenCalled())
          throw new Error('the sandbox is gone')
        },
        undefined,
        { docs },
      )
      await passes.run(dialog.job)
      expect(docs.checkLive).toHaveBeenCalledWith(dialog.taskId, 1, refuses)
      const calls = docs.checkLive.mock.calls.length
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(docs.checkLive.mock.calls.length).toBe(calls)
    })

    it('checks nothing while the values of the variables cannot be read (plan 74, Д2)', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      const docs = { settle: vi.fn(async () => {}), checkLive: vi.fn(async () => {}) }
      const refusal = vi.fn(async () => {
        throw new Error('vault is down')
      })
      const { passes } = runner(
        async (_request, _policy, _signal, hooks) => {
          hooks?.onArmed?.(refusal)
          await vi.waitFor(() => expect(refusal.mock.calls.length).toBeGreaterThan(1))
          throw new Error('the sandbox is gone')
        },
        undefined,
        { docs },
      )
      await passes.run(dialog.job)
      expect(docs.checkLive).not.toHaveBeenCalled()
    })

    it('checks no sections after a turn that failed: they wait for the next end of a turn', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      const docs = { settle: vi.fn(async () => {}) }
      const { passes } = runner(
        async () => {
          throw new Error('the sandbox is gone')
        },
        undefined,
        { docs },
      )
      await passes.run(dialog.job)
      expect(docs.settle).not.toHaveBeenCalled()
    })

    it('plans the turn, runs it under the supervisor and ends the pass', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      let planned: { request: UnkeyedTurnRequest; policy: TurnCredentialPolicy } | null = null
      const { passes } = runner(async (request, policy) => {
        planned = { request, policy }
        // What the supervisor and its journal do to the task: the turn opens, the agent works.
        await db.task.update({
          where: { id: dialog.taskId },
          data: { status: 'running', turnNo: 1 },
        })
        await db.taskTurn.create({
          data: {
            taskId: dialog.taskId,
            turnNo: 1,
            status: 'completed',
            driverId: sampleDriverId,
            image,
          },
        })
        await worked(dialog.taskId)
        return {
          result: {
            summary: 'Ответил без правок',
            change_type: 'none',
            client_message: 'Телефон уже верный, менять ничего не нужно.',
            files_changed: [],
            questions: [],
            needs_approval: false,
            risk: 'low',
          },
          manifest: {} as SnapshotManifest,
        }
      })

      await passes.run(dialog.job)

      expect(planned).not.toBeNull()
      const { request, policy } = planned!
      expect(() => toTurnPlan(request, sampleDriverId)).not.toThrow()
      expect(request).not.toHaveProperty('workspace')
      expect(request.input.prompt).toBe('Поменяйте телефон в шапке')
      expect(policy).toMatchObject({ backend: sampleBackendId, modelSlug: sampleModelSlug })
      expect(Number(policy.budgetRub)).toBeGreaterThan(0)
      // Nothing changed and nothing asked: the dialog waits for the next words, and the pass is
      // charged when it ends (owner's answers of 26.10.2026).
      const task = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
      expect(task.status).toBe('awaiting_user')
      expect(
        (await db.creditHold.findMany({ where: { taskId: dialog.taskId } })).every(
          (hold) => hold.status === 'captured',
        ),
      ).toBe(true)
    })

    // docs/plan/61-chats-first.md, К31, §5.14: `/init` is a pass, paid as any other.
    describe('of `/init`', () => {
      async function init(dialog: Awaited<ReturnType<typeof queued>>) {
        const requestEventId = await insertFeedEvent(db, {
          taskId: dialog.taskId,
          row: {
            type: 'feed.request',
            payload: {
              v: 1,
              kind: 'agent_command',
              command: 'init',
              authorId: dialog.userId,
              requestId: randomUUID(),
            },
          },
        })
        return { ...dialog.job, requestEventId: requestEventId.toString() }
      }
      const answering = (taskId: string, clientMessage: string) => async () => {
        await db.task.update({ where: { id: taskId }, data: { status: 'running', turnNo: 1 } })
        await db.taskTurn.create({
          data: {
            taskId,
            turnNo: 1,
            status: 'completed',
            driverId: sampleDriverId,
            image,
          },
        })
        await worked(taskId)
        return {
          result: {
            summary: 'Изучил код',
            change_type: 'none',
            client_message: clientMessage,
            files_changed: [],
            questions: [],
            needs_approval: false,
            risk: 'low',
          },
          manifest: {} as SnapshotManifest,
        }
      }

      it('asks in the words of the platform, answers and charges the pass', async () => {
        await rate()
        const dialog = await queued({ reserve: true })
        const job = await init(dialog)
        const answer = 'Тема лежит в wp-content/themes/shop, стили собирает Vite.'
        const run = vi.fn<Run>(answering(dialog.taskId, answer))

        await runner(run).passes.run(job)

        expect(run.mock.calls[0]![0].input.prompt).toContain(INIT_PROMPT)
        expect(run.mock.calls[0]![0].input.prompt).not.toContain('/init')
        const [row] = await db.taskEvent.findMany({
          where: { taskId: dialog.taskId, type: 'feed.result' },
        })
        expect(row?.payload).toMatchObject({ message: answer, next: 'awaiting_user' })
        const holds = await db.creditHold.findMany({ where: { taskId: dialog.taskId } })
        expect(holds.length).toBeGreaterThan(0)
        expect(holds.every((hold) => hold.status === 'captured')).toBe(true)
        // Two credits of work: one is paid by the reserve row, the other by free credits.
        expect(holds.reduce((sum, hold) => sum + Number(hold.charged ?? 0), 0)).toBe(1)
      })

      it('takes an answer of the longest size the result has', async () => {
        await rate()
        const dialog = await queued({ reserve: true })
        const job = await init(dialog)

        await runner(answering(dialog.taskId, 'а'.repeat(2000))).passes.run(job)

        expect(await failure(dialog.taskId)).toEqual([])
        expect(
          await db.taskEvent.count({ where: { taskId: dialog.taskId, type: 'feed.result' } }),
        ).toBe(1)
      })

      it('ends a longer answer as a failure of the platform, and it is not paid for', async () => {
        await rate()
        const dialog = await queued({ reserve: true })
        const job = await init(dialog)

        await runner(answering(dialog.taskId, 'а'.repeat(2001))).passes.run(job)

        expect(await failure(dialog.taskId)).toEqual([
          expect.objectContaining({ code: 'technical' }),
        ])
        expect(
          await db.taskEvent.count({ where: { taskId: dialog.taskId, type: 'feed.result' } }),
        ).toBe(0)
        const holds = await db.creditHold.findMany({ where: { taskId: dialog.taskId } })
        expect(holds.some((hold) => hold.status === 'captured')).toBe(false)
      })
    })

    // docs/plan/61-chats-first.md, К30, §5.14: a pass of its own over the session of the last turn.
    describe('of `/compact`', () => {
      const answer = {
        summary: 'Ответил',
        change_type: 'none',
        client_message: 'Готово.',
        files_changed: [],
        questions: [],
        needs_approval: false,
        risk: 'low',
      }
      /** A chat whose first pass completed, with the plan a compaction restores its session by. */
      async function answered(status: 'awaiting_user' | 'awaiting_approval' = 'awaiting_user') {
        await rate()
        const dialog = await queued({ reserve: true })
        await runner(async (request) => {
          await db.task.update({
            where: { id: dialog.taskId },
            data: { status: 'running', turnNo: 1 },
          })
          const row = await db.taskEvent.findFirstOrThrow({
            where: { taskId: dialog.taskId },
            orderBy: { id: 'desc' },
            select: { createdAt: true },
          })
          const startedAt = new Date(row.createdAt.getTime() + 1)
          await db.taskTurn.create({
            data: {
              taskId: dialog.taskId,
              turnNo: 1,
              status: 'completed',
              driverId: sampleDriverId,
              image,
              nativeSessionId: 'ses_0001',
              startedAt,
              finishedAt: startedAt,
            },
          })
          await db.turnAssignment.create({
            data: {
              taskId: dialog.taskId,
              siteId: dialog.taskId,
              sessionId: dialog.taskId,
              turnNo: 1,
              executor: 'local',
              plan: toTurnPlan(request, sampleDriverId) as never,
              firstEpoch: 1,
              leaseEpoch: 1,
              deadlineAt: new Date(startedAt.getTime() + 60_000),
              outcome: 'completed',
              finishedAt: startedAt,
            },
          })
          return { result: answer, manifest: {} as SnapshotManifest }
        }).passes.run(dialog.job)
        const { workspaceId } = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
        await db.task.update({ where: { id: dialog.taskId }, data: { status, attempt: 2 } })
        await fixtures.reserve({
          workspaceId,
          taskId: dialog.taskId,
          attempt: 2,
          follows: 'message',
          now: NOW,
          expiresAt: new Date(NOW.getTime() + 3_600_000),
        })
        return dialog
      }
      /** `/compact` as `task.compact` writes it, and the job of its pass. */
      async function compact(dialog: Awaited<ReturnType<typeof queued>>) {
        await db.task.update({ where: { id: dialog.taskId }, data: { status: 'queued' } })
        const requestEventId = await insertFeedEvent(db, {
          taskId: dialog.taskId,
          row: {
            type: 'feed.request',
            payload: {
              v: 1,
              kind: 'agent_command',
              command: 'compact',
              authorId: dialog.userId,
              requestId: randomUUID(),
            },
          },
        })
        return { taskId: dialog.taskId, attempt: 2, requestEventId: requestEventId.toString() }
      }
      /** What the supervisor leaves of a compaction: its turn and the fixed line of the platform. */
      const compacts = (taskId: string) => async () => {
        await db.task.update({ where: { id: taskId }, data: { status: 'running', turnNo: 2 } })
        await db.taskTurn.create({
          data: {
            taskId,
            turnNo: 2,
            status: 'completed',
            driverId: sampleDriverId,
            image,
            nativeSessionId: 'ses_0001',
          },
        })
        return {
          result: { ...answer, client_message: 'Готово: переписка сжата.' },
          manifest: {} as SnapshotManifest,
        }
      }
      const holdsOf = (taskId: string, attempt: number) =>
        db.creditHold.findMany({ where: { taskId, attempt } })

      it('runs the action over the session of the last turn and charges it like any pass', async () => {
        const dialog = await answered()
        const job = await compact(dialog)
        const pool = await fixtures.modelPool()
        const price = await fixtures.modelPrice(pool, {
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        })
        const finished = compacts(dialog.taskId)
        const run = vi.fn<Run>(async () => {
          const completed = await finished()
          // The summary went through the gateway like any call: its tokens are what is charged.
          await fixtures.modelCall({
            taskId: dialog.taskId,
            pool,
            priceId: price.id,
            costRub: '12.00',
            occurredAt: NOW,
            attempt: 2,
            turnNo: 2,
          })
          return completed
        })

        await runner(run).passes.run(job)

        const [request] = run.mock.calls[0]!
        expect(request.input.action).toBe('compact')
        expect(request.input.attachments).toEqual([])
        expect(request.input.prompt).not.toContain('Поменяйте телефон')
        expect(request.previous?.turn).toBe(1)
        const [row] = await db.taskEvent.findMany({
          where: { taskId: dialog.taskId, type: 'feed.result' },
          orderBy: { id: 'desc' },
          take: 1,
        })
        expect(row?.payload).toMatchObject({
          turn: 2,
          message: 'Готово: переписка сжата.',
          next: 'awaiting_user',
        })
        const holds = await holdsOf(dialog.taskId, 2)
        expect(holds.reduce((sum, hold) => sum + Number(hold.charged ?? 0), 0)).toBeGreaterThan(0)
        expect(holds.some((hold) => hold.status === 'active')).toBe(false)
      })

      it('costs nothing when it fails: the reserve goes back and the chat stays open', async () => {
        const dialog = await answered()
        const job = await compact(dialog)
        const charges = () =>
          db.creditLedger.count({
            where: { taskId: dialog.taskId, idempotencyKey: { contains: ':charge:' } },
          })
        const charged = await charges()

        await runner(async () => {
          await db.task.update({
            where: { id: dialog.taskId },
            data: { status: 'running', turnNo: 2 },
          })
          await db.taskTurn.create({
            data: {
              taskId: dialog.taskId,
              turnNo: 2,
              status: 'failed',
              driverId: sampleDriverId,
              image,
            },
          })
          throw new Error('the provider refused')
        }).passes.run(job)

        expect(await failure(dialog.taskId)).toEqual([
          expect.objectContaining({
            turn: 2,
            code: 'technical',
            credits: 'returned',
            next: 'awaiting_user',
          }),
        ])
        expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
          status: 'awaiting_user',
        })
        const holds = await holdsOf(dialog.taskId, 2)
        expect(holds.length).toBeGreaterThan(0)
        expect(holds.every((hold) => hold.status === 'released')).toBe(true)
        expect(await charges()).toBe(charged)
      })

      it('answers words that never reached the session instead: no summary would tell them', async () => {
        const dialog = await answered()
        await insertFeedEvent(db, {
          taskId: dialog.taskId,
          row: {
            type: 'feed.request',
            payload: {
              v: 1,
              kind: 'revision',
              text: 'И логотип',
              candidateRevision: 1,
              authorId: dialog.userId,
              requestId: randomUUID(),
            },
          },
        })
        const job = await compact(dialog)
        const run = vi.fn<Run>(compacts(dialog.taskId))

        await runner(run).passes.run(job)

        const [request] = run.mock.calls[0]!
        expect(request.input).not.toHaveProperty('action')
        expect(request.input.prompt).toContain('И логотип')
      })
    })

    it('sends the pass back to the queue when the site is busy, and puts it again later', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      const { passes, queue } = runner(async () => {
        throw siteBusy()
      })

      await passes.run(dialog.job)

      expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
        status: 'queued',
        waiting: 'site',
      })
      expect(queue.enqueue).toHaveBeenCalledWith(
        'agent-turns',
        'turn.run',
        dialog.job,
        expect.objectContaining({ delayMs: 120_000, jobId: expect.stringContaining(':retry:') }),
      )
    })

    describe('when the pool of agents has nothing for the pass', () => {
      const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000)
      const retried = (queue: { enqueue: ReturnType<typeof vi.fn> }) =>
        queue.enqueue.mock.calls.filter((call) => call[1] === 'turn.run')

      it('puts the pass back within the minute when only a slot of the pool is busy', async () => {
        await rate()
        const dialog = await queued({ reserve: true })
        const { passes, queue } = runner(async () => {
          throw subscriptionBusy(minutes(1))
        })

        await passes.run(dialog.job)

        expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
          status: 'queued',
          waiting: 'agents',
        })
        expect(queue.enqueue).toHaveBeenCalledWith(
          'agent-turns',
          'turn.run',
          dialog.job,
          expect.objectContaining({ delayMs: 60_000 }),
        )
        expect(await failure(dialog.taskId)).toEqual([])
      })

      it('waits for a pause that ends within the longest wait of the pool, looking again every ten minutes', async () => {
        await rate()
        const dialog = await queued({ reserve: true })
        const { passes, queue } = runner(async () => {
          throw subscriptionWait(minutes(45))
        })

        await passes.run(dialog.job)

        expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
          status: 'queued',
          waiting: 'agents',
        })
        expect(queue.enqueue).toHaveBeenCalledWith(
          'agent-turns',
          'turn.run',
          dialog.job,
          expect.objectContaining({ delayMs: 600_000 }),
        )
        expect(await failure(dialog.taskId)).toEqual([])
      })

      // The owner's decision of 10.11.2026: a window of the plan that resets in hours is not a
      // queue. The chat of 10.11.2026 sat «в очереди» for four hours with its credits held.
      it('tells the client the limits are out when the pool names a later time, and does not wait', async () => {
        await rate()
        const dialog = await queued({ reserve: true })
        const { passes, queue } = runner(async () => {
          throw subscriptionWait(minutes(4 * 60 + 12))
        })

        await passes.run(dialog.job)

        expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
          status: 'awaiting_user',
          waiting: null,
        })
        expect(await failure(dialog.taskId)).toEqual([
          expect.objectContaining({
            code: 'agent_limits',
            next: 'awaiting_user',
            credits: 'returned',
          }),
        ])
        expect(retried(queue)).toEqual([])
      })

      // The chat of 13.11.2026: a pass the pool sent back woke the passes that wait for the
      // agents as it ended — itself among them —, and ran again within a second, a new turn each
      // time, for minutes. A pass that waited freed no place; its retry is the only one.
      it.each([
        ['a busy slot', () => subscriptionBusy(minutes(1))],
        ['a pause', () => subscriptionWait(minutes(45), 'cooling')],
        ['a busy site', () => siteBusy()],
      ])('wakes nobody, itself included, when %s sends the pass back', async (_name, refusal) => {
        await rate()
        const dialog = await queued({ reserve: true })
        // Another dialog of the same workspace waits for the agents as well.
        const { workspaceId } = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
        const other = await fixtures.task(workspaceId, { status: 'queued' })
        await db.task.update({ where: { id: other.taskId }, data: { waiting: 'agents' } })
        await insertFeedEvent(db, {
          taskId: other.taskId,
          row: {
            type: 'feed.request',
            payload: {
              v: 1,
              kind: 'first',
              authorId: dialog.userId,
              requestId: randomUUID(),
              text: 'Поменяйте адрес в подвале',
            },
          },
        })
        const wakes = () =>
          db.outboxEvent.count({
            where: {
              topic: 'agent-turns',
              type: 'turn.run',
              OR: [
                { payload: { path: ['taskId'], equals: dialog.taskId } },
                { payload: { path: ['taskId'], equals: other.taskId } },
              ],
            },
          })
        const before = await wakes()
        const job = { ...dialog.job, priority: 3 }
        const { passes, queue } = runner(async () => {
          throw refusal()
        })

        await passes.run(job)

        expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
          status: 'queued',
        })
        expect(await wakes()).toBe(before)
        // Its own retry, in the place of its tier (plan 71: the queue orders the tiers).
        expect(retried(queue)).toEqual([
          ['agent-turns', 'turn.run', job, expect.objectContaining({ priority: 3 })],
        ])
      })
    })

    describe('a chat without a project (docs/plan/61-chats-first.md, §5.3, §5.6)', () => {
      const answer = {
        summary: 'Посчитал смету',
        change_type: 'none',
        client_message: 'Смета готова: 12 500 ₽.',
        files_changed: [],
        questions: [],
        needs_approval: false,
        risk: 'low',
      }
      const completes = (taskId: string) => async (request: UnkeyedTurnRequest) => {
        void request
        await db.task.update({ where: { id: taskId }, data: { status: 'running', turnNo: 1 } })
        await db.taskTurn.create({
          data: {
            taskId,
            turnNo: 1,
            status: 'completed',
            driverId: sampleDriverId,
            image,
          },
        })
        return { result: answer, manifest: {} as SnapshotManifest }
      }

      it('runs without git, plans no repository, answers and charges the pass', async () => {
        await rate()
        const dialog = await queued({ reserve: true })
        const run = vi.fn<Run>(async (request) => {
          const done = await completes(dialog.taskId)(request)
          await worked(dialog.taskId)
          return done
        })
        const { passes } = runner(run, async () => null, { browser: null })

        await passes.run(dialog.job)

        const [request, policy] = run.mock.calls[0]!
        expect(request.workspace).toBeUndefined()
        expect(request.requirements).toEqual({ repository: false, browser: false })
        expect(request.sandbox.labels.siteId).toBe(dialog.taskId)
        expect(request.context.instructions).toContain('You help a small business owner in a chat.')
        expect(policy).toMatchObject({ backend: sampleBackendId })
        expect(() => toTurnPlan(request, sampleDriverId)).not.toThrow()
        expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
          status: 'awaiting_user',
          turnNo: 1,
        })
        const [row] = await db.taskEvent.findMany({
          where: { taskId: dialog.taskId, type: 'feed.result' },
        })
        expect(row?.payload).toMatchObject({ message: answer.client_message })
        expect(
          (await db.creditHold.findMany({ where: { taskId: dialog.taskId } })).every(
            (hold) => hold.status === 'captured',
          ),
        ).toBe(true)
      })

      it('puts a file of the chat into the plan of its turn', async () => {
        await rate()
        const dialog = await queued({ reserve: true })
        const { workspaceId } = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
        const file = (await createAttachment(db, {
          workspaceId,
          uploadedById: dialog.userId,
          fileName: 'смета.pdf',
          contentType: 'application/pdf',
          sizeBytes: 2048,
        }))!
        try {
          await markAttachmentReady(db, {
            id: file.id,
            sizeBytes: 2048,
            contentType: 'application/pdf',
          })
          await bindAttachments(db, {
            ids: [file.id],
            taskId: dialog.taskId,
            userId: dialog.userId,
            workspaceId,
          })
          const run = vi.fn<Run>(completes(dialog.taskId))
          await runner(run, async () => null, { browser: null }).passes.run(dialog.job)
          const [request] = run.mock.calls[0]!
          expect(request.input.attachments).toEqual([`/workspace/inbox/${file.id}/смета.pdf`])
          expect(request.context.instructions).toContain('/workspace/inbox')
        } finally {
          await db.attachment.delete({ where: { id: file.id } })
        }
      })

      it('looks at the lease of its own id while it is busy (#siteRetry)', async () => {
        await rate()
        const dialog = await queued({ reserve: true })
        const inspect = vi.fn(async () => ({
          expiresAt: new Date(NOW.getTime() + 30_000),
          serverNow: NOW,
        }))
        const { passes, queue } = runner(
          async () => {
            throw siteBusy()
          },
          inspect,
          { browser: null },
        )

        await passes.run(dialog.job)

        expect(inspect).toHaveBeenCalledExactlyOnceWith(dialog.taskId)
        expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
          status: 'queued',
          waiting: 'site',
        })
        expect(queue.enqueue).toHaveBeenCalledWith(
          'agent-turns',
          'turn.run',
          dialog.job,
          expect.objectContaining({ delayMs: 30_000 }),
        )
      })
    })

    it('looks again when a short lease ends, not before ten seconds', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      const { passes, queue } = runner(
        async () => {
          throw siteBusy()
        },
        async () => ({ expiresAt: new Date(NOW.getTime() + 2_000), serverNow: NOW }),
      )

      await passes.run(dialog.job)

      expect(queue.enqueue).toHaveBeenCalledWith(
        'agent-turns',
        'turn.run',
        dialog.job,
        expect.objectContaining({ delayMs: 10_000 }),
      )
    })

    it('leaves a pass whose turn is still assigned to recovery', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      const { passes } = runner(async () => {
        await db.turnAssignment.create({
          data: {
            taskId: dialog.taskId,
            siteId: dialog.taskId,
            sessionId: dialog.taskId,
            turnNo: 1,
            executor: 'local',
            plan: {},
            firstEpoch: 1,
            leaseEpoch: 1,
            deadlineAt: new Date(Date.now() + 60_000),
          },
        })
        throw new Error('core stops')
      })

      await passes.run(dialog.job)

      expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe(
        'preparing',
      )
      expect(await failure(dialog.taskId)).toEqual([])
      await db.turnAssignment.deleteMany({ where: { taskId: dialog.taskId } })
    })
  })
})
