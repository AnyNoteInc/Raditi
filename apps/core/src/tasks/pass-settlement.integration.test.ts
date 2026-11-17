import { randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  createPrismaClient,
  insertFeedEvent,
  markBrowserSessionWrote,
  openBrowserSession,
  recordBrowserControl,
  recordBrowserHelp,
  upsertBrowserCheckpoint,
  type PrismaClient,
} from '@repo/db'
import type { BrowserVerifiedObject, TurnResult } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import {
  CHARGE_LATER_EVENT,
  ORPHANED_PASS_EVENT,
  PassSettlement,
  type PassEnding,
} from './pass-settlement.ts'
import { QueueDrain } from './queue-drain.ts'
import { ChatNotify } from './chat-notify.ts'
import { NotificationDelivery } from './notification-delivery.ts'
import { ScheduleNotify } from '../schedules/schedule-notify.ts'

// The end of a pass of a chat on PostgreSQL with the credits of @repo/billing: the move, its feed
// rows and the money in one transaction (no chat has a site, docs/plan/83-remove-projects.md). Only on a disposable database
// (RADITI_GATEWAY_DB_TESTS=1), as the other suites that write the reserves of whole workspaces.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

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

describe.skipIf(!enabled)('pass settlement with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /** A chat in its first turn, with the gift of its client set aside for it. */
  async function dialog(
    status: 'running' | 'preparing' = 'running',
    { browser = false }: { browser?: boolean } = {},
  ) {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status,
      turnNo: status === 'running' ? 1 : 0,
      needsBrowser: browser,
    })
    if (status === 'running')
      await db.taskTurn.create({
        data: {
          taskId,
          turnNo: 1,
          status: 'completed',
          driverId: sampleDriverId,
          image,
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

  const settlement = () => new PassSettlement({ db, logger: quiet, now: () => NOW })
  const ref = (task: { taskId: string; turnNo: number }) => ({
    taskId: task.taskId,
    attempt: 1,
    turnNo: task.turnNo,
  })
  const completed = (patch: Partial<TurnResult> = {}): PassEnding => ({
    kind: 'completed',
    turn: 1,
    result: result(patch),
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
  it('keeps the chat of a pass open and charges the pass', async () => {
    // The owner, 26.10.2026: «после того как в работе произошла какая-то работа, не закрывай чат».
    const task = await dialog()

    expect(await settlement().settle(ref(task), completed({ change_type: 'none' }))).toBe('moved')

    expect(await status(task.taskId)).toBe('awaiting_user')
    expect(await feed(task.taskId)).toEqual([
      [
        'feed.result',
        {
          v: 1,
          turn: 1,
          message: 'Телефон в шапке заменён.',
          site: 'none',
          next: 'awaiting_user',
          filesChanged: 0,
          changeType: 'none',
          needsApproval: false,
          risk: 'low',
        },
      ],
    ])
    // The pass is charged when it ends (owner's answer of 26.10.2026: «любой успешный запрос от
    // LLM должен тарифицироваться»), by its work rounded up and with no minimum (КР5–КР8): this
    // one recorded no model call, so it costs nothing and its chain is given back; the next
    // words open a new chain.
    expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
    expect(await charged(task.taskId)).toBe(0)
    // Ended once: the second writer finds the task elsewhere.
    expect(await settlement().settle(ref(task), completed())).toBe('skipped')
  })

  it('writes the head of a turn with a repository with the move, before the queue goes on', async () => {
    // Ревью C1: the next pass the drain starts reads the head from the turns that stand; a head
    // written only with the card after the move let it move the chat's ref back.
    const task = await dialog()
    const baseSha = 'a'.repeat(40)
    const headSha = 'b'.repeat(40)

    expect(
      await settlement().settle(ref(task), {
        ...completed({ change_type: 'none' }),
        repoHead: { baseSha, headSha },
      } as PassEnding),
    ).toBe('moved')

    expect(
      await db.taskTurn.findFirstOrThrow({
        where: { taskId: task.taskId, turnNo: 1 },
        select: { baseSha: true, headSha: true },
      }),
    ).toEqual({ baseSha, headSha })
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
    // Settled: no recorded work, so nothing is charged and the chain is given back (КР5–КР8).
    expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
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
          site: 'none',
          credits: 'returned',
          next: 'awaiting_user',
        },
      ],
    ])
    expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
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
          site: 'none',
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

  it('asks «Продолжить?» before a turn, the chat open for the answer', async () => {
    const task = await dialog('preparing')
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

    expect(await status(task.taskId)).toBe('awaiting_user')
    expect(await feed(task.taskId)).toEqual([['feed.question', question]])
  })

  it('writes nothing while a turn of the task is still assigned', async () => {
    const task = await dialog()
    await db.turnAssignment.create({
      data: {
        taskId: task.taskId,
        siteId: task.taskId,
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

  it('cancels a pass whose «Отменить» was written while its ending was being prepared', async () => {
    const task = await dialog()
    // The chat is named outside the transaction: web writes the press meanwhile.
    const ends = settlement()
    const name = vi.spyOn(db, '$executeRaw').mockImplementationOnce((async () => {
      await cancelPress(task)
      return 0
    }) as never)

    expect(await ends.settle(ref(task), completed({ chat_title: 'Смета' }))).toBe('moved')
    name.mockRestore()

    expect(await status(task.taskId)).toBe('cancelled')
    expect((await feed(task.taskId)).map(([type]) => type)).toEqual(['feed.cancelled'])
    expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
  })

  it('closes a waiting dialog whose «Отменить» reached core after its pass had ended', async () => {
    const task = await dialog()
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
          site: 'none',
          credits: 'returned',
        },
      ],
    ])
    // Without a press after the last words there is nothing to close.
    const other = await dialog()
    await db.task.update({ where: { id: other.taskId }, data: { status: 'awaiting_user' } })
    expect(await settlement().cancelWaiting(other.taskId)).toBe('skipped')
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
          site: 'none',
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
          site: 'none',
          credits: 'returned',
          next: 'awaiting_user',
        },
      ])
    })
  })

  // The owner's decision of 10.11.2026: the limits of the model provider are out — tell the client
  // to ask the administrator, instead of «технический сбой» that invites a press into the wall.
  describe('a turn whose key the gateway refused for the limits of the subscription', () => {
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z')

    /** A dialog whose turn 1 called the model once and was then refused with `refusal`. */
    async function refusedWith(refusal: string, turnNo = 1) {
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
        data: { turnNo, lastRefusal: refusal, lastRefusalAt: NOW },
      })
      return task
    }
    const execFailed = (turn: number): PassEnding => ({
      kind: 'failed',
      turn,
      errorCode: 'TURN_EXEC_FAILED',
      journalReason: 'run_failed',
    })
    const code = async (taskId: string) =>
      (await feed(taskId)).map(([type, payload]) => [type, (payload as { code?: string }).code])

    it('tells the client the limits are out, keeps the dialog open and gives the reserve back', async () => {
      const task = await refusedWith('subscription_limit')

      expect(await settlement().settle(ref(task), execFailed(1))).toBe('moved')

      expect(await status(task.taskId)).toBe('awaiting_user')
      expect(await feed(task.taskId)).toEqual([
        [
          'feed.failure',
          {
            v: 1,
            turn: 1,
            code: 'agent_limits',
            site: 'none',
            credits: 'returned',
            next: 'awaiting_user',
          },
        ],
      ])
      expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
    })

    it('keeps a failure that names its own cause: the limits did not end this turn', async () => {
      const task = await refusedWith('subscription_limit')

      await settlement().settle(ref(task), {
        kind: 'failed',
        turn: 1,
        errorCode: 'PUBLICATION_FORBIDDEN',
        journalReason: 'run_failed',
      })

      expect(await code(task.taskId)).toEqual([['feed.failure', 'forbidden_change']])
    })

    it('does not take another refusal of the gateway for the limits', async () => {
      const task = await refusedWith('transient')

      await settlement().settle(ref(task), execFailed(1))

      expect(await code(task.taskId)).toEqual([['feed.failure', 'technical']])
    })

    it('does not take the refusal of the key of another turn for the limits', async () => {
      // The key of turn 3 was refused; the pass that failed is the one of turn 1.
      const task = await refusedWith('subscription_limit', 3)

      await settlement().settle(ref(task), execFailed(1))

      expect(await code(task.taskId)).toEqual([['feed.failure', 'technical']])
    })

    // Plan 71 (scenario 1): a window of the workspace stopped the key — the work is charged, the
    // row names the window and its reset, and the dialog waits for the client after the reset.
    it('names the window of the workspace and its reset, and charges the work done', async () => {
      const task = await refusedWith('workspace_limit')
      const workspaceId = (await db.task.findUniqueOrThrow({ where: { id: task.taskId } }))
        .workspaceId
      const startedAt = new Date(NOW.getTime() - 3_600_000)
      await db.workspaceUsageWindow.create({
        data: {
          workspaceId,
          kind: '5h',
          startedAt,
          endsAt: new Date(startedAt.getTime() + 5 * 3_600_000),
        },
      })

      expect(await settlement().settle(ref(task), execFailed(1))).toBe('moved')

      expect(await status(task.taskId)).toBe('awaiting_user')
      expect(await feed(task.taskId)).toEqual([
        [
          'feed.failure',
          {
            v: 1,
            turn: 1,
            code: 'usage_limit',
            site: 'none',
            credits: null,
            next: 'awaiting_user',
            window: { kind: '5h', resetsAt: '2026-10-17T14:00:00.000Z' },
          },
        ],
      ])
      // The pass was charged, not given back as a failure is.
      expect((await holds(task.taskId)).some((hold) => hold.status === 'captured')).toBe(true)
    })

    it('ends with the same words a pass the pool refused before its turn, with no turn to ask about', async () => {
      const task = await dialog()

      await settlement().settle(ref(task), {
        kind: 'failed',
        turn: null,
        errorCode: 'SUBSCRIPTION_WAIT',
        detailReason: 'agent_limits',
      })

      expect(await status(task.taskId)).toBe('awaiting_user')
      expect(await code(task.taskId)).toEqual([['feed.failure', 'agent_limits']])
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
            site: 'none',
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
      // Settled without recorded work: nothing charged, the chain given back (КР5–КР8).
      expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
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
      // Settled without recorded work: nothing charged, the chain given back (КР5–КР8).
      expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
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
          site: 'none',
          message: 'Новость опубликована.',
          objects: [{ kind: 'post', title: null, status: 'unconfirmed', editUrl }],
        }),
      ])
      // Settled without recorded work: nothing charged, the chain given back (КР5–КР8).
      expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
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
            site: 'none',
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
            site: 'elsewhere',
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
      expect((await feed(running.taskId))[0]![1]).toMatchObject({ site: 'none' })
      expect((await feed(waiting.taskId))[0]![1]).toMatchObject({ site: 'elsewhere' })
      expect(await db.browserCheckpoint.count({ where: { taskId: running.taskId } })).toBe(1)
    })

    it('names the chat with the title of its first pass, never over a name the client chose', async () => {
      // The owner's request of 15.11.2026: the model names the chat, paid with the pass.
      const named = await dialog()
      const renamed = await dialog()
      await db.task.update({
        where: { id: renamed.taskId },
        data: { title: 'Моё название', titleSource: 'client' },
      })
      for (const task of [named, renamed])
        await settlement().settle(ref(task), {
          kind: 'completed',
          turn: 1,
          result: result({ chat_title: '«Телефон в шапке сайта».' }),
        })

      const titles = await db.task.findMany({
        where: { id: { in: [named.taskId, renamed.taskId] } },
        select: { id: true, title: true, titleSource: true },
      })
      expect(titles.find((task) => task.id === named.taskId)).toMatchObject({
        title: 'Телефон в шапке сайта',
        titleSource: 'agent',
      })
      expect(titles.find((task) => task.id === renamed.taskId)).toMatchObject({
        title: 'Моё название',
        titleSource: 'client',
      })
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
      // Settled without recorded work: nothing charged, the chain given back (КР5–КР8).
      expect((await holds(task.taskId)).every((hold) => hold.status === 'released')).toBe(true)
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

    it('leaves a chat held for recovery open, with its credits back', async () => {
      const task = await chat()

      await open().settle(ref(task), { kind: 'failed', turn: 1, errorCode: 'SITE_HELD' })

      expect(await status(task.taskId)).toBe('awaiting_user')
      expect((await feed(task.taskId))[0]).toEqual([
        'feed.failure',
        {
          v: 1,
          turn: 1,
          code: 'site_held',
          site: 'none',
          credits: 'returned',
          next: 'awaiting_user',
        },
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

  describe('the queue of the chat (docs/plan/75-chat-input-output.md, ВВ1–ВВ4)', () => {
    const queue = (task: { taskId: string; userId: string }, text: string) =>
      db.taskQueuedMessage.create({
        data: { taskId: task.taskId, authorId: task.userId, requestId: randomUUID(), text },
      })
    const drains = (taskId: string) =>
      db.outboxEvent.findMany({ where: { dedupeKey: { startsWith: `queue.drain:${taskId}` } } })
    const requests = async (taskId: string) =>
      (
        await db.taskEvent.findMany({
          where: { taskId, type: 'feed.request' },
          orderBy: { id: 'asc' },
        })
      ).map((row) => row.payload as { kind: string; text?: string })
    afterEach(async () => {
      await db.outboxEvent.deleteMany({
        where: {
          OR: [
            { dedupeKey: { startsWith: 'queue.drain:' } },
            { dedupeKey: { startsWith: 'turn.run:' } },
          ],
        },
      })
    })

    it('goes after a pass that completed: one row per words, a new reserve, the next pass queued', async () => {
      // The next reserve is placed under the rate of the credit, as `task.message` places it.
      await fixtures.creditRate({ effectiveFrom: new Date('2026-01-01T00:00:00.000Z') })
      const task = await dialog()
      await queue(task, 'И поменяйте адрес')
      await queue(task, 'И часы работы')
      expect(await settlement().settle(ref(task), completed({ change_type: 'none' }))).toBe('moved')
      expect(await status(task.taskId)).toBe('awaiting_user')
      expect(await drains(task.taskId)).toHaveLength(1)

      const drain = new QueueDrain({ db, logger: { log: vi.fn(), warn: vi.fn() }, now: () => NOW })
      expect(await drain.run({ taskId: task.taskId, attempt: 1, turnNo: 1 })).toBe('moved')
      const row = await db.task.findUniqueOrThrow({ where: { id: task.taskId } })
      expect(row.status).toBe('queued')
      expect(row.attempt).toBe(2)
      expect((await requests(task.taskId)).slice(-2)).toMatchObject([
        { kind: 'queued', text: 'И поменяйте адрес' },
        { kind: 'queued', text: 'И часы работы' },
      ])
      expect(await db.taskQueuedMessage.count({ where: { taskId: task.taskId } })).toBe(0)
      expect((await holds(task.taskId)).map((hold) => hold.status)).toContain('active')
      // A second run finds nothing to take.
      expect(await drain.run({ taskId: task.taskId, attempt: 1, turnNo: 1 })).toBe('skipped')
    })

    it('waits for the client after a failure: a failure must not go round in a circle (ВВ3)', async () => {
      const task = await dialog()
      await queue(task, 'Попробуйте ещё раз')
      expect(await settlement().settle(ref(task), { kind: 'failed', turn: 1 })).toBe('moved')
      expect(await drains(task.taskId)).toHaveLength(0)
      const drain = new QueueDrain({ db, logger: { log: vi.fn(), warn: vi.fn() }, now: () => NOW })
      expect(await drain.run({ taskId: task.taskId, attempt: 1, turnNo: 1 })).toBe('skipped')
      expect(await db.taskQueuedMessage.count({ where: { taskId: task.taskId } })).toBe(1)
    })

    it('keeps the dialog open when «Отправить сейчас» stopped the pass, and the queue goes next (ВВ4)', async () => {
      await fixtures.creditRate({ effectiveFrom: new Date('2026-01-01T00:00:00.000Z') })
      const task = await dialog()
      await queue(task, 'Стоп, лучше синим цветом')
      await insertFeedEvent(db, {
        taskId: task.taskId,
        row: {
          type: 'feed.request',
          payload: { v: 1, kind: 'interrupt', authorId: task.userId, requestId: randomUUID() },
        },
      })
      expect(await settlement().settle(ref(task), { kind: 'cancelled', turn: 1 })).toBe('moved')
      expect(await status(task.taskId)).toBe('awaiting_user')
      // No failure and no «отменено» for the client: the press is the row.
      expect((await feed(task.taskId)).map(([type]) => type)).not.toContain('feed.cancelled')
      expect(await drains(task.taskId)).toHaveLength(1)
      const drain = new QueueDrain({ db, logger: { log: vi.fn(), warn: vi.fn() }, now: () => NOW })
      expect(await drain.run({ taskId: task.taskId, attempt: 1, turnNo: 1 })).toBe('moved')
      expect(await status(task.taskId)).toBe('queued')
    })

    it('still lets «Остановить» end the chat, the queue with it', async () => {
      const task = await dialog()
      await queue(task, 'Ещё одно')
      await cancelPress(task)
      expect(await settlement().settle(ref(task), { kind: 'cancelled', turn: 1 })).toBe('moved')
      expect(await status(task.taskId)).toBe('cancelled')
      expect(await drains(task.taskId)).toHaveLength(0)
    })
  })

  describe('the notifications of a chat that waits (docs/plan/75-chat-input-output.md, ВВ6–ВВ9)', () => {
    const notices = (taskId: string) =>
      db.outboxEvent.findMany({ where: { dedupeKey: { startsWith: `chat.notify:${taskId}` } } })
    const letters = (id: string) =>
      db.outboxEvent.findMany({
        where: {
          dedupeKey: { startsWith: `chat.waiting:` },
          payload: { path: ['url'], string_contains: id },
        },
      })
    afterEach(async () => {
      await db.outboxEvent.deleteMany({
        where: {
          OR: [
            { dedupeKey: { startsWith: 'chat.notify:' } },
            { dedupeKey: { startsWith: 'chat.waiting:' } },
          ],
        },
      })
    })
    const pushes: { endpoint: string; payload: string }[] = []
    const sender = (answer: 'sent' | 'gone' = 'sent') => ({
      publicKey: 'K'.repeat(87),
      send: vi.fn(async (target: { endpoint: string }, payload: string) => {
        pushes.push({ endpoint: target.endpoint, payload })
        return answer
      }),
    })
    const notify = (push: ReturnType<typeof sender> | null, now = NOW) => {
      const delivery = new NotificationDelivery({
        db,
        appUrl: 'https://raditi.example',
        push,
        logger: { log: vi.fn(), warn: vi.fn() },
        now: () => now,
      })
      return new ChatNotify({
        db,
        delivery,
        schedules: new ScheduleNotify({
          db,
          delivery,
          logger: { log: vi.fn(), warn: vi.fn() },
          now: () => now,
        }),
        logger: { log: vi.fn(), warn: vi.fn() },
        now: () => now,
      })
    }

    it('is due 45 seconds after the ending, then tells the author by a letter and a push with no words', async () => {
      const task = await dialog()
      expect(await settlement().settle(ref(task), completed({ change_type: 'none' }))).toBe('moved')
      const [due] = await notices(task.taskId)
      expect(due?.availableAt.getTime()).toBe(NOW.getTime() + 45_000)
      expect(due?.payload).toMatchObject({ kind: 'answered', attempt: 1, turnNo: 1 })

      await db.task.update({ where: { id: task.taskId }, data: { createdById: task.userId } })
      await db.user.update({ where: { id: task.userId }, data: { emailVerified: true } })
      await db.notificationSetting.create({ data: { userId: task.userId, push: true } })
      await db.pushSubscription.create({
        data: {
          userId: task.userId,
          endpoint: `https://fcm.googleapis.com/fcm/send/${task.taskId}`,
          p256dh: 'p'.repeat(87),
          auth: 'a'.repeat(22),
        },
      })
      const push = sender()
      const job = { taskId: task.taskId, kind: 'answered' as const, attempt: 1, turnNo: 1 }
      expect(await notify(push).run(job)).toBe('sent')
      const sent = pushes.find((one) => one.endpoint.endsWith(task.taskId))
      // The push names the notification and nothing of the chat (rule 1; docs/plan/82, Зп40).
      expect(JSON.parse(sent!.payload)).toEqual({
        id: expect.any(String),
        path: `/chats/${task.taskId}`,
        kind: 'answered',
        scheduled: false,
        tag: `chat:${task.taskId}`,
        at: NOW.getTime(),
      })
      expect(await letters(task.taskId)).toHaveLength(1)
      // The same job again — a repeat of BullMQ: the row of its pass is there, nothing goes twice.
      const pushed = pushes.length
      expect(await notify(push, new Date(NOW.getTime() + 60_000)).run(job)).toBe('repeated')
      expect(pushes).toHaveLength(pushed)
      expect(await db.chatNotification.count({ where: { taskId: task.taskId } })).toBe(1)
      // A second ending in the same half hour: the push again, no second letter.
      await db.task.update({ where: { id: task.taskId }, data: { turnNo: 2 } })
      expect(await notify(push, new Date(NOW.getTime() + 60_000)).run({ ...job, turnNo: 2 })).toBe(
        'sent',
      )
      expect(pushes).toHaveLength(pushed + 1)
      expect(await letters(task.taskId)).toHaveLength(1)
    })

    it('says nothing to a client who looks at the chat, nor of a chat that went on', async () => {
      const task = await dialog()
      await settlement().settle(ref(task), completed({ change_type: 'none' }))
      await db.task.update({ where: { id: task.taskId }, data: { createdById: task.userId } })
      await db.taskPresence.create({
        data: {
          userId: task.userId,
          taskId: task.taskId,
          seenAt: new Date(NOW.getTime() - 10_000),
        },
      })
      const job = { taskId: task.taskId, kind: 'answered' as const, attempt: 1, turnNo: 1 }
      expect(await notify(sender()).run(job)).toBe('seen')
      expect(await notify(sender()).run({ ...job, attempt: 2 })).toBe('moved_on')
      expect(await db.chatNotification.count({ where: { taskId: task.taskId } })).toBe(0)
    })

    it('never sends to an endpoint that is not a push service, and forgets it (ВВ8)', async () => {
      const task = await dialog()
      await settlement().settle(ref(task), completed({ change_type: 'none' }))
      await db.task.update({ where: { id: task.taskId }, data: { createdById: task.userId } })
      await db.notificationSetting.create({
        data: { userId: task.userId, push: true, email: false },
      })
      await db.pushSubscription.create({
        data: {
          userId: task.userId,
          endpoint: `https://10.10.0.10:8200/v1/${task.taskId}`,
          p256dh: 'p'.repeat(87),
          auth: 'a'.repeat(22),
        },
      })
      const push = sender()
      const job = { taskId: task.taskId, kind: 'answered' as const, attempt: 1, turnNo: 1 }
      expect(await notify(push).run(job)).toBe('skipped')
      expect(push.send).not.toHaveBeenCalled()
      expect(await db.pushSubscription.count({ where: { userId: task.userId } })).toBe(0)
    })

    it('tells a client who linked Telegram there, unless the chat is bound to Telegram (docs/plan/80, Т8)', async () => {
      const telegram = () =>
        db.outboxEvent.findMany({
          where: { topic: 'telegram' },
          select: { type: true, payload: true },
        })
      const task = await dialog()
      await db.task.update({ where: { id: task.taskId }, data: { createdById: task.userId } })
      await db.channelIdentity.create({
        data: { userId: task.userId, channel: 'telegram', externalId: '4242' },
      })
      await settlement().settle(ref(task), completed({ change_type: 'none' }))
      // A chat of the cabinet: no delivery of its rows, only the notification.
      expect((await telegram()).filter((row) => row.type === 'telegram.deliver')).toEqual([])
      const job = { taskId: task.taskId, kind: 'answered' as const, attempt: 1, turnNo: 1 }
      expect(await notify(null).run(job)).toBe('sent')
      expect((await telegram()).filter((row) => row.type === 'telegram.send')).toEqual([
        {
          type: 'telegram.send',
          payload: expect.objectContaining({
            chatId: '4242',
            text: expect.stringMatching(/^Агент ответил — чат «/u),
          }),
        },
      ])

      // The same chat bound to Telegram: its rows go there, the bot says nothing more of it.
      await db.outboxEvent.deleteMany({ where: { topic: 'telegram' } })
      const { workspaceId } = await db.task.findUniqueOrThrow({
        where: { id: task.taskId },
        select: { workspaceId: true },
      })
      const session = await db.chatSession.create({
        data: { workspaceId, channel: 'telegram', externalChatId: '4242' },
      })
      await db.task.update({ where: { id: task.taskId }, data: { chatSessionId: session.id } })
      try {
        const { enqueueTelegramDeliver } = await import('@repo/db')
        expect(
          await db.$transaction((tx) => enqueueTelegramDeliver(tx, { ...job, turnNo: 2 })),
        ).toBe(true)
        expect(await notify(null, new Date(NOW.getTime() + 60_000)).run(job)).not.toBe('sent')
        expect((await telegram()).map((row) => row.type)).toEqual(['telegram.deliver'])
      } finally {
        await db.task.update({ where: { id: task.taskId }, data: { chatSessionId: null } })
        await db.chatSession.delete({ where: { id: session.id } })
        await db.outboxEvent.deleteMany({ where: { topic: 'telegram' } })
      }
    })

    it('forgets a browser that dropped its subscription', async () => {
      const task = await dialog()
      await settlement().settle(ref(task), completed({ change_type: 'none' }))
      await db.task.update({ where: { id: task.taskId }, data: { createdById: task.userId } })
      await db.notificationSetting.create({
        data: { userId: task.userId, push: true, email: false },
      })
      await db.pushSubscription.create({
        data: {
          userId: task.userId,
          endpoint: `https://updates.push.services.mozilla.com/wpush/v2/${task.taskId}`,
          p256dh: 'p'.repeat(87),
          auth: 'a'.repeat(22),
        },
      })
      const job = { taskId: task.taskId, kind: 'answered' as const, attempt: 1, turnNo: 1 }
      expect(await notify(sender('gone')).run(job)).toBe('skipped')
      expect(await db.pushSubscription.count({ where: { userId: task.userId } })).toBe(0)
    })

    describe('of a run of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп22, Зп38, Зп39)', () => {
      const schedules: string[] = []
      afterEach(async () => {
        // Runs hold their chats (Restrict): they go with their tasks before the chats do.
        await db.scheduledTask.deleteMany({ where: { id: { in: schedules.splice(0) } } })
        await db.outboxEvent.deleteMany({ where: { topic: 'telegram' } })
      })

      /** The chat of `task` made the chat of a run of a scheduled task of its author. */
      async function runOf(
        task: { userId: string; workspaceId: string; taskId: string },
        notify = true,
      ) {
        await db.task.update({ where: { id: task.taskId }, data: { createdById: task.userId } })
        const schedule = await db.scheduledTask.create({
          data: {
            workspaceId: task.workspaceId,
            createdById: task.userId,
            name: 'Проверка сайта',
            instructions: 'Поменяйте телефон в шапке',
            effort: 'high',
            triggers: [{ kind: 'daily', time: '09:00' }],
            timezone: 'Europe/Moscow',
            nextRunAt: new Date(NOW.getTime() + 86_400_000),
            notify,
            createdVia: 'manual',
          },
        })
        schedules.push(schedule.id)
        const run = await db.scheduledRun.create({
          data: {
            scheduledTaskId: schedule.id,
            dueAt: NOW,
            trigger: 'schedule',
            status: 'started',
            taskId: task.taskId,
            startedAt: NOW,
            name: schedule.name,
            instructions: schedule.instructions,
            effort: schedule.effort,
          },
        })
        await db.channelIdentity.create({
          data: { userId: task.userId, channel: 'telegram', externalId: telegramIdOf(task) },
        })
        await db.user.update({ where: { id: task.userId }, data: { emailVerified: true } })
        await db.pushSubscription.create({
          data: {
            userId: task.userId,
            endpoint: `https://fcm.googleapis.com/fcm/send/run-${task.taskId}`,
            p256dh: 'p'.repeat(87),
            auth: 'a'.repeat(22),
          },
        })
        return { scheduleId: schedule.id, runId: run.id }
      }
      /** A chat id of Telegram is a number: one of this chat's own. */
      const telegramIdOf = (task: { taskId: string }) =>
        String(BigInt(`0x${task.taskId.replaceAll('-', '').slice(-12)}`))
      const told = (task: { taskId: string }) =>
        db.outboxEvent.findMany({
          where: { topic: 'telegram', payload: { path: ['chatId'], equals: telegramIdOf(task) } },
          select: { payload: true },
        })
      const pushOf = (task: { taskId: string }) =>
        pushes
          .filter((one) => one.endpoint.endsWith(`run-${task.taskId}`))
          .map((one) => JSON.parse(one.payload))

      it('tells a pass without its client in the words of a scheduled task, with no letter of it', async () => {
        const task = await dialog()
        const run = await runOf(task)
        await settlement().settle(ref(task), completed({ change_type: 'none' }))
        const job = { taskId: task.taskId, kind: 'answered' as const, attempt: 1, turnNo: 1 }
        expect(await notify(sender()).run(job)).toBe('sent')
        expect(pushOf(task)).toEqual([
          {
            id: expect.any(String),
            path: `/chats/${task.taskId}`,
            kind: 'answered',
            scheduled: true,
            tag: `schedule:${run.scheduleId}`,
            at: expect.any(Number),
          },
        ])
        expect(await told(task)).toEqual([
          {
            payload: expect.objectContaining({
              text: 'Запланированная задача выполнена — «Проверка сайта».',
            }),
          },
        ])
        // «Выполнена» goes by push and the bot; a letter only of a question or a failure (Зп39).
        expect(await letters(task.taskId)).toHaveLength(0)
        const notice = await db.chatNotification.findFirstOrThrow({
          where: { taskId: task.taskId },
        })
        expect(notice).toMatchObject({
          scheduledTaskId: run.scheduleId,
          scheduledRunId: run.runId,
          attempt: 1,
          turnNo: 1,
          kind: 'answered',
        })
      })

      it('tells a run that prepared changes in the branch to look and send them (plan 84)', async () => {
        const task = await dialog()
        const run = await runOf(task)
        await settlement().settle(ref(task), completed({ change_type: 'code' }))
        const turn = await db.taskTurn.findFirstOrThrow({
          where: { taskId: task.taskId, turnNo: 1 },
          select: { id: true },
        })
        // The card «Изменения в ветке» RepoChanges writes right after the pass settles.
        await insertFeedEvent(db, {
          taskId: task.taskId,
          turnId: turn.id,
          row: {
            type: 'feed.repo_changes',
            payload: {
              v: 1,
              branch: 'raditi/svodka-12345678',
              baseSha: 'a'.repeat(40),
              headSha: 'b'.repeat(40),
              diffSha256: 'c'.repeat(64),
              files: 1,
              additions: 2,
              deletions: 0,
              list: [{ path: 'README.md', additions: 2, deletions: 0 }],
              ciTouched: false,
              pushed: false,
              mergeRequest: null,
            },
          },
        })
        const job = { taskId: task.taskId, kind: 'answered' as const, attempt: 1, turnNo: 1 }
        expect(await notify(sender()).run(job)).toBe('sent')
        // Ids and the kind only (rule 1, Зп40).
        expect(pushOf(task)).toEqual([
          {
            id: expect.any(String),
            path: `/chats/${task.taskId}`,
            kind: 'ready',
            scheduled: true,
            tag: `schedule:${run.scheduleId}`,
            at: expect.any(Number),
          },
        ])
        expect(await told(task)).toEqual([
          {
            payload: expect.objectContaining({
              text: 'Задача «Проверка сайта» подготовила изменения — посмотрите и отправьте в ветку.',
            }),
          },
        ])
        expect(await letters(task.taskId)).toHaveLength(0)
        expect(
          await db.chatNotification.findFirstOrThrow({ where: { taskId: task.taskId } }),
        ).toMatchObject({ kind: 'ready', scheduledRunId: run.runId })
      })

      it('says nothing of prepared changes to a client who looks, nor with the switch off', async () => {
        const task = await dialog()
        await runOf(task, false)
        await settlement().settle(ref(task), completed({ change_type: 'code' }))
        const turn = await db.taskTurn.findFirstOrThrow({
          where: { taskId: task.taskId, turnNo: 1 },
          select: { id: true },
        })
        await insertFeedEvent(db, {
          taskId: task.taskId,
          turnId: turn.id,
          row: {
            type: 'feed.repo_proposal',
            payload: {
              v: 1,
              reservedId: randomUUID(),
              title: 'Сводка',
              description: '',
              draft: false,
            },
          },
        })
        const job = { taskId: task.taskId, kind: 'answered' as const, attempt: 1, turnNo: 1 }
        expect(await notify(sender()).run(job)).toBe('skipped')
        await db.scheduledTask.updateMany({
          where: { runs: { some: { taskId: task.taskId } } },
          data: { notify: true },
        })
        await db.taskPresence.create({
          data: { userId: task.userId, taskId: task.taskId, seenAt: NOW },
        })
        expect(await notify(sender()).run(job)).toBe('seen')
        expect(await db.chatNotification.count({ where: { taskId: task.taskId } })).toBe(0)
      })

      it('keeps «выполнена» quiet with the switch of the task off, never a question', async () => {
        const task = await dialog()
        await runOf(task, false)
        await settlement().settle(ref(task), completed({ change_type: 'none' }))
        const job = { taskId: task.taskId, kind: 'answered' as const, attempt: 1, turnNo: 1 }
        expect(await notify(sender()).run(job)).toBe('skipped')
        expect(await db.chatNotification.count({ where: { taskId: task.taskId } })).toBe(0)
        expect(await notify(sender()).run({ ...job, kind: 'question' })).toBe('sent')
        expect(await letters(task.taskId)).toHaveLength(1)
        expect((await letters(task.taskId))[0]?.payload).toMatchObject({
          kind: 'question',
          scheduled: true,
        })
      })

      it('pauses the task once when the gate refused its run, and tells only that (Зп22)', async () => {
        const task = await dialog()
        const run = await runOf(task)
        await settlement().settle(ref(task), { kind: 'refused', code: 'not_accepted' })
        const job = { taskId: task.taskId, kind: 'failed' as const, attempt: 1, turnNo: 1 }
        expect(await notify(sender()).run(job)).toBe('sent')
        expect(
          await db.scheduledTask.findUniqueOrThrow({
            where: { id: run.scheduleId },
            select: { enabled: true, nextRunAt: true, pausedReason: true },
          }),
        ).toEqual({ enabled: false, nextRunAt: null, pausedReason: 'not_accepted' })
        const notices = await db.chatNotification.findMany({
          where: { scheduledTaskId: run.scheduleId },
          select: { kind: true, taskId: true, scheduledRunId: true },
        })
        expect(notices).toEqual([{ kind: 'paused', taskId: null, scheduledRunId: run.runId }])
        expect(pushOf(task)).toEqual([
          expect.objectContaining({ kind: 'paused', path: `/scheduled/${run.scheduleId}` }),
        ])
        // A repeat of the job: the task is paused already and its notice was sent.
        expect(await notify(sender()).run(job)).toBe('repeated')
        expect(
          await db.chatNotification.count({ where: { scheduledTaskId: run.scheduleId } }),
        ).toBe(1)
      })

      // A cancel or an interrupt the client wrote while the pass ran is for the passes after it.
      it('tells of a pass by the request it answered, not by the words written since (Зп27)', async () => {
        const task = await dialog()
        await runOf(task)
        const answered = await db.taskEvent.findFirstOrThrow({
          where: { taskId: task.taskId, type: 'feed.request' },
          orderBy: { id: 'desc' },
          select: { id: true },
        })
        await settlement().settle(ref(task), completed({ change_type: 'none' }))
        await insertFeedEvent(db, {
          taskId: task.taskId,
          row: {
            type: 'feed.request',
            payload: {
              v: 1,
              kind: 'answer',
              authorId: task.userId,
              requestId: randomUUID(),
              answersEventId: '1',
              text: 'Остановитесь',
            },
          },
        })
        const job = {
          taskId: task.taskId,
          kind: 'answered' as const,
          attempt: 1,
          turnNo: 1,
          requestEventId: String(answered.id),
        }
        expect(await notify(sender()).run(job)).toBe('sent')
        expect(pushOf(task)).toEqual([expect.objectContaining({ scheduled: true })])
      })

      it('is an ordinary chat from the first words of its client on (Зп27)', async () => {
        const task = await dialog()
        await runOf(task)
        await insertFeedEvent(db, {
          taskId: task.taskId,
          row: {
            type: 'feed.request',
            payload: {
              v: 1,
              kind: 'answer',
              authorId: task.userId,
              requestId: randomUUID(),
              answersEventId: '1',
              text: 'Спасибо, а ещё поменяйте почту',
            },
          },
        })
        await settlement().settle(ref(task), completed({ change_type: 'none' }))
        const job = { taskId: task.taskId, kind: 'answered' as const, attempt: 1, turnNo: 1 }
        expect(await notify(sender()).run(job)).toBe('sent')
        expect(pushOf(task)).toEqual([expect.objectContaining({ scheduled: false })])
        expect(await told(task)).toEqual([
          {
            payload: expect.objectContaining({
              text: expect.stringMatching(/^Агент ответил — чат «/u),
            }),
          },
        ])
      })
    })
  })
})
