import { createHash, randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  createPrismaClient,
  insertFeedEvent,
  recordCandidate,
  type CandidateRecordInput,
  type PrismaClient,
} from '@repo/db'
import type { CandidateFacts, TurnResult } from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import {
  CandidateBuilder,
  type CandidateBuild,
  type CandidateContext,
} from './candidate-builder.ts'
import { candidateGitOf } from './candidate-git.ts'
import { ORPHANED_PASS_EVENT, PassSettlement, type PassEnding } from './pass-settlement.ts'

// The end of a pass on PostgreSQL with the credits of @repo/billing: the move, its feed rows,
// the candidate and the money in one transaction. Only on a disposable database
// (RADITI_GATEWAY_DB_TESTS=1), as the other suites that write the reserves of whole workspaces.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const NOW = new Date('2026-10-17T10:00:00.000Z')
const quiet = { warn: vi.fn(), error: vi.fn() }

const result = (patch: Partial<TurnResult> = {}): TurnResult => ({
  summary: 'Поменял телефон в шапке',
  change_type: 'code',
  client_message: 'Телефон в шапке заменён.',
  files_changed: ['header.php'],
  questions: [],
  needs_approval: false,
  risk: 'low',
  ...patch,
})

const facts: CandidateFacts = {
  changeType: 'code',
  risk: 'low',
  addedFiles: 1,
  modifiedFiles: 2,
  deletedFiles: 0,
  mediaFiles: 0,
  dbObjects: 0,
  newFunctionality: false,
}

