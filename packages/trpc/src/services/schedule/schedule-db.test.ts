import { randomInt, randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { underPrivateCreditRate } from '@repo/billing/testing'
import {
  createPrismaClient,
  ensurePersonalWorkspace,
  insertFeedEvent,
  type Prisma,
  type PrismaClient,
  type User,
} from '@repo/db'
import {
  legalDocuments,
  type KvMetadata,
  type KvWriteOptions,
  type ModelClass,
  type ObjectStorage,
  type SecretStore,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../../router.ts'
import { releaseConfirmKey, type ChatContext } from '../chat/context.ts'
import { readChatNotification } from '../notifications.ts'
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
const ADDRESS = { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 } as const
const KEY = releaseConfirmKey('a-secret-of-the-sessions-of-this-test-of-schedules')
const VAPID = 'B'.repeat(87)
const HOUR = 3_600_000

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
    where: { modelClass, providerModelId: { not: null } },
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

/** The client with every writing transaction of the chat under a private credit rate and price. */
function underRate(db: PrismaClient): PrismaClient {
  return new Proxy(db, {
    get(target, property) {
      if (property === '$transaction') {
        return (work: unknown, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) =>
          typeof work === 'function' && options?.isolationLevel === 'ReadCommitted'
            ? target.$transaction(
                (tx) =>
                  underPrivateCreditRate(tx, () =>
                    underPricedModel(tx, 'light', () =>
                      underPricedModel(tx, 'standard', () =>
                        underPricedModel(tx, 'heavy', () =>
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
    preview: { address: ADDRESS, ttlHours: 72 },
    browser: null,
    webPushPublicKey: VAPID,
    releaseConfirmKey: KEY,
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
    const previews = await db.previewEnvironment.findMany({
      where: { task: owned },
      select: { id: true },
    })
    await db.outboxEvent.deleteMany({
      where: {
        OR: [...tasks, ...previews].map(({ id }) => ({ dedupeKey: { contains: id } })),
      },
    })
    await db.chatNotification.deleteMany({ where: { userId: { in: users } } })
    await db.pushSubscription.deleteMany({ where: { userId: { in: users } } })
    await db.scheduledTask.deleteMany({ where: owned })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.giftSiteClaim.deleteMany({ where: owned })
    await db.gitRepository.deleteMany({ where: { site: owned } })
    await db.task.deleteMany({ where: owned })
    await db.credentialRef.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.site.deleteMany({ where: owned })
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

  /** An owner with the gift and an active site with its repository and database access. */
  async function siteOwner(options: { gift?: boolean } = {}) {
    const owner = await person()
    const workspace = await db.$transaction((tx) =>
      options.gift === false
        ? ensurePersonalWorkspace(tx, { userId: owner.id, appEnv: 'test' })
        : ensurePersonalWorkspaceWithGift(tx, { userId: owner.id, appEnv: 'test' }),
    )
    const site = await db.site.create({
      data: {
        name: 'Кофейня',
        url: `https://${randomUUID()}.example.ru`,
        stack: 'wordpress',
        status: 'active',
        workspaceId: workspace.id,
      },
    })
    await db.gitRepository.create({
      data: {
        siteId: site.id,
        provider: 'gitea',
        owner: 'sites',
        name: `site-${site.id}`,
        url: `https://git.example.ru/sites/site-${site.id}`,
      },
    })
    await db.credentialRef.create({
      data: {
        kind: 'db',
        workspaceId: workspace.id,
        siteId: site.id,
        vaultPath: `kv/sites/${site.id}/db`,
      },
    })
    return { owner, workspaceId: workspace.id, site }
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
    })
  }

  /** A task of the owner's project and a run of its schedule, as the tick writes them. */
  async function runOf(
    owner: User,
    siteId: string | null,
    options: { dueAt?: Date; trigger?: 'schedule' | 'manual' } = {},
  ) {
    const caller = callerOf(owner)
    const task = await caller.schedule.create({
      siteId,
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
        siteId,
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
    it('starts its chat from the snapshot, named by the task, its preview waiting for a need', async () => {
      const { owner, site } = await siteOwner()
      const { task, run } = await runOf(owner, site.id)
      // The task is edited after the run was written: the run starts with what it took.
      await callerOf(owner).schedule.update({ scheduleId: task.id, instructions: 'Другая просьба' })

      const answer = await start(run.id)
      const taskId = scheduledChatId(run)
      expect(answer).toEqual({ outcome: 'started', taskId })
      const chatRow = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(chatRow).toMatchObject({
        siteId: site.id,
        createdById: owner.id,
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
      // Зп18: the row of the preview is there, stopped and never built, and no build is queued.
      const preview = await db.previewEnvironment.findUniqueOrThrow({ where: { taskId } })
      expect(preview).toMatchObject({ status: 'expired', dbMode: 'copy', writeEpoch: 0 })
      expect(
        await db.outboxEvent.count({
          where: { dedupeKey: { startsWith: `preview.sync:${preview.id}:` } },
        }),
      ).toBe(0)
      expect(await db.scheduledRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: 'started',
        taskId,
      })

      // A repeat of the delivery answers the same and makes nothing more.
      expect(await start(run.id)).toEqual({ outcome: 'started', taskId })
      expect(await db.task.count({ where: { siteId: site.id } })).toBe(1)
    })

    it('records the chat a delivery made before its outcome was written (б)', async () => {
      const { owner, site } = await siteOwner()
      const { run } = await runOf(owner, site.id)
      const taskId = scheduledChatId(run)
      await start(run.id)
      // As if the outcome had been lost: the run waits again, its chat is there.
      await db.$executeRaw`UPDATE scheduled_runs SET status = 'pending', task_id = NULL,
        started_at = NULL WHERE id = ${run.id}::uuid`
      expect(await start(run.id)).toEqual({ outcome: 'started', taskId })
      expect(await db.task.count({ where: { siteId: site.id } })).toBe(1)
    })

    it('skips a run that came late or whose task was paused or deleted (в)', async () => {
      const { owner, site } = await siteOwner()
      const old = await runOf(owner, site.id, { dueAt: new Date(Date.now() - 7 * HOUR) })
      expect(await start(old.run.id)).toEqual({ outcome: 'skipped', reason: 'missed' })

      const paused = await runOf(owner, site.id)
      await callerOf(owner).schedule.setEnabled({ scheduleId: paused.task.id, enabled: false })
      expect(await start(paused.run.id)).toEqual({ outcome: 'skipped', reason: 'paused' })

      const deleted = await runOf(owner, site.id)
      await callerOf(owner).schedule.delete({ scheduleId: deleted.task.id })
      expect(await start(deleted.run.id)).toEqual({ outcome: 'skipped', reason: 'paused' })

      expect(await start(randomUUID())).toEqual({ outcome: 'skipped', reason: 'paused' })
      expect(await db.task.count({ where: { siteId: site.id } })).toBe(0)
    })

    it('skips a run when a later one of its task already waits or started (в)', async () => {
      const { owner, site } = await siteOwner()
      const { task, run } = await runOf(owner, site.id, { dueAt: new Date(Date.now() - HOUR) })
      await db.scheduledRun.create({
        data: {
          scheduledTaskId: task.id,
          dueAt: new Date(Date.now() - 60_000),
          trigger: 'schedule',
          status: 'pending',
          siteId: site.id,
          name: task.name,
          instructions: task.instructions,
          effort: task.effort,
        },
      })
      expect(await start(run.id)).toEqual({ outcome: 'skipped', reason: 'missed' })
    })

    it('stops the task when its project is gone or its creator lost the right (г)', async () => {
      const { owner, workspaceId, site } = await siteOwner()
      const gone = await runOf(owner, site.id)
      const right = await runOf(owner, site.id)
      await db.site.update({ where: { id: site.id }, data: { deletedAt: new Date() } })
      expect(await start(gone.run.id)).toEqual({ outcome: 'refused', reason: 'project_gone' })
      expect(
        await db.scheduledTask.findUniqueOrThrow({ where: { id: gone.task.id } }),
      ).toMatchObject({ enabled: false, pausedReason: 'project_gone' })

      await db.site.update({ where: { id: site.id }, data: { deletedAt: null } })
      await db.member.update({
        where: { workspaceId_userId: { workspaceId, userId: owner.id } },
        data: { role: 'member' },
      })
      expect(await start(right.run.id)).toEqual({ outcome: 'refused', reason: 'member_gone' })
      expect(
        await db.scheduledTask.findUniqueOrThrow({ where: { id: right.task.id } }),
      ).toMatchObject({ enabled: false, pausedReason: 'member_gone' })
    })

    it('refuses while the creator has documents to accept (г)', async () => {
      const { owner, site } = await siteOwner()
      const { run } = await runOf(owner, site.id)
      await db.userConsent.deleteMany({ where: { userId: owner.id } })
      expect(await start(run.id)).toEqual({ outcome: 'refused', reason: 'consent' })
    })

    it('records the refusal of credits, counted for the pause (д)', async () => {
      const { owner, site } = await siteOwner({ gift: false })
      const { task, run } = await runOf(owner, site.id)
      const answer = await start(run.id)
      expect(answer.outcome).toBe('refused')
      expect(['needs_tariff', 'no_credits']).toContain(
        answer.outcome === 'refused' ? answer.reason : null,
      )
      expect(await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
        refusalStreak: 1,
        enabled: true,
      })
      expect(await db.task.count({ where: { siteId: site.id } })).toBe(0)
    })

    it('leaves the run waiting when Vault fails, so core delivers it again', async () => {
      const { owner, site } = await siteOwner()
      const { run } = await runOf(owner, site.id)
      vault.transit.failing = true
      await expect(start(run.id)).rejects.toMatchObject({ code: 'WORKSPACE_KEY_UNAVAILABLE' })
      expect(await db.scheduledRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: 'pending',
      })
    })

    it('starts a chat without a project in the personal workspace', async () => {
      const owner = await person()
      const { run } = await runOf(owner, null)
      const answer = await start(run.id)
      expect(answer).toEqual({ outcome: 'started', taskId: scheduledChatId(run) })
      expect(await db.previewEnvironment.count({ where: { taskId: scheduledChatId(run) } })).toBe(0)
    })
  })

  describe('the procedures of «Расписание»', () => {
    it('creates, lists, reads, changes, pauses and deletes a task of its creator', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const created = await caller.schedule.create({
        siteId: site.id,
        name: 'Заявки за сутки',
        instructions: 'Соберите заявки за сутки',
        triggers: [{ kind: 'weekdays', time: '08:00' }],
        timezone: 'Asia/Novosibirsk',
        templateSlug: 'leads-digest',
      })
      expect(created).toMatchObject({
        effort: 'high',
        enabled: true,
        notify: true,
        createdVia: 'template',
        templateSlug: 'leads-digest',
        project: { id: site.id, name: 'Кофейня' },
        lastRun: null,
        runs: [],
      })
      expect(created.nextRunAt).toBeInstanceOf(Date)

      const { schedules, timezone } = await caller.schedule.list()
      expect(schedules.map((schedule) => schedule.id)).toEqual([created.id])
      expect(timezone).toBe('Europe/Moscow')

      const renamed = await caller.schedule.update({
        scheduleId: created.id,
        name: 'Заявки',
        siteId: site.id,
      })
      expect(renamed).toMatchObject({ name: 'Заявки', nextRunAt: created.nextRunAt })

      const paused = await caller.schedule.setEnabled({ scheduleId: created.id, enabled: false })
      expect(paused).toMatchObject({ enabled: false, nextRunAt: null, pausedReason: null })

      expect(await caller.schedule.delete({ scheduleId: created.id })).toEqual({ deleted: true })
      expect((await caller.schedule.list()).schedules).toEqual([])
      await expect(caller.schedule.get({ scheduleId: created.id })).rejects.toMatchObject({
        message: 'Задачи уже нет',
      })
    })

    it('refuses in the words of the client what the rules of a task refuse', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const base = {
        siteId: site.id,
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
      await expect(
        caller.schedule.create({
          ...base,
          siteId: null,
          instructions: 'Посмотрите сайты конкурентов: [впишите адреса].',
          templateSlug: 'competitors',
        }),
      ).rejects.toMatchObject({ message: 'Впишите адреса сайтов конкурентов' })
      await expect(
        caller.schedule.create({ ...base, siteId: null, templateSlug: 'site-check' }),
      ).rejects.toMatchObject({ message: 'Этому шаблону нужен проект — выберите его' })
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
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const task = await caller.schedule.create({
        siteId: site.id,
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
      const { owner, site } = await siteOwner({ gift: false })
      const caller = callerOf(owner)
      const task = await caller.schedule.create({
        siteId: site.id,
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

    it('drops the run of «Запустить сейчас» when Vault fails', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const task = await caller.schedule.create({
        siteId: site.id,
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
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const hint = await caller.schedule.costHint({
        siteId: site.id,
        triggers: [{ kind: 'daily', time: '09:00' }],
        timezone: 'Europe/Moscow',
      })
      expect(hint).toMatchObject({ averageCredits: 11, runsPerWeek: 7, creditsPerWeek: 77 })
      expect(hint.nextRunAt).toBeInstanceOf(Date)
      expect(
        await caller.schedule.costHint({ siteId: null, triggers: [], timezone: 'Europe/Moscow' }),
      ).toMatchObject({ runsPerWeek: 0, creditsPerWeek: 0, nextRunAt: null, overHalf: false })

      expect(await caller.schedule.rememberTimezone({ timezone: 'Asia/Novosibirsk' })).toEqual({
        timezone: 'Asia/Novosibirsk',
      })
      expect((await caller.schedule.list()).timezone).toBe('Asia/Novosibirsk')
    })

    it('counts the tasks «Удалить проект» stops', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      for (const name of ['Первая', 'Вторая'])
        await caller.schedule.create({
          siteId: site.id,
          name,
          instructions: 'Проверьте сайт',
          triggers: [],
          timezone: 'Europe/Moscow',
        })
      expect(await caller.schedule.projectCount({ siteId: site.id })).toEqual({ count: 2 })
      await expect(
        callerOf(await person()).schedule.projectCount({ siteId: site.id }),
      ).rejects.toMatchObject({ cause: { code: 'NOT_FOUND' } })
    })
  })

  describe('a chat of a run', () => {
    it('is labelled by its task in the list and in its head, without a link once it is deleted', async () => {
      const { owner, site } = await siteOwner()
      const { task, run } = await runOf(owner, site.id)
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
      const { owner, site } = await siteOwner()
      const { task, run } = await runOf(owner, site.id)
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

      // The browser replaced its subscription: the new one is the user's, the old one is gone.
      await caller.notification.resubscribe({
        oldEndpoint: subscription(1).endpoint,
        ...subscription(3),
      })
      const endpoints = await db.pushSubscription.findMany({
        where: { userId: owner.id },
        select: { endpoint: true },
        orderBy: { endpoint: 'asc' },
      })
      expect(endpoints.map(({ endpoint }) => endpoint)).toEqual([
        subscription(2).endpoint,
        subscription(3).endpoint,
      ])
      // An old endpoint of another user is left to them.
      const other = await person()
      await callerOf(other).notification.subscribe(subscription(4))
      await caller.notification.resubscribe({
        oldEndpoint: subscription(4).endpoint,
        ...subscription(5),
      })
      expect(
        await db.pushSubscription.findUniqueOrThrow({
          where: { endpoint: subscription(4).endpoint },
        }),
      ).toMatchObject({ userId: other.id })
    })

    it('says a notice of a pass without its client and of the task itself in the words of Зп38', async () => {
      const { owner, site } = await siteOwner()
      const { task, run } = await runOf(owner, site.id)
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
          siteId: site.id,
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
})
