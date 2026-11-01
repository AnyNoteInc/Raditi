import { createHash, randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  createPrismaClient,
  insertFeedEvent,
  markBrowserSessionWrote,
  openBrowserSession,
  recordBrowserControl,
  recordBrowserHelp,
  recordCandidate,
  upsertBrowserCheckpoint,
  type CandidateRecordInput,
  type PrismaClient,
} from '@repo/db'
import type { BrowserVerifiedObject, CandidateFacts, TurnResult } from '@repo/domain'
import { failureAllowsRetry, siteIdOf } from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import {
  CandidateBuilder,
  type CandidateBuild,
  type CandidateContext,
} from './candidate-builder.ts'
import { candidateGitOf } from './candidate-git.ts'
import {
  CHARGE_LATER_EVENT,
  ORPHANED_PASS_EVENT,
  PassSettlement,
  type PassEnding,
} from './pass-settlement.ts'

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
  /** What the task was charged, in credits: the sum of its `charge` rows. */
  const charged = async (taskId: string) =>
    0 -
    Number(
      (
        await db.creditLedger.aggregate({
          where: { taskId, kind: 'charge' },
          _sum: { amount: true },
        })
      )._sum.amount ?? 0,
    )
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

  it('keeps the dialog of a pass that changed nothing open, its preview kept and the pass charged', async () => {
    // The owner, 26.10.2026: «после того как в работе произошла какая-то работа, не закрывай чат».
    const task = await dialog()
    const watched = await preview(task.taskId)

    expect(await settlement().settle(ref(task), completed({ change_type: 'none' }))).toBe('moved')

    expect(await status(task.taskId)).toBe('awaiting_user')
    // The dialog goes on: its preview stays as it is.
    expect(await watched.synced()).toEqual([])
    expect(await feed(task.taskId)).toEqual([
      [
        'feed.result',
        {
          v: 1,
          turn: 1,
          message: 'Телефон в шапке заменён.',
          site: 'unchanged',
          next: 'awaiting_user',
          filesChanged: 0,
          changeType: 'none',
          needsApproval: false,
          risk: 'low',
        },
      ],
    ])
    // The pass is charged when it ends (owner's answer of 26.10.2026: «любой успешный запрос от
    // LLM должен тарифицироваться»): the first charge of the task, its minimum; the next words
    // open a new chain.
    expect((await holds(task.taskId)).every((hold) => hold.status === 'captured')).toBe(true)
    expect(await charged(task.taskId)).toBe(5)
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
    // The pass that made the candidate is charged now; the release charges nothing more.
    expect((await holds(task.taskId)).every((hold) => hold.status === 'captured')).toBe(true)
    expect(await charged(task.taskId)).toBe(5)
  })

  it('asks the agent question and charges the pass that asked', async () => {
    const task = await dialog()

    await settlement().settle(ref(task), completed({ questions: ['Какой номер поставить?'] }))

    expect(await status(task.taskId)).toBe('awaiting_user')
    expect(
      (await feed(task.taskId)).map(([type, payload]) => [
        type,
        (payload as { kind: string }).kind,
      ]),
    ).toEqual([['feed.question', 'agent']])
    expect((await holds(task.taskId)).every((hold) => hold.status === 'captured')).toBe(true)
  })

  it('keeps a dialog open while a turn key still counts its usage: the charge waits for the sweep', async () => {
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

    expect(await settlement().settle(ref(task), completed({ change_type: 'none' }))).toBe('moved')
    expect(await status(task.taskId)).toBe('awaiting_user')
    // The client is not held back: the chain stays active, moved on, and a row names its attempt
    // for the sweep (`TaskSweep.chargeLater`).
    for (const hold of await holds(task.taskId)) {
      expect(hold.status).toBe('active')
      expect(hold.expiresAt.getTime()).toBe(NOW.getTime() + 72 * 3_600_000)
    }
    expect(await charged(task.taskId)).toBe(0)
    expect(
      (
        await db.taskEvent.findMany({
          where: { taskId: task.taskId, type: CHARGE_LATER_EVENT },
          select: { payload: true, clientVisible: true },
        })
      ).map((row) => [row.payload, row.clientVisible]),
    ).toEqual([[{ v: 1, attempt: 1 }, false]])
  })

  // The owner's decision of 28.10.2026: «никогда не завершай диалог, если произошла ошибка».
  it('keeps the dialog open after a failed pass, with the client code and the reserve given back', async () => {
    const task = await dialog()

    const answer = await settlement().settle(ref(task), {
      kind: 'failed',
      turn: 1,
      errorCode: 'PUBLICATION_FORBIDDEN',
      journalReason: 'run_failed',
    })

    expect(answer).toBe('moved')
    expect(await status(task.taskId)).toBe('awaiting_user')
    expect(await feed(task.taskId)).toEqual([
      [
        'feed.failure',
        {
          v: 1,
          turn: 1,
          code: 'forbidden_change',
          site: 'unchanged',
          credits: 'returned',
          next: 'awaiting_user',
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
          siteId: siteIdOf(task),
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

    it('keeps the dialog of a pass that changed nothing by its trees alone open', async () => {
      const task = await dialog()
      const candidates = await realBuilder(task.taskId, { [BASE]: T0, [HEAD]: T0 })
      const ends = new PassSettlement({ db, candidates, logger: quiet, now: () => NOW })

      expect(await ends.settle(ref(task), completed({ change_type: 'none' }))).toBe('moved')
      expect(await status(task.taskId)).toBe('awaiting_user')
      expect((await holds(task.taskId)).every((hold) => hold.status === 'captured')).toBe(true)
    })

    it('asks the agent question of a pass that changed nothing', async () => {
      const task = await dialog()
      const candidates = await realBuilder(task.taskId, { [BASE]: T0, [HEAD]: T0 })
      const ends = new PassSettlement({ db, candidates, logger: quiet, now: () => NOW })

      expect(await ends.settle(ref(task), completed({ questions: ['Какой номер?'] }))).toBe('moved')
      expect(await status(task.taskId)).toBe('awaiting_user')
    })

    it('keeps open the dialog of a pass that changed files at once, its reserve given back', async () => {
      const task = await dialog()
      const candidates = await realBuilder(task.taskId, { [BASE]: T0, [HEAD]: T1 })
      const ends = new PassSettlement({ db, candidates, logger: quiet, now: () => NOW })

      expect(await ends.settle(ref(task), completed())).toBe('moved')
      expect(await status(task.taskId)).toBe('awaiting_user')
      expect(await feed(task.taskId)).toEqual([
        [
          'feed.failure',
          {
            v: 1,
            turn: 1,
            code: 'unavailable',
            site: 'unchanged',
            credits: 'returned',
            next: 'awaiting_user',
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

  it('wakes the preview when a pass fails before it opened a turn: the dialog stays open', async () => {
    const task = await dialog('preparing')
    const watched = await preview(task.taskId)

    expect(await settlement().settle(ref(task), { kind: 'refused', code: 'technical' })).toBe(
      'moved',
    )
    expect(await status(task.taskId)).toBe('awaiting_user')
    // The manager syncs a preview of an open dialog and takes down only one of a closed dialog.
    expect(await watched.synced()).toEqual([0])
  })

  it('puts an orphaned pass back in the queue and fails it the third time, the dialog open', async () => {
    const task = await dialog('preparing')
    const back = async () => {
      expect(await settlement().settle(ref(task), { kind: 'orphaned' })).toBe('moved')
      return db.task.findUniqueOrThrow({ where: { id: task.taskId } })
    }

    expect(await back()).toMatchObject({ status: 'queued', waiting: null })
    await db.task.update({ where: { id: task.taskId }, data: { status: 'preparing' } })
    expect((await back()).status).toBe('queued')
    await db.task.update({ where: { id: task.taskId }, data: { status: 'preparing' } })
    expect((await back()).status).toBe('awaiting_user')
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
          next: 'awaiting_user',
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
      expect(await status(task.taskId)).toBe('awaiting_user')
      expect((await feed(task.taskId))[0]).toEqual([
        'feed.failure',
        {
          v: 1,
          turn: 1,
          code: 'technical',
          site: 'unchanged',
          credits: 'returned',
          next: 'awaiting_user',
        },
      ])
    })
  })

  describe('of a task in the cloud browser (docs/plan/57-browser-tasks.md, Б23–Б25, Б28)', () => {
    const editUrl = 'https://example.ru/wp-admin/post.php?post=12&action=edit'
    const verified: BrowserVerifiedObject = {
      kind: 'post',
      objectId: '12',
      title: 'Скидки в октябре',
      status: 'publish',
      url: 'https://example.ru/skidki/',
      editUrl,
      images: 2,
      files: 1,
      featuredImage: true,
    }

    /** A task in the browser in its first turn, its session open, the gift set aside for it. */
    async function browserTask(status: 'running' | 'awaiting_user' = 'running') {
      const { userId } = await fixtures.user()
      const workspace = await db.$transaction((tx) =>
        ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
      )
      const { taskId } = await fixtures.task(workspace.id, {
        status,
        turnNo: 1,
        needsRepository: false,
        needsBrowser: true,
      })
      await db.taskTurn.create({
        data: { taskId, turnNo: 1, status: 'completed', driverId: sampleDriverId, image },
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
            text: 'Добавьте новость о скидках',
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
      const session = await openBrowserSession(db, { taskId })
      return { userId, workspaceId: workspace.id, taskId, turnNo: 1, sessionId: session.id }
    }
    const saved = (task: { taskId: string; sessionId: string }, read = true) =>
      upsertBrowserCheckpoint(db, {
        taskId: task.taskId,
        sessionId: task.sessionId,
        ref: { kind: 'post', objectId: '12', editUrl },
        ...(read ? { state: 'verified' as const, verified } : { state: 'unverified' as const }),
      })
    const done = (patch: Partial<TurnResult> = {}): PassEnding => ({
      kind: 'completed',
      turn: 1,
      result: result({
        change_type: 'content',
        client_message: 'Новость опубликована.',
        files_changed: [],
        ...patch,
      }),
    })
    /** The settlement with a closer of browsers that records what it was asked. */
    const ends = () => {
      const close = vi.fn(async () => {})
      return {
        close,
        settlement: new PassSettlement({
          db,
          candidates: null,
          browser: { close },
          logger: quiet,
          now: () => NOW,
        }),
      }
    }

    // The owner, 26.10.2026: «сделай также как в работе, результат не должен быть подтвержден, мы
    // тарифицируем работу с LLM» — the pass answers, the dialog stays open, the pass is charged.
    it('answers with what the site confirmed, keeps the dialog and the browser, charges the pass', async () => {
      const task = await browserTask()
      await saved(task)
      await markBrowserSessionWrote(db, { sessionId: task.sessionId })
      const { settlement: browser, close } = ends()

      expect(await browser.settle(ref(task), done())).toBe('moved')

      expect(await status(task.taskId)).toBe('awaiting_user')
      expect(await feed(task.taskId)).toEqual([
        [
          'feed.result',
          {
            v: 1,
            turn: 1,
            message: 'Новость опубликована.',
            site: 'changed',
            next: 'awaiting_user',
            filesChanged: 0,
            changeType: 'content',
            needsApproval: false,
            risk: 'low',
            objects: [
              {
                kind: 'post',
                title: 'Скидки в октябре',
                status: 'published',
                url: 'https://example.ru/skidki/',
                editUrl,
              },
            ],
          },
        ],
      ])
      expect((await holds(task.taskId)).every((hold) => hold.status === 'captured')).toBe(true)
      // The browser lives on for the next words, until its idle time ends.
      expect(close).not.toHaveBeenCalled()
    })

    it('keeps the dialog open while a turn key still counts its usage: the charge waits', async () => {
      const task = await browserTask()
      await saved(task)
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
      const { settlement: browser, close } = ends()

      expect(await browser.settle(ref(task), done())).toBe('moved')
      expect(await status(task.taskId)).toBe('awaiting_user')
      expect((await holds(task.taskId)).every((hold) => hold.status === 'active')).toBe(true)
      expect(
        await db.taskEvent.count({ where: { taskId: task.taskId, type: CHARGE_LATER_EVENT } }),
      ).toBe(1)
      expect(close).not.toHaveBeenCalled()
    })

    it('asks the client to act when the agent asked for help, and charges the pass that asked', async () => {
      const task = await browserTask()
      await saved(task)
      await recordBrowserHelp(db, {
        sessionId: task.sessionId,
        reason: 'login',
        message: 'Войдите, пожалуйста, в админку сайта.',
      })
      const { settlement: browser, close } = ends()

      expect(await browser.settle(ref(task), done())).toBe('moved')

      expect(await status(task.taskId)).toBe('awaiting_user')
      expect(await feed(task.taskId)).toEqual([
        [
          'feed.question',
          {
            v: 1,
            kind: 'browser',
            turn: 1,
            reason: 'login',
            message: 'Войдите, пожалуйста, в админку сайта.',
          },
        ],
      ])
      expect((await holds(task.taskId)).every((hold) => hold.status === 'captured')).toBe(true)
      expect(close).not.toHaveBeenCalled()
    })

    it('waits for the client who holds the browser, and for an answer to the agent', async () => {
      const held = await browserTask()
      await recordBrowserControl(db, {
        sessionId: held.sessionId,
        controller: 'user',
        controlEpoch: 1,
      })
      const asked = await browserTask()
      const { settlement: browser } = ends()

      await browser.settle(ref(held), done())
      await browser.settle(ref(asked), done({ questions: ['Опубликовать сразу или черновиком?'] }))

      expect(await feed(held.taskId)).toEqual([
        [
          'feed.question',
          { v: 1, kind: 'browser', turn: 1, reason: 'control', message: 'Новость опубликована.' },
        ],
      ])
      expect(
        (await feed(asked.taskId)).map(([type, payload]) => [
          type,
          (payload as { kind: string }).kind,
        ]),
      ).toEqual([['feed.question', 'agent']])
      expect(await status(held.taskId)).toBe('awaiting_user')
      expect(await status(asked.taskId)).toBe('awaiting_user')
    })

    it('answers without a question when nothing the task saved is confirmed on the site', async () => {
      const task = await browserTask()
      await saved(task, false)
      const { settlement: browser, close } = ends()

      await browser.settle(ref(task), done())

      expect(await status(task.taskId)).toBe('awaiting_user')
      const [row] = await feed(task.taskId)
      expect(row).toEqual([
        'feed.result',
        expect.objectContaining({
          next: 'awaiting_user',
          site: 'unchanged',
          message: 'Новость опубликована.',
          objects: [{ kind: 'post', title: null, status: 'unconfirmed', editUrl }],
        }),
      ])
      expect((await holds(task.taskId)).every((hold) => hold.status === 'captured')).toBe(true)
      expect(close).not.toHaveBeenCalled()
    })

    it('shows the client why the agent saved nothing, as its answer', async () => {
      // The page refused a setting: the guide tells the agent to say so, not to look for a way
      // around it — and its words are all the client has to learn why.
      const task = await browserTask()
      const refused =
        'Менять настройки сайта мне нельзя: это раздел, который платформа закрывает. Поменяйте его сами в браузере задачи.'
      const { settlement: browser } = ends()

      await browser.settle(ref(task), done({ change_type: 'none', client_message: refused }))

      expect(await status(task.taskId)).toBe('awaiting_user')
      expect(await feed(task.taskId)).toEqual([
        [
          'feed.result',
          {
            v: 1,
            turn: 1,
            message: refused,
            site: 'unchanged',
            next: 'awaiting_user',
            filesChanged: 0,
            changeType: 'none',
            needsApproval: false,
            risk: 'low',
          },
        ],
      ])
    })

    it('fails with what the site holds, tells the client to check it and keeps the browser', async () => {
      const task = await browserTask()
      await saved(task, false)
      await markBrowserSessionWrote(db, { sessionId: task.sessionId })
      const { settlement: browser, close } = ends()

      await browser.settle(ref(task), { kind: 'failed', turn: 1, journalReason: 'run_failed' })

      // The dialog stays open (28.10.2026): «продолжи» goes on in the same browser.
      expect(await status(task.taskId)).toBe('awaiting_user')
      expect(await feed(task.taskId)).toEqual([
        [
          'feed.failure',
          {
            v: 1,
            turn: 1,
            code: 'technical',
            site: 'check',
            credits: 'returned',
            next: 'awaiting_user',
            objects: [{ kind: 'post', title: null, status: 'unconfirmed', editUrl }],
          },
        ],
      ])
      expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
      expect(close).not.toHaveBeenCalled()
    })

    it('cancels a running and a waiting task with what the site holds; nothing is deleted', async () => {
      const running = await browserTask()
      await saved(running)
      const waiting = await browserTask('awaiting_user')
      await saved(waiting)
      await markBrowserSessionWrote(db, { sessionId: waiting.sessionId })
      await cancelPress(waiting)
      const { settlement: browser, close } = ends()

      await browser.settle(ref(running), { kind: 'cancelled', turn: 1 })
      expect(await browser.cancelWaiting(waiting.taskId)).toBe('moved')

      for (const task of [running, waiting]) {
        expect(await status(task.taskId)).toBe('cancelled')
        const [row] = await feed(task.taskId)
        expect(row).toEqual([
          'feed.cancelled',
          expect.objectContaining({
            by: 'customer',
            credits: 'returned',
            objects: [expect.objectContaining({ status: 'published', title: 'Скидки в октябре' })],
          }),
        ])
        expect(close).toHaveBeenCalledWith(task.taskId, 'task_cancelled')
      }
      expect((await feed(running.taskId))[0]![1]).toMatchObject({ site: 'unchanged' })
      expect((await feed(waiting.taskId))[0]![1]).toMatchObject({ site: 'check' })
      expect(await db.browserCheckpoint.count({ where: { taskId: running.taskId } })).toBe(1)
    })

    it('fails a completed pass of a task with a repository that names no head', async () => {
      const task = await dialog()

      await settlement().settle(ref(task), { kind: 'completed', turn: 1, result: result() })

      // The dialog stays open (28.10.2026).
      expect(await status(task.taskId)).toBe('awaiting_user')
      expect((await feed(task.taskId))[0]![1]).toMatchObject({ code: 'technical' })
    })
  })

  describe('of a chat with the code and the browser (docs/plan/61-chats-first.md, §5.8)', () => {
    const STARTED = new Date('2026-10-17T09:00:00.000Z')
    const editUrl = 'https://example.ru/wp-admin/post.php?post=12&action=edit'
    const news = (objectId: string): BrowserVerifiedObject => ({
      kind: 'post',
      objectId,
      title: `Новость ${objectId}`,
      status: 'publish',
      url: `https://example.ru/${objectId}/`,
      editUrl,
      images: 0,
      files: 0,
      featuredImage: false,
    })

    /**
     * A chat in its turn 2, which started at STARTED, the feed having told of turn 1; a candidate
     * stands when `standing`. `asked` — in its turn 3: turn 2 ended with a question, which tells
     * of nothing.
     */
    async function both(options: { standing?: boolean; asked?: boolean } = {}) {
      const { userId } = await fixtures.user()
      const workspace = await db.$transaction((tx) =>
        ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
      )
      const turnNo = options.asked ? 3 : 2
      const { taskId } = await fixtures.task(workspace.id, {
        status: 'running',
        turnNo,
        needsRepository: true,
        needsBrowser: true,
      })
      for (const no of options.asked ? [1, 2, 3] : [1, 2])
        await db.taskTurn.create({
          data: {
            taskId,
            turnNo: no,
            status: 'completed',
            driverId: sampleDriverId,
            image,
            headSha: HEAD,
            startedAt: new Date(STARTED.getTime() + (no - 2) * 3_600_000),
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
            text: 'Опубликуйте новость и поправьте шапку',
          },
        },
      })
      const told = await insertFeedEvent(db, {
        taskId,
        row: {
          type: 'feed.result',
          payload: {
            v: 1,
            turn: 1,
            message: 'Новость опубликована.',
            site: 'changed',
            next: 'awaiting_user',
            filesChanged: 0,
            changeType: 'content',
            needsApproval: false,
            risk: 'low',
          },
        },
      })
      await db.taskEvent.update({
        where: { id: told },
        data: { createdAt: new Date(STARTED.getTime() - 1_800_000) },
      })
      await fixtures.reserve({
        workspaceId: workspace.id,
        taskId,
        attempt: 1,
        now: NOW,
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      })
      if (options.standing) await db.$transaction((tx) => recordCandidate(tx, record(taskId, 1)))
      const session = await openBrowserSession(db, { taskId })
      return { userId, taskId, turnNo, sessionId: session.id }
    }
    type Chat = Awaited<ReturnType<typeof both>>
    /** The object, as a read left it: `ago` hours before the pass, or within it when absent. */
    async function published(chat: Chat, objectId: string, ago?: number) {
      await upsertBrowserCheckpoint(db, {
        taskId: chat.taskId,
        sessionId: chat.sessionId,
        ref: { kind: 'post', objectId, editUrl },
        state: 'verified',
        verified: news(objectId),
      })
      if (ago !== undefined)
        await db.browserCheckpoint.updateMany({
          where: { taskId: chat.taskId, objectId },
          data: { updatedAt: new Date(STARTED.getTime() - ago * 3_600_000) },
        })
    }
    const wrote = (chat: Chat, at: Date) =>
      db.browserSession.update({
        where: { id: chat.sessionId },
        data: { wroteAt: new Date(STARTED.getTime() - 7_200_000), lastWroteAt: at },
      })
    const earlier = new Date(STARTED.getTime() - 3_600_000)
    const inThisPass = new Date(STARTED.getTime() + 60_000)
    const answer = (patch: Partial<TurnResult> = {}, turn = 2): PassEnding => ({
      kind: 'completed',
      turn,
      result: result({ client_message: 'Готово.', ...patch }),
      headSha: HEAD,
    })
    const row = async (taskId: string, type: string) =>
      (await feed(taskId)).findLast(([kind]) => kind === type)?.[1] as Record<string, unknown>

    it('asks for the sign-in with a candidate standing: the request is not lost', async () => {
      const chat = await both({ standing: true })
      await db.browserSession.update({
        where: { id: chat.sessionId },
        data: { helpReason: 'login', helpMessage: 'Войдите в админку' },
      })
      const answered = await settlement(() => ({ kind: 'unchanged' })).settle(ref(chat), answer())

      expect(answered).toBe('moved')
      expect(await status(chat.taskId)).toBe('awaiting_user')
      expect(await row(chat.taskId, 'feed.question')).toMatchObject({
        kind: 'browser',
        reason: 'login',
        message: 'Войдите в админку',
      })
      // Only the result of turn 1.
      expect((await feed(chat.taskId)).filter(([type]) => type === 'feed.result')).toHaveLength(1)
      // The candidate stands: the client signs in and it waits for `/release` after that.
      expect(
        await db.taskCandidate.count({ where: { taskId: chat.taskId, status: 'current' } }),
      ).toBe(1)
      expect(await charged(chat.taskId)).toBeGreaterThan(0)
    })

    it('waits for the client who holds the browser, with what the agent said', async () => {
      const chat = await both({ standing: true })
      await db.browserSession.update({
        where: { id: chat.sessionId },
        data: { controller: 'user' },
      })
      await settlement(() => ({ kind: 'unchanged' })).settle(
        ref(chat),
        answer({ client_message: 'Шапку поправил.' }),
      )

      expect(await status(chat.taskId)).toBe('awaiting_user')
      expect(await row(chat.taskId, 'feed.question')).toMatchObject({
        kind: 'browser',
        reason: 'control',
        message: 'Шапку поправил.',
      })
    })

    it('tells of the object this pass published, and of none of the earlier ones', async () => {
      const chat = await both()
      await published(chat, '11', 1)
      await published(chat, '12')
      await wrote(chat, inThisPass)
      await settlement(() => EMPTY).settle(ref(chat), answer())

      const shown = await row(chat.taskId, 'feed.result')
      expect(shown).toMatchObject({ site: 'changed', next: 'awaiting_user' })
      expect((shown.objects as { title: string }[]).map((object) => object.title)).toEqual([
        'Новость 12',
      ])
    })

    it('says nothing of the site to a question about the code after a news item', async () => {
      const chat = await both()
      await published(chat, '11', 1)
      await wrote(chat, earlier)
      await settlement(() => EMPTY).settle(ref(chat), answer())

      const shown = await row(chat.taskId, 'feed.result')
      expect(shown).toMatchObject({ site: 'unchanged' })
      expect(shown).not.toHaveProperty('objects')
    })

    it('tells of a pass that ended with a question in the next result', async () => {
      const chat = await both({ asked: true })
      await published(chat, '11', 1)
      await published(chat, '12', -0.1)
      await wrote(chat, inThisPass)
      await settlement(() => EMPTY).settle(ref(chat), answer({}, 3))

      const shown = await row(chat.taskId, 'feed.result')
      expect(shown).toMatchObject({ turn: 3, site: 'changed' })
      expect((shown.objects as { title: string }[]).map((object) => object.title)).toEqual([
        'Новость 12',
      ])
    })

    it('does not take what someone else changed on the site for the work of this pass', async () => {
      const chat = await both()
      await published(chat, '11', 1)
      await wrote(chat, earlier)
      // The read at the end of a pass that never touched the browser found another title.
      await upsertBrowserCheckpoint(db, {
        taskId: chat.taskId,
        sessionId: chat.sessionId,
        ref: { kind: 'post', objectId: '11', editUrl },
        state: 'verified',
        verified: { ...news('11'), title: 'Заголовок из админки' },
      })
      await settlement(() => EMPTY).settle(ref(chat), answer())

      const shown = await row(chat.taskId, 'feed.result')
      expect(shown).toMatchObject({ site: 'unchanged' })
      expect(shown).not.toHaveProperty('objects')
    })

    it('asks the client to check the site when this pass acted and nothing is confirmed', async () => {
      const chat = await both()
      await published(chat, '11', 1)
      await wrote(chat, inThisPass)
      await settlement(() => EMPTY).settle(ref(chat), answer())

      expect(await row(chat.taskId, 'feed.result')).toMatchObject({ site: 'check' })
    })

    it('does not write «ничего не изменилось» on the card of a candidate after a news item', async () => {
      const chat = await both({ standing: true })
      await published(chat, '11', 1)
      await wrote(chat, earlier)
      await settlement(() => ({ kind: 'unchanged' })).settle(ref(chat), answer())

      expect(await row(chat.taskId, 'feed.result')).toMatchObject({
        site: 'none',
        next: 'awaiting_approval',
      })
      expect(await status(chat.taskId)).toBe('awaiting_approval')
    })

    it('says «unchanged» on that card while the browser did nothing in the chat', async () => {
      const chat = await both({ standing: true })
      await settlement(() => ({ kind: 'unchanged' })).settle(ref(chat), answer())

      expect(await row(chat.taskId, 'feed.result')).toMatchObject({
        site: 'unchanged',
        next: 'awaiting_approval',
      })
    })

    it('fails a pass with a candidate naming what this pass left on the site', async () => {
      const chat = await both({ standing: true })
      await published(chat, '11', 1)
      await published(chat, '12')
      await wrote(chat, inThisPass)
      await settlement().settle(ref(chat), { kind: 'failed', turn: 2, errorCode: 'crash' })

      const failure = await row(chat.taskId, 'feed.failure')
      expect(failure).toMatchObject({ site: 'check', next: 'awaiting_approval' })
      expect((failure.objects as { title: string }[]).map((object) => object.title)).toEqual([
        'Новость 12',
      ])
      expect(await status(chat.taskId)).toBe('awaiting_approval')
    })

    it('fails a pass without a candidate the same way, the chat open', async () => {
      const chat = await both()
      await published(chat, '11', 1)
      await published(chat, '12')
      await wrote(chat, inThisPass)
      await settlement().settle(ref(chat), { kind: 'failed', turn: 2, errorCode: 'crash' })

      const failure = await row(chat.taskId, 'feed.failure')
      expect(failure).toMatchObject({ next: 'awaiting_user' })
      expect((failure.objects as { title: string }[]).map((object) => object.title)).toEqual([
        'Новость 12',
      ])
    })

    it('keeps «Попробовать ещё» after a news item of an earlier pass', async () => {
      const chat = await both({ standing: true })
      await published(chat, '11', 1)
      await wrote(chat, earlier)
      await settlement().settle(ref(chat), { kind: 'failed', turn: 2, errorCode: 'crash' })

      const failure = await row(chat.taskId, 'feed.failure')
      expect(failure).toMatchObject({ code: 'technical', site: 'none' })
      expect(failure).not.toHaveProperty('objects')
      expect(failureAllowsRetry(failure as Parameters<typeof failureAllowsRetry>[0])).toBe(true)
    })

    it('closes «Попробовать ещё» for the pass that acted on the site itself', async () => {
      const chat = await both({ standing: true })
      await wrote(chat, inThisPass)
      await settlement().settle(ref(chat), { kind: 'failed', turn: 2, errorCode: 'crash' })

      const failure = await row(chat.taskId, 'feed.failure')
      expect(failure).toMatchObject({ code: 'technical', site: 'check' })
      expect(failureAllowsRetry(failure as Parameters<typeof failureAllowsRetry>[0])).toBe(false)
    })

    it.each<[string, PassEnding]>([
      ['the planner refused', { kind: 'refused', code: 'unavailable' }],
      ['failed before its turn', { kind: 'failed', turn: null, errorCode: 'crash' }],
    ])('names none of the earlier objects when a pass %s', async (_, ending) => {
      const chat = await both()
      await published(chat, '11', 1)
      await wrote(chat, earlier)
      await settlement().settle(ref(chat), ending)

      const failure = await row(chat.taskId, 'feed.failure')
      expect(failure).toMatchObject({ site: 'none', next: 'awaiting_user' })
      expect(failure).not.toHaveProperty('objects')
    })

    it('names all the chat left on the site when it is cancelled: it ends there', async () => {
      const chat = await both()
      await published(chat, '11', 1)
      await published(chat, '12')
      await settlement().settle(ref(chat), { kind: 'cancelled', turn: 2 })

      const cancelled = await row(chat.taskId, 'feed.cancelled')
      expect((cancelled.objects as { title: string }[]).map((object) => object.title)).toEqual([
        'Новость 11',
        'Новость 12',
      ])
    })

    it('keeps the words of a chat with the code alone as they were', async () => {
      const task = await dialog()
      await settlement().settle(ref(task), completed())

      const shown = await row(task.taskId, 'feed.result')
      expect(shown).toMatchObject({ site: 'unchanged' })
      expect(shown).not.toHaveProperty('objects')
    })
  })

  describe('of a chat without a project (docs/plan/61-chats-first.md, К18)', () => {
    /** A chat at work in its first turn, the gift set aside; `browser` — with a browser. */
    async function chat({ browser = false, wrote = false } = {}) {
      const { userId } = await fixtures.user()
      const workspace = await db.$transaction((tx) =>
        ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
      )
      const { taskId } = await fixtures.task(workspace.id, {
        status: 'running',
        turnNo: 1,
        siteId: null,
        needsRepository: false,
        needsBrowser: browser,
      })
      await db.taskTurn.create({
        data: { taskId, turnNo: 1, status: 'completed', driverId: sampleDriverId, image },
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
            text: 'Предложите пять названий для пекарни',
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
      if (browser)
        await db.browserSession.create({
          data: {
            taskId,
            workspaceId: workspace.id,
            siteId: null,
            status: 'ready',
            readyAt: new Date(),
            // The database's clock checks it, not the clock of this file.
            expiresAt: new Date(Date.now() + 3_600_000),
            ...(wrote ? { wroteAt: new Date(), lastWroteAt: new Date() } : {}),
          },
        })
      return { userId, workspaceId: workspace.id, taskId, turnNo: 1 }
    }
    const open = () =>
      new PassSettlement({
        db,
        candidates: null,
        browser: { close: vi.fn(async () => {}) },
        logger: quiet,
        now: () => NOW,
      })
    const answered = (): PassEnding => ({
      kind: 'completed',
      turn: 1,
      result: result({ client_message: 'Вот пять вариантов.', files_changed: [] }),
    })
    const failed: PassEnding = { kind: 'failed', turn: 1, errorCode: 'TURN_EXEC_FAILED' }

    it('answers without a word of a site or of files, and charges the pass', async () => {
      const task = await chat()

      expect(await open().settle(ref(task), answered())).toBe('moved')

      expect(await status(task.taskId)).toBe('awaiting_user')
      const [[type, row] = []] = await feed(task.taskId)
      expect(type).toBe('feed.result')
      expect(row).toMatchObject({ site: 'none', filesChanged: 0, next: 'awaiting_user' })
      expect((await holds(task.taskId)).every((hold) => hold.status === 'captured')).toBe(true)
    })

    it('fails and cancels without a word of a site', async () => {
      const failing = await chat()
      const cancelling = await chat()
      const waiting = await chat()
      await db.task.update({ where: { id: waiting.taskId }, data: { status: 'awaiting_user' } })
      await cancelPress(waiting)

      await open().settle(ref(failing), failed)
      await open().settle(ref(cancelling), { kind: 'cancelled', turn: 1 })
      expect(await open().cancelWaiting(waiting.taskId)).toBe('moved')

      expect((await feed(failing.taskId))[0]).toEqual([
        'feed.failure',
        {
          v: 1,
          turn: 1,
          code: 'technical',
          site: 'none',
          credits: 'returned',
          next: 'awaiting_user',
        },
      ])
      for (const task of [cancelling, waiting])
        expect((await feed(task.taskId))[0]).toEqual([
          'feed.cancelled',
          expect.objectContaining({ site: 'none', credits: 'returned' }),
        ])
    })

    // `wrote_at` is set by any click, so only a failure and a cancellation speak of it.
    it('names other sites once something was done in its browser, never in an answer', async () => {
      const failing = await chat({ browser: true, wrote: true })
      const cancelling = await chat({ browser: true, wrote: true })
      const answering = await chat({ browser: true, wrote: true })
      const untouched = await chat({ browser: true })

      await open().settle(ref(failing), failed)
      await open().settle(ref(cancelling), { kind: 'cancelled', turn: 1 })
      await open().settle(ref(answering), answered())
      await open().settle(ref(untouched), failed)

      expect((await feed(failing.taskId))[0]![1]).toMatchObject({ site: 'elsewhere' })
      expect((await feed(cancelling.taskId))[0]![1]).toMatchObject({ site: 'elsewhere' })
      expect((await feed(answering.taskId))[0]![1]).toMatchObject({ site: 'none' })
      expect((await feed(untouched.taskId))[0]![1]).toMatchObject({ site: 'none' })
    })
  })
})