const record = (taskId: string, revision: number): CandidateRecordInput => ({
  taskId,
  revision,
  turnNo: 1,
  baseSha: BASE,
  baseTree: 'c'.repeat(40),
  baseVersion: null,
  headSha: HEAD,
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

/** A stand-in of the candidate builder: git and S3 are not this suite's business. */
/** What the builder answers for a head with the tree of its base and an empty plan. */
const EMPTY: CandidateBuild = {
  kind: 'empty',
  baseTree: 'f'.repeat(40),
  dbPlanSha256: createHash('sha256').update('[]').digest('hex'),
}

function builder(build: (context: CandidateContext) => CandidateBuild | Promise<CandidateBuild>) {
  return {
    context: vi.fn(
      async (task: { id: string }, standing: CandidateContext['standing'], revision: number) => ({
        taskId: task.id,
        repo: { provider: 'gitea' as const, owner: 'sites', name: 'site' },
        addOnlyPaths: [],
        base: BASE,
        standing,
        installedVersion: null,
        releasedVersions: [],
        revision,
      }),
    ),
    build: vi.fn(build),
  } as unknown as CandidateBuilder
}

describe.skipIf(!enabled)('pass settlement with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await db.outboxEvent.deleteMany({ where: { dedupeKey: { startsWith: 'preview.sync:' } } })
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /** A dialog in its first turn, with the gift of its client set aside for it. */
  async function dialog(status: 'running' | 'preparing' = 'running') {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status,
      turnNo: status === 'running' ? 1 : 0,
    })
    if (status === 'running')
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
    await insertFeedEvent(db, {
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
    await fixtures.reserve({
      workspaceId: workspace.id,
      taskId,
      attempt: 1,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    })
    return { userId, workspaceId: workspace.id, taskId, turnNo: status === 'running' ? 1 : 0 }
  }

  const settlement = (build: Parameters<typeof builder>[0] = () => EMPTY) =>
    new PassSettlement({ db, candidates: builder(build), logger: quiet, now: () => NOW })
  const ref = (task: { taskId: string; turnNo: number }) => ({
    taskId: task.taskId,
    attempt: 1,
    turnNo: task.turnNo,
  })
  const completed = (patch: Partial<TurnResult> = {}): PassEnding => ({
    kind: 'completed',
    turn: 1,
    result: result(patch),
    headSha: HEAD,
  })
  const feed = async (taskId: string) =>
    (
      await db.taskEvent.findMany({
        where: { taskId, clientVisible: true, NOT: { type: 'feed.request' } },
        orderBy: { id: 'asc' },
      })
    ).map((row) => [row.type, row.payload])
  const holds = (taskId: string) =>
    db.creditHold.findMany({ where: { taskId }, select: { status: true, expiresAt: true } })
  const status = async (taskId: string) =>
    (await db.task.findUniqueOrThrow({ where: { id: taskId } })).status
  const cancelPress = (task: { taskId: string; userId: string }) =>
    insertFeedEvent(db, {
      taskId: task.taskId,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'command',
          command: 'cancel',
          authorId: task.userId,
          requestId: randomUUID(),
        },
      },
    })
  /** The preview of the dialog, and the revisions its manager was asked to bring it to. */
  async function preview(taskId: string) {
    const [site, row] = await Promise.all([
      db.site.findFirstOrThrow({ where: { tasks: { some: { id: taskId } } } }),
      db.task.findUniqueOrThrow({ where: { id: taskId } }),
    ])
    const created = await db.previewEnvironment.create({
      data: {
        siteId: site.id,
        taskId,
        hostname: `site-${site.alias}-chat-${row.alias}.localhost`,
        expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
      },
    })
    return {
      synced: async () =>
        (
          await db.outboxEvent.findMany({
            where: { dedupeKey: { startsWith: `preview.sync:${created.id}:` } },
            orderBy: { createdAt: 'asc' },
          })
        ).map((row) => (row.payload as { revision: number }).revision),
    }
  }

  it('ends a pass that changed nothing in done and charges it in the same transaction', async () => {
    const task = await dialog()
    const watched = await preview(task.taskId)

    expect(await settlement().settle(ref(task), completed({ change_type: 'none' }))).toBe('moved')

    expect(await status(task.taskId)).toBe('done')
    // The dialog is closed: its manager takes the preview down.
    expect(await watched.synced()).toEqual([0])
    expect(await feed(task.taskId)).toEqual([
      [
        'feed.result',
        {
          v: 1,
          turn: 1,
          message: 'Телефон в шапке заменён.',
          site: 'unchanged',
          next: 'done',
          filesChanged: 0,
          changeType: 'none',
          needsApproval: false,
          risk: 'low',
        },
      ],
    ])
    expect((await holds(task.taskId)).every((hold) => hold.status === 'captured')).toBe(true)
    const charged = await db.creditLedger.aggregate({
      where: { taskId: task.taskId, kind: 'charge' },
      _sum: { amount: true },
    })
    // The minimum of a done task: no model call was recorded.
    expect(charged._sum.amount?.toFixed(0)).toBe('-5')
    // Ended once: the second writer finds the task elsewhere.
    expect(await settlement().settle(ref(task), completed())).toBe('skipped')
  })

  it('waits with a candidate: the revision, its checks, the preview and a longer reserve', async () => {
    const task = await dialog()
    const [site, row] = await Promise.all([
      db.site.findFirstOrThrow({ where: { tasks: { some: { id: task.taskId } } } }),
      db.task.findUniqueOrThrow({ where: { id: task.taskId } }),
    ])
    const preview = await db.previewEnvironment.create({
      data: {
        siteId: site.id,
        taskId: task.taskId,
        hostname: `site-${site.alias}-chat-${row.alias}.localhost`,
        expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
      },
    })
    const ends = settlement((context) => ({
      kind: 'candidate',
      record: record(task.taskId, context.revision),
    }))

    expect(await ends.settle(ref(task), completed())).toBe('moved')

    expect(await status(task.taskId)).toBe('awaiting_approval')
    const candidates = await db.taskCandidate.findMany({
      where: { taskId: task.taskId },
      include: { checks: true },
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ revision: 1, status: 'current', previewRevision: 1 })
    expect(candidates[0]!.checks.map((check) => check.status)).toEqual(['pending', 'pending'])
    const rows = await feed(task.taskId)
    expect(rows.map(([type]) => type)).toEqual(['feed.candidate', 'feed.result'])
    expect(rows[0]![1]).toEqual({
      v: 1,
      turn: 1,
      revision: 1,
      version: 'v0.1.0',
      bump: 'minor',
      files: { added: 1, modified: 2, deleted: 0 },
      media: 0,
      records: 0,
    })
    expect(rows[1]![1]).toMatchObject({ next: 'awaiting_approval', filesChanged: 3 })
    expect(
      await db.outboxEvent.count({
        where: { dedupeKey: { startsWith: `preview.sync:${preview.id}:1:` } },
      }),
    ).toBe(1)
    // The reserve waits with the dialog; nothing is charged before a release.
    for (const hold of await holds(task.taskId)) {
      expect(hold.status).toBe('active')
      expect(hold.expiresAt.getTime()).toBe(NOW.getTime() + 72 * 3_600_000)
    }
  })

  it('asks the agent question and keeps the reserve', async () => {
    const task = await dialog()

    await settlement().settle(ref(task), completed({ questions: ['Какой номер поставить?'] }))

    expect(await status(task.taskId)).toBe('awaiting_user')
    expect(
      (await feed(task.taskId)).map(([type, payload]) => [
        type,
        (payload as { kind: string }).kind,
      ]),
    ).toEqual([['feed.question', 'agent']])
    expect((await holds(task.taskId)).every((hold) => hold.status === 'active')).toBe(true)
  })

  it('leaves a done pass for later while a turn key still counts its usage', async () => {
    const task = await dialog()
    const pool = await fixtures.modelPool()
    const price = await fixtures.modelPrice(pool, {
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    })
    await fixtures.modelCall({
      taskId: task.taskId,
      pool,
      priceId: price.id,
      costRub: '1.00',
      occurredAt: NOW,
      usageClosed: false,
    })

    expect(await settlement().settle(ref(task), completed({ change_type: 'none' }))).toBe('later')
    expect(await status(task.taskId)).toBe('running')
    expect(await feed(task.taskId)).toEqual([])
  })

  it('fails a pass with the client code and gives the reserve back', async () => {
    const task = await dialog()

    const answer = await settlement().settle(ref(task), {
      kind: 'failed',
      turn: 1,
      errorCode: 'PUBLICATION_FORBIDDEN',
      journalReason: 'run_failed',
    })

    expect(answer).toBe('moved')
    expect(await status(task.taskId)).toBe('failed')
    expect(await feed(task.taskId)).toEqual([
      [
        'feed.failure',
        {
          v: 1,
          turn: 1,
          code: 'forbidden_change',
          site: 'unchanged',
          credits: 'returned',
          next: 'failed',
        },
      ],
    ])
    expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
  })

  // The owner's answer 1 of 18.10.2026 (docs/plan/53, «Попробовать ещё (18.10)»).
  describe('a pass of a dialog that already has a candidate', () => {
    /** A dialog waiting with revision 1 whose second pass is in its turn 2. */
    async function revising() {
      const task = await dialog()
      await db.$transaction((tx) => recordCandidate(tx, record(task.taskId, 1)))
      await db.taskTurn.create({
        data: {
          taskId: task.taskId,
          turnNo: 2,
          status: 'failed',
          driverId: sampleDriverId,
          image,
        },
      })
      await db.task.update({ where: { id: task.taskId }, data: { turnNo: 2 } })
      const watched = await preview(task.taskId)
      return { ...task, turnNo: 2, watched }
    }

    it('keeps the candidate and the preview after a failure, with the reserve moved on', async () => {
      const task = await revising()
      const before = await holds(task.taskId)

      const answer = await settlement().settle(ref(task), {
        kind: 'failed',
        turn: 2,
        errorCode: 'TURN_EXEC_FAILED',
      })

      expect(answer).toBe('moved')
      expect(await status(task.taskId)).toBe('awaiting_approval')
      expect(await feed(task.taskId)).toEqual([
        [
          'feed.failure',
          {
            v: 1,
            turn: 2,
            code: 'technical',
            site: 'unchanged',
            credits: null,
            next: 'awaiting_approval',
          },
        ],
      ])
      expect(
        (await db.taskCandidate.findMany({ where: { taskId: task.taskId } })).map((row) => [
          row.revision,
          row.status,
        ]),
      ).toEqual([[1, 'current']])
      // The preview goes back to the candidate; it is not taken down.
      expect(await task.watched.synced()).toEqual([1])
      // The reserve stays for the release or a retry, and lives as long as a waiting dialog.
      const after = await holds(task.taskId)
      expect(after.map((hold) => hold.status)).toEqual(before.map(() => 'active'))
      for (const hold of after)
        expect(hold.expiresAt.getTime()).toBe(NOW.getTime() + 72 * 3_600_000)
      // The turn is marked: the planner replaces it, and its calls are not charged.
      const turns = await db.taskTurn.findMany({
        where: { taskId: task.taskId },
        orderBy: { turnNo: 'asc' },
        select: { turnNo: true, rejectedAt: true },
      })
      expect(turns.map((turn) => [turn.turnNo, turn.rejectedAt !== null])).toEqual([
        [1, false],
        [2, true],
      ])
    })

    // Whatever the failure but money (spec §20, «Чат, предпросмотр и /release»).
    it.each([
      ['site_held', 'SITE_HELD'],
      ['too_large', 'PUBLICATION_TOO_LARGE'],
      ['forbidden_change', 'PUBLICATION_FORBIDDEN'],
    ])('keeps the candidate after %s too', async (code, errorCode) => {
      const task = await revising()
      expect(await settlement().settle(ref(task), { kind: 'failed', turn: 2, errorCode })).toBe(
        'moved',
      )
      expect(await status(task.taskId)).toBe('awaiting_approval')
      const [row] = await feed(task.taskId)
      expect(row?.[1]).toMatchObject({ next: 'awaiting_approval', credits: null })
      expect((row?.[1] as { code: string }).code).toBe(code)
    })

    it('keeps it after a pass refused before its turn, and the preview as it was', async () => {
      const task = await revising()
      await db.task.update({ where: { id: task.taskId }, data: { status: 'preparing' } })

      expect(await settlement().settle(ref(task), { kind: 'refused', code: 'unavailable' })).toBe(
        'moved',
      )
      expect(await status(task.taskId)).toBe('awaiting_approval')
      expect(await task.watched.synced()).toEqual([])
      expect((await holds(task.taskId)).every((hold) => hold.status === 'active')).toBe(true)
    })

    it("still lets the client's «Отменить» win", async () => {
      const task = await revising()
      await cancelPress(task)

      expect(await settlement().settle(ref(task), { kind: 'failed', turn: 2 })).toBe('moved')
      expect(await status(task.taskId)).toBe('cancelled')
      expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
    })
  })

  it('cancels whatever the pass came to once the client pressed «Отменить»', async () => {
    const task = await dialog()
    await insertFeedEvent(db, {
      taskId: task.taskId,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'command',
          command: 'cancel',
          authorId: task.userId,
          requestId: randomUUID(),
        },
      },
    })

    expect(await settlement().settle(ref(task), completed())).toBe('moved')

    expect(await status(task.taskId)).toBe('cancelled')
    expect(await feed(task.taskId)).toEqual([
      [
        'feed.cancelled',
        {
          v: 1,
          turn: 1,
          by: 'customer',
          authorId: task.userId,
          site: 'unchanged',
          credits: 'returned',
        },
      ],
    ])
  })

  it('sends a pass of a busy site back to the queue with its reserve', async () => {
    const task = await dialog('preparing')

    expect(await settlement().settle(ref(task), { kind: 'busy', waiting: 'site' })).toBe('moved')

    expect(await db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({
      status: 'queued',
      waiting: 'site',
    })
    expect(await feed(task.taskId)).toEqual([])
    expect((await holds(task.taskId)).every((hold) => hold.status === 'active')).toBe(true)
  })

  it('asks «Продолжить?» before a turn, keeping /release when a candidate stands', async () => {
    const task = await dialog('preparing')
    await db.$transaction((tx) => recordCandidate(tx, record(task.taskId, 1)))
    const question = {
      v: 1 as const,
      kind: 'ceiling' as const,
      turn: 1,
      reason: 'step' as const,
      spent: 45,
      held: 45,
      left: 0,
    }

    expect(await settlement().settle(ref(task), { kind: 'ceiling', question })).toBe('moved')

    expect(await status(task.taskId)).toBe('awaiting_approval')
    expect(await feed(task.taskId)).toEqual([['feed.question', question]])
  })

  it('writes nothing while a turn of the task is still assigned', async () => {
    const task = await dialog()
    const site = await db.site.findFirstOrThrow({ where: { tasks: { some: { id: task.taskId } } } })
    await db.turnAssignment.create({
      data: {
        taskId: task.taskId,
        siteId: site.id,
        sessionId: task.taskId,
        turnNo: 1,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + 60_000),
      },
    })

    expect(
      await settlement().settle(ref(task), { kind: 'failed', turn: 1, errorCode: 'EXEC_LOST' }),
    ).toBe('skipped')
    expect(await status(task.taskId)).toBe('running')
    expect((await holds(task.taskId)).every((hold) => hold.status === 'active')).toBe(true)
    await db.turnAssignment.deleteMany({ where: { taskId: task.taskId } })
  })

  describe('with the builder of candidates over a service that cannot compare commits', () => {
    const T0 = 'd'.repeat(40)
    const T1 = 'e'.repeat(40)

    /** The real builder and port: git tells trees, and has no comparison yet (R4). */
    async function realBuilder(taskId: string, trees: Record<string, string>) {
      const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      await db.gitRepository.create({
        data: {
          siteId: task.siteId,
          provider: 'gitea',
          owner: 'sites-r3-settle',
          name: `site-${task.siteId}`,
          url: `https://git.invalid/sites/site-${task.siteId}.git`,
        },
      })
      await db.taskTurn.update({
        where: { taskId_turnNo: { taskId, turnNo: 1 } },
        data: { baseSha: BASE },
      })
      const git = candidateGitOf({
        readBranchHead: vi.fn(),
        rebaseCandidate: vi.fn(),
        treeOf: vi.fn(async ({ sha }: { sha: string }) => trees[sha]!),
      })
      const put = vi.fn(async () => {})
      return new CandidateBuilder(db, git, { put }, getSiteAdapter)
    }
    afterEach(async () => {
      await db.gitRepository.deleteMany({ where: { owner: 'sites-r3-settle' } })
    })

    it('ends a pass that changed nothing by its trees alone', async () => {
      const task = await dialog()
      const candidates = await realBuilder(task.taskId, { [BASE]: T0, [HEAD]: T0 })
      const ends = new PassSettlement({ db, candidates, logger: quiet, now: () => NOW })

      expect(await ends.settle(ref(task), completed({ change_type: 'none' }))).toBe('moved')
      expect(await status(task.taskId)).toBe('done')
      expect((await holds(task.taskId)).every((hold) => hold.status === 'captured')).toBe(true)
    })

    it('asks the agent question of a pass that changed nothing', async () => {
      const task = await dialog()
      const candidates = await realBuilder(task.taskId, { [BASE]: T0, [HEAD]: T0 })
      const ends = new PassSettlement({ db, candidates, logger: quiet, now: () => NOW })

      expect(await ends.settle(ref(task), completed({ questions: ['Какой номер?'] }))).toBe('moved')
      expect(await status(task.taskId)).toBe('awaiting_user')
    })

    it('fails a pass that changed files at once, with its reserve given back', async () => {
      const task = await dialog()
      const candidates = await realBuilder(task.taskId, { [BASE]: T0, [HEAD]: T1 })
      const ends = new PassSettlement({ db, candidates, logger: quiet, now: () => NOW })

      expect(await ends.settle(ref(task), completed())).toBe('moved')
      expect(await status(task.taskId)).toBe('failed')
      expect(await feed(task.taskId)).toEqual([
        [
          'feed.failure',
          {
            v: 1,
            turn: 1,
            code: 'unavailable',
            site: 'unchanged',
            credits: 'returned',
            next: 'failed',
          },
        ],
      ])
    })
  })

  it('cancels a pass whose «Отменить» was written while its ending was being prepared', async () => {
    const task = await dialog()
    // The candidate is built outside the transaction (git, S3): web writes the press meanwhile.
    const ends = settlement(async (context) => {
      await cancelPress(task)
      return { kind: 'candidate', record: record(task.taskId, context.revision) }
    })

    expect(await ends.settle(ref(task), completed())).toBe('moved')

    expect(await status(task.taskId)).toBe('cancelled')
    expect(await db.taskCandidate.count({ where: { taskId: task.taskId } })).toBe(0)
    expect((await feed(task.taskId)).map(([type]) => type)).toEqual(['feed.cancelled'])
    expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
  })

  it('closes a waiting dialog whose «Отменить» reached core after its pass had ended', async () => {
    const task = await dialog()
    const watched = await preview(task.taskId)
    await db.task.update({ where: { id: task.taskId }, data: { status: 'awaiting_user' } })
    await cancelPress(task)

    expect(await settlement().cancelWaiting(task.taskId)).toBe('moved')

    expect(await status(task.taskId)).toBe('cancelled')
    expect(await feed(task.taskId)).toEqual([
      [
        'feed.cancelled',
        {
          v: 1,
          turn: 1,
          by: 'customer',
          authorId: task.userId,
          site: 'unchanged',
          credits: 'returned',
        },
      ],
    ])
    expect(await watched.synced()).toEqual([0])
    // Without a press after the last words there is nothing to close.
    const other = await dialog()
    await db.task.update({ where: { id: other.taskId }, data: { status: 'awaiting_user' } })
    expect(await settlement().cancelWaiting(other.taskId)).toBe('skipped')
  })

  it('takes the preview down when a pass fails before it opened a turn', async () => {
    const task = await dialog('preparing')
    const watched = await preview(task.taskId)

    expect(await settlement().settle(ref(task), { kind: 'refused', code: 'technical' })).toBe(
      'moved',
    )
    expect(await status(task.taskId)).toBe('failed')
    expect(await watched.synced()).toEqual([0])
  })

  it('puts an orphaned pass back in the queue and fails it the third time', async () => {
    const task = await dialog('preparing')
    const back = async () => {
      expect(await settlement().settle(ref(task), { kind: 'orphaned' })).toBe('moved')
      return db.task.findUniqueOrThrow({ where: { id: task.taskId } })
    }

    expect(await back()).toMatchObject({ status: 'queued', waiting: null })
    await db.task.update({ where: { id: task.taskId }, data: { status: 'preparing' } })
    expect((await back()).status).toBe('queued')
    await db.task.update({ where: { id: task.taskId }, data: { status: 'preparing' } })
    expect((await back()).status).toBe('failed')
    expect(
      await db.taskEvent.count({ where: { taskId: task.taskId, type: ORPHANED_PASS_EVENT } }),
    ).toBe(2)
    expect(await feed(task.taskId)).toEqual([
      [
        'feed.failure',
        {
          v: 1,
          turn: null,
          code: 'unavailable',
          site: 'unchanged',
          credits: 'returned',
          next: 'failed',
        },
      ],
    ])
  })

  describe('a turn whose key the gateway refused (`budget`)', () => {
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z')

    /** A dialog whose turn 1 called the model once for 1 ₽ and was then refused `budget`. */
    async function refused(budgetRub: string) {
      await fixtures.creditRate({ effectiveFrom })
      const pool = await fixtures.modelPool({ enabled: true })
      const price = await fixtures.modelPrice(pool, { effectiveFrom })
      const task = await dialog()
      const call = await fixtures.modelCall({
        taskId: task.taskId,
        pool,
        priceId: price.id,
        costRub: '1.00',
        occurredAt: NOW,
      })
      await db.llmKey.update({
        where: { id: call.keyId },
        data: { budgetRub, lastRefusal: 'budget', lastRefusalAt: NOW },
      })
      return task
    }
    const failedTurn: PassEnding = { kind: 'failed', turn: 1, errorCode: 'TURN_FAILED' }

    it('asks «Продолжить?» when what the key had left could not cover a next call', async () => {
      const task = await refused('1.0100000000')

      expect(await settlement().settle(ref(task), failedTurn)).toBe('moved')
      expect(await status(task.taskId)).toBe('awaiting_user')
      expect(
        (await feed(task.taskId)).map(([type, payload]) => [
          type,
          (payload as { kind: string }).kind,
        ]),
      ).toEqual([['feed.question', 'ceiling']])
    })

    it('fails the pass when the key still had money: the gateway stopped its pace', async () => {
      const task = await refused('750.0000000000')

      expect(await settlement().settle(ref(task), failedTurn)).toBe('moved')
      expect(await status(task.taskId)).toBe('failed')
      expect((await feed(task.taskId))[0]).toEqual([
        'feed.failure',
        {
          v: 1,
          turn: 1,
          code: 'technical',
          site: 'unchanged',
          credits: 'returned',
          next: 'failed',
        },
      ])
    })
  })
})
