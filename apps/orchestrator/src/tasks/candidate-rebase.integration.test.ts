import { createHash, randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  createPrismaClient,
  insertFeedEvent,
  PostgresSiteLeaseStore,
  recordCandidate,
  type CandidateRecordInput,
  type PrismaClient,
} from '@repo/db'
import { DomainError, type CandidateFacts } from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { CandidateRebase as CandidateRebaseAnswer } from '../git-workspace/git-workspace.service.ts'
import { sampleDriverId } from '../testing/ids.ts'
import type { CandidateBuild, CandidateBuilder, CandidateContext } from './candidate-builder.ts'
import type { CandidateGit } from './candidate-git.ts'
import { CANDIDATE_REBASE_EVENT, CandidateRebase } from './candidate-rebase.ts'

// «Обновить» on PostgreSQL with stand-ins for git and the builder of candidates: the lease of
// the site, the CAS of the task branch and the next revision written with its feed row.
const databaseUrl = process.env.DATABASE_URL

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const MAIN = 'c'.repeat(40)
const REBASED = 'e'.repeat(40)
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

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
  base: string,
  head: string,
): CandidateRecordInput => ({
  taskId,
  revision,
  turnNo: 1,
  baseSha: base,
  baseTree: 'f'.repeat(40),
  baseVersion: null,
  headSha: head,
  files: [{ path: 'wp-content/themes/t/a.php', change: 'added', sizeBytes: 3, executable: false }],
  media: [],
  dbPlan: [],
  dbPlanSha256: createHash('sha256').update('[]').digest('hex'),
  proposedBump: 'minor',
  proposedVersion: 'v0.1.0',
  facts,
  checks: ['php_lint', 'preview_smoke'],
  installed: null,
})

/** What the builder answers when `main` holds the whole change of the dialog. */
const EMPTY: CandidateBuild = {
  kind: 'empty',
  baseTree: 'f'.repeat(40),
  dbPlanSha256: createHash('sha256').update('[]').digest('hex'),
}

