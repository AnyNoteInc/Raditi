import { createHash, randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  createPrismaClient,
  excludeTurnDbOperations,
  includeTurnDbOperations,
  insertFeedEvent,
  PostgresSiteLeaseStore,
  PostgresTaskTurnAssignmentStore,
  recordCandidate,
  type CandidateRecordInput,
  type PrismaClient,
} from '@repo/db'
import {
  CANDIDATE_REWIND_EVENT,
  CANDIDATE_REWIND_JOB,
  CANDIDATE_REWIND_PUSH_EVENT,
  DomainError,
  previewHostname,
  siteIdOf,
  taskHoldExpiry,
  toTurnPlan,
  type AgentDriver,
  type CandidateFacts,
  type CandidateRewindJob,
  type LlmBackend,
  type TurnPlan,
} from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { getSiteAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  sampleBackendId,
  sampleDriverId,
  sampleModelSlug,
  sampleProviderModelId,
  sampleRoutePath,
} from '../testing/ids.ts'
import {
  CandidateBuilder,
  type CandidateBuild,
  type CandidateContext,
} from './candidate-builder.ts'
import type { CandidateGit } from './candidate-git.ts'
import { CandidateRewind, REWIND_GIVE_UP_MS } from './candidate-rewind.ts'
import { readPassFacts } from './pass-facts.ts'
import { TaskSweep } from './task-sweep.ts'
import { planTurn, UPDATE_REPAIR_MS } from './turn-planner.ts'

// `/undo` of a turn with the repository on PostgreSQL (docs/plan/61-chats-first.md, §5.14), with
// stand-ins for git and the builder of candidates: the lease of the site, the CAS of the task
// branch, the candidate of the turn before and what the next turn reads afterwards.
const databaseUrl = process.env.DATABASE_URL

const MAIN = 'a'.repeat(40)
const HEAD1 = 'b'.repeat(40)
const HEAD2 = 'c'.repeat(40)
const OTHER = 'd'.repeat(40)
const HEAD3 = 'f'.repeat(40)
const TREE = 'e'.repeat(40)
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
const emptyPlan = createHash('sha256').update('[]').digest('hex')

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
const record = (
  taskId: string,
  revision: number,
  turnNo: number,
  head: string,
  claims: Partial<Pick<CandidateFacts, 'changeType' | 'risk'>> = {},
): CandidateRecordInput => ({
  taskId,
  revision,
  turnNo,
  baseSha: MAIN,
  baseTree: 'f'.repeat(40),
  baseVersion: null,
  headSha: head,
  files: [{ path: 'wp-content/themes/t/a.php', change: 'added', sizeBytes: 3, executable: false }],
  media: [],
  dbPlan: [],
  dbPlanSha256: emptyPlan,
  proposedBump: 'minor',
  proposedVersion: 'v0.1.0',
  facts: { ...facts, ...claims },
  checks: ['php_lint', 'preview_smoke'],
  installed: null,
})

const EMPTY: CandidateBuild = { kind: 'empty', baseTree: TREE, dbPlanSha256: emptyPlan }

const gitDown = () => new DomainError('GIT_OPERATION_FAILED', 'git did not answer', 502)

// The plan reads only these of a driver and of a backend.
const driver = {
  id: sampleDriverId,
  image,
  cliVersion: '1.0.0',
  capabilities: { resume: true },
  sessionState: () => ({ root: `/agent-home/${sampleDriverId}`, include: [], exclude: [] }),
} as unknown as AgentDriver
const backend = {
  id: sampleBackendId,
  routes: [{ method: 'POST', path: sampleRoutePath }],
} as unknown as LlmBackend

