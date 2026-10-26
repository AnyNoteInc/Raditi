import { randomUUID } from 'node:crypto'

import type { AgentDriverRegistry } from '@repo/agent-drivers'
import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  createPrismaClient,
  insertFeedEvent,
  openBrowserSession,
  PostgresSiteLeaseStore,
  PostgresTaskTurnAssignmentStore,
  recordCandidate,
  upsertBrowserCheckpoint,
  type PrismaClient,
} from '@repo/db'
import {
  BROWSER_ONLY,
  browserTaskError,
  siteBusy,
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
import { PassRunner } from './pass-runner.ts'
import { PassSettlement } from './pass-settlement.ts'

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
  capabilities: { resume: true, jsonEvents: true, outputSchema: false, mcp: true, images: false },
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
  async function queued({ reserve, browser = false }: { reserve: boolean; browser?: boolean }) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status: 'queued',
      ...(browser ? { needsRepository: false, needsBrowser: true } : {}),
    })
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
    if (browser)
      await db.site.update({
        where: { id: task.siteId },
        data: { agentNotes: 'Вход по адресу /login' },
      })
    else
      await db.gitRepository.create({
        data: {
          siteId: task.siteId,
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
      browser?: { ensure: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> } | null
    } = {},
  ) {
    const queue = { enqueue: vi.fn(async () => {}) }
    const close = vi.fn(async () => {})
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
      live: new LivePasses(),
      queue,
      logger: quiet,
      now: () => NOW,
    })
    return { passes, queue, supervisor, close }
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
    expect(await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).toMatchObject({
      status: 'failed',
      turnNo: 0,
    })
    expect(await failure(dialog.taskId)).toEqual([
      { v: 1, turn: null, code: 'unavailable', site: 'unchanged', credits: null, next: 'failed' },
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
        next: 'failed',
      },
    ])
    const holds = await db.creditHold.findMany({ where: { taskId: dialog.taskId } })
    expect(holds.every((hold) => hold.status === 'released')).toBe(true)
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

    // One claim, one ending: the task without a reserve failed once, with one feed row.
    expect(await failure(dialog.taskId)).toHaveLength(1)
    expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe(
      'failed',
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
      // Nothing changed and nothing asked: the dialog waits for the next words (26.10.2026).
      const task = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
      expect(task.status).toBe('awaiting_user')
      expect(
        (await db.creditHold.findMany({ where: { taskId: dialog.taskId } })).every(
          (hold) => hold.status === 'active',
        ),
      ).toBe(true)
    })

    it('refuses a task with a repository while git is not configured, before its turn', async () => {
      await rate()
      const dialog = await queued({ reserve: true })
      const run = vi.fn<Run>()
      const { passes } = runner(run, undefined, { git: null })

      await passes.run(dialog.job)

      expect(run).not.toHaveBeenCalled()
      expect(await failure(dialog.taskId)).toEqual([
        expect.objectContaining({ code: 'unavailable', next: 'failed', credits: 'returned' }),
      ])
    })

    describe('a task in the cloud browser (docs/plan/57-browser-tasks.md)', () => {
      const editUrl = 'https://example.ru/wp-admin/post.php?post=12&action=edit'
      const browserSessions = () => ({
        ensure: vi.fn(async (_taskId: string, _signal: AbortSignal) => {}),
        verify: vi.fn(async (_taskId: string) => true),
      })

      it('runs on a core without git: opens the browser, plans no repository, verifies, ends done', async () => {
        await rate()
        const dialog = await queued({ reserve: true, browser: true })
        const browser = browserSessions()
        const order: string[] = []
        browser.ensure.mockImplementation(async () => {
          order.push('ensure')
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

        expect(order).toEqual(['ensure', 'run', 'verify'])
        expect(browser.ensure).toHaveBeenCalledWith(dialog.taskId, expect.any(AbortSignal))
        const request = planned!
        expect(() => toTurnPlan(request, sampleDriverId)).not.toThrow()
        expect(request.requirements).toEqual(BROWSER_ONLY)
        expect(request).not.toHaveProperty('workspace')
        expect(request.input.prompt).toContain('Поменяйте телефон в шапке')
        expect(request.input.prompt).toContain('Вход по адресу /login')
        expect(request.context.instructions).toContain('cloud browser')
        const task = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
        expect(task.status).toBe('done')
        const [result] = await db.taskEvent.findMany({
          where: { taskId: dialog.taskId, type: 'feed.result' },
        })
        expect(result!.payload).toMatchObject({
          site: 'changed',
          objects: [{ kind: 'post', status: 'draft', title: 'Скидки', editUrl }],
        })
        expect(close).toHaveBeenCalledExactlyOnceWith(dialog.taskId, 'task_done')
      })

      it('refuses the task when no browser worker is configured, before its turn', async () => {
        await rate()
        const dialog = await queued({ reserve: true, browser: true })
        const run = vi.fn<Run>()
        const { passes } = runner(run, undefined, { git: null, browser: null })

        await passes.run(dialog.job)

        expect(run).not.toHaveBeenCalled()
        expect(await failure(dialog.taskId)).toEqual([
          expect.objectContaining({ code: 'unavailable', next: 'failed', credits: 'returned' }),
        ])
      })

      it('refuses the task `unavailable` when its browser could not be opened', async () => {
        await rate()
        const dialog = await queued({ reserve: true, browser: true })
        const browser = browserSessions()
        browser.ensure.mockRejectedValue(browserTaskError('BROWSER_SESSION_UNAVAILABLE'))
        const run = vi.fn<Run>()
        const { passes } = runner(run, undefined, { git: null, browser })

        await passes.run(dialog.job)

        expect(run).not.toHaveBeenCalled()
        expect(browser.verify).not.toHaveBeenCalled()
        expect(await failure(dialog.taskId)).toEqual([
          expect.objectContaining({ code: 'unavailable', next: 'failed' }),
        ])
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
          'failed',
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

    it('starts the turn after «Обновить» as a new session on the head the update wrote', async () => {
      await rate()
      const dialog = await rebasedDialog()
      vi.mocked(git.readBranchHead).mockResolvedValue(REBASED)
      let planned: UnkeyedTurnRequest | null = null
      let admitted: unknown = null
      const { passes } = runner(async (request) => {
        planned = request
        // The store that opens the turn under the site lease admits what the planner built:
        // both read where the platform last left the task branch the same way.
        const fence = await new PostgresSiteLeaseStore(db).acquire({
          siteId: dialog.siteId,
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
        await db.siteLease.deleteMany({ where: { siteId: dialog.siteId } })
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
            siteId: dialog.siteId,
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