describe.skipIf(!databaseUrl)('«Обновить» of a candidate with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  let leases: PostgresSiteLeaseStore

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
    leases = new PostgresSiteLeaseStore(db)
  })
  afterEach(async () => {
    await db.gitRepository.deleteMany({ where: { owner: 'sites-r3-rebase' } })
    const sites = await db.site.findMany({
      where: { name: 'Billing verification', tasks: { some: { candidates: { some: {} } } } },
      select: { id: true },
    })
    await db.siteLease.deleteMany({ where: { siteId: { in: sites.map((site) => site.id) } } })
    await fixtures.cleanup()
    vi.clearAllMocks()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function waiting() {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, { status: 'awaiting_approval', turnNo: 1 })
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
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
    await db.gitRepository.create({
      data: {
        siteId: task.siteId,
        provider: 'gitea',
        owner: 'sites-r3-rebase',
        name: `site-${task.siteId}`,
        url: `https://git.invalid/sites/site-${task.siteId}.git`,
      },
    })
    const standing = await db.$transaction((tx) =>
      recordCandidate(tx, record(taskId, 1, BASE, HEAD)),
    )
    return { taskId, siteId: task.siteId, standing, userId }
  }

  interface Setup {
    /** What the push answers; by default the branch moves to REBASED once the fence holds. */
    rebased?: () => Promise<CandidateRebaseAnswer>
    /** The head of `agent/<taskId>`: the standing candidate's unless told. */
    branch?: string
    /** What the builder of the new revision answers. */
    build?: (
      context: CandidateContext,
      pass: { headSha: string; baseSha?: string },
    ) => Promise<CandidateBuild>
    comparesCommits?: boolean
  }

  function setup(options: Setup = {}) {
    const git = {
      readBranchHead: vi.fn(async ({ branch }: { branch: string }) =>
        branch === 'main' ? MAIN : (options.branch ?? HEAD),
      ),
      treeOf: vi.fn(),
      comparesCommits: options.comparesCommits ?? true,
      compareCommits: vi.fn(),
      rebaseCandidate: vi.fn(
        async (_input: unknown, assertFence: () => Promise<void> = async () => {}) => {
          if (options.rebased) return options.rebased()
          await assertFence()
          return { status: 'rebased' as const, headSha: REBASED, treeSha: '1'.repeat(40) }
        },
      ),
    }
    const candidates = {
      context: vi.fn(
        async (task: { id: string }, standing: CandidateContext['standing'], revision: number) => ({
          taskId: task.id,
          repo: { provider: 'gitea' as const, owner: 'sites-r3-rebase', name: 'site' },
          addOnlyPaths: [],
          base: BASE,
          standing,
          installedVersion: null,
          releasedVersions: [],
          revision,
        }),
      ),
      build: vi.fn(
        options.build ??
          (async (context: CandidateContext, pass: { headSha: string; baseSha?: string }) => ({
            kind: 'candidate' as const,
            record: record(context.taskId, context.revision, pass.baseSha!, pass.headSha),
          })),
      ),
      carrier: vi.fn((context: CandidateContext, pass: { headSha: string; baseSha: string }) => ({
        ...record(context.taskId, context.revision, pass.baseSha, pass.headSha),
        files: [],
        checks: [],
      })),
    } as unknown as CandidateBuilder
    const queue = { enqueue: vi.fn(async () => {}) }
    const rebase = new CandidateRebase({
      db,
      git: git as unknown as CandidateGit,
      candidates,
      leases,
      queue,
      adapter: getSiteAdapter,
      logger: quiet,
    })
    return { rebase, git, queue, candidates }
  }

  /** The `/update` press of the dialog, as web writes it. */
  async function update(dialog: { taskId: string; userId: string }) {
    const id = await insertFeedEvent(db, {
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
    return { taskId: dialog.taskId, requestEventId: id.toString() }
  }
  const outcomes = async (taskId: string) =>
    (
      await db.taskEvent.findMany({
        where: { taskId, type: CANDIDATE_REBASE_EVENT },
        orderBy: { id: 'asc' },
      })
    ).map((row) => (row.payload as { outcome: string }).outcome)
  /** What the client's feed was told of the updates (`feed.update`). */
  const told = async (taskId: string) =>
    (
      await db.taskEvent.findMany({
        where: { taskId, type: 'feed.update' },
        orderBy: { id: 'asc' },
      })
    ).map((row) => row.payload)
  const revisions = async (taskId: string) =>
    (await db.taskCandidate.findMany({ where: { taskId }, orderBy: { revision: 'asc' } })).map(
      (c) => [c.revision, c.status, c.baseSha, c.headSha],
    )

  it('carries the candidate onto main as the next revision, under the lease of the site', async () => {
    const dialog = await waiting()
    const job = await update(dialog)
    const written = await db.taskEvent.findUniqueOrThrow({
      where: { id: BigInt(job.requestEventId) },
    })
    const { rebase, git } = setup()

    expect(await rebase.run(job)).toBe('rebased')

    // The same command gives the same commit: its instant is the time the command was written.
    expect(git.rebaseCandidate).toHaveBeenCalledWith(
      {
        repo: expect.objectContaining({ owner: 'sites-r3-rebase' }),
        branch: `agent/${dialog.taskId}`,
        fromBase: BASE,
        toBase: MAIN,
        head: HEAD,
        committedAt: new Date(Math.floor(written.createdAt.getTime() / 1000) * 1000).toISOString(),
        // Every path the update changes is held to the rules publication held the candidate to.
        rules: expect.objectContaining({
          protectedPaths: expect.arrayContaining(['wp-config.php']),
          workingSet: expect.objectContaining({ include: expect.any(Array) }),
          addOnlyPaths: ['wp-content/uploads/raditi/'],
          media: expect.objectContaining({ maxFileBytes: expect.any(Number) }),
        }),
      },
      expect.any(Function),
    )
    expect(await revisions(dialog.taskId)).toEqual([
      [1, 'superseded', BASE, HEAD],
      [2, 'current', MAIN, REBASED],
    ])
    expect(await outcomes(dialog.taskId)).toEqual(['rebased'])
    expect(
      (
        await db.taskEvent.findMany({ where: { taskId: dialog.taskId, type: 'feed.candidate' } })
      ).map((row) => (row.payload as { revision: number }).revision),
    ).toEqual([2])
    // The new revision is told by its own card.
    expect(await told(dialog.taskId)).toEqual([])
    // The site is free again.
    expect((await leases.inspect(dialog.siteId))?.taskId).toBeNull()
    // A repeat of the command (a pass that waited put it again) finds it done and keeps its answer.
    expect(await setup({ branch: REBASED }).rebase.run(job)).toBe('nothing')
    expect(await outcomes(dialog.taskId)).toEqual(['rebased'])
  })

  // docs/plan/53, «Попробовать ещё (18.10)»: a pass of the dialog failed after its turn
  // published past the candidate, and the dialog kept the candidate.
  it('carries the candidate, not the head of a turn the platform refused', async () => {
    const dialog = await waiting()
    const REFUSED = 'd'.repeat(40)
    await db.taskTurn.create({
      data: {
        taskId: dialog.taskId,
        turnNo: 2,
        status: 'completed',
        driverId: sampleDriverId,
        image,
        headSha: REFUSED,
        rejectedAt: new Date(),
      },
    })
    await db.task.update({ where: { id: dialog.taskId }, data: { turnNo: 2 } })
    const { rebase, git } = setup({ branch: REFUSED })

    expect(await rebase.run(await update(dialog))).toBe('rebased')
    expect(git.rebaseCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ fromBase: BASE, toBase: MAIN, head: HEAD, branchHead: REFUSED }),
      expect.any(Function),
    )
    expect(await revisions(dialog.taskId)).toEqual([
      [1, 'superseded', BASE, HEAD],
      [2, 'current', MAIN, REBASED],
    ])

    // The same head without the mark is an update that pushed and did not record: carried.
    const other = await waiting()
    await db.task.update({ where: { id: other.taskId }, data: { turnNo: 2 } })
    const again = setup({ branch: REFUSED })
    expect(await again.rebase.run(await update(other))).toBe('rebased')
    expect(again.git.rebaseCandidate).toHaveBeenCalledWith(
      expect.not.objectContaining({ branchHead: expect.anything() }),
      expect.any(Function),
    )
    expect(again.git.rebaseCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ head: REFUSED }),
      expect.any(Function),
    )
  })

  it('leaves the candidate as it is when its change does not apply onto main', async () => {
    const dialog = await waiting()
    const { rebase } = setup({ rebased: async () => ({ status: 'conflict', paths: ['a.php'] }) })

    expect(await rebase.run(await update(dialog))).toBe('conflict')
    expect(await db.taskCandidate.count({ where: { taskId: dialog.taskId } })).toBe(1)
    expect(await outcomes(dialog.taskId)).toEqual(['conflict'])
    // The client sees it: the update did not carry, and why.
    expect(await told(dialog.taskId)).toEqual([{ v: 1, outcome: 'conflict', conflicts: 1 }])
    expect((await leases.inspect(dialog.siteId))?.taskId).toBeNull()
  })

  it('refuses an update that would change a path the rules of the workspace refuse', async () => {
    const dialog = await waiting()
    // A head past the candidate carries a CI file: the rules refuse it before any push.
    const { rebase } = setup({
      branch: REBASED,
      rebased: async () => {
        throw new DomainError('PUBLICATION_FORBIDDEN', 'Publication changes a protected path', 409)
      },
    })

    expect(await rebase.run(await update(dialog))).toBe('refused')
    expect(await revisions(dialog.taskId)).toEqual([[1, 'current', BASE, HEAD]])
    expect(await outcomes(dialog.taskId)).toEqual(['refused'])
    expect(await told(dialog.taskId)).toEqual([{ v: 1, outcome: 'failed', conflicts: 0 }])
  })

  it('waits for a busy site and does nothing for a dialog that does not wait with a candidate', async () => {
    const dialog = await waiting()
    // Another dialog of the same site holds it.
    const row = await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })
    const other = await db.task.create({
      data: { workspaceId: row.workspaceId, siteId: dialog.siteId, status: 'running' },
    })
    expect(
      await leases.acquire({
        siteId: dialog.siteId,
        taskId: other.id,
        operation: 'turn',
        ttlMs: 60_000,
      }),
    ).not.toBeNull()
    const { rebase, queue } = setup()

    expect(await rebase.run({ taskId: dialog.taskId, requestEventId: '1' })).toBe('busy')
    expect(queue.enqueue).toHaveBeenCalledWith(
      'agent-turns',
      'candidate.rebase',
      { taskId: dialog.taskId, requestEventId: '1' },
      expect.objectContaining({ delayMs: 30_000 }),
    )

    await db.task.update({ where: { id: dialog.taskId }, data: { status: 'cancelled' } })
    expect(await rebase.run({ taskId: dialog.taskId, requestEventId: '2' })).toBe('nothing')
  })

  it('pushes nothing while this core cannot compare commits', async () => {
    const dialog = await waiting()
    const { rebase, git } = setup({ comparesCommits: false })

    expect(await rebase.run(await update(dialog))).toBe('unavailable')
    expect(git.rebaseCandidate).not.toHaveBeenCalled()
    expect(await outcomes(dialog.taskId)).toEqual(['unavailable'])
  })

  it('moves nothing when the dialog stopped waiting before the push', async () => {
    const dialog = await waiting()
    const { rebase, git } = setup()
    // The client wrote meanwhile: the fence right before the push refuses it.
    git.rebaseCandidate.mockImplementationOnce(async (_input, assertFence) => {
      await db.task.update({ where: { id: dialog.taskId }, data: { status: 'queued' } })
      await assertFence!()
      throw new Error('pushed')
    })

    expect(await rebase.run(await update(dialog))).toBe('nothing')
    expect(await revisions(dialog.taskId)).toEqual([[1, 'current', BASE, HEAD]])
    expect(await outcomes(dialog.taskId)).toEqual(['nothing'])
    expect(await told(dialog.taskId)).toEqual([{ v: 1, outcome: 'withdrawn', conflicts: 0 }])
  })

  it('records an update that pushed and could not record, whatever the dialog did meanwhile', async () => {
    const dialog = await waiting()
    const job = await update(dialog)
    // The push went through; the comparison did not answer.
    const first = setup({
      build: async () => {
        throw new Error('git is down')
      },
    })

    expect(await first.rebase.run(job)).toBe('later')
    expect(await revisions(dialog.taskId)).toEqual([[1, 'current', BASE, HEAD]])
    expect(first.queue.enqueue).toHaveBeenCalledWith(
      'agent-turns',
      'candidate.rebase',
      job,
      expect.objectContaining({ delayMs: 30_000, jobId: expect.stringContaining(':record:') }),
    )

    // The client wrote meanwhile: the dialog is queued, and the branch holds the update.
    await db.task.update({ where: { id: dialog.taskId }, data: { status: 'queued' } })
    const again = setup({ branch: REBASED })

    expect(await again.rebase.run(job)).toBe('rebased')
    expect(again.git.rebaseCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ fromBase: BASE, toBase: MAIN, head: REBASED }),
      expect.any(Function),
    )
    expect(await revisions(dialog.taskId)).toEqual([
      [1, 'superseded', BASE, HEAD],
      [2, 'current', MAIN, REBASED],
    ])
    expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe(
      'queued',
    )
  })

  it('ends the dialog done when main holds its whole change already', async () => {
    const dialog = await waiting()
    await fixtures.reserve({
      workspaceId: (await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).workspaceId,
      taskId: dialog.taskId,
      attempt: 1,
      now: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    const { rebase } = setup({ build: async () => EMPTY })

    expect(await rebase.run(await update(dialog))).toBe('emptied')

    expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe('done')
    expect(await revisions(dialog.taskId)).toEqual([[1, 'superseded', BASE, HEAD]])
    expect(
      (await db.creditHold.findMany({ where: { taskId: dialog.taskId } })).every(
        (hold) => hold.status === 'captured',
      ),
    ).toBe(true)
    expect(await outcomes(dialog.taskId)).toEqual(['emptied'])
    expect(await told(dialog.taskId)).toEqual([{ v: 1, outcome: 'emptied', conflicts: 0 }])
  })

  it('records the head it pushed when main holds the whole change and a pass is queued', async () => {
    // The client wrote after the push: the dialog is queued. It goes on without a candidate, and
    // its next pass finds the branch where the platform left it — a revision superseded at once,
    // on `main` — instead of waiting for a branch nothing records.
    const dialog = await waiting()
    const { rebase } = setup({
      build: async () => {
        await db.task.update({ where: { id: dialog.taskId }, data: { status: 'queued' } })
        return EMPTY
      },
    })

    expect(await rebase.run(await update(dialog))).toBe('emptied')

    expect((await db.task.findUniqueOrThrow({ where: { id: dialog.taskId } })).status).toBe(
      'queued',
    )
    expect(await revisions(dialog.taskId)).toEqual([
      [1, 'superseded', BASE, HEAD],
      [2, 'superseded', MAIN, REBASED],
    ])
    expect(await outcomes(dialog.taskId)).toEqual(['emptied'])
    expect(await told(dialog.taskId)).toEqual([{ v: 1, outcome: 'emptied', conflicts: 0 }])
  })
})