describe.skipIf(!databaseUrl)('`/undo` of a turn with the repository on PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  let leases: PostgresSiteLeaseStore

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
    leases = new PostgresSiteLeaseStore(db)
  })
  afterEach(async () => {
    await db.previewDbOperation.deleteMany({
      where: { task: { site: { name: 'Billing verification' } } },
    })
    await db.mcpCall.deleteMany({
      where: { turn: { task: { site: { name: 'Billing verification' } } } },
    })
    await db.snapshot.deleteMany({ where: { site: { name: 'Billing verification' } } })
    await db.gitRepository.deleteMany({ where: { owner: 'sites-61-rewind' } })
    const sites = await db.site.findMany({
      where: { name: 'Billing verification', tasks: { some: { turns: { some: {} } } } },
      select: { id: true, tasks: { select: { id: true } } },
    })
    // The rows of the sites and those of their chats (`turnLeaseOf`).
    await db.siteLease.deleteMany({
      where: {
        siteId: { in: sites.flatMap((site) => [site.id, ...site.tasks.map((task) => task.id)]) },
      },
    })
    await fixtures.cleanup()
    vi.clearAllMocks()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /** The plan a turn was assigned, as the planner keeps it. */
  const planOf = (
    task: { id: string; workspaceId: string; siteId: string | null },
    turn: number,
    workspace: { base: string; pin?: string | null; rebased?: boolean },
  ): TurnPlan => ({
    sandbox: {
      image,
      labels: {
        workspaceId: task.workspaceId,
        siteId: siteIdOf(task),
        taskId: task.id,
        sessionId: task.id,
        turn,
      },
      runtime: 'runc',
      resources: { cpu: 1, memoryMiB: 256, pids: 64 },
      user: { uid: 10001, gid: 10001 },
      env: {},
      secrets: [],
      network: { mode: 'none' },
      hardTimeoutMs: 600_000,
    },
    context: {
      taskId: task.id,
      sessionId: task.id,
      turn,
      llm: { baseUrl: 'http://llm.invalid', model: 'synthetic' },
      mcp: { url: 'http://mcp.invalid/mcp' },
      instructions: 'Synthetic',
    },
    input: { prompt: 'Synthetic', attachments: [] },
    driverId: sampleDriverId,
    driverVersion: '1.0.0',
    workspace: {
      repo: { provider: 'gitea', owner: 'sites-61-rewind', name: 'site' },
      branch: `agent/${task.id}`,
      expectedBaseSha: workspace.base,
      ...(workspace.pin === undefined ? {} : { expectedBranchSha: workspace.pin }),
      protectedPaths: [],
    },
    ...(workspace.pin === undefined ? {} : { replacesTurn: turn - 1 }),
    ...(workspace.rebased ? { rebased: true } : {}),
    committedAt: '2026-10-01T00:00:00.000Z',
  })

  /**
   * A chat that waits after its last turn: turns of `heads` completed, each with its plan; `pins`
   * — turns that replaced the turn before, with where they found the branch.
   */
  async function chat(options: {
    heads: readonly string[]
    status?: 'awaiting_user' | 'awaiting_approval'
    bases?: readonly string[]
    pins?: Readonly<Record<number, string | null>>
    rejected?: readonly number[]
    /** Turns that started on a head «Обновить» wrote: a new session on it. */
    rebased?: readonly number[]
    browser?: boolean
  }) {
    const { heads, status = 'awaiting_approval' } = options
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status,
      turnNo: heads.length,
      ...(options.browser ? { needsBrowser: true } : {}),
    })
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
    await db.gitRepository.create({
      data: {
        siteId: siteIdOf(task),
        provider: 'gitea',
        owner: 'sites-61-rewind',
        name: `site-${task.siteId}`,
        url: `https://git.invalid/sites/site-${task.siteId}.git`,
      },
    })
    for (const [at, head] of heads.entries()) {
      const turn = at + 1
      const base = options.bases?.[at] ?? (at === 0 ? MAIN : heads[at - 1]!)
      await db.taskTurn.create({
        data: {
          taskId,
          turnNo: turn,
          status: 'completed',
          driverId: sampleDriverId,
          image,
          baseSha: base,
          headSha: head,
          startedAt: new Date(Date.now() - 60_000 + at),
          ...(options.rejected?.includes(turn) ? { rejectedAt: new Date() } : {}),
        },
      })
      const pin = options.pins?.[turn]
      await db.turnAssignment.create({
        data: {
          taskId,
          siteId: siteIdOf(task),
          sessionId: taskId,
          turnNo: turn,
          executor: 'local',
          plan: planOf(task, turn, {
            base,
            ...(pin === undefined ? {} : { pin }),
            ...(options.rebased?.includes(turn) ? { rebased: true } : {}),
          }),
          firstEpoch: 1,
          leaseEpoch: 1,
          deadlineAt: new Date(Date.now() + 60_000),
          outcome: 'completed',
          finishedAt: new Date(),
        },
      })
    }
    return { taskId, userId, workspaceId: workspace.id, siteId: siteIdOf(task) }
  }

  /** The `/undo` press of the chat, as web writes it; `/redo` by `command`. */
  async function press(
    dialog: { taskId: string; userId: string },
    command: 'turn_undo' | 'turn_redo' = 'turn_undo',
  ) {
    const id = await insertFeedEvent(db, {
      taskId: dialog.taskId,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'command',
          command,
          authorId: dialog.userId,
          requestId: randomUUID(),
        },
      },
    })
    return { taskId: dialog.taskId, requestEventId: id.toString() }
  }

  interface Setup {
    /** Where `agent/<taskId>` stands; a push moves it. */
    branch: string | null
    /** Commits whose tree is the same as the one before them: no file changed. */
    sameTree?: readonly string[]
    build?: (
      context: CandidateContext,
      pass: { turnNo: number; headSha: string; withoutTurn?: number },
    ) => CandidateBuild | Promise<CandidateBuild>
    /** Runs right before the push, under the fence. */
    beforePush?: () => Promise<void>
    /** Runs before the hold of the undone commit, ahead of its fence. */
    onHold?: () => Promise<void>
    /** Runs right after the push: where a core dies, or its database goes away. */
    afterPush?: () => void | Promise<void>
    /** Commits no mirror holds any more: the branch left them, and core was started anew. */
    gone?: readonly string[]
    now?: () => Date
    db?: PrismaClient
  }

  function setup(options: Setup) {
    const state: { branch: string | null; held: string | null } = {
      branch: options.branch,
      held: null,
    }
    const git = {
      readBranchHead: vi.fn(async () => state.branch),
      treeOf: vi.fn(async ({ sha }: { sha: string }) => {
        if (options.gone?.includes(sha))
          throw new DomainError('GIT_OPERATION_FAILED', 'no such commit', 502)
        return options.sameTree?.includes(sha) ? TREE : sha
      }),
      comparesCommits: true,
      compareCommits: vi.fn(),
      rebaseCandidate: vi.fn(),
      holdUndoneCommit: vi.fn(
        async (
          input: { branch: string; sha: string },
          assertFence: () => Promise<void> = async () => {},
        ) => {
          await options.onHold?.()
          await assertFence()
          state.held = input.sha
        },
      ),
      rewindBranch: vi.fn(
        async (
          input: { from: string | null; to: string | null },
          assertFence: () => Promise<void> = async () => {},
        ) => {
          if (state.branch === input.to) return
          await options.beforePush?.()
          await assertFence()
          state.branch = input.to
          await options.afterPush?.()
        },
      ),
    }
    const candidates = {
      context: vi.fn(
        async (task: { id: string }, standing: CandidateContext['standing'], revision: number) => ({
          taskId: task.id,
          repo: { provider: 'gitea' as const, owner: 'sites-61-rewind', name: 'site' },
          addOnlyPaths: [],
          base: MAIN,
          standing,
          installedVersion: null,
          releasedVersions: [],
          revision,
        }),
      ),
      build: vi.fn(
        async (
          context: CandidateContext,
          pass: { turnNo: number; headSha: string; withoutTurn?: number },
        ) =>
          options.build?.(context, pass) ??
          ({
            kind: 'candidate' as const,
            record: record(context.taskId, context.revision, pass.turnNo, pass.headSha),
          } satisfies CandidateBuild),
      ),
    }
    const queue = { enqueue: vi.fn(async (..._put: unknown[]) => {}) }
    const rewind = new CandidateRewind({
      db: options.db ?? db,
      git: git as unknown as CandidateGit,
      candidates: candidates as unknown as CandidateBuilder,
      leases,
      queue,
      logger: quiet,
      ...(options.now ? { now: options.now } : {}),
    })
    return { rewind, git, queue, candidates, state }
  }

  /** A client of the same database in which `broken` calls refuse, as they do when it goes away. */
  function failing(broken: { calls: Set<string>; on: boolean }): PrismaClient {
    const refused = () => Promise.reject(new Error('The database does not answer'))
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property === '$transaction' && broken.on && broken.calls.has('$transaction'))
          return refused
        const value: unknown = Reflect.get(target, property, receiver)
        if (typeof property !== 'string' || typeof value !== 'object' || value === null)
          return typeof value === 'function' ? value.bind(target) : value
        return new Proxy(value, {
          get(model, method) {
            const call: unknown = Reflect.get(model, method)
            if (broken.on && broken.calls.has(`${property}.${String(method)}`)) return refused
            return typeof call === 'function' ? call.bind(model) : call
          },
        })
      },
    })
  }

  /** `at` past now: the press is that old for the job. */
  const after = (ms: number) => () => new Date(Date.now() + ms)
  /** The job that wrote `candidate.rewind.push` died or lost the database: the push may be made. */
  const markedPush = (job: CandidateRewindJob, files = true) =>
    db.taskEvent.create({
      data: {
        taskId: job.taskId,
        type: CANDIDATE_REWIND_PUSH_EVENT,
        payload: { v: 1, requestEventId: job.requestEventId, files },
      },
    })
  /** How many rows say a job of the press reached the push. */
  const pushRows = (job: CandidateRewindJob) =>
    db.taskEvent.count({
      where: {
        taskId: job.taskId,
        type: CANDIDATE_REWIND_PUSH_EVENT,
        payload: { path: ['requestEventId'], equals: job.requestEventId },
      },
    })

  /** A write of the turn into the dialog's preview, with what the journal keeps of it. */
  async function previewWrite(dialog: { taskId: string; siteId: string }, turnNo: number) {
    const task = await db.task.findUniqueOrThrow({
      where: { id: dialog.taskId },
      include: { site: true },
    })
    const preview =
      (await db.previewEnvironment.findFirst({ where: { taskId: dialog.taskId } })) ??
      (await db.previewEnvironment.create({
        data: {
          siteId: dialog.siteId,
          taskId: dialog.taskId,
          status: 'ready',
          dbMode: 'copy',
          hostname: previewHostname(
            { siteAlias: task.site!.alias, taskAlias: task.alias },
            'localhost',
          ),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      }))
    const turn = await db.taskTurn.findUniqueOrThrow({
      where: { taskId_turnNo: { taskId: dialog.taskId, turnNo } },
    })
    const assignment = await db.turnAssignment.findFirstOrThrow({
      where: { taskId: dialog.taskId, turnNo },
    })
    const objectRef = `post:${turnNo}`
    const snapshot = await db.snapshot.create({
      data: {
        siteId: dialog.siteId,
        taskId: task.id,
        previewId: preview.id,
        objectRef,
        s3Key: `snapshots/${randomUUID()}.json`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const hash = (seed: string) => createHash('sha256').update(seed).digest('hex')
    const call = randomUUID()
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO mcp_calls (id, turn_id, tool, idempotency_key, assignment_id,
          credential_key_id, preview_id, preview_write_epoch, request_hash, lease_epoch,
          snapshot_id, object_ref)
        VALUES (${call}::uuid, ${turn.id}::uuid, 'wp_rest', ${`synthetic-${call}`},
          ${assignment.id}::uuid, ${randomUUID()}::uuid, ${preview.id}::uuid, 1, ${hash('1')},
          1, ${snapshot.id}::uuid, ${objectRef})`
      await tx.previewDbOperation.create({
        data: {
          taskId: task.id,
          previewId: preview.id,
          turnNo,
          mcpCallId: call,
          kind: 'content_update',
          objectRef,
          fields: ['title'],
          beforeHash: hash(`before-${turnNo}`),
          afterHash: hash(`after-${turnNo}`),
          beforeObjectKey: `tasks/${task.id}/db/${call}/before.json`,
          beforeSha256: hash('2'),
          beforeBytes: 10,
          afterObjectKey: `tasks/${task.id}/db/${call}/after.json`,
          afterSha256: hash('3'),
          afterBytes: 10,
        },
      })
    })
  }

  /** The builder of candidates of the product, as far as the plan of the database goes. */
  const planBuilder = () =>
    new CandidateBuilder(db, {} as unknown as CandidateGit, { put: vi.fn() }, getSiteAdapter)
  const planOfTask = async (taskId: string, withoutTurn?: number) =>
    (await planBuilder().dbPlan(taskId, withoutTurn)).plan.map((entry) => entry.objectRef)

  const answers = async (taskId: string) =>
    (
      await db.taskEvent.findMany({
        where: { taskId, type: CANDIDATE_REWIND_EVENT },
        orderBy: { id: 'asc' },
      })
    ).map((row) => (row.payload as { outcome: string }).outcome)
  const feedOf = async (taskId: string) =>
    (
      await db.taskEvent.findMany({
        where: {
          taskId,
          type: { in: ['feed.rewind', 'feed.redo', 'feed.update', 'feed.candidate'] },
        },
        orderBy: { id: 'asc' },
      })
    ).map((row) => ({ type: row.type, payload: row.payload }))
  const statusOf = async (taskId: string) =>
    (await db.task.findUniqueOrThrow({ where: { id: taskId } })).status
  const undoneOf = async (taskId: string, turnNo: number) =>
    (await db.taskTurn.findUniqueOrThrow({ where: { taskId_turnNo: { taskId, turnNo } } })).undoneAt
  const revisions = async (taskId: string) =>
    (await db.taskCandidate.findMany({ where: { taskId }, orderBy: { revision: 'asc' } })).map(
      (c) => [c.revision, c.status, c.turnNo, c.headSha],
    )
  /** Every number of money the chat touches, but the term of its reserve. */
  async function moneyOf(dialog: { taskId: string; workspaceId: string }) {
    const holds = await db.creditHold.findMany({
      where: { taskId: dialog.taskId },
      orderBy: { id: 'asc' },
    })
    return {
      ledger: await db.creditLedger.findMany({
        where: { account: { workspaceId: dialog.workspaceId } },
        orderBy: { id: 'asc' },
      }),
      accounts: await db.billingAccount.findMany({
        where: { workspaceId: dialog.workspaceId },
        orderBy: { id: 'asc' },
      }),
      holds: holds.map(({ expiresAt: _expiry, ...hold }) => hold),
    }
  }
  /** The `preview.sync` jobs of the chat's preview: the revisions it was asked for. */
  async function syncsOf(taskId: string) {
    const preview = await db.previewEnvironment.findFirstOrThrow({ where: { taskId } })
    const rows = await db.outboxEvent.findMany({
      where: { type: 'preview.sync', payload: { path: ['previewId'], equals: preview.id } },
      orderBy: { id: 'asc' },
    })
    return rows.map((row) => (row.payload as { revision: number }).revision)
  }

  it('takes the branch and the candidate back to the turn before, under the lease of the site', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    await db.$transaction(async (tx) => {
      await recordCandidate(tx, record(dialog.taskId, 1, 1, HEAD1))
      await recordCandidate(tx, record(dialog.taskId, 2, 2, HEAD2))
    })
    const { rewind, git, candidates } = setup({
      branch: HEAD2,
      build: (context, pass) => {
        expect(pass.turnNo).toBe(1)
        return {
          kind: 'candidate',
          record: record(context.taskId, context.revision, pass.turnNo, pass.headSha),
        }
      },
    })
    const fenced = vi.spyOn(leases, 'assert')

    expect(await rewind.run(await press(dialog))).toBe('rewound')

    expect(git.rewindBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branch: `agent/${dialog.taskId}`, from: HEAD2, to: HEAD1 }),
      expect.any(Function),
    )
    expect(fenced).toHaveBeenCalled()
    expect(candidates.build).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headSha: HEAD1, withoutTurn: 2 }),
    )
    expect(await revisions(dialog.taskId)).toEqual([
      [1, 'superseded', 1, HEAD1],
      [2, 'superseded', 2, HEAD2],
      [3, 'current', 1, HEAD1],
    ])
    expect(await statusOf(dialog.taskId)).toBe('awaiting_approval')
    expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
    expect(await undoneOf(dialog.taskId, 1)).toBeNull()
    expect(await answers(dialog.taskId)).toEqual(['rewound'])
    const rows = await feedOf(dialog.taskId)
    expect(rows.map((row) => row.type)).toEqual(['feed.candidate', 'feed.rewind'])
    expect(rows[1]?.payload).toEqual({ v: 1, turn: 2, files: true, site: 'unchanged' })
    // The words about this revision are those of turn 1: the turn taken back said something else.
    expect(rows[0]?.payload).toMatchObject({ turn: 1, revision: 3 })
  })

  it('gives the revision the claims of the agent from before the turn, not those of the turn', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    await db.$transaction(async (tx) => {
      await recordCandidate(
        tx,
        record(dialog.taskId, 1, 1, HEAD1, { changeType: 'content', risk: 'high' }),
      )
      await recordCandidate(tx, record(dialog.taskId, 2, 2, HEAD2))
    })
    const { rewind, candidates } = setup({ branch: HEAD2 })
    await rewind.run(await press(dialog))
    expect(candidates.build).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        turnNo: 1,
        claims: { change_type: 'content', risk: 'high' },
      }),
    )
  })

  it('names no claims and the turn before when nothing was written of the head it goes to', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2], bases: [MAIN, OTHER] })
    await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
    const { rewind, candidates } = setup({ branch: HEAD2 })
    await rewind.run(await press(dialog))
    expect(candidates.build).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ turnNo: 1, headSha: OTHER, claims: null }),
    )
  })

  it('leaves the records of the turn before in the plan and takes those of the turn out', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    await previewWrite(dialog, 1)
    await previewWrite(dialog, 2)
    await db.$transaction(async (tx) => {
      await recordCandidate(tx, record(dialog.taskId, 1, 1, HEAD1))
      await recordCandidate(tx, record(dialog.taskId, 2, 2, HEAD2))
    })
    const built: string[][] = []
    const { rewind } = setup({
      branch: HEAD2,
      build: async (context, pass) => {
        built.push(await planOfTask(context.taskId, pass.withoutTurn))
        return {
          kind: 'candidate',
          record: record(context.taskId, context.revision, pass.turnNo, pass.headSha),
        }
      },
    })

    expect(await rewind.run(await press(dialog))).toBe('rewound')

    expect(built).toEqual([['post:1']])
    const operations = await db.previewDbOperation.findMany({
      where: { taskId: dialog.taskId },
      orderBy: { turnNo: 'asc' },
    })
    expect(operations.map((row) => [row.turnNo, row.excluded])).toEqual([
      [1, false],
      [2, true],
    ])
    // What the next build reads with nothing to leave out, and `/release` after it.
    expect(await planOfTask(dialog.taskId)).toEqual(['post:1'])
    expect(await syncsOf(dialog.taskId)).toEqual([3])
  })

  it('keeps the money of the pass: nothing is held anew, charged or given back', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
    const placedAt = new Date(Date.now() - 60_000)
    await fixtures.reserve({
      workspaceId: dialog.workspaceId,
      taskId: dialog.taskId,
      attempt: 1,
      now: placedAt,
      expiresAt: new Date(placedAt.getTime() + 3_600_000),
    })
    const before = await moneyOf(dialog)
    expect(before.holds.length).toBeGreaterThan(0)
    const at = new Date()
    const { rewind } = setup({ branch: HEAD2, now: () => at })

    expect(await rewind.run(await press(dialog))).toBe('rewound')

    expect(await moneyOf(dialog)).toEqual(before)
    // The chat waits on, and so does its reserve.
    const holds = await db.creditHold.findMany({ where: { taskId: dialog.taskId } })
    for (const hold of holds) expect(hold.expiresAt).toEqual(taskHoldExpiry(at, 'waiting'))
  })

  it('leaves the chat open and deletes the branch when the first turn goes back to nothing', async () => {
    const dialog = await chat({ heads: [HEAD1] })
    await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 1, HEAD1)))
    const { rewind, git, state } = setup({ branch: HEAD1, build: () => EMPTY })

    expect(await rewind.run(await press(dialog))).toBe('rewound')

    expect(git.rewindBranch).toHaveBeenCalledWith(
      expect.objectContaining({ from: HEAD1, to: null }),
      expect.any(Function),
    )
    expect(state.branch).toBeNull()
    // Open for the next words, never `done`: finishEmptiedDialog is for «Обновить».
    expect(await statusOf(dialog.taskId)).toBe('awaiting_user')
    expect(await revisions(dialog.taskId)).toEqual([[1, 'superseded', 1, HEAD1]])
    expect(await feedOf(dialog.taskId)).toEqual([
      { type: 'feed.rewind', payload: { v: 1, turn: 1, files: true, site: 'unchanged' } },
    ])
  })

  it('says nothing of files after a turn that changed none (К19)', async () => {
    // A turn publishes a commit whatever it did: of the same tree when it changed nothing.
    const dialog = await chat({ heads: [HEAD1], status: 'awaiting_user' })
    const { rewind } = setup({ branch: HEAD1, sameTree: [MAIN, HEAD1], build: () => EMPTY })

    expect(await rewind.run(await press(dialog))).toBe('rewound')

    expect(await statusOf(dialog.taskId)).toBe('awaiting_user')
    expect(await feedOf(dialog.taskId)).toEqual([
      { type: 'feed.rewind', payload: { v: 1, turn: 1, files: false, site: 'unchanged' } },
    ])
  })

  it('brings the chat back to its candidate after a turn that asked a question', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2], status: 'awaiting_user' })
    await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 1, HEAD1)))
    const { rewind } = setup({
      branch: HEAD2,
      sameTree: [HEAD1, HEAD2],
      build: () => ({ kind: 'unchanged' }),
    })

    expect(await rewind.run(await press(dialog))).toBe('rewound')

    // The revision that stood before the turn stands: `/release` is open again.
    expect(await statusOf(dialog.taskId)).toBe('awaiting_approval')
    expect(await revisions(dialog.taskId)).toEqual([[1, 'current', 1, HEAD1]])
    expect((await feedOf(dialog.taskId)).map((row) => row.type)).toEqual(['feed.rewind'])
  })

  it('leaves the branch where a replacement found it, and the candidate on what it worked from', async () => {
    // Turn 1 published and was refused; turn 2 replaced it from `main`, leased on its head.
    const dialog = await chat({
      heads: [HEAD1, HEAD2],
      bases: [MAIN, MAIN],
      pins: { 2: HEAD1 },
      rejected: [1],
    })
    await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
    const { rewind, git, candidates } = setup({ branch: HEAD2, build: () => EMPTY })

    expect(await rewind.run(await press(dialog))).toBe('rewound')

    expect(git.rewindBranch).toHaveBeenCalledWith(
      expect.objectContaining({ from: HEAD2, to: HEAD1 }),
      expect.any(Function),
    )
    expect(candidates.build).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headSha: MAIN }),
    )
  })

  // docs/plan/61-chats-first.md, §5.14: turn 1, turn 2, `/undo`, «Обновить», turn 3, `/undo`.
  it('gives the revision the words the feed gave the one it stands on, not those of a turn taken back', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2, HEAD3], bases: [MAIN, HEAD1, OTHER] })
    const candidateRow = (revision: number, turn: number) =>
      insertFeedEvent(db, {
        taskId: dialog.taskId,
        row: {
          type: 'feed.candidate',
          payload: {
            v: 1,
            turn,
            revision,
            version: 'v0.1.0',
            bump: 'minor',
            files: { added: 1, modified: 0, deleted: 0 },
            media: 0,
            records: 0,
          },
        },
      })
    await db.taskTurn.update({
      where: { taskId_turnNo: { taskId: dialog.taskId, turnNo: 2 } },
      data: { undoneAt: new Date() },
    })
    // «Обновить» after `/undo` records under the undone turn, and says the words of turn 1.
    await db.$transaction(async (tx) => {
      await recordCandidate(tx, record(dialog.taskId, 1, 2, OTHER))
      await recordCandidate(tx, record(dialog.taskId, 2, 3, HEAD3))
    })
    await candidateRow(1, 1)
    await candidateRow(2, 3)
    const { rewind } = setup({ branch: HEAD3 })

    expect(await rewind.run(await press(dialog))).toBe('rewound')

    // The record keeps the turn that wrote the head: `moved` and `writtenHead` read it.
    expect((await revisions(dialog.taskId)).at(-1)).toEqual([3, 'current', 2, OTHER])
    expect((await feedOf(dialog.taskId)).at(-2)).toMatchObject({
      type: 'feed.candidate',
      payload: { turn: 1, revision: 3 },
    })
  })

  it('gives the revision the words of the turn before a compaction, not those of the platform', async () => {
    // Turn 2 compacted the session and published the same tree: nothing of it became a revision.
    const dialog = await chat({ heads: [HEAD1, HEAD2, HEAD3], bases: [MAIN, HEAD1, HEAD2] })
    await db.$transaction(async (tx) => {
      await recordCandidate(tx, record(dialog.taskId, 1, 1, HEAD1))
      await recordCandidate(tx, record(dialog.taskId, 2, 3, HEAD3))
    })
    await insertFeedEvent(db, {
      taskId: dialog.taskId,
      row: {
        type: 'feed.candidate',
        payload: {
          v: 1,
          turn: 1,
          revision: 1,
          version: 'v0.1.0',
          bump: 'minor',
          files: { added: 1, modified: 0, deleted: 0 },
          media: 0,
          records: 0,
        },
      },
    })
    const { rewind } = setup({ branch: HEAD3 })

    expect(await rewind.run(await press(dialog))).toBe('rewound')

    expect((await revisions(dialog.taskId)).at(-1)).toEqual([3, 'current', 2, HEAD2])
    expect((await feedOf(dialog.taskId)).at(-2)).toMatchObject({
      type: 'feed.candidate',
      payload: { turn: 1, revision: 3 },
    })
  })

  it('moves nothing past «Обновить»: the branch stands on the turn, the candidate does not', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, OTHER)))
    const { rewind, git } = setup({ branch: HEAD2 })

    expect(await rewind.run(await press(dialog))).toBe('refused')

    expect(git.rewindBranch).not.toHaveBeenCalled()
    expect(await undoneOf(dialog.taskId, 2)).toBeNull()
    expect(await answers(dialog.taskId)).toEqual(['refused'])
    expect(await feedOf(dialog.taskId)).toEqual([
      { type: 'feed.update', payload: { v: 1, outcome: 'rewind_failed', conflicts: 0 } },
    ])
  })

  it('moves nothing when the branch is not where the turn left it', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    const { rewind, git } = setup({ branch: OTHER })
    expect(await rewind.run(await press(dialog))).toBe('refused')
    expect(git.rewindBranch).not.toHaveBeenCalled()
    expect(await statusOf(dialog.taskId)).toBe('awaiting_approval')
  })

  it('finishes from a branch that moved already, when the record failed the first time', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    await previewWrite(dialog, 2)
    await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
    let broken = true
    const { rewind, git, queue, state, candidates } = setup({
      branch: HEAD2,
      gone: [HEAD2],
      build: (context, pass) => ({
        kind: 'candidate',
        // A revision the record refuses: the branch is pushed by then.
        record: record(context.taskId, broken ? 0 : context.revision, pass.turnNo, pass.headSha),
      }),
    })
    git.treeOf.mockResolvedValueOnce(HEAD2).mockResolvedValueOnce(HEAD1)
    const job = await press(dialog)

    expect(await rewind.run(job)).toBe('later')
    expect(state.branch).toBe(HEAD1)
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(await answers(dialog.taskId)).toEqual([])
    expect(await undoneOf(dialog.taskId, 2)).toBeNull()
    // Nothing of the record stays: the turn is not undone, and its writes are in the plan.
    expect(await planOfTask(dialog.taskId)).toEqual(['post:2'])

    broken = false
    expect(await rewind.run(job)).toBe('rewound')
    // The commit left the remote with the branch, and a repeat asks nothing of it: no push, no
    // look at the trees, and the build compares with the base, not with the head that went.
    expect(git.rewindBranch).toHaveBeenCalledTimes(1)
    expect(candidates.build).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ baseSha: MAIN }),
    )
    expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
    expect(await answers(dialog.taskId)).toEqual(['rewound'])
    expect((await feedOf(dialog.taskId)).at(-1)?.payload).toMatchObject({ files: true })
    expect(await planOfTask(dialog.taskId)).toEqual([])
  })

  it('answers a press once: a repeat of the job finds the turn undone', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
    const { rewind } = setup({ branch: HEAD2 })
    const job = await press(dialog)
    expect(await rewind.run(job)).toBe('rewound')
    await rewind.run(job)
    expect(await answers(dialog.taskId)).toEqual(['rewound'])
    expect((await feedOf(dialog.taskId)).filter((row) => row.type === 'feed.rewind')).toHaveLength(
      1,
    )
    expect((await feedOf(dialog.taskId)).filter((row) => row.type === 'feed.update')).toEqual([])
  })

  it('waits for a release of its site and answers nothing meanwhile', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    // A release of another chat of the site holds it (a turn of another chat would not,
    // `turnLeaseOf`).
    const other = await fixtures.task(dialog.workspaceId, {
      siteId: dialog.siteId,
      status: 'deploying',
    })
    const held = await leases.acquire({
      siteId: dialog.siteId,
      taskId: other.taskId,
      operation: 'deploy',
      ttlMs: 60_000,
    })
    const { rewind, git, queue } = setup({ branch: HEAD2 })

    expect(await rewind.run(await press(dialog))).toBe('busy')

    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(git.rewindBranch).not.toHaveBeenCalled()
    expect(await answers(dialog.taskId)).toEqual([])
    await leases.release(held!)
  })

  it('moves nothing when the chat closed before the push, and tells no one', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    const { rewind, state } = setup({
      branch: HEAD2,
      beforePush: async () => {
        await db.task.update({ where: { id: dialog.taskId }, data: { status: 'cancelled' } })
      },
    })

    expect(await rewind.run(await press(dialog))).toBe('nothing')

    expect(state.branch).toBe(HEAD2)
    expect(await undoneOf(dialog.taskId, 2)).toBeNull()
    expect(await answers(dialog.taskId)).toEqual(['nothing'])
    expect(await feedOf(dialog.taskId)).toEqual([])
  })

  it('tells of a press this core cannot carry out, and the chat takes words again', async () => {
    const dialog = await chat({ heads: [HEAD1] })
    const rewind = new CandidateRewind({
      db,
      git: null,
      candidates: null,
      leases,
      queue: { enqueue: vi.fn(async () => {}) },
      logger: quiet,
    })
    expect(await rewind.run(await press(dialog))).toBe('unavailable')
    expect(await answers(dialog.taskId)).toEqual(['unavailable'])
    expect((await feedOf(dialog.taskId)).map((row) => row.type)).toEqual(['feed.update'])
  })

  it('takes a failure of git for later, before anything moved', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    const { rewind, git, queue } = setup({ branch: HEAD2 })
    git.readBranchHead.mockRejectedValueOnce(gitDown())
    expect(await rewind.run(await press(dialog))).toBe('later')
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(await answers(dialog.taskId)).toEqual([])
  })

  it('leaves the branch where it is when the lease of the site is lost before the push', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    const { rewind, queue, state } = setup({ branch: HEAD2 })
    const lost = vi.spyOn(leases, 'assert').mockResolvedValueOnce(false)
    expect(await rewind.run(await press(dialog))).toBe('later')
    lost.mockRestore()
    expect(state.branch).toBe(HEAD2)
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(await undoneOf(dialog.taskId, 2)).toBeNull()
    expect(await answers(dialog.taskId)).toEqual([])
  })

  it('moves nothing when another turn started before the push', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2] })
    const { rewind, state } = setup({
      branch: HEAD2,
      beforePush: async () => {
        await db.task.update({ where: { id: dialog.taskId }, data: { turnNo: 3 } })
      },
    })
    expect(await rewind.run(await press(dialog))).toBe('nothing')
    expect(state.branch).toBe(HEAD2)
    expect(await feedOf(dialog.taskId)).toEqual([])
  })

  describe('what the feed says of the site', () => {
    /** An applied write of the turn on the site itself, not into a preview. */
    async function liveWrite(dialog: { taskId: string; siteId: string }, turnNo: number) {
      const turn = await db.taskTurn.findUniqueOrThrow({
        where: { taskId_turnNo: { taskId: dialog.taskId, turnNo } },
      })
      const assignment = await db.turnAssignment.findFirstOrThrow({
        where: { taskId: dialog.taskId, turnNo },
      })
      const snapshot = await db.snapshot.create({
        data: {
          siteId: dialog.siteId,
          taskId: dialog.taskId,
          objectRef: 'page:42',
          s3Key: `snapshots/${randomUUID()}.json`,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      })
      await db.mcpCall.create({
        data: {
          turnId: turn.id,
          tool: 'wp_rest',
          idempotencyKey: randomUUID(),
          assignmentId: assignment.id,
          credentialKeyId: randomUUID(),
          requestHash: 'a'.repeat(64),
          leaseEpoch: 1,
          writeStartedAt: new Date(),
          appliedStateHash: 'b'.repeat(64),
          objectRef: 'page:42',
          snapshotId: snapshot.id,
          result: 'ok',
          response: {},
          finishedAt: new Date(),
        },
      })
    }

    it('says «проверьте сайт» after a click in the browser of the chat, and takes the turn back', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2], browser: true })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
      await db.browserSession.create({
        data: {
          taskId: dialog.taskId,
          workspaceId: dialog.workspaceId,
          siteId: dialog.siteId,
          status: 'ready',
          readyAt: new Date(),
          expiresAt: new Date(Date.now() + 3_600_000),
          wroteAt: new Date(),
          lastWroteAt: new Date(),
        },
      })
      const { rewind } = setup({ branch: HEAD2 })

      expect(await rewind.run(await press(dialog))).toBe('rewound')

      // The browser belongs to the whole task: what it did is no write of this turn.
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect((await feedOf(dialog.taskId)).at(-1)).toEqual({
        type: 'feed.rewind',
        payload: { v: 1, turn: 2, files: true, site: 'check' },
      })
    })

    it('refuses a turn that wrote on the site, a write that came after the press too', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      const job = await press(dialog)
      await liveWrite(dialog, 2)
      const { rewind, git } = setup({ branch: HEAD2 })

      expect(await rewind.run(job)).toBe('refused')

      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(await undoneOf(dialog.taskId, 2)).toBeNull()
      expect(await answers(dialog.taskId)).toEqual(['refused'])
      expect(await feedOf(dialog.taskId)).toEqual([
        { type: 'feed.update', payload: { v: 1, outcome: 'rewind_failed', conflicts: 0 } },
      ])
    })

    it('takes back a turn whose earlier turn wrote on the site, and says so', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
      await liveWrite(dialog, 1)
      const { rewind } = setup({ branch: HEAD2 })
      expect(await rewind.run(await press(dialog))).toBe('rewound')
      expect((await feedOf(dialog.taskId)).at(-1)?.payload).toMatchObject({ site: 'check' })
    })
  })

  describe('a press nothing answered: the chat is closed until something does', () => {
    const giveUp = after(REWIND_GIVE_UP_MS + 60_000)
    const failedRow = {
      type: 'feed.update',
      payload: { v: 1, outcome: 'rewind_failed', conflicts: 0 },
    }

    it('gives up a press past its time when git never answered, and the chat goes on', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      const { rewind, git, queue } = setup({ branch: HEAD2, now: giveUp })
      git.readBranchHead.mockRejectedValueOnce(gitDown())

      expect(await rewind.run(await press(dialog))).toBe('later')

      expect(queue.enqueue).not.toHaveBeenCalled()
      expect(await answers(dialog.taskId)).toEqual(['later'])
      expect(await feedOf(dialog.taskId)).toEqual([failedRow])
    })

    it('gives up a press past its time while a release holds the site for days', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      const other = await fixtures.task(dialog.workspaceId, {
        siteId: dialog.siteId,
        status: 'deploying',
      })
      const held = await leases.acquire({
        siteId: dialog.siteId,
        taskId: other.taskId,
        operation: 'deploy',
        ttlMs: 60_000,
      })
      const job = await press(dialog)

      const young = setup({ branch: HEAD2 })
      expect(await young.rewind.run(job)).toBe('busy')
      expect(await answers(dialog.taskId)).toEqual([])

      const { rewind, git, queue } = setup({ branch: HEAD2, now: giveUp })
      expect(await rewind.run(job)).toBe('later')
      expect(queue.enqueue).not.toHaveBeenCalled()
      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(await feedOf(dialog.taskId)).toEqual([failedRow])
      await leases.release(held!)
    })

    it('moves no branch for a press past its time: its words have been waiting all along', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      const { rewind, git } = setup({ branch: HEAD2, now: giveUp })
      expect(await rewind.run(await press(dialog))).toBe('later')
      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(await feedOf(dialog.taskId)).toEqual([failedRow])
    })

    it('never says the files stayed after a job reached the push', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      const job = await press(dialog)
      await markedPush(job)
      const { rewind, git, queue } = setup({ branch: HEAD2, now: giveUp })
      git.readBranchHead.mockRejectedValueOnce(gitDown())

      expect(await rewind.run(job)).toBe('later')

      expect(queue.enqueue).toHaveBeenCalledTimes(1)
      expect(await answers(dialog.taskId)).toEqual([])
      expect(await feedOf(dialog.taskId)).toEqual([])
    })

    it('records a push it can no longer build for, without a candidate: the next pass builds one', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
      const job = await press(dialog)
      await markedPush(job, false)
      const { rewind, candidates, git } = setup({
        branch: HEAD1,
        now: after(UPDATE_REPAIR_MS + 60_000),
      })

      expect(await rewind.run(job)).toBe('rewound')

      expect(candidates.build).not.toHaveBeenCalled()
      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(await statusOf(dialog.taskId)).toBe('awaiting_user')
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect(await revisions(dialog.taskId)).toEqual([[1, 'superseded', 2, HEAD2]])
      // What the job that pushed knew of the files: the commit it left is out of reach.
      expect(await feedOf(dialog.taskId)).toEqual([
        { type: 'feed.rewind', payload: { v: 1, turn: 2, files: false, site: 'unchanged' } },
      ])
    })

    it('goes on, and ends, when a push left the branch neither here nor there', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      const job = await press(dialog)
      await markedPush(job)
      const young = setup({ branch: OTHER })
      expect(await young.rewind.run(job)).toBe('later')
      expect(young.queue.enqueue).toHaveBeenCalledTimes(1)
      expect(await answers(dialog.taskId)).toEqual([])

      const old = setup({ branch: OTHER, now: after(UPDATE_REPAIR_MS + 60_000) })
      expect(await old.rewind.run(job)).toBe('refused')
      expect(await answers(dialog.taskId)).toEqual(['refused'])
    })

    it('throws nothing out of a job when the database and the queue are gone', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      const job = await press(dialog)
      const broken = {
        on: true,
        calls: new Set(['taskEvent.count', 'taskEvent.findFirst', 'task.findUnique']),
      }
      const { rewind, queue } = setup({ branch: HEAD2, db: failing(broken) })

      expect(await rewind.run(job)).toBe('later')
      expect(queue.enqueue).toHaveBeenCalledTimes(1)

      queue.enqueue.mockRejectedValue(new Error('Redis does not answer'))
      expect(await rewind.run(job)).toBe('later')
      expect(await answers(dialog.taskId)).toEqual([])
    })

    it('leaves an answer it could not write to the next job', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      const job = await press(dialog)
      const broken = { on: true, calls: new Set(['$transaction']) }
      const { rewind } = setup({ branch: OTHER, db: failing(broken) })

      await expect(rewind.run(job)).resolves.toBe('refused')
      expect(await answers(dialog.taskId)).toEqual([])

      expect(await setup({ branch: OTHER }).rewind.run(job)).toBe('refused')
      expect(await answers(dialog.taskId)).toEqual(['refused'])
    })

    it('comes back from a job that died between the push and the record, by the sweep', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
      const job = await press(dialog)
      const broken = {
        on: false,
        calls: new Set(['$transaction', 'taskEvent.count', 'taskEvent.findFirst']),
      }
      const dying = setup({
        branch: HEAD2,
        db: failing(broken),
        afterPush: () => {
          broken.on = true
        },
      })
      dying.queue.enqueue.mockRejectedValue(new Error('Redis does not answer'))

      expect(await dying.rewind.run(job)).toBe('later')
      expect(dying.state.branch).toBe(HEAD1)
      expect(await answers(dialog.taskId)).toEqual([])
      expect(await undoneOf(dialog.taskId, 2)).toBeNull()

      await db.$executeRaw`UPDATE task_events SET created_at = now() - interval '3 minutes'
        WHERE id = ${BigInt(job.requestEventId)}`
      const queue = { enqueue: vi.fn(async (..._put: unknown[]) => {}) }
      const sweep = new TaskSweep({
        db,
        settlement: {} as never,
        live: {} as never,
        journal: {} as never,
        drivers: {} as never,
        queue,
        logger: quiet,
      })
      expect(await sweep.rewinds()).toBe(1)
      expect(queue.enqueue.mock.calls[0]?.slice(0, 3)).toEqual([
        'agent-turns',
        CANDIDATE_REWIND_JOB,
        job,
      ])

      // The next core has an empty mirror: the commit the branch left is nowhere.
      const { rewind, git } = setup({ branch: HEAD1, gone: [HEAD2] })
      expect(await rewind.run(job)).toBe('rewound')
      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect((await feedOf(dialog.taskId)).at(-1)?.payload).toMatchObject({ files: true })
      expect(await sweep.rewinds()).toBe(0)
    })
  })

  describe('`/redo` of what `/undo` took', () => {
    const redo = (dialog: { taskId: string; userId: string }) => press(dialog, 'turn_redo')
    /** A chat with two turns and a candidate of each, its last turn taken back. */
    async function undone(options: Parameters<typeof chat>[0] = { heads: [HEAD1, HEAD2] }) {
      const dialog = await chat(options)
      await db.$transaction(async (tx) => {
        await recordCandidate(tx, record(dialog.taskId, 1, 1, HEAD1))
        await recordCandidate(tx, record(dialog.taskId, 2, 2, HEAD2, { changeType: 'content' }))
      })
      expect(await setup({ branch: HEAD2 }).rewind.run(await press(dialog))).toBe('rewound')
      return dialog
    }

    it('holds the undone commit on the remote before the branch leaves it', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
      const { rewind, git } = setup({ branch: HEAD2 })

      expect(await rewind.run(await press(dialog))).toBe('rewound')

      expect(git.holdUndoneCommit).toHaveBeenCalledWith(
        expect.objectContaining({ branch: `agent/${dialog.taskId}`, sha: HEAD2 }),
        expect.any(Function),
      )
      expect(git.holdUndoneCommit.mock.invocationCallOrder[0]).toBeLessThan(
        git.rewindBranch.mock.invocationCallOrder[0]!,
      )
    })

    it.each([
      [
        'the chat closed',
        (dialog: { taskId: string }) =>
          db.task.update({ where: { id: dialog.taskId }, data: { status: 'cancelled' } }),
        'nothing',
      ],
      [
        'another turn started',
        (dialog: { taskId: string }) =>
          db.task.update({ where: { id: dialog.taskId }, data: { turnNo: 3 } }),
        'refused',
      ],
    ])('holds nothing and moves nothing when %s before the hold', async (_case, close, answer) => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
      const { rewind, git, state, queue } = setup({
        branch: HEAD2,
        onHold: async () => {
          await close(dialog)
        },
      })
      const job = await press(dialog)

      // The hold is no push: its refusal goes the way of any failure, and the next job answers.
      expect(await rewind.run(job)).toBe('later')

      expect(state.held).toBeNull()
      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(state.branch).toBe(HEAD2)
      expect(queue.enqueue).toHaveBeenCalledTimes(1)
      expect(await db.taskEvent.count({ where: { type: CANDIDATE_REWIND_PUSH_EVENT } })).toBe(0)
      expect(await setup({ branch: HEAD2 }).rewind.run(job)).toBe(answer)
    })

    it('holds nothing when the lease of the site is lost before the hold', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
      const { rewind, git, state } = setup({ branch: HEAD2 })
      const lost = vi.spyOn(leases, 'assert').mockResolvedValueOnce(false)

      expect(await rewind.run(await press(dialog))).toBe('later')

      lost.mockRestore()
      expect(state.held).toBeNull()
      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(await db.taskEvent.count({ where: { type: CANDIDATE_REWIND_PUSH_EVENT } })).toBe(0)
    })

    it('moves no branch when the commit cannot be held, and may still give the press up', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
      const { rewind, git, state, queue } = setup({
        branch: HEAD2,
        onHold: () => Promise.reject(gitDown()),
      })
      const job = await press(dialog)

      expect(await rewind.run(job)).toBe('later')

      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(state.branch).toBe(HEAD2)
      expect(queue.enqueue).toHaveBeenCalled()
      // No row of the push: nothing says the branch may have moved.
      expect(await db.taskEvent.count({ where: { type: CANDIDATE_REWIND_PUSH_EVENT } })).toBe(0)
    })

    it('brings the branch, the candidate and the claims of the turn back', async () => {
      const dialog = await undone()
      const { rewind, git, candidates } = setup({ branch: HEAD1 })
      const job = await redo(dialog)

      expect(await rewind.run(job)).toBe('redone')

      expect(git.rewindBranch).toHaveBeenCalledWith(
        expect.objectContaining({ branch: `agent/${dialog.taskId}`, from: HEAD1, to: HEAD2 }),
        expect.any(Function),
      )
      expect(git.holdUndoneCommit).not.toHaveBeenCalled()
      expect(candidates.build).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          turnNo: 2,
          headSha: HEAD2,
          withTurn: 2,
          claims: expect.objectContaining({ change_type: 'content' }),
        }),
      )
      expect((await revisions(dialog.taskId)).at(-1)).toEqual([4, 'current', 2, HEAD2])
      expect(await statusOf(dialog.taskId)).toBe('awaiting_approval')
      expect(await undoneOf(dialog.taskId, 2)).toBeNull()
      expect(await answers(dialog.taskId)).toEqual(['rewound', 'redone'])
      const rows = await feedOf(dialog.taskId)
      expect(rows.at(-1)).toEqual({
        type: 'feed.redo',
        payload: { v: 1, turn: 2, files: true, open: false },
      })
      expect(rows.at(-2)).toMatchObject({
        type: 'feed.candidate',
        payload: { turn: 2, revision: 4 },
      })
    })

    it('brings back the branch `/undo` of the first turn deleted', async () => {
      const dialog = await chat({ heads: [HEAD1] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 1, HEAD1)))
      const first = setup({ branch: HEAD1, build: () => EMPTY })
      expect(await first.rewind.run(await press(dialog))).toBe('rewound')
      expect(first.state.branch).toBeNull()
      expect(await statusOf(dialog.taskId)).toBe('awaiting_user')

      const { rewind, git, state } = setup({ branch: null })
      expect(await rewind.run(await redo(dialog))).toBe('redone')

      expect(git.rewindBranch).toHaveBeenCalledWith(
        expect.objectContaining({ from: null, to: HEAD1 }),
        expect.any(Function),
      )
      expect(state.branch).toBe(HEAD1)
      expect(await statusOf(dialog.taskId)).toBe('awaiting_approval')
      expect((await revisions(dialog.taskId)).at(-1)).toEqual([2, 'current', 1, HEAD1])
    })

    it('says nothing of files after a turn that changed none (К19)', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 1, HEAD1)))
      const unchanged = {
        sameTree: [HEAD1, HEAD2],
        build: () => ({ kind: 'unchanged' }) as const,
      }
      expect(await setup({ branch: HEAD2, ...unchanged }).rewind.run(await press(dialog))).toBe(
        'rewound',
      )

      expect(await setup({ branch: HEAD1, ...unchanged }).rewind.run(await redo(dialog))).toBe(
        'redone',
      )

      expect((await feedOf(dialog.taskId)).at(-1)).toEqual({
        type: 'feed.redo',
        payload: { v: 1, turn: 2, files: false, open: false },
      })
      expect(await revisions(dialog.taskId)).toEqual([[1, 'current', 1, HEAD1]])
    })

    it('leaves an open question open: the chat waits as it did before `/undo`', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2], status: 'awaiting_user' })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 1, HEAD1)))
      const unchanged = { build: () => ({ kind: 'unchanged' }) as const }
      await setup({ branch: HEAD2, ...unchanged }).rewind.run(await press(dialog))
      expect(await statusOf(dialog.taskId)).toBe('awaiting_approval')

      expect(await setup({ branch: HEAD1, ...unchanged }).rewind.run(await redo(dialog))).toBe(
        'redone',
      )

      expect(await statusOf(dialog.taskId)).toBe('awaiting_user')
    })

    it('leaves a chat without a candidate open when the turn undid every change', async () => {
      const dialog = await undone()
      await previewWrite(dialog, 2)
      const { rewind, state } = setup({ branch: HEAD1, build: () => EMPTY })

      expect(await rewind.run(await redo(dialog))).toBe('redone')

      expect(state.branch).toBe(HEAD2)
      expect(await statusOf(dialog.taskId)).toBe('awaiting_user')
      expect((await revisions(dialog.taskId)).at(-1)?.[1]).toBe('superseded')
      // The result it waited after expects a release: this row takes the next words instead.
      expect((await feedOf(dialog.taskId)).at(-1)).toEqual({
        type: 'feed.redo',
        payload: { v: 1, turn: 2, files: true, open: true },
      })
      expect(await syncsOf(dialog.taskId)).toEqual([0])
    })

    it('reopens no chat that waited for words: its question or result takes them', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2], status: 'awaiting_user' })
      await setup({ branch: HEAD2, build: () => EMPTY }).rewind.run(await press(dialog))
      expect(await statusOf(dialog.taskId)).toBe('awaiting_user')

      const { rewind } = setup({ branch: HEAD1, build: () => EMPTY })
      expect(await rewind.run(await redo(dialog))).toBe('redone')

      expect(await statusOf(dialog.taskId)).toBe('awaiting_user')
      expect((await feedOf(dialog.taskId)).at(-1)?.payload).toMatchObject({ open: false })
    })

    it('puts the records of the turn back into the plan', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
      await previewWrite(dialog, 1)
      await previewWrite(dialog, 2)
      await setup({ branch: HEAD2 }).rewind.run(await press(dialog))
      expect(await planOfTask(dialog.taskId)).toEqual(['post:1'])
      const seen: string[][] = []
      const builder = planBuilder()
      const { rewind } = setup({
        branch: HEAD1,
        build: async (context, pass) => {
          const { withoutTurn, withTurn } = pass as { withoutTurn?: number; withTurn?: number }
          seen.push(
            (await builder.dbPlan(context.taskId, withoutTurn, withTurn)).plan.map(
              (entry) => entry.objectRef,
            ),
          )
          return {
            kind: 'candidate',
            record: record(context.taskId, context.revision, pass.turnNo, pass.headSha),
          }
        },
      })

      expect(await rewind.run(await redo(dialog))).toBe('redone')

      expect(seen).toEqual([['post:1', 'post:2']])
      expect(await planOfTask(dialog.taskId)).toEqual(['post:1', 'post:2'])
    })

    it('puts back the records of its own turn only, and says how many', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
      await previewWrite(dialog, 1)
      await previewWrite(dialog, 2)
      const turn2 = { taskId: dialog.taskId, turnNo: 2 }
      await excludeTurnDbOperations(db, { taskId: dialog.taskId, turnNo: 1 })
      await excludeTurnDbOperations(db, turn2)

      expect(await includeTurnDbOperations(db, turn2)).toBe(1)
      expect(await includeTurnDbOperations(db, turn2)).toBe(0)

      const operations = await db.previewDbOperation.findMany({
        where: { taskId: dialog.taskId },
        orderBy: { turnNo: 'asc' },
      })
      expect(operations.map((row) => [row.turnNo, row.excluded])).toEqual([
        [1, true],
        [2, false],
      ])
    })

    it('keeps the money of the pass: nothing is held anew, charged or given back', async () => {
      const dialog = await undone()
      const placedAt = new Date(Date.now() - 60_000)
      await fixtures.reserve({
        workspaceId: dialog.workspaceId,
        taskId: dialog.taskId,
        attempt: 1,
        now: placedAt,
        expiresAt: new Date(placedAt.getTime() + 3_600_000),
      })
      const before = await moneyOf(dialog)
      expect(before.holds.length).toBeGreaterThan(0)
      const at = new Date()

      const { rewind } = setup({ branch: HEAD1, now: () => at })
      expect(await rewind.run(await redo(dialog))).toBe('redone')

      expect(await moneyOf(dialog)).toEqual(before)
      // The chat waits on, and so does its reserve.
      const holds = await db.creditHold.findMany({ where: { taskId: dialog.taskId } })
      for (const hold of holds) expect(hold.expiresAt).toEqual(taskHoldExpiry(at, 'waiting'))
    })

    it('asks the preview for the revision of the turn that came back', async () => {
      const dialog = await undone()
      await previewWrite(dialog, 2)

      expect(await setup({ branch: HEAD1 }).rewind.run(await redo(dialog))).toBe('redone')

      expect(await syncsOf(dialog.taskId)).toEqual([4])
    })

    it('finishes from a branch that moved already, when the record failed the first time', async () => {
      const dialog = await undone()
      const job = await redo(dialog)
      const broken = { on: false, calls: new Set(['$transaction']) }
      const dying = setup({
        branch: HEAD1,
        db: failing(broken),
        afterPush: () => {
          broken.on = true
        },
      })
      expect(await dying.rewind.run(job)).toBe('later')
      expect(dying.state.branch).toBe(HEAD2)
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)

      const { rewind, git } = setup({ branch: HEAD2 })
      expect(await rewind.run(job)).toBe('redone')

      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(await undoneOf(dialog.taskId, 2)).toBeNull()
      expect(await answers(dialog.taskId)).toEqual(['rewound', 'redone'])
    })

    it('moves nothing when the branch is not where `/undo` left it, and says so', async () => {
      const dialog = await undone()
      const { rewind, git } = setup({ branch: OTHER })

      expect(await rewind.run(await redo(dialog))).toBe('refused')

      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect((await feedOf(dialog.taskId)).at(-1)).toEqual({
        type: 'feed.update',
        payload: { v: 1, outcome: 'redo_failed', conflicts: 0 },
      })
    })

    it('moves nothing when the chat closed before the push, and tells no one', async () => {
      const dialog = await undone()
      const { rewind, state } = setup({
        branch: HEAD1,
        beforePush: async () => {
          await db.task.update({ where: { id: dialog.taskId }, data: { status: 'cancelled' } })
        },
      })

      expect(await rewind.run(await redo(dialog))).toBe('nothing')

      expect(state.branch).toBe(HEAD1)
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect(await answers(dialog.taskId)).toEqual(['rewound', 'nothing'])
      expect((await feedOf(dialog.taskId)).at(-1)?.type).toBe('feed.rewind')
    })

    it('moves nothing when another turn started before the push', async () => {
      const dialog = await undone()
      const { rewind, state } = setup({
        branch: HEAD1,
        beforePush: async () => {
          await db.task.update({ where: { id: dialog.taskId }, data: { turnNo: 3 } })
        },
      })

      expect(await rewind.run(await redo(dialog))).toBe('nothing')

      expect(state.branch).toBe(HEAD1)
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect((await feedOf(dialog.taskId)).at(-1)?.type).toBe('feed.rewind')
    })

    it('leaves the branch where it is when the lease of the site is lost before the push', async () => {
      const dialog = await undone()
      const { rewind, queue, state } = setup({ branch: HEAD1 })
      const lost = vi.spyOn(leases, 'assert').mockResolvedValueOnce(false)

      expect(await rewind.run(await redo(dialog))).toBe('later')

      lost.mockRestore()
      expect(state.branch).toBe(HEAD1)
      expect(queue.enqueue).toHaveBeenCalledTimes(1)
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect(await answers(dialog.taskId)).toEqual(['rewound'])
      expect((await feedOf(dialog.taskId)).at(-1)?.type).toBe('feed.rewind')
    })

    it('says so when a push loses the race for the branch', async () => {
      const dialog = await undone()
      const { rewind, git } = setup({ branch: HEAD1 })
      git.rewindBranch.mockRejectedValueOnce(new DomainError('CONFLICT', 'The branch moved', 409))

      expect(await rewind.run(await redo(dialog))).toBe('refused')

      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect(await answers(dialog.taskId)).toEqual(['rewound', 'refused'])
      expect((await feedOf(dialog.taskId)).at(-1)).toEqual({
        type: 'feed.update',
        payload: { v: 1, outcome: 'redo_failed', conflicts: 0 },
      })
    })

    it('writes nothing when the chat closed between the push and the record', async () => {
      const dialog = await undone()
      const { rewind, state } = setup({
        branch: HEAD1,
        afterPush: async () => {
          await db.task.update({ where: { id: dialog.taskId }, data: { status: 'cancelled' } })
        },
      })

      expect(await rewind.run(await redo(dialog))).toBe('nothing')

      expect(state.branch).toBe(HEAD2)
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect(await answers(dialog.taskId)).toEqual(['rewound', 'nothing'])
      expect((await feedOf(dialog.taskId)).at(-1)?.type).toBe('feed.rewind')
    })

    it('writes nothing for a job that outlived its lease: others moved the turn since', async () => {
      const dialog = await undone()
      const job = await redo(dialog)
      const unchanged = { build: () => ({ kind: 'unchanged' }) as const }
      const stale = setup({
        branch: HEAD1,
        ...unchanged,
        afterPush: async () => {
          // It froze past its lease: the sweep put the press again, and the client pressed `/undo`.
          // The chat's own row (`turnLeaseOf`).
          await db.siteLease.update({
            where: { siteId: dialog.taskId },
            data: { expiresAt: new Date(0) },
          })
          expect(await setup({ branch: HEAD2, ...unchanged }).rewind.run(job)).toBe('redone')
          const undo = await press(dialog)
          expect(await setup({ branch: HEAD2, ...unchanged }).rewind.run(undo)).toBe('rewound')
        },
      })

      expect(await stale.rewind.run(job)).toBe('nothing')

      // The branch stands where the last `/undo` left it, and the base says the same.
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect(await answers(dialog.taskId)).toEqual(['rewound', 'redone', 'rewound'])
      expect((await feedOf(dialog.taskId)).map((row) => row.type).slice(-2)).toEqual([
        'feed.redo',
        'feed.rewind',
      ])
    })

    it('writes the row of the push before the branch moves', async () => {
      const dialog = await undone()
      const job = await redo(dialog)
      let written = 0
      const { rewind } = setup({
        branch: HEAD1,
        beforePush: async () => {
          written = await pushRows(job)
        },
      })

      expect(await rewind.run(job)).toBe('redone')

      expect(written).toBe(1)
    })

    it('holds no commit of its own: `/undo` held it', async () => {
      const dialog = await undone()
      const { rewind, git } = setup({ branch: HEAD1 })
      expect(await rewind.run(await redo(dialog))).toBe('redone')
      expect(git.holdUndoneCommit).not.toHaveBeenCalled()
    })

    it('never says it stayed undone after a job reached the push', async () => {
      const dialog = await undone()
      const job = await redo(dialog)
      await markedPush(job)
      const { rewind, git, queue } = setup({
        branch: HEAD1,
        now: after(REWIND_GIVE_UP_MS + 60_000),
      })
      git.readBranchHead.mockRejectedValueOnce(gitDown())

      expect(await rewind.run(job)).toBe('later')

      expect(queue.enqueue).toHaveBeenCalledTimes(1)
      expect(await answers(dialog.taskId)).toEqual(['rewound'])
      expect((await feedOf(dialog.taskId)).at(-1)?.type).toBe('feed.rewind')
    })

    it('goes on, and ends, when a push left the branch neither here nor there', async () => {
      const dialog = await undone()
      const job = await redo(dialog)
      await markedPush(job)
      const young = setup({ branch: OTHER })
      expect(await young.rewind.run(job)).toBe('later')
      expect(young.queue.enqueue).toHaveBeenCalledTimes(1)
      expect(await answers(dialog.taskId)).toEqual(['rewound'])

      const old = setup({ branch: OTHER, now: after(UPDATE_REPAIR_MS + 60_000) })
      expect(await old.rewind.run(job)).toBe('refused')
      expect(await answers(dialog.taskId)).toEqual(['rewound', 'refused'])
      expect((await feedOf(dialog.taskId)).at(-1)?.payload).toMatchObject({
        outcome: 'redo_failed',
      })
    })

    it('records a push it can no longer build for: the chat is open for the next words', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2] })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 2, HEAD2)))
      // `/undo` read no change of files: nothing but its row knows that now.
      await setup({ branch: HEAD2, sameTree: [HEAD1, HEAD2] }).rewind.run(await press(dialog))
      await previewWrite(dialog, 2)
      const job = await redo(dialog)
      const { rewind, candidates, git } = setup({
        branch: HEAD2,
        now: after(UPDATE_REPAIR_MS + 60_000),
      })

      expect(await rewind.run(job)).toBe('redone')

      expect(candidates.build).not.toHaveBeenCalled()
      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(await undoneOf(dialog.taskId, 2)).toBeNull()
      expect(await statusOf(dialog.taskId)).toBe('awaiting_user')
      expect((await revisions(dialog.taskId)).at(-1)?.[1]).toBe('superseded')
      expect((await feedOf(dialog.taskId)).at(-1)).toEqual({
        type: 'feed.redo',
        payload: { v: 1, turn: 2, files: false, open: true },
      })
      expect(await syncsOf(dialog.taskId)).toEqual([0])
    })

    it.each([
      [
        'no context',
        (candidates: ReturnType<typeof setup>['candidates']) =>
          candidates.context.mockResolvedValueOnce(null as never),
      ],
      [
        'a candidate too large',
        (candidates: ReturnType<typeof setup>['candidates']) =>
          candidates.build.mockRejectedValueOnce(
            new DomainError('REPOSITORY_TOO_LARGE', 'Too large', 413),
          ),
      ],
    ])('refuses before the push with %s, and says so', async (_case, refuse) => {
      const dialog = await undone()
      const { rewind, candidates, git } = setup({ branch: HEAD1 })
      refuse(candidates)

      expect(await rewind.run(await redo(dialog))).toBe('refused')

      expect(git.rewindBranch).not.toHaveBeenCalled()
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect((await feedOf(dialog.taskId)).at(-1)?.payload).toMatchObject({
        outcome: 'redo_failed',
      })
    })

    it.each([
      [
        'no context',
        (candidates: ReturnType<typeof setup>['candidates']) =>
          candidates.context.mockResolvedValueOnce(null as never),
      ],
      [
        'a candidate too large',
        (candidates: ReturnType<typeof setup>['candidates']) =>
          candidates.build.mockRejectedValueOnce(
            new DomainError('REPOSITORY_TOO_LARGE', 'Too large', 413),
          ),
      ],
    ])('never refuses a branch that moved already, with %s', async (_case, refuse) => {
      const dialog = await undone()
      const job = await redo(dialog)
      const { rewind, candidates, queue } = setup({ branch: HEAD2 })
      refuse(candidates)

      expect(await rewind.run(job)).toBe('later')

      expect(queue.enqueue).toHaveBeenCalledTimes(1)
      expect(await answers(dialog.taskId)).toEqual(['rewound'])
      expect((await feedOf(dialog.taskId)).at(-1)?.type).toBe('feed.rewind')
    })

    it('tells of a press given up in its own words, and `/undo` still stands', async () => {
      const dialog = await undone()
      const job = await redo(dialog)
      const { rewind } = setup({ branch: HEAD1, now: after(REWIND_GIVE_UP_MS + 60_000) })

      expect(await rewind.run(job)).toBe('later')

      expect((await feedOf(dialog.taskId)).at(-1)?.payload).toMatchObject({
        outcome: 'redo_failed',
      })
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
    })

    it('leaves a press to the sweep when nothing answered it', async () => {
      const dialog = await undone()
      const job = await redo(dialog)
      await db.$executeRaw`UPDATE task_events SET created_at = now() - interval '3 minutes'
        WHERE id = ${BigInt(job.requestEventId)}`
      const queue = { enqueue: vi.fn(async (..._put: unknown[]) => {}) }
      const sweep = new TaskSweep({
        db,
        settlement: {} as never,
        live: {} as never,
        journal: {} as never,
        drivers: {} as never,
        queue,
        logger: quiet,
      })

      expect(await sweep.rewinds()).toBe(1)

      expect(queue.enqueue.mock.calls[0]?.slice(0, 3)).toEqual([
        'agent-turns',
        CANDIDATE_REWIND_JOB,
        job,
      ])
      expect(await setup({ branch: HEAD1 }).rewind.run(job)).toBe('redone')
      expect(await sweep.rewinds()).toBe(0)
    })

    it('takes the turn back again after it came back', async () => {
      const dialog = await undone()
      await setup({ branch: HEAD1 }).rewind.run(await redo(dialog))

      const { rewind, git } = setup({ branch: HEAD2 })
      expect(await rewind.run(await press(dialog))).toBe('rewound')

      expect(git.holdUndoneCommit).toHaveBeenCalled()
      expect(await undoneOf(dialog.taskId, 2)).toBeInstanceOf(Date)
      expect((await revisions(dialog.taskId)).at(-1)).toEqual([5, 'current', 1, HEAD1])
    })

    it('takes the status and the files of each `/redo` from the `/undo` before it', async () => {
      const dialog = await chat({ heads: [HEAD1, HEAD2], status: 'awaiting_user' })
      await db.$transaction((tx) => recordCandidate(tx, record(dialog.taskId, 1, 1, HEAD1)))
      const unchanged = { build: () => ({ kind: 'unchanged' }) as const }
      const noChange = { ...unchanged, sameTree: [HEAD1, HEAD2] }

      // The turn asked a question and changed no file.
      await setup({ branch: HEAD2, ...noChange }).rewind.run(await press(dialog))
      await setup({ branch: HEAD1, ...noChange }).rewind.run(await redo(dialog))
      expect(await statusOf(dialog.taskId)).toBe('awaiting_user')
      expect((await feedOf(dialog.taskId)).at(-1)?.payload).toMatchObject({ files: false })

      // Then the chat waits with the candidate, and the turn is read as having changed files.
      await db.task.update({ where: { id: dialog.taskId }, data: { status: 'awaiting_approval' } })
      await setup({ branch: HEAD2, ...unchanged }).rewind.run(await press(dialog))
      expect(await setup({ branch: HEAD1, ...unchanged }).rewind.run(await redo(dialog))).toBe(
        'redone',
      )
      expect(await statusOf(dialog.taskId)).toBe('awaiting_approval')
      expect((await feedOf(dialog.taskId)).at(-1)?.payload).toMatchObject({ files: true })
    })

    it('holds the candidate when the row of `/undo` does not say what stood before it', async () => {
      const unknown = async () => {
        const dialog = await undone()
        await db.$executeRaw`UPDATE task_events SET payload = payload - 'before'
          WHERE task_id = ${dialog.taskId}::uuid AND type = ${CANDIDATE_REWIND_EVENT}`
        return dialog
      }
      const held = await unknown()
      expect(await setup({ branch: HEAD1 }).rewind.run(await redo(held))).toBe('redone')
      expect(await statusOf(held.taskId)).toBe('awaiting_approval')
      expect((await feedOf(held.taskId)).at(-1)?.payload).toMatchObject({ open: false })

      const emptied = await unknown()
      expect(
        await setup({ branch: HEAD1, build: () => EMPTY }).rewind.run(await redo(emptied)),
      ).toBe('redone')
      expect(await statusOf(emptied.taskId)).toBe('awaiting_user')
      expect((await feedOf(emptied.taskId)).at(-1)?.payload).toMatchObject({ open: true })
    })

    it('hands the next turn a continuation from the turn that came back, and the store takes it', async () => {
      const dialog = await undone()
      await db.task.update({ where: { id: dialog.taskId }, data: { billable: false } })
      const { rewind, state } = setup({ branch: HEAD1 })
      expect(await rewind.run(await redo(dialog))).toBe('redone')
      const words = await insertFeedEvent(db, {
        taskId: dialog.taskId,
        row: {
          type: 'feed.request',
          payload: {
            v: 1,
            kind: 'revision',
            authorId: dialog.userId,
            requestId: randomUUID(),
            text: 'Ещё слова',
            candidateRevision: 4,
          },
        },
      })

      const facts = await readPassFacts(
        { db, adapter: getSiteAdapter, backends: llmBackends, previews: null },
        {
          taskId: dialog.taskId,
          attempt: 1,
          turnNo: 2,
          requestEventId: String(words),
          now: new Date(),
        },
      )
      expect(facts?.writtenHead).toBe(HEAD2)
      const planned = await planTurn(
        {
          ...facts!,
          profile: {
            backend: sampleBackendId,
            modelSlug: sampleModelSlug,
            providerModelId: sampleProviderModelId,
          },
        },
        {
          driver: {
            ...driver,
            sessionState: () => ({
              root: `/agent-home/${sampleDriverId}`,
              include: ['session'],
              exclude: [],
            }),
          },
          backends: [backend],
          runtime: 'runc',
          browser: false,
          mainHead: async () => MAIN,
          branchHead: async () => state.branch,
        },
      )
      if (planned.kind !== 'turn') throw new Error(`The next turn was not planned: ${planned.kind}`)
      const plan = toTurnPlan(planned.request, sampleDriverId)
      expect(plan.replacesTurn).toBeUndefined()
      expect(plan.previous).toMatchObject({ turn: 2 })
      expect(plan.workspace).toMatchObject({ expectedBaseSha: HEAD2 })

      const fence = (await leases.acquire({
        siteId: dialog.taskId,
        taskId: dialog.taskId,
        operation: 'turn',
        ttlMs: 60_000,
      }))!
      await expect(
        new PostgresTaskTurnAssignmentStore(db).open({
          fence,
          sessionId: dialog.taskId,
          turn: 3,
          executor: 'local',
          plan,
          remainingMs: 30_000,
        }),
      ).resolves.not.toBeNull()
    })
  })

  it('hands the turn after it a replacement on the head «Обновить» wrote, and the store takes it', async () => {
    const dialog = await chat({ heads: [HEAD1, HEAD2], bases: [MAIN, OTHER], rebased: [2] })
    await db.task.update({ where: { id: dialog.taskId }, data: { billable: false } })
    const words = await insertFeedEvent(db, {
      taskId: dialog.taskId,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'first',
          authorId: dialog.userId,
          requestId: randomUUID(),
          text: 'Слова',
        },
      },
    })
    // «Обновить» after turn 1 records under that turn a head no turn wrote; turn 2 stands on it.
    await db.$transaction(async (tx) => {
      await recordCandidate(tx, record(dialog.taskId, 1, 1, OTHER))
      await recordCandidate(tx, record(dialog.taskId, 2, 2, HEAD2))
    })
    const { rewind, git, state } = setup({ branch: HEAD2 })

    expect(await rewind.run(await press(dialog))).toBe('rewound')

    expect(git.rewindBranch).toHaveBeenCalledWith(
      expect.objectContaining({ from: HEAD2, to: OTHER }),
      expect.any(Function),
    )
    // The revision is the head of «Обновить», under the turn it stood on.
    expect((await revisions(dialog.taskId)).at(-1)).toEqual([3, 'current', 1, OTHER])

    const facts = await readPassFacts(
      { db, adapter: getSiteAdapter, backends: llmBackends, previews: null },
      {
        taskId: dialog.taskId,
        attempt: 1,
        turnNo: 2,
        requestEventId: String(words),
        now: new Date(),
      },
    )
    expect(facts?.writtenHead).toBe(OTHER)
    const planned = await planTurn(
      {
        ...facts!,
        profile: {
          backend: sampleBackendId,
          modelSlug: sampleModelSlug,
          providerModelId: sampleProviderModelId,
        },
      },
      {
        driver,
        backends: [backend],
        runtime: 'runc',
        browser: false,
        mainHead: async () => MAIN,
        branchHead: async () => state.branch,
      },
    )
    if (planned.kind !== 'turn') throw new Error(`The next turn was not planned: ${planned.kind}`)
    const plan = toTurnPlan(planned.request, sampleDriverId)
    expect(plan).toMatchObject({ replacesTurn: 2, rebased: true })
    expect(plan.workspace).toMatchObject({ expectedBaseSha: OTHER, expectedBranchSha: OTHER })

    const fence = (await leases.acquire({
      siteId: dialog.taskId,
      taskId: dialog.taskId,
      operation: 'turn',
      ttlMs: 60_000,
    }))!
    await expect(
      new PostgresTaskTurnAssignmentStore(db).open({
        fence,
        sessionId: dialog.taskId,
        turn: 3,
        executor: 'local',
        plan,
        remainingMs: 30_000,
      }),
    ).resolves.not.toBeNull()
  })
})
