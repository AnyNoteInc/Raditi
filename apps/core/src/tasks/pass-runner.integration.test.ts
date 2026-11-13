import { randomUUID } from 'node:crypto'

import type { AgentDriverRegistry } from '@repo/agent-drivers'
import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  bindAttachments,
  closeBrowserSession,
  createAttachment,
  createPrismaClient,
  insertFeedEvent,
  markAttachmentReady,
  markBrowserSessionReady,
  openBrowserSession,
  PostgresSiteLeaseStore,
  PostgresTaskTurnAssignmentStore,
  recordCandidate,
  upsertBrowserCheckpoint,
  type PrismaClient,
} from '@repo/db'
import {
  BROWSER_ONLY,
  siteBusy,
  siteIdOf,
  subscriptionBusy,
  subscriptionWait,
  toTurnPlan,
  type AgentDriver,
  type SnapshotManifest,
  type TurnCredentialPolicy,
  type UnkeyedTurnRequest,
} from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { getSiteAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { sampleBackendId, sampleDriverId, sampleModelSlug } from '../testing/ids.ts'
import type { TurnSupervisor } from '../turns/turn-supervisor.ts'
import type { CandidateBuilder } from './candidate-builder.ts'
import type { CandidateGit } from './candidate-git.ts'
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
const MAIN = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const REBASED = 'c'.repeat(40)
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
const git = {
  readBranchHead: vi.fn(async () => MAIN),
  compareCommits: vi.fn(),
  preparePublication: vi.fn(),
} as unknown as CandidateGit
/** No change against the base: the dialog ends `done`. Git and S3 are not this suite's. */
const candidates = {
  context: vi.fn(async (task: { id: string }) => ({
    taskId: task.id,
    repo: { provider: 'gitea', owner: 'sites', name: 'site' },
    addOnlyPaths: [],
    base: MAIN,
    standing: null,
    installedVersion: null,
    releasedVersions: [],
    revision: 1,
  })),
  build: vi.fn(async () => ({ kind: 'empty' as const })),
} as unknown as CandidateBuilder

type Run = (
  request: UnkeyedTurnRequest,
  policy: TurnCredentialPolicy,
  signal?: AbortSignal,
) => Promise<unknown>

describe.skipIf(!databaseUrl)('the handler of a pass with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await db.gitRepository.deleteMany({ where: { owner: 'sites-r3-test' } })
    await fixtures.cleanup()
    vi.clearAllMocks()
    vi.mocked(git.readBranchHead).mockImplementation(async () => MAIN)
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /**
   * A queued dialog of a client with the gift of the registration, and its first words; with
   * `browser`, a task in the cloud browser on a site without a repository (plan 57, Б2, Б8).
   */
  async function queued({
    reserve,
    browser = false,
    chat = false,
  }: {
    reserve: boolean
    browser?: boolean
    /** A chat without a project (docs/plan/61-chats-first.md, §5.6). */
    chat?: boolean
  }) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status: 'queued',
      ...(browser ? { needsRepository: false, needsBrowser: true } : {}),
      ...(chat ? { siteId: null, needsRepository: false, needsBrowser: browser } : {}),
    })
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
    if (chat) {
      // Neither a site nor a repository to prepare.
    } else if (browser)
      await db.site.update({
        where: { id: siteIdOf(task) },
        data: { agentNotes: 'Вход по адресу /login' },
      })
    else
      await db.gitRepository.create({
        data: {
          siteId: siteIdOf(task),
          provider: 'gitea',
          owner: 'sites-r3-test',
          name: `site-${task.siteId}`,
          url: `https://git.invalid/sites/site-${task.siteId}.git`,
        },
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
      siteId: task.siteId,
      job: { taskId, attempt: 1, requestEventId: requestEventId.toString() },
    }
  }

  function runner(
    run: Run | null,
    inspect: () => Promise<unknown> = async () => null,
    options: {
      git?: CandidateGit | null
      browser?: { reclaim: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> } | null
      capacity?: TurnCapacity
    } = {},
  ) {
    const queue = { enqueue: vi.fn(async () => {}) }
    const close = vi.fn(async () => {})
    const live = new LivePasses()
    const settlement = new PassSettlement({
      db,
      candidates,
      browser: { close },
      logger: quiet,
      now: () => NOW,
    })
    const supervisor = run ? ({ run: vi.fn(run) } as unknown as TurnSupervisor) : null
    const passes = new PassRunner({
      db,
      supervisor,
      git: options.git === undefined ? git : options.git,
      ...(options.browser !== undefined ? { browser: options.browser as never } : {}),
      drivers,
      backends: llmBackends,
      adapter: getSiteAdapter,
      leases: { inspect: vi.fn(inspect) as never },
      runtime: 'runc',
      previews: null,
      settlement,
      live,
      queue,
      logger: quiet,
      ...(options.capacity ? { capacity: options.capacity } : {}),
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
        site: 'unchanged',
        credits: null,
        next: 'awaiting_user',
      },
    ])
  })

  it('fails every pass while git is not configured and gives its reserve back', async () => {
    const dialog = await queued({ reserve: true })
    const { passes } = runner(null)

    await passes.run(dialog.job)

    expect(await failure(dialog.taskId)).toEqual([
      {
        v: 1,
        turn: null,
        code: 'unavailable',
        site: 'unchanged',
        credits: 'returned',
        next: 'awaiting_user',
      },
    ])
    const holds = await db.creditHold.findMany({ where: { taskId: dialog.taskId } })
    expect(holds.every((hold) => hold.status === 'released')).toBe(true)
  })

  // The owner, 06.11 and 12.11.2026: «до 8 сендбоксов на одного клиента» (plan 70, ВР13).
  it('lets a pass wait while its workspace runs eight others, as for a busy pool', async () => {
    const dialog = await queued({ reserve: true, chat: true })
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
    const dialog = await queued({ reserve: true, chat: true })
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
    const other = await queued({ reserve: true, chat: true })
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
    ).toEqual([{ v: 1, turn: null, by: 'customer', site: 'unchanged', credits: 'returned' }])
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
            headSha: HEAD,
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
          manifest: { git: { headSha: HEAD } } as SnapshotManifest,
        }
      })

      await passes.run(dialog.job)

      expect(planned).not.toBeNull()
      const { request, policy } = planned!
      expect(() => toTurnPlan(request, sampleDriverId)).not.toThrow()
      expect(request.workspace?.expectedBaseSha).toBe(MAIN)
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
            headSha: HEAD,
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
          manifest: { git: { headSha: HEAD } } as SnapshotManifest,
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
              headSha: HEAD,
              nativeSessionId: 'ses_0001',
              startedAt,
              finishedAt: startedAt,
            },
          })
          await db.turnAssignment.create({
            data: {
              taskId: dialog.taskId,
              siteId: siteIdOf(dialog),
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
          return { result: answer, manifest: { git: { headSha: HEAD } } as SnapshotManifest }
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
        vi.mocked(git.readBranchHead).mockImplementation(async () => HEAD)
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
      const compacts =
        (taskId: string, headSha = HEAD) =>
        async () => {
          await db.task.update({ where: { id: taskId }, data: { status: 'running', turnNo: 2 } })
          await db.taskTurn.create({
            data: {
              taskId,
              turnNo: 2,
              status: 'completed',
              driverId: sampleDriverId,
              image,
              headSha,
              nativeSessionId: 'ses_0001',
            },
          })
          return {
            result: { ...answer, client_message: 'Готово: переписка сжата.' },
            manifest: { git: { headSha } } as SnapshotManifest,
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

      it('leaves the candidate where it stands: the chat waits for the release with the same one', async () => {
        const dialog = await answered('awaiting_approval')
        const candidate = await db.taskCandidate.create({
          data: {
            taskId: dialog.taskId,
            revision: 1,
            turnNo: 1,
            baseSha: MAIN,
            baseTree: 'd'.repeat(40),
            headSha: HEAD,
            dbPlanSha256: '0'.repeat(64),
            proposedBump: 'minor',
            proposedVersion: 'v0.1.0',
            facts: {
              changeType: 'code',
              risk: 'low',
              addedFiles: 0,
              modifiedFiles: 1,
              deletedFiles: 0,
              mediaFiles: 0,
              dbObjects: 0,
              newFunctionality: false,
            },
          },
        })
        const job = await compact(dialog)
        vi.mocked(candidates.build).mockImplementationOnce(
          async () => ({ kind: 'unchanged' }) as never,
        )
        const run = vi.fn<Run>(compacts(dialog.taskId))

        await runner(run).passes.run(job)

        expect(run.mock.calls[0]![0].input.action).toBe('compact')
        expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
          status: 'awaiting_approval',
        })
        expect(
          await db.taskCandidate.findMany({
            where: { taskId: dialog.taskId },
            select: { id: true, revision: true, status: true },
          }),
        ).toEqual([{ id: candidate.id, revision: 1, status: 'current' }])
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

    it('refuses a task with a repository while git is not configured, before its turn', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      const run = vi.fn<Run>()
      const { passes } = runner(run, undefined, { git: null })

      await passes.run(dialog.job)

      expect(run).not.toHaveBeenCalled()
      expect(await failure(dialog.taskId)).toEqual([
        expect.objectContaining({
          code: 'unavailable',
          next: 'awaiting_user',
          credits: 'returned',
        }),
      ])
    })

    describe('a task in the cloud browser (docs/plan/57-browser-tasks.md)', () => {
      const editUrl = 'https://example.ru/wp-admin/post.php?post=12&action=edit'
      const browserSessions = () => ({
        reclaim: vi.fn(async (_taskId: string, _signal: AbortSignal) => {}),
        verify: vi.fn(async (_taskId: string) => true),
      })

      it('runs on a core without git: starts no browser, plans no repository, verifies, answers', async () => {
        await rate()
        const dialog = await queued({ reserve: true, browser: true })
        const browser = browserSessions()
        const order: string[] = []
        browser.reclaim.mockImplementation(async () => {
          order.push('reclaim')
        })
        browser.verify.mockImplementation(async () => {
          order.push('verify')
          return true
        })
        let planned: UnkeyedTurnRequest | null = null
        const { passes, close } = runner(
          async (request) => {
            order.push('run')
            planned = request
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
            // What the worker records while the agent publishes and verifies (Б22).
            const session = await openBrowserSession(db, { taskId: dialog.taskId })
            await upsertBrowserCheckpoint(db, {
              taskId: dialog.taskId,
              sessionId: session.id,
              ref: { kind: 'post', objectId: '12', editUrl },
              state: 'verified',
              verified: {
                kind: 'post',
                objectId: '12',
                title: 'Скидки',
                status: 'draft',
                editUrl,
                images: 0,
                files: 0,
                featuredImage: false,
              },
            })
            return {
              result: {
                summary: 'Сохранил новость черновиком',
                change_type: 'content',
                client_message: 'Новость сохранена черновиком.',
                files_changed: [],
                questions: [],
                needs_approval: false,
                risk: 'low',
              },
              // No `git`: a turn without a repository published nothing.
              manifest: {} as SnapshotManifest,
            }
          },
          undefined,
          { git: null, browser },
        )

        await passes.run(dialog.job)

        expect(order).toEqual(['reclaim', 'run', 'verify'])
        expect(browser.reclaim).toHaveBeenCalledWith(dialog.taskId, expect.any(AbortSignal))
        const request = planned!
        expect(() => toTurnPlan(request, sampleDriverId)).not.toThrow()
        expect(request.requirements).toEqual(BROWSER_ONLY)
        expect(request).not.toHaveProperty('workspace')
        expect(request.input.prompt).toContain('Поменяйте телефон в шапке')
        expect(request.input.prompt).toContain('Вход по адресу /login')
        expect(request.context.instructions).toContain('cloud browser')
        // Like a dialog with the repository (owner's answer of 26.10.2026): the answer leaves it
        // open, the pass is charged, and the browser lives on for the next words.
        const task = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
        expect(task.status).toBe('awaiting_user')
        const [result] = await db.taskEvent.findMany({
          where: { taskId: dialog.taskId, type: 'feed.result' },
        })
        expect(result!.payload).toMatchObject({
          site: 'changed',
          next: 'awaiting_user',
          objects: [{ kind: 'post', status: 'draft', title: 'Скидки', editUrl }],
        })
        expect(close).not.toHaveBeenCalled()
      })

      describe('a browser that failed to start in the turn', () => {
        /** A turn that asked for a browser and ended with words; `session` is what became of it. */
        const turnThatAsked = (
          dialog: { taskId: string; siteId: string | null },
          session: (id: string) => Promise<unknown>,
        ) =>
          runner(
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
              await db.turnAssignment.create({
                data: {
                  taskId: dialog.taskId,
                  siteId: dialog.siteId ?? dialog.taskId,
                  sessionId: dialog.taskId,
                  turnNo: 1,
                  executor: 'local',
                  plan: {},
                  firstEpoch: 1,
                  leaseEpoch: 1,
                  deadlineAt: new Date(Date.now() + 60_000),
                  outcome: 'completed',
                  finishedAt: new Date(),
                },
              })
              const { id } = await openBrowserSession(db, { taskId: dialog.taskId })
              await session(id)
              return {
                result: {
                  summary: 'Браузер недоступен',
                  change_type: 'content',
                  client_message: 'Не удалось открыть браузер.',
                  files_changed: [],
                  questions: [],
                  needs_approval: false,
                  risk: 'low',
                },
                manifest: {} as SnapshotManifest,
              }
            },
            undefined,
            { git: null, browser: browserSessions() },
          )
        const charges = (taskId: string) =>
          db.creditLedger.count({ where: { taskId, idempotencyKey: { contains: ':charge:' } } })

        it.each([
          ['core gave up', 'BROWSER_START_FAILED'],
          ['the worker gave up', 'TimeoutError'],
        ])('is not charged when %s: the failure is the platform’s (rule 7)', async (_who, code) => {
          await rate()
          const dialog = await queued({ reserve: true, browser: true })
          const { passes } = turnThatAsked(dialog, (sessionId) =>
            closeBrowserSession(db, {
              sessionId,
              status: 'failed',
              reason: 'crashed',
              errorCode: code,
            }),
          )

          await passes.run(dialog.job)

          expect(await failure(dialog.taskId)).toEqual([
            expect.objectContaining({
              code: 'unavailable',
              next: 'awaiting_user',
              credits: 'returned',
            }),
          ])
          expect(await charges(dialog.taskId)).toBe(0)
          expect(
            await db.taskEvent.count({ where: { taskId: dialog.taskId, type: 'feed.result' } }),
          ).toBe(0)
          expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
            status: 'awaiting_user',
          })
        })

        it('is charged in a chat without a site: the browser was not all it had (plan 61, 61.9)', async () => {
          await rate()
          const dialog = await queued({ reserve: true, chat: true, browser: true })
          const { passes } = turnThatAsked(dialog, async (sessionId) => {
            await worked(dialog.taskId)
            await closeBrowserSession(db, {
              sessionId,
              status: 'failed',
              reason: 'crashed',
              errorCode: 'BROWSER_START_FAILED',
            })
          })

          await passes.run(dialog.job)

          expect(await failure(dialog.taskId)).toEqual([])
          expect(await charges(dialog.taskId)).toBeGreaterThan(0)
          expect(
            await db.taskEvent.count({ where: { taskId: dialog.taskId, type: 'feed.result' } }),
          ).toBe(1)
        })

        it('is charged when a browser came up in the turn and the next one failed', async () => {
          await rate()
          const dialog = await queued({ reserve: true, browser: true })
          const { passes } = turnThatAsked(dialog, async (sessionId) => {
            await worked(dialog.taskId)
            await markBrowserSessionReady(db, { sessionId })
            await closeBrowserSession(db, { sessionId, status: 'lost', reason: 'crashed' })
            const { id } = await openBrowserSession(db, { taskId: dialog.taskId })
            await closeBrowserSession(db, { sessionId: id, status: 'failed', reason: 'crashed' })
          })

          await passes.run(dialog.job)

          expect(await failure(dialog.taskId)).toEqual([])
          expect(await charges(dialog.taskId)).toBeGreaterThan(0)
        })

        it('is charged while the browser only starts: the agent was told to call again', async () => {
          await rate()
          const dialog = await queued({ reserve: true, browser: true })
          const { passes } = turnThatAsked(dialog, () => worked(dialog.taskId))

          await passes.run(dialog.job)

          expect(await failure(dialog.taskId)).toEqual([])
          expect(await charges(dialog.taskId)).toBeGreaterThan(0)
        })
      })

      it('refuses the task when no browser worker is configured, before its turn', async () => {
        await rate()
        const dialog = await queued({ reserve: true, browser: true })
        const run = vi.fn<Run>()
        const { passes } = runner(run, undefined, { git: null, browser: null })

        await passes.run(dialog.job)

        expect(run).not.toHaveBeenCalled()
        expect(await failure(dialog.taskId)).toEqual([
          expect.objectContaining({
            code: 'unavailable',
            next: 'awaiting_user',
            credits: 'returned',
          }),
        ])
      })

      it('ends a pass the client cancelled while its browser came back, before its turn', async () => {
        await rate()
        const dialog = await queued({ reserve: true, browser: true })
        const browser = browserSessions()
        const run = vi.fn<Run>()
        const { passes, live } = runner(run, undefined, { git: null, browser })
        browser.reclaim.mockImplementation(async (taskId: string) => {
          live.abort(taskId)
        })

        await passes.run(dialog.job)

        expect(run).not.toHaveBeenCalled()
        expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
          status: 'cancelled',
        })
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

      // Plan 71, Л17: the reserve of the higher tiers is capacity that exists — a new task of a
      // lower tier waits in the queue for the reset however far it is, and keeps its priority.
      it('keeps a pass the reserve of the higher tiers holds back in the queue, with its priority', async () => {
        await rate()
        const dialog = await queued({ reserve: true })
        const job = { ...dialog.job, priority: 3 }
        const { passes, queue } = runner(async () => {
          throw subscriptionWait(minutes(4 * 60 + 12), 'tier_reserve')
        })

        await passes.run(job)

        expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
          status: 'queued',
          waiting: 'agents',
        })
        expect(queue.enqueue).toHaveBeenCalledWith(
          'agent-turns',
          'turn.run',
          job,
          expect.objectContaining({ delayMs: 600_000, priority: 3 }),
        )
        expect(await failure(dialog.taskId)).toEqual([])
      })
    })

    it('looks again within two minutes when the lease of the site lasts long', async () => {
      // A deploy holds its lease for half an hour and may end in a minute (stand R12): its end
      // wakes the pass; this is the retry for a wake that never came.
      await rate()
      const dialog = await queued({ reserve: true })
      const { passes, queue } = runner(
        async () => {
          throw siteBusy()
        },
        async () => ({ expiresAt: new Date(NOW.getTime() + 30 * 60_000), serverNow: NOW }),
      )

      await passes.run(dialog.job)

      expect(queue.enqueue).toHaveBeenCalledWith(
        'agent-turns',
        'turn.run',
        dialog.job,
        expect.objectContaining({ delayMs: 120_000 }),
      )
    })

    it('wakes the passes of other dialogs that waited for its site once its turn ended', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      const row = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
      const other = await db.task.create({
        data: {
          workspaceId: row.workspaceId,
          siteId: row.siteId,
          modelClass: 'standard',
          status: 'queued',
          waiting: 'site',
        },
      })
      const request = await insertFeedEvent(db, {
        taskId: other.id,
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
      const key = `turn.run:${other.id}:1:${request}:retry:turn-${dialog.taskId}-0`
      try {
        const { passes } = runner(async () => {
          throw new Error('the sandbox did not start')
        })
        await passes.run(dialog.job)
        expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe(
          'awaiting_user',
        )
        expect(await db.outboxEvent.findUniqueOrThrow({ where: { dedupeKey: key } })).toMatchObject(
          {
            topic: 'agent-turns',
            type: 'turn.run',
            payload: { taskId: other.id, attempt: 1, requestEventId: String(request) },
          },
        )
      } finally {
        await db.outboxEvent.deleteMany({ where: { dedupeKey: key } })
        await db.taskEvent.deleteMany({ where: { taskId: other.id } })
        await db.task.delete({ where: { id: other.id } })
      }
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
        const dialog = await queued({ reserve: true, chat: true })
        const run = vi.fn<Run>(async (request) => {
          const done = await completes(dialog.taskId)(request)
          await worked(dialog.taskId)
          return done
        })
        const { passes } = runner(run, async () => null, { git: null, browser: null })

        await passes.run(dialog.job)

        const [request, policy] = run.mock.calls[0]!
        expect(request.workspace).toBeUndefined()
        expect(request.requirements).toEqual({ repository: false, browser: false })
        expect(request.sandbox.labels.siteId).toBe(dialog.taskId)
        expect(request.context.instructions).toContain('a chat that has no site and no repository')
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
        const dialog = await queued({ reserve: true, chat: true })
        const { workspaceId } = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
        const file = (await createAttachment(db, {
          workspaceId,
          siteId: null,
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
            siteId: null,
          })
          const run = vi.fn<Run>(completes(dialog.taskId))
          await runner(run, async () => null, { git: null, browser: null }).passes.run(dialog.job)
          const [request] = run.mock.calls[0]!
          expect(request.input.attachments).toEqual([`/workspace/inbox/${file.id}/смета.pdf`])
          expect(request.context.instructions).toContain('/workspace/inbox')
        } finally {
          await db.attachment.delete({ where: { id: file.id } })
        }
      })

      it('looks at the lease of its own id while it is busy (#siteRetry)', async () => {
        await rate()
        const dialog = await queued({ reserve: true, chat: true })
        const inspect = vi.fn(async () => ({
          expiresAt: new Date(NOW.getTime() + 30_000),
          serverNow: NOW,
        }))
        const { passes, queue } = runner(
          async () => {
            throw siteBusy()
          },
          inspect,
          { git: null, browser: null },
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

      it('wakes nobody when its turn ended: a lease of its own has no one waiting (#wakeSite)', async () => {
        await rate()
        const dialog = await queued({ reserve: true, chat: true })
        const row = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
        // Another dialog of the workspace that waits: for a site, not for this chat.
        const { taskId: other } = await fixtures.task(row.workspaceId, {
          status: 'queued',
          waiting: 'site',
        })
        const request = await insertFeedEvent(db, {
          taskId: other,
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
        const key = `turn.run:${other}:1:${request}:retry:turn-${dialog.taskId}-0`
        try {
          const { passes } = runner(
            async () => {
              throw new Error('the sandbox did not start')
            },
            async () => null,
            { git: null, browser: null },
          )
          await passes.run(dialog.job)
          expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe(
            'awaiting_user',
          )
          expect(await db.outboxEvent.count({ where: { dedupeKey: key } })).toBe(0)
          // It did not try: a wake without a site is no wake that failed.
          expect(quiet.warn).not.toHaveBeenCalledWith(expect.stringContaining('pass_wake_failed'))
        } finally {
          await db.outboxEvent.deleteMany({ where: { dedupeKey: key } })
          await db.taskEvent.deleteMany({ where: { taskId: other } })
        }
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

    it('does not look again every ten seconds while a release barrier stands over an expired lease', async () => {
      // An attempt whose run still goes, or a release held for the operator: the barrier
      // outlives the lease, `acquire` refuses until the release ends, and its end wakes the pass.
      await rate()
      for (const lease of [
        {
          expiresAt: new Date(NOW.getTime() - 60_000),
          serverNow: NOW,
          inflightReleaseId: randomUUID(),
        },
        { expiresAt: new Date(NOW.getTime() - 60_000), serverNow: NOW, inflightReleaseId: null },
      ]) {
        const dialog = await queued({ reserve: true })
        const { passes, queue } = runner(
          async () => {
            throw siteBusy()
          },
          async () => lease,
        )
        await passes.run(dialog.job)
        expect(queue.enqueue).toHaveBeenCalledWith(
          'agent-turns',
          'turn.run',
          dialog.job,
          expect.objectContaining({ delayMs: 120_000 }),
        )
      }
    })

    /** A dialog «Обновить» moved after its turn 1: its next turn starts on REBASED. */
    async function rebasedDialog() {
      const dialog = await queued({ reserve: true })
      await db.task.update({ where: { id: dialog.taskId }, data: { turnNo: 1 } })
      await db.taskTurn.create({
        data: {
          taskId: dialog.taskId,
          turnNo: 1,
          status: 'completed',
          driverId: sampleDriverId,
          image,
          headSha: HEAD,
        },
      })
      await db.$transaction((tx) =>
        recordCandidate(tx, {
          taskId: dialog.taskId,
          revision: 1,
          turnNo: 1,
          baseSha: MAIN,
          baseTree: 'c'.repeat(40),
          baseVersion: null,
          headSha: REBASED,
          files: [
            { path: 'wp-content/themes/t/a.php', change: 'added', sizeBytes: 3, executable: false },
          ],
          media: [],
          dbPlan: [],
          dbPlanSha256: '0'.repeat(64),
          proposedBump: 'minor',
          proposedVersion: 'v0.1.0',
          facts: {
            changeType: 'code',
            risk: 'low',
            addedFiles: 1,
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
      return dialog
    }
    const pressUpdate = (dialog: { taskId: string; userId: string }) =>
      insertFeedEvent(db, {
        taskId: dialog.taskId,
        row: {
          type: 'feed.request',
          payload: {
            v: 1,
            kind: 'command',
            command: 'update',
            authorId: dialog.userId,
            requestId: randomUUID(),
          },
        },
      })

    it('runs no turn on a branch an `/update` is still moving: waits, and puts the update again', async () => {
      await rate()
      const dialog = await rebasedDialog()
      const update = await pressUpdate(dialog)
      // The task branch is not yet where the update will record it.
      vi.mocked(git.readBranchHead).mockResolvedValue(HEAD)
      const run = vi.fn<Run>()
      const { passes, queue } = runner(run)

      await passes.run(dialog.job)

      expect(run).not.toHaveBeenCalled()
      expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
        status: 'queued',
        waiting: 'site',
      })
      expect(queue.enqueue).toHaveBeenCalledWith(
        'agent-turns',
        'candidate.rebase',
        { taskId: dialog.taskId, requestEventId: update.toString() },
        expect.objectContaining({ jobId: expect.stringContaining(':repair:') }),
      )
      expect(queue.enqueue).toHaveBeenCalledWith(
        'agent-turns',
        'turn.run',
        dialog.job,
        expect.objectContaining({ jobId: expect.stringContaining(':retry:') }),
      )
    })

    it('fails a pass before its turn when the branch moved and no update explains it', async () => {
      await rate()
      const dialog = await rebasedDialog()
      vi.mocked(git.readBranchHead).mockResolvedValue(HEAD)
      const run = vi.fn<Run>()
      const { passes } = runner(run)

      await passes.run(dialog.job)

      expect(run).not.toHaveBeenCalled()
      // The dialog keeps its candidate and its reserve (docs/plan/53, «Попробовать ещё (18.10)»).
      expect(await failure(dialog.taskId)).toEqual([
        {
          v: 1,
          turn: null,
          code: 'technical',
          site: 'unchanged',
          credits: null,
          next: 'awaiting_approval',
        },
      ])
      expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe(
        'awaiting_approval',
      )
    })

    // Turn 1 of this dialog kept no plan, so no checkpoint: a new session (the owner, 06.11.2026 — a
    // session with one goes on; the planner and the store test that path).
    it('starts the turn after «Обновить» without a checkpoint as a new session on the moved head', async () => {
      await rate()
      const dialog = await rebasedDialog()
      vi.mocked(git.readBranchHead).mockResolvedValue(REBASED)
      let planned: UnkeyedTurnRequest | null = null
      let admitted: unknown = null
      const { passes } = runner(async (request) => {
        planned = request
        // The store that opens the turn under its lease — the chat's own row, as the planner
        // names it (`turnLeaseOf`) — admits what the planner built: both read where the platform
        // last left the task branch the same way.
        const fence = await new PostgresSiteLeaseStore(db).acquire({
          siteId: request.sandbox.labels.siteId,
          taskId: dialog.taskId,
          operation: 'turn',
          ttlMs: 60_000,
        })
        admitted = await new PostgresTaskTurnAssignmentStore(db).open({
          fence: fence!,
          sessionId: request.context.sessionId,
          turn: request.sandbox.labels.turn,
          executor: 'local',
          plan: toTurnPlan(request, sampleDriverId),
          remainingMs: 30_000,
        })
        throw new Error('stops here')
      })

      try {
        await passes.run(dialog.job)
      } finally {
        await db.siteLease.deleteMany({
          where: { siteId: { in: [siteIdOf(dialog), dialog.taskId] } },
        })
      }

      expect(planned).toMatchObject({
        rebased: true,
        workspace: { expectedBaseSha: REBASED },
      })
      expect(planned!.previous).toBeUndefined()
      expect(admitted).toMatchObject({ turn: 2, plan: { rebased: true } })
    })

    it('leaves a pass whose turn is still assigned to recovery', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      const { passes } = runner(async () => {
        await db.turnAssignment.create({
          data: {
            taskId: dialog.taskId,
            siteId: siteIdOf(dialog),
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
