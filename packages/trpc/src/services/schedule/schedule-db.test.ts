import { createHmac, randomInt, randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { placeReserve, settleTaskCharge, underPrivateCreditRate } from '@repo/billing/testing'
import {
  createPrismaClient,
  insertFeedEvent,
  type Prisma,
  type PrismaClient,
  type User,
} from '@repo/db'
import {
  legalDocuments,
  signupGiftCredits,
  type KvMetadata,
  type KvWriteOptions,
  type ModelClass,
  type ObjectStorage,
  type SecretStore,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../../router.ts'
import type { ChatContext } from '../chat/context.ts'
import { readChatNotification } from '../notifications.ts'
import { deterministicUuidV7 } from '../deterministic-uuid.ts'
import { scheduledChatId, startScheduledRun } from './runs.ts'

// The scheduled tasks on PostgreSQL (docs/plan/82-scheduled-tasks.md, slice 82.3): the start of a
// run by the steps of §4.3, the procedures of «Расписание», the notices of scheduled tasks and the
// label of a chat of a run. Every test works in workspaces of its own; `afterEach` removes them.

const databaseUrl = process.env.DATABASE_URL

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)
const VAPID = 'B'.repeat(87)
const HOUR = 3_600_000
const SECRET = 'synthetic-repo-confirm-secret-of-the-schedule-test'
const mac = (material: string) => createHmac('sha256', SECRET).update(material).digest('base64url')

/** Vault as `sites-writer` and `workspace-provisioner` see it; `failing` — Transit refuses. */
function memoryVault() {
  const transit = { failing: false }
  const store = {
    async transitEnsureKey() {
      if (transit.failing)
        throw Object.assign(new Error('Vault request returned HTTP 503'), {
          name: 'VaultError',
          status: 503,
        })
    },
    async kvMetadata(): Promise<KvMetadata | null> {
      return null
    },
    async kvWrite(_path: string, _data: Record<string, string>, _options?: KvWriteOptions) {
      return { version: 1 }
    },
  }
  return { secrets: store as unknown as SecretStore, transit }
}

/**
 * The seeded model of a class, switched on and priced, in the caller's transaction alone, and put
 * back after it (as chat-db.test.ts does): `task.create` asks whether a pass of the class could
 * run, and a run takes the class of its «Размышление».
 */
async function underPricedModel<T>(
  tx: Prisma.TransactionClient,
  modelClass: ModelClass,
  work: () => Promise<T>,
) {
  const model = await tx.llmModel.findFirst({
    where: { modelClass, providerModelId: { not: null }, vision: false },
    orderBy: [{ slug: 'asc' }, { provider: { slug: 'asc' } }],
    select: { id: true, enabled: true, provider: { select: { id: true, enabled: true } } },
  })
  if (model === null) throw new Error(`The seeds have no model of the class ${modelClass}`)
  const price = await tx.llmModelPrice.create({
    data: {
      modelId: model.id,
      effectiveFrom: new Date(Date.UTC(2025, 11, 31) + randomInt(24 * 3600 * 1000)),
      inputPer1m: '100',
      outputPer1m: '1000',
      vatRate: '0.2200',
      sourceUrl: 'https://rates.invalid/schedule-verification',
    },
  })
  if (!model.enabled) await tx.llmModel.update({ where: { id: model.id }, data: { enabled: true } })
  if (!model.provider.enabled)
    await tx.llmProvider.update({ where: { id: model.provider.id }, data: { enabled: true } })
  const result = await work()
  await tx.llmModelPrice.delete({ where: { id: price.id } })
  if (!model.enabled)
    await tx.llmModel.update({ where: { id: model.id }, data: { enabled: false } })
  if (!model.provider.enabled)
    await tx.llmProvider.update({ where: { id: model.provider.id }, data: { enabled: false } })
  return result
}

/**
 * The client with every writing transaction of the chat under a private credit rate and price.
 * The classes are switched on `standard` first, then `heavy`, as chat-db.test.ts does: the two
 * files run side by side on one database, and rows of one provider taken in another order would
 * deadlock their transactions.
 */
function underRate(db: PrismaClient): PrismaClient {
  return new Proxy(db, {
    get(target, property) {
      if (property === '$transaction') {
        return (work: unknown, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) =>
          typeof work === 'function' && options?.isolationLevel === 'ReadCommitted'
            ? target.$transaction(
                (tx) =>
                  underPrivateCreditRate(tx, () =>
                    underPricedModel(tx, 'standard', () =>
                      underPricedModel(tx, 'heavy', () =>
                        underPricedModel(tx, 'light', () =>
                          (work as (client: typeof tx) => Promise<unknown>)(tx),
                        ),
                      ),
                    ),
                  ),
                options,
              )
            : target.$transaction(work as never, options as never)
      }
      const value: unknown = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

describe.skipIf(!databaseUrl)('PostgreSQL: scheduled tasks of the cabinet and their runs', () => {
  let db: PrismaClient
  const userIds: string[] = []
  const vault = memoryVault()
  const storage = { get: async () => null } as unknown as ObjectStorage
  const chat: ChatContext = {
    appEnv: 'test',
    browser: null,
    webPushPublicKey: VAPID,
    storage: () => storage,
    secrets: () => vault.secrets,
  }

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    vault.transit.failing = false
    const users = userIds.splice(0)
    const workspaces = await db.workspace.findMany({
      where: { createdById: { in: users } },
      select: { id: true },
    })
    const owned = { workspaceId: { in: workspaces.map(({ id }) => id) } }
    const tasks = await db.task.findMany({ where: owned, select: { id: true } })
    await db.outboxEvent.deleteMany({
      where: { OR: tasks.map(({ id }) => ({ dedupeKey: { contains: id } })) },
    })
    await db.chatNotification.deleteMany({ where: { userId: { in: users } } })
    await db.pushSubscription.deleteMany({ where: { userId: { in: users } } })
    await db.scheduledTask.deleteMany({ where: owned })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.task.deleteMany({ where: owned })
    await db.projectRepository.deleteMany({ where: owned })
    await db.gitConnection.deleteMany({ where: owned })
    await db.credentialRef.deleteMany({ where: owned })
    await db.project.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function person(options: { consents?: boolean } = {}): Promise<User> {
    const row = await db.user.create({
      data: { name: 'Schedule verification', email: `${randomUUID()}@schedule.example.ru` },
    })
    userIds.push(row.id)
    if (options.consents !== false)
      await db.userConsent.createMany({
        data: requiredConsents.map((consent) => ({
          ...consent,
          userId: row.id,
          source: 'sign_up',
        })),
      })
    return row
  }

  /**
   * A client with their personal workspace and the gift of the registration, where every task of
   * theirs goes (Зп44); `credits: false` — the gift spent by a chat of theirs, nothing left: a task
   * makes the personal workspace with the gift, so a client without credits is one who spent it.
   */
  async function newClient(options: { credits?: boolean } = {}) {
    const user = await person()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId: user.id, appEnv: 'test' }),
    )
    if (options.credits === false) {
      const now = new Date()
      const taskId = deterministicUuidV7('schedule-test', randomUUID(), now)
      await db.task.create({
        data: {
          id: taskId,
          workspaceId: workspace.id,
          createdById: user.id,
          status: 'awaiting_user',
          modelClass: 'light',
          billable: true,
        },
      })
      await placeReserve(db, {
        workspaceId: workspace.id,
        taskId,
        attempt: 1,
        now,
        expiresAt: new Date(now.getTime() + HOUR),
      })
      await db.$transaction(
        (tx) => settleTaskCharge(tx, { taskId, credits: signupGiftCredits, now }),
        { isolationLevel: 'ReadCommitted' },
      )
    }
    return { owner: user, workspaceId: workspace.id }
  }

  function callerOf(user: User, client: PrismaClient = underRate(db)) {
    return createCaller({
      prisma: client,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `schedule-test-${randomUUID()}`,
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      billing: null,
      chat,
      git: {
        appEnv: 'test',
        secrets: { kvWrite: async () => ({ version: 1 }), kvMetadata: async () => null },
        checkHost: async () => {},
        gitlabComConfigured: false,
        confirmMac: mac,
      },
    })
  }

  /** A task of the owner and a run of its schedule, as the tick writes them. */
  async function runOf(
    owner: User,
    options: { dueAt?: Date; trigger?: 'schedule' | 'manual' } = {},
  ) {
    const caller = callerOf(owner)
    const task = await caller.schedule.create({
      name: 'Проверка сайта',
      instructions: 'Откройте главную и скажите, всё ли открывается',
      effort: 'low',
      triggers: [{ kind: 'daily', time: '09:00' }],
      timezone: 'Europe/Moscow',
    })
    const run = await db.scheduledRun.create({
      data: {
        scheduledTaskId: task.id,
        dueAt: options.dueAt ?? new Date(Math.floor(Date.now() / 60_000) * 60_000),
        trigger: options.trigger ?? 'schedule',
        status: 'pending',
        name: task.name,
        instructions: task.instructions,
        effort: task.effort,
      },
    })
    return { task, run }
  }

  const start = (runId: string, now = new Date()) =>
    startScheduledRun(underRate(db), chat, { runId, now })

  describe('the start of a run (§4.3)', () => {
    it('starts its chat from the snapshot, named by the task, in the creator’s workspace (Зп45)', async () => {
      const { owner, workspaceId } = await newClient()
      const { task, run } = await runOf(owner)
      // The task is edited after the run was written: the run starts with what it took.
      await callerOf(owner).schedule.update({ scheduleId: task.id, instructions: 'Другая просьба' })

      const answer = await start(run.id)
      const taskId = scheduledChatId(run)
      expect(answer).toEqual({ outcome: 'started', taskId })
      const chatRow = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(chatRow).toMatchObject({
        workspaceId,
        createdById: owner.id,
        needsBrowser: false,
        title: 'Проверка сайта',
        titleSource: 'client',
        modelClass: 'light',
        status: 'queued',
      })
      const request = await db.taskEvent.findFirstOrThrow({
        where: { taskId, type: 'feed.request' },
      })
      expect((request.payload as { text: string }).text).toBe(
        'Откройте главную и скажите, всё ли открывается',
      )
      expect(await db.scheduledRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: 'started',
        taskId,
      })

      // A repeat of the delivery answers the same and makes nothing more.
      expect(await start(run.id)).toEqual({ outcome: 'started', taskId })
      expect(await db.task.count({ where: { workspaceId } })).toBe(1)
    })

    it('records the chat a delivery made before its outcome was written (б)', async () => {
      const { owner, workspaceId } = await newClient()
      const { run } = await runOf(owner)
      const taskId = scheduledChatId(run)
      await start(run.id)
      // As if the outcome had been lost: the run waits again, its chat is there.
      await db.$executeRaw`UPDATE scheduled_runs SET status = 'pending', task_id = NULL,
        started_at = NULL WHERE id = ${run.id}::uuid`
      expect(await start(run.id)).toEqual({ outcome: 'started', taskId })
      expect(await db.task.count({ where: { workspaceId } })).toBe(1)
    })

    it('skips a run that came late or whose task was paused or deleted (в)', async () => {
      const { owner, workspaceId } = await newClient()
      const old = await runOf(owner, { dueAt: new Date(Date.now() - 7 * HOUR) })
      expect(await start(old.run.id)).toEqual({ outcome: 'skipped', reason: 'missed' })

      const paused = await runOf(owner)
      await callerOf(owner).schedule.setEnabled({ scheduleId: paused.task.id, enabled: false })
      expect(await start(paused.run.id)).toEqual({ outcome: 'skipped', reason: 'paused' })

      const deleted = await runOf(owner)
      await callerOf(owner).schedule.delete({ scheduleId: deleted.task.id })
      expect(await start(deleted.run.id)).toEqual({ outcome: 'skipped', reason: 'paused' })

      expect(await start(randomUUID())).toEqual({ outcome: 'skipped', reason: 'paused' })
      expect(await db.task.count({ where: { workspaceId } })).toBe(0)
    })

    it('skips a run when a later one of its task already waits or started (в)', async () => {
      const { owner } = await newClient()
      const { task, run } = await runOf(owner, { dueAt: new Date(Date.now() - HOUR) })
      await db.scheduledRun.create({
        data: {
          scheduledTaskId: task.id,
          dueAt: new Date(Date.now() - 60_000),
          trigger: 'schedule',
          status: 'pending',
          name: task.name,
          instructions: task.instructions,
          effort: task.effort,
        },
      })
      expect(await start(run.id)).toEqual({ outcome: 'skipped', reason: 'missed' })
    })

    it('refuses while the creator has documents to accept (г)', async () => {
      const { owner } = await newClient()
      const { run } = await runOf(owner)
      await db.userConsent.deleteMany({ where: { userId: owner.id } })
      expect(await start(run.id)).toEqual({ outcome: 'refused', reason: 'consent' })
    })

    it('records the refusal of credits, counted for the pause (д)', async () => {
      const { owner, workspaceId } = await newClient({ credits: false })
      const { task, run } = await runOf(owner)
      const answer = await start(run.id)
      expect(answer.outcome).toBe('refused')
      expect(['needs_tariff', 'no_credits']).toContain(
        answer.outcome === 'refused' ? answer.reason : null,
      )
      expect(await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
        refusalStreak: 1,
        enabled: true,
      })
      // No chat of the run: the one chat is the client's own, which spent the gift.
      expect(await db.task.findUnique({ where: { id: scheduledChatId(run) } })).toBeNull()
      expect(await db.task.count({ where: { workspaceId } })).toBe(1)
    })

    it('leaves the run waiting when Vault fails, so core delivers it again', async () => {
      const { owner } = await newClient()
      const { run } = await runOf(owner)
      vault.transit.failing = true
      await expect(start(run.id)).rejects.toMatchObject({ code: 'WORKSPACE_KEY_UNAVAILABLE' })
      expect(await db.scheduledRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: 'pending',
      })
    })

    it('makes no chat for a run closed while it was being made (Зп20, §4.3)', async () => {
      const { owner } = await newClient()
      const { task, run } = await runOf(owner)
      // The sweep — or core giving its last delivery up — holds the task and closes the run.
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      let locked!: () => void
      const isLocked = new Promise<void>((resolve) => (locked = resolve))
      const sweep = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM scheduled_tasks WHERE id = ${task.id}::uuid FOR UPDATE`
          locked()
          await held
          await tx.scheduledRun.update({
            where: { id: run.id },
            data: { status: 'refused', reason: 'platform' },
          })
        },
        { timeout: 20_000 },
      )
      await isLocked
      const started = start(run.id)
      await new Promise((resolve) => setTimeout(resolve, 500))
      release()
      await sweep
      // The client is told the task did not run, and it does not: no chat, no reserve.
      expect(await started).toEqual({ outcome: 'refused', reason: 'platform' })
      expect(await db.task.findUnique({ where: { id: scheduledChatId(run) } })).toBeNull()
      expect(await db.creditHold.count({ where: { taskId: scheduledChatId(run) } })).toBe(0)
    })

    it('makes the personal workspace of a new user with its gift, and starts the chat there', async () => {
      const owner = await person()
      const { task, run } = await runOf(owner)
      const answer = await start(run.id)
      expect(answer).toEqual({ outcome: 'started', taskId: scheduledChatId(run) })
      const chatRow = await db.task.findUniqueOrThrow({ where: { id: scheduledChatId(run) } })
      const row = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
      expect(chatRow.workspaceId).toBe(row.workspaceId)
    })
  })

  describe('the procedures of «Расписание»', () => {
    it('creates, lists, reads, changes, pauses and deletes a task of its creator', async () => {
      const { owner } = await newClient()
      const caller = callerOf(owner)
      const created = await caller.schedule.create({
        name: 'Курс валют',
        instructions: 'Пришли курс доллара, евро и юаня по ЦБ на сегодня',
        triggers: [{ kind: 'weekdays', time: '08:00' }],
        timezone: 'Asia/Novosibirsk',
        templateSlug: 'currency-rates',
      })
      expect(created).toMatchObject({
        effort: 'high',
        enabled: true,
        notify: true,
        createdVia: 'template',
        templateSlug: 'currency-rates',
        lastRun: null,
        runs: [],
      })
      expect(created.nextRunAt).toBeInstanceOf(Date)

      const { schedules, timezone } = await caller.schedule.list()
      expect(schedules.map((schedule) => schedule.id)).toEqual([created.id])
      expect(timezone).toBe('Europe/Moscow')

      const renamed = await caller.schedule.update({ scheduleId: created.id, name: 'Курс' })
      expect(renamed).toMatchObject({ name: 'Курс', nextRunAt: created.nextRunAt })

      const paused = await caller.schedule.setEnabled({ scheduleId: created.id, enabled: false })
      expect(paused).toMatchObject({ enabled: false, nextRunAt: null, pausedReason: null })

      expect(await caller.schedule.delete({ scheduleId: created.id })).toEqual({ deleted: true })
      expect((await caller.schedule.list()).schedules).toEqual([])
      await expect(caller.schedule.get({ scheduleId: created.id })).rejects.toMatchObject({
        message: 'Задачи уже нет',
      })
    })

    it('refuses in the words of the client what the rules of a task refuse', async () => {
      const { owner } = await newClient()
      const caller = callerOf(owner)
      const base = {
        name: 'Проверка',
        instructions: 'Проверьте сайт',
        triggers: [{ kind: 'daily' as const, time: '09:00' }],
        timezone: 'Europe/Moscow',
      }
      await expect(
        caller.schedule.create({
          ...base,
          instructions: 'пароль: sk-1234567890abcdefghijklmnopqrstuv',
        }),
      ).rejects.toMatchObject({ cause: { code: 'TASK_TEXT_HAS_SECRET' } })
      await expect(
        caller.schedule.create({
          ...base,
          triggers: [
            { kind: 'daily', time: '09:00' },
            { kind: 'daily', time: '09:30' },
          ],
        }),
      ).rejects.toMatchObject({ message: 'Запуски одной задачи — не чаще раза в час' })
      await expect(
        caller.schedule.create({
          ...base,
          triggers: [{ kind: 'once', date: '2020-01-01', time: '09:00' }],
        }),
      ).rejects.toMatchObject({ message: 'Это время уже прошло — выберите другое' })
      // A place of a template left unfilled, in a task of a template or of none (Зп59).
      for (const templateSlug of ['competitors', null])
        await expect(
          caller.schedule.create({
            ...base,
            instructions: 'Посмотри сайты конкурентов: [впишите адреса сайтов].',
            templateSlug,
          }),
        ).rejects.toMatchObject({
          message: 'Замените текст в квадратных скобках своим',
          cause: { code: 'SCHEDULE_TEMPLATE_PLACEHOLDER' },
        })
      const kept = await caller.schedule.create({ ...base, templateSlug: 'site-check' })
      await expect(
        caller.schedule.update({ scheduleId: kept.id, instructions: 'Открой [впишите адрес]' }),
      ).rejects.toMatchObject({ cause: { code: 'SCHEDULE_TEMPLATE_PLACEHOLDER' } })
      // A slug of no template is never stored.
      await expect(
        caller.schedule.create({ ...base, templateSlug: 'leads-digest' }),
      ).rejects.toMatchObject({ cause: { code: 'BAD_REQUEST' } })
      // Another user's task is not there for this one.
      const stranger = callerOf(await person())
      const own = await caller.schedule.create(base)
      await expect(stranger.schedule.get({ scheduleId: own.id })).rejects.toMatchObject({
        cause: { code: 'SCHEDULE_NOT_FOUND' },
      })
      await expect(stranger.schedule.runNow({ scheduleId: own.id })).rejects.toMatchObject({
        cause: { code: 'SCHEDULE_NOT_FOUND' },
      })
    })

    it('runs a task now, opens its chat, and refuses a second run while it goes on', async () => {
      const { owner } = await newClient()
      const caller = callerOf(owner)
      const task = await caller.schedule.create({
        name: 'Вручную',
        instructions: 'Проверьте сайт',
        triggers: [],
        timezone: 'Europe/Moscow',
      })
      const { taskId } = await caller.schedule.runNow({ scheduleId: task.id })
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        title: 'Вручную',
        titleSource: 'client',
      })
      // The same minute is the same run: its chat again.
      expect(await caller.schedule.runNow({ scheduleId: task.id })).toEqual({ taskId })
      const page = await caller.schedule.get({ scheduleId: task.id })
      expect(page.runs).toHaveLength(1)
      expect(page.runs[0]).toMatchObject({
        trigger: 'manual',
        state: { kind: 'running' },
        chat: { id: taskId, title: 'Вручную' },
      })
      // A minute later the chat still works: «Задача уже выполняется».
      await db.$executeRaw`UPDATE scheduled_runs SET due_at = due_at - interval '1 minute'
        WHERE scheduled_task_id = ${task.id}::uuid`
      await expect(caller.schedule.runNow({ scheduleId: task.id })).rejects.toMatchObject({
        message: 'Задача уже выполняется',
      })
    })

    it('tells a refused «Запустить сейчас» in the words of its refusal and leaves no notice', async () => {
      const { owner } = await newClient({ credits: false })
      const caller = callerOf(owner)
      const task = await caller.schedule.create({
        name: 'Без кредитов',
        instructions: 'Проверьте сайт',
        triggers: [],
        timezone: 'Europe/Moscow',
      })
      await expect(caller.schedule.runNow({ scheduleId: task.id })).rejects.toMatchObject({
        cause: { code: expect.stringMatching(/^BILLING_/) },
      })
      const page = await caller.schedule.get({ scheduleId: task.id })
      expect(page.runs[0]?.state.kind).toBe('refused')
      expect(await db.chatNotification.count({ where: { userId: owner.id } })).toBe(0)
    })

    it('takes up a run of «Запустить сейчас» a stopped web left waiting, and never drops another press', async () => {
      const { owner } = await newClient()
      const caller = callerOf(owner)
      const task = await caller.schedule.create({
        name: 'Брошенный запуск',
        instructions: 'Проверьте сайт',
        triggers: [],
        timezone: 'Europe/Moscow',
      })
      // A web stopped between writing the run and starting it, two minutes ago.
      const left = await db.scheduledRun.create({
        data: {
          scheduledTaskId: task.id,
          dueAt: new Date(Math.floor(Date.now() / 60_000) * 60_000 - 2 * 60_000),
          trigger: 'manual',
          status: 'pending',
          name: task.name,
          instructions: task.instructions,
          effort: task.effort,
        },
      })
      // The press that takes it up fails: the run of the earlier press is not this press's to drop.
      vault.transit.failing = true
      await expect(caller.schedule.runNow({ scheduleId: task.id })).rejects.toMatchObject({
        cause: { code: 'WORKSPACE_KEY_UNAVAILABLE' },
      })
      expect(await db.scheduledRun.findUniqueOrThrow({ where: { id: left.id } })).toMatchObject({
        status: 'pending',
      })
      vault.transit.failing = false
      expect(await caller.schedule.runNow({ scheduleId: task.id })).toEqual({
        taskId: scheduledChatId(left),
      })
      expect(await db.scheduledRun.count({ where: { scheduledTaskId: task.id } })).toBe(1)
    })

    it('drops the run of «Запустить сейчас» when Vault fails', async () => {
      const { owner } = await newClient()
      const caller = callerOf(owner)
      const task = await caller.schedule.create({
        name: 'Сбой',
        instructions: 'Проверьте сайт',
        triggers: [],
        timezone: 'Europe/Moscow',
      })
      vault.transit.failing = true
      await expect(caller.schedule.runNow({ scheduleId: task.id })).rejects.toMatchObject({
        cause: { code: 'WORKSPACE_KEY_UNAVAILABLE' },
      })
      expect(await db.scheduledRun.count({ where: { scheduledTaskId: task.id } })).toBe(0)
    })

    it('says what a week of runs costs against the weekly limit, and remembers the zone', async () => {
      const { owner } = await newClient()
      const caller = callerOf(owner)
      const hint = await caller.schedule.costHint({
        triggers: [{ kind: 'daily', time: '09:00' }],
        timezone: 'Europe/Moscow',
      })
      expect(hint).toMatchObject({ averageCredits: 11, runsPerWeek: 7, creditsPerWeek: 77 })
      expect(hint.nextRunAt).toBeInstanceOf(Date)
      expect(
        await caller.schedule.costHint({ triggers: [], timezone: 'Europe/Moscow' }),
      ).toMatchObject({ runsPerWeek: 0, creditsPerWeek: 0, nextRunAt: null, overHalf: false })

      expect(await caller.schedule.rememberTimezone({ timezone: 'Asia/Novosibirsk' })).toEqual({
        timezone: 'Asia/Novosibirsk',
      })
      expect((await caller.schedule.list()).timezone).toBe('Asia/Novosibirsk')
    })
  })

  describe('a chat of a run', () => {
    it('is labelled by its task in the list and in its head, without a link once it is deleted', async () => {
      const { owner } = await newClient()
      const { task, run } = await runOf(owner)
      const { taskId } = (await start(run.id)) as { taskId: string }
      const caller = callerOf(owner)
      const label = { id: task.id, name: 'Проверка сайта', trigger: 'schedule' }
      expect((await caller.task.list({})).items.find((item) => item.id === taskId)).toMatchObject({
        schedule: label,
      })
      expect((await caller.task.get({ taskId })).schedule).toEqual(label)
      await caller.schedule.delete({ scheduleId: task.id })
      expect((await caller.task.get({ taskId })).schedule).toEqual({ ...label, id: null })
      expect(
        (await caller.task.list({})).items.find((item) => item.id === taskId)?.schedule,
      ).toEqual({ ...label, id: null })
    })

    it('tells the run by the state of its chat: an answer, a stop at the limit', async () => {
      const { owner } = await newClient()
      const { task, run } = await runOf(owner)
      const { taskId } = (await start(run.id)) as { taskId: string }
      const caller = callerOf(owner)
      await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_user' } })
      await db.$transaction((tx) =>
        insertFeedEvent(tx, {
          taskId,
          row: {
            type: 'feed.question',
            payload: {
              v: 1,
              kind: 'ceiling',
              turn: 1,
              reason: 'credits',
              spent: 5,
              held: 5,
              left: 0,
            },
          },
        }),
      )
      expect((await caller.schedule.get({ scheduleId: task.id })).runs[0]?.state).toEqual({
        kind: 'stopped',
        cause: 'credits',
      })
      await db.task.update({ where: { id: taskId }, data: { deletedAt: new Date() } })
      expect((await caller.schedule.get({ scheduleId: task.id })).runs[0]).toMatchObject({
        state: { kind: 'chat_deleted' },
        chat: null,
      })
    })
  })

  describe('notices (Зп37–Зп41)', () => {
    it('keeps the key a browser subscribed under, counts the others, and resubscribes it', async () => {
      const owner = await person()
      const caller = callerOf(owner)
      const subscription = (n: number) => ({
        endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
        p256dh: 'B'.repeat(87),
        auth: 'a'.repeat(22),
      })
      await caller.notification.subscribe(subscription(1))
      await caller.notification.subscribe(subscription(2))
      expect(
        await db.pushSubscription.findUniqueOrThrow({
          where: { endpoint: subscription(1).endpoint },
        }),
      ).toMatchObject({ userId: owner.id, vapidKey: VAPID })
      expect(
        await caller.notification.settings({ endpoint: subscription(1).endpoint }),
      ).toMatchObject({ browsers: 2, otherBrowsers: 1 })
      expect(await caller.notification.settings()).toMatchObject({ otherBrowsers: 2 })

      const endpointsOf = async (userId: string) =>
        (
          await db.pushSubscription.findMany({
            where: { userId },
            select: { endpoint: true },
            orderBy: { endpoint: 'asc' },
          })
        ).map(({ endpoint }) => endpoint)

      // The browser replaced its subscription by itself: the row moves to the new one.
      expect(
        await caller.notification.replaceSubscription({
          oldEndpoint: subscription(1).endpoint,
          ...subscription(3),
        }),
      ).toEqual({ replaced: true })
      expect(await endpointsOf(owner.id)).toEqual([
        subscription(2).endpoint,
        subscription(3).endpoint,
      ])
      // Another account signed in on the browser then gets nothing, and the owner's row is left to
      // the push service; an old endpoint nobody has, or none, makes nothing either (Зп37).
      const other = await person()
      await callerOf(other).notification.subscribe(subscription(4))
      expect(
        await caller.notification.replaceSubscription({
          oldEndpoint: subscription(4).endpoint,
          ...subscription(5),
        }),
      ).toEqual({ replaced: false })
      for (const oldEndpoint of ['https://fcm.googleapis.com/fcm/send/nobody', null])
        expect(
          await caller.notification.replaceSubscription({ oldEndpoint, ...subscription(6) }),
        ).toEqual({ replaced: false })
      expect(await endpointsOf(other.id)).toEqual([subscription(4).endpoint])
      expect(await endpointsOf(owner.id)).toEqual([
        subscription(2).endpoint,
        subscription(3).endpoint,
      ])

      // «Включить» in a browser subscribed under another key: the press is the consent — the new
      // subscription is the user's, an old one of this user goes, another's is left to them.
      await caller.notification.resubscribe({
        oldEndpoint: subscription(3).endpoint,
        ...subscription(7),
      })
      await caller.notification.resubscribe({
        oldEndpoint: subscription(4).endpoint,
        ...subscription(8),
      })
      expect(await endpointsOf(owner.id)).toEqual([
        subscription(2).endpoint,
        subscription(7).endpoint,
        subscription(8).endpoint,
      ])
      expect(await endpointsOf(other.id)).toEqual([subscription(4).endpoint])
    })

    it('says a notice of a pass without its client and of the task itself in the words of Зп38', async () => {
      const { owner } = await newClient()
      const { task, run } = await runOf(owner)
      const { taskId } = (await start(run.id)) as { taskId: string }
      const notice = (data: Prisma.ChatNotificationUncheckedCreateInput) =>
        db.chatNotification.create({ data, select: { id: true } })

      const answered = await notice({
        userId: owner.id,
        taskId,
        scheduledTaskId: task.id,
        scheduledRunId: run.id,
        kind: 'answered',
        attempt: 1,
        turnNo: 1,
      })
      expect(await readChatNotification(db, owner.id, answered.id)).toEqual({
        title: 'Запланированная задача выполнена',
        body: 'Проверка сайта',
        url: `/chats/${taskId}`,
      })

      // A run in a project with a repository that prepared changes (plan 84): look and send.
      const ready = await notice({
        userId: owner.id,
        taskId,
        scheduledTaskId: task.id,
        scheduledRunId: run.id,
        kind: 'ready',
        attempt: 1,
        turnNo: 3,
      })
      expect(await readChatNotification(db, owner.id, ready.id)).toEqual({
        title: 'Запланированная задача подготовила изменения',
        body: 'Проверка сайта — посмотрите и отправьте в ветку',
        url: `/chats/${taskId}`,
      })

      // A pass the client watched is told as any chat.
      const attended = await notice({
        userId: owner.id,
        taskId,
        kind: 'question',
        attempt: 1,
        turnNo: 2,
      })
      expect(await readChatNotification(db, owner.id, attended.id)).toEqual({
        title: 'Агент задал вопрос',
        body: 'Проверка сайта',
        url: `/chats/${taskId}`,
      })

      await db.$transaction((tx) =>
        insertFeedEvent(tx, {
          taskId,
          row: {
            type: 'feed.question',
            payload: {
              v: 1,
              kind: 'ceiling',
              turn: 1,
              reason: 'credits',
              spent: 5,
              held: 5,
              left: 0,
            },
          },
        }),
      )
      const limit = await notice({
        userId: owner.id,
        taskId,
        scheduledTaskId: task.id,
        scheduledRunId: run.id,
        kind: 'limit',
        attempt: 1,
        turnNo: 1,
      })
      expect((await readChatNotification(db, owner.id, limit.id)).title).toBe(
        'Запланированная задача остановилась: закончились кредиты',
      )

      // The task itself: it opens the page of the task, with the reason for the second line.
      const refused = await db.scheduledRun.create({
        data: {
          scheduledTaskId: task.id,
          dueAt: new Date(Date.now() - HOUR),
          trigger: 'schedule',
          status: 'refused',
          reason: 'needs_tariff',
          name: task.name,
          instructions: task.instructions,
          effort: task.effort,
        },
      })
      const notStarted = await notice({
        userId: owner.id,
        scheduledTaskId: task.id,
        scheduledRunId: refused.id,
        kind: 'not_started',
      })
      expect(await readChatNotification(db, owner.id, notStarted.id)).toEqual({
        title: 'Запланированная задача не запустилась',
        body: 'Проверка сайта — нужен тариф',
        url: `/scheduled/${task.id}`,
      })
      await db.scheduledTask.update({
        where: { id: task.id },
        data: {
          enabled: false,
          nextRunAt: null,
          pausedReason: 'refused',
          lastRefusalReason: 'no_credits',
        },
      })
      const paused = await notice({ userId: owner.id, scheduledTaskId: task.id, kind: 'paused' })
      expect(await readChatNotification(db, owner.id, paused.id)).toEqual({
        title: 'Запланированная задача приостановлена',
        body: 'Проверка сайта — не хватило кредитов',
        url: `/scheduled/${task.id}`,
      })
      // Another user reads none of them.
      await expect(readChatNotification(db, (await person()).id, paused.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })
  })

  describe('the tasks of a project (docs/plan/84-projects.md, ПР19)', () => {
    /** A project of the client; `connection` — its repository by a connection in that state. */
    async function projectOf(
      owner: User,
      options: { connection?: 'ok' | 'reauth_needed' } = {},
    ): Promise<string> {
      const projectId = deterministicUuidV7('schedule-project', randomUUID(), new Date())
      await callerOf(owner).project.create({ projectId, name: 'Сайт пекарни' })
      if (options.connection) {
        const { workspaceId } = await db.project.findUniqueOrThrow({ where: { id: projectId } })
        const connectionId = randomUUID()
        const ref = await db.credentialRef.create({
          data: {
            workspaceId,
            kind: 'git_connection',
            vaultPath: `kv/workspaces/${workspaceId}/git/${connectionId}`,
          },
        })
        await db.gitConnection.create({
          data: {
            id: connectionId,
            workspaceId,
            createdById: owner.id,
            kind: 'gitlab_token',
            host: 'gitlab.example.ru',
            accountLogin: 'kolos',
            accountId: `acc-${connectionId.slice(0, 8)}`,
            credentialRefId: ref.id,
            state: options.connection,
          },
        })
        await db.projectRepository.create({
          data: {
            id: randomUUID(),
            projectId,
            workspaceId,
            connectionId,
            provider: 'gitlab',
            host: 'gitlab.example.ru',
            providerRepoId: '42',
            path: 'kolos/site',
            webUrl: 'https://gitlab.example.ru/kolos/site',
            defaultBranch: 'main',
            mode: 'write',
            mirrorState: 'ready',
          },
        })
      }
      return projectId
    }

    /** A task of the project and a run of its schedule, as the tick writes them. */
    async function projectRun(owner: User, projectId: string) {
      const task = await callerOf(owner).schedule.create({
        name: 'Сводка запросов',
        instructions: 'Пришли сводку открытых запросов на слияние',
        effort: 'low',
        triggers: [{ kind: 'daily', time: '09:00' }],
        timezone: 'Europe/Moscow',
        projectId,
      })
      const run = await db.scheduledRun.create({
        data: {
          scheduledTaskId: task.id,
          dueAt: new Date(Math.floor(Date.now() / 60_000) * 60_000),
          trigger: 'schedule',
          status: 'pending',
          name: task.name,
          instructions: task.instructions,
          effort: task.effort,
          projectId,
        },
      })
      return { task, run }
    }

    it('lists a task of a project with it, by the project, and stops it with «В архив»', async () => {
      const { owner } = await newClient()
      const caller = callerOf(owner)
      const projectId = await projectOf(owner)
      const { task } = await projectRun(owner, projectId)
      expect(task.project).toEqual({ id: projectId, name: 'Сайт пекарни', gone: false })
      await caller.schedule.create({
        name: 'Курс валют',
        instructions: 'Пришли курс доллара',
        triggers: [],
        timezone: 'Europe/Moscow',
      })
      expect((await caller.schedule.list({ projectId })).schedules.map((s) => s.id)).toEqual([
        task.id,
      ])
      expect((await caller.schedule.list({ projectId: null })).schedules).toHaveLength(1)
      expect((await caller.schedule.list()).schedules).toHaveLength(2)

      await caller.project.archive({ projectId, archived: true })
      const [archived] = (await caller.schedule.list({ projectId })).schedules
      expect(archived).toMatchObject({
        enabled: false,
        pausedReason: 'project_gone',
        project: { id: projectId, gone: true },
      })
      await expect(
        caller.schedule.setEnabled({ scheduleId: task.id, enabled: true }),
      ).rejects.toMatchObject({
        message: 'Проект задачи в архиве или удалён — верните его, чтобы включить задачу',
      })
      // A task cannot be set up in a project of «Архив», nor in another's.
      await expect(
        caller.schedule.create({
          name: 'Ещё',
          instructions: 'Пришли сводку',
          triggers: [],
          timezone: 'Europe/Moscow',
          projectId,
        }),
      ).rejects.toMatchObject({ cause: { code: 'SCHEDULE_PROJECT_GONE' } })
    })

    it('pauses the tasks of a project put into the trash', async () => {
      const { owner } = await newClient()
      const caller = callerOf(owner)
      const projectId = await projectOf(owner)
      const { task } = await projectRun(owner, projectId)
      await caller.project.remove({ projectId })
      expect(
        (await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).pausedReason,
      ).toBe('project_gone')
    })

    it('starts a run as a new chat of the project of the run', async () => {
      const { owner } = await newClient()
      const projectId = await projectOf(owner)
      const { run } = await projectRun(owner, projectId)
      const answer = await start(run.id)
      const taskId = scheduledChatId(run)
      expect(answer).toEqual({ outcome: 'started', taskId })
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        projectId,
        title: 'Сводка запросов',
        titleSource: 'client',
      })
    })

    it('refuses a run of a project put away, and stops its task at once', async () => {
      const { owner } = await newClient()
      const projectId = await projectOf(owner)
      const { task, run } = await projectRun(owner, projectId)
      // Put away after the run was written: as if a race with the tick.
      await db.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } })
      expect(await start(run.id)).toEqual({ outcome: 'refused', reason: 'project_gone' })
      expect(await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
        enabled: false,
        pausedReason: 'project_gone',
      })
      expect(await db.task.count({ where: { id: scheduledChatId(run) } })).toBe(0)
    })

    it('refuses a run while the sign-in with GitLab has to be renewed', async () => {
      const { owner } = await newClient()
      const projectId = await projectOf(owner, { connection: 'reauth_needed' })
      const { task, run } = await projectRun(owner, projectId)
      expect(await start(run.id)).toEqual({ outcome: 'refused', reason: 'project_unavailable' })
      expect(await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
        enabled: true,
        refusalStreak: 1,
        lastRefusalReason: 'project_unavailable',
      })
    })

    it('turns on a task the agent set up only by the card of exactly that task', async () => {
      const { owner } = await newClient()
      const caller = callerOf(owner)
      const projectId = await projectOf(owner, { connection: 'ok' })
      const { task } = await projectRun(owner, projectId)
      // As the agent's reservation applied in a chat of the project with a repository leaves it.
      await db.scheduledTask.update({
        where: { id: task.id },
        data: { enabled: false, nextRunAt: null, pausedReason: 'unconfirmed', createdVia: 'chat' },
      })
      const card = await caller.schedule.confirmCard({ scheduleId: task.id })
      expect(card.schedule).toMatchObject({ id: task.id, pausedReason: 'unconfirmed' })
      // A forged token, and one of another user, turn nothing on.
      await expect(
        caller.schedule.confirm({ confirmToken: card.confirmToken.replace(/.$/u, 'x') }),
      ).rejects.toMatchObject({ cause: { code: 'SCHEDULE_CONFIRM_CHANGED' } })
      const { owner: stranger } = await newClient()
      await expect(
        callerOf(stranger).schedule.confirm({ confirmToken: card.confirmToken }),
      ).rejects.toMatchObject({ cause: { code: 'SCHEDULE_NOT_FOUND' } })
      // The agent changed the words after the card was shown: the card is stale.
      await db.scheduledTask.update({
        where: { id: task.id },
        data: { instructions: 'Пришли сводку и отправь ветку' },
      })
      await expect(
        caller.schedule.confirm({ confirmToken: card.confirmToken }),
      ).rejects.toMatchObject({ cause: { code: 'SCHEDULE_CONFIRM_CHANGED' } })
      const fresh = await caller.schedule.confirmCard({ scheduleId: task.id })
      const on = await caller.schedule.confirm({ confirmToken: fresh.confirmToken })
      expect(on).toMatchObject({ enabled: true, pausedReason: null })
      expect(on.nextRunAt).toBeInstanceOf(Date)
      // Spent: the same card again, and a card of a task that waits no more.
      await expect(
        caller.schedule.confirm({ confirmToken: fresh.confirmToken }),
      ).rejects.toMatchObject({ cause: { code: 'SCHEDULE_CONFIRM_CHANGED' } })
      await expect(caller.schedule.confirmCard({ scheduleId: task.id })).rejects.toMatchObject({
        cause: { code: 'SCHEDULE_CONFIRM_CHANGED' },
      })
    })
  })
})
