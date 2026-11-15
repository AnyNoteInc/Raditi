import { randomInt, randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift, grantTariffCredits } from '@repo/billing'
import { settleTaskCharge, underPrivateCreditRate } from '@repo/billing/testing'
import {
  createPrismaClient,
  ensurePersonalWorkspace,
  insertFeedEvent,
  markAttachmentReady,
  openBrowserSession,
  Prisma,
  type PrismaClient,
  type User,
} from '@repo/db'
import {
  feedLimits,
  feedRowText,
  legalDocuments,
  type KvMetadata,
  type KvWriteOptions,
  type ModelClass,
  type ObjectStorage,
  type SecretStore,
  type ChatCommandFacts,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import type { ChatContext } from '../services/chat/context.ts'
import { commandRefusal, dialogFacts } from '../services/chat/dialog-facts.ts'
import { dialogPageQuery } from '../services/chat/dialog-list.ts'
import { wordsOfTurn } from '../services/chat/dialog-state.ts'
import { handleTelegramUpdate, type TelegramMedia } from '../services/telegram/intake.ts'
import { readTelegramUpdate } from '@repo/telegram'

// The procedures of a dialog on PostgreSQL (docs/plan/53-chat-preview-release.md, R2): what one
// transaction writes together, what a repeat writes again (nothing), and what a refusal leaves
// (nothing). Every test works in a workspace of its own; `cleanup` removes what it wrote.

const databaseUrl = process.env.DATABASE_URL

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)
const STREAM_URL = 'ws://localhost:8091/v1/browser/stream'

/**
 * Vault KV v2 in memory, with CAS and `max_versions`: what `sites-writer` may do, and what the
 * test may look at. Without `maxVersions` a key keeps its history, as the `kv/` mount does.
 * `workspaceKeys` — every Transit key `workspace-provisioner` was asked to make, repeats included
 * (docs/plan/57, Б32); while `transit.failing`, Vault refuses that.
 */
function memoryVault() {
  const keys = new Map<string, { version: number; data: Record<string, string> }[]>()
  const workspaceKeys: string[] = []
  const transit = { failing: false }
  const store = {
    async transitEnsureKey(key: string) {
      if (transit.failing)
        throw Object.assign(new Error('Vault request returned HTTP 503'), {
          name: 'VaultError',
          status: 503,
        })
      workspaceKeys.push(key)
    },
    async kvMetadata(path: string): Promise<KvMetadata | null> {
      const versions = keys.get(path)
      if (versions === undefined) return null
      return {
        currentVersion: versions.at(-1)!.version,
        custom: {},
        createdTime: new Date(),
        deleted: false,
        destroyed: false,
      }
    },
    async kvWrite(path: string, data: Record<string, string>, options?: KvWriteOptions) {
      const versions = keys.get(path) ?? []
      const current = versions.at(-1)?.version ?? 0
      if (options?.cas !== undefined && options.cas !== current)
        throw new Error('check-and-set parameter did not match the current version')
      versions.push({ version: current + 1, data })
      keys.set(path, versions.slice(-(options?.maxVersions ?? 10)))
      return { version: current + 1 }
    },
  }
  return { secrets: store as unknown as SecretStore, keys, workspaceKeys, transit }
}

/**
 * The process-wide client with every writing transaction (READ COMMITTED, as the writers of
 * @repo/billing require) run under a credit rate no other transaction sees
 * (`underPrivateCreditRate`) and with the class `standard` — that of a dialog the client starts
 * with no reasoning chosen — priced the same way (`underPricedModel`): a reserve needs a usable
 * rate, `task.create` a class a pass could run in, and this database may be shared with suites
 * that expect neither. Reads in a snapshot of their own are left as they are. `rate: false` —
 * the class priced without a rate, for a reserve refused for want of one.
 */
function underRate(db: PrismaClient, { rate = true }: { rate?: boolean } = {}): PrismaClient {
  const priced = <T>(tx: Prisma.TransactionClient, work: () => Promise<T>): Promise<T> =>
    rate
      ? underPrivateCreditRate(tx, () => underPricedModel(tx, 'standard', work))
      : underPricedModel(tx, 'standard', work)
  return new Proxy(db, {
    get(target, property) {
      if (property === '$transaction') {
        return (work: unknown, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) =>
          typeof work === 'function' && options?.isolationLevel === 'ReadCommitted'
            ? target.$transaction(
                (tx) => priced(tx, () => (work as (client: typeof tx) => Promise<unknown>)(tx)),
                options,
              )
            : target.$transaction(work as never, options as never)
      }
      const value: unknown = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** How a class stands for a pass (`underPricedModel`). */
interface PricedModel {
  /** When its price starts: before any private credit rate unless told otherwise. */
  priceFrom?: Date
  /** false — its provider is left as the seeds have it: switched off. */
  provider?: boolean
}

/**
 * Runs `work` with the seeded model of `modelClass` and its provider switched on and the model
 * priced, in the caller's transaction alone: the price row is written before the work and
 * deleted after it, and the switches are put back, so the database is left as every other suite
 * expects. `task.create` and «Попробовать ещё» ask first whether a pass of the class could run:
 * the profile the planner takes, with a price. The price starts before any private credit rate
 * (`underPrivateCreditRate`), which so stays usable, unless `priceFrom` says otherwise.
 */
async function underPricedModel<T>(
  tx: Prisma.TransactionClient,
  modelClass: ModelClass,
  work: () => Promise<T>,
  options: PricedModel = {},
): Promise<T> {
  const model = await tx.llmModel.findFirst({
    where: { modelClass, providerModelId: { not: null } },
    orderBy: [{ slug: 'asc' }, { provider: { slug: 'asc' } }],
    select: { id: true, enabled: true, provider: { select: { id: true, enabled: true } } },
  })
  if (model === null) throw new Error(`The seeds have no model of the class ${modelClass}`)
  const price = await tx.llmModelPrice.create({
    data: {
      modelId: model.id,
      effectiveFrom:
        options.priceFrom ?? new Date(Date.UTC(2025, 11, 31) + randomInt(24 * 3600 * 1000)),
      inputPer1m: '100',
      outputPer1m: '1000',
      vatRate: '0.2200',
      sourceUrl: 'https://rates.invalid/dialog-verification',
    },
  })
  const provider = options.provider !== false && !model.provider.enabled
  if (!model.enabled) await tx.llmModel.update({ where: { id: model.id }, data: { enabled: true } })
  if (provider)
    await tx.llmProvider.update({ where: { id: model.provider.id }, data: { enabled: true } })
  const result = await work()
  await tx.llmModelPrice.delete({ where: { id: price.id } })
  if (!model.enabled)
    await tx.llmModel.update({ where: { id: model.id }, data: { enabled: false } })
  if (provider)
    await tx.llmProvider.update({ where: { id: model.provider.id }, data: { enabled: false } })
  return result
}

/**
 * `underRate` with the class `heavy` priced as well. A client whose `heavy` is under a provider
 * left off only retries: pricing `standard` would switch that provider on, so it is not priced.
 */
function underRateAndHeavy(db: PrismaClient, heavy: PricedModel = {}): PrismaClient {
  const priced = <T>(tx: Prisma.TransactionClient, work: () => Promise<T>): Promise<T> =>
    heavy.provider === false
      ? underPricedModel(tx, 'heavy', work, heavy)
      : underPricedModel(tx, 'standard', () => underPricedModel(tx, 'heavy', work, heavy))
  return new Proxy(db, {
    get(target, property) {
      if (property === '$transaction') {
        return (work: unknown, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) =>
          typeof work === 'function' && options?.isolationLevel === 'ReadCommitted'
            ? target.$transaction(
                (tx) =>
                  underPrivateCreditRate(tx, () =>
                    priced(tx, () => (work as (client: typeof tx) => Promise<unknown>)(tx)),
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

describe.skipIf(!databaseUrl)('PostgreSQL: the procedures of a dialog', () => {
  let db: PrismaClient
  const userIds: string[] = []
  const taskIds: string[] = []
  const planIds: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const users = userIds.splice(0)
    const tasks = taskIds.splice(0)
    const workspaces = await db.workspace.findMany({
      where: { createdById: { in: users } },
      select: { id: true },
    })
    const owned = { workspaceId: { in: workspaces.map(({ id }) => id) } }
    await db.outboxEvent.deleteMany({
      where: { OR: tasks.map((id) => ({ dedupeKey: { contains: id } })) },
    })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    // Files of messages: a file nobody sent holds its workspace.
    await db.attachment.deleteMany({ where: owned })
    await db.turnAssignment.deleteMany({ where: { task: owned } })
    await db.task.deleteMany({ where: owned })
    // The chats bound to Telegram (docs/plan/80-telegram.md) hold their workspace.
    await db.chatSession.deleteMany({ where: owned })
    await db.workspaceEnvVar.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.subscription.deleteMany({ where: owned })
    await db.order.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.plan.deleteMany({ where: { id: { in: planIds.splice(0) } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function person(): Promise<User> {
    const row = await db.user.create({
      data: { name: 'Dialog verification', email: `${randomUUID()}@dialog.example.ru` },
    })
    userIds.push(row.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: row.id, source: 'sign_up' })),
    })
    return row
  }

  const vault = memoryVault()
  const storage = { get: async () => null } as unknown as ObjectStorage

  function callerOf(
    user: User,
    options: {
      client?: PrismaClient
      /** The cloud browser of the platform (docs/plan/57); off unless asked for. */
      browser?: boolean
      storage?: ObjectStorage
      /** The environment of the platform; a test one unless asked for. */
      appEnv?: ChatContext['appEnv']
    } = {},
  ) {
    const chat: ChatContext = {
      appEnv: options.appEnv ?? 'test',
      browser: options.browser === true ? { streamUrl: STREAM_URL } : null,
      storage: () => options.storage ?? storage,
      secrets: () => vault.secrets,
      telegramBot: 'raditi_bot',
    }
    return createCaller({
      prisma: options.client ?? underRate(db),
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `dialog-test-${randomUUID()}`,
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

  /**
   * An owner with the gift of the registration and their personal workspace, where their chats
   * go; `gift: false` — the workspace alone, as a test that counts tariff credits only needs it.
   */
  async function chatOwner(options: { gift?: boolean } = {}) {
    const owner = await person()
    const workspace = await db.$transaction((tx) =>
      options.gift === false
        ? ensurePersonalWorkspace(tx, { userId: owner.id, appEnv: 'test' })
        : ensurePersonalWorkspaceWithGift(tx, { userId: owner.id, appEnv: 'test' }),
    )
    return { owner, workspaceId: workspace.id }
  }

  /**
   * A paid tariff of a month with its credits, for a workspace that needs more than the gift:
   * a plan of its own, never on sale, its paid order and the quota granted by that order. No
   * daily cap unless `creditsPerDay` is given; the period began `startedDaysAgo` days ago.
   */
  async function paidTariff(
    workspaceId: string,
    options: { creditsPerDay?: number; startedDaysAgo?: number } = {},
  ) {
    const plan = await db.plan.create({
      data: {
        slug: `test-${randomUUID()}`,
        name: 'Проверочный',
        kind: 'quota',
        price: '4900.00',
        creditsPerMonth: 300,
        creditsPerDay: options.creditsPerDay ?? null,
        creditsPer5h: null,
        creditsPerWeek: null,
        isActive: false,
      },
    })
    planIds.push(plan.id)
    const start = new Date(Date.now() - (options.startedDaysAgo ?? 1) * 24 * 3600 * 1000)
    const end = new Date(start.getTime() + 30 * 24 * 3600 * 1000)
    const order = await db.order.create({
      data: {
        workspaceId,
        planId: plan.id,
        kind: 'subscription',
        amount: '4900.00',
        status: 'paid',
        idempotenceKey: randomUUID(),
        periodStart: start,
        periodEnd: end,
      },
    })
    await db.subscription.create({
      data: {
        workspaceId,
        planId: plan.id,
        status: 'active',
        currentPeriodStart: start,
        currentPeriodEnd: end,
        periodAnchor: start,
      },
    })
    await db.$transaction((tx) =>
      grantTariffCredits(tx, { workspaceId, orderId: order.id, credits: 300 }),
    )
  }

  /** An id of version 7, the only one a chat takes (К14). */
  const chatId = () => {
    const id = randomUUID().replace(/^(.{14})./u, '$17')
    taskIds.push(id)
    return id
  }

  async function newDialog(
    caller: ReturnType<typeof callerOf>,
    text = 'Поменяйте телефон в шапке сайта',
  ) {
    const taskId = chatId()
    return { taskId, created: await caller.task.create({ taskId, text }) }
  }

  const outboxOf = (needle: string) =>
    db.outboxEvent.findMany({
      where: { dedupeKey: { contains: needle } },
      orderBy: { createdAt: 'asc' },
      select: { topic: true, type: true, payload: true, dedupeKey: true },
    })
  const feedOf = (taskId: string) =>
    db.taskEvent.findMany({
      where: { taskId },
      orderBy: { id: 'asc' },
      select: { id: true, type: true, payload: true, clientVisible: true },
    })
  const activeHolds = (taskId: string) =>
    db.creditHold.findMany({
      where: { taskId, status: 'active' },
      orderBy: { attempt: 'asc' },
      select: { attempt: true, amount: true, expiresAt: true },
    })

  /** What core does when a pass ends with a question: the row and the move, in one go. */
  async function asked(taskId: string, question: Record<string, unknown>) {
    return db.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data: { status: 'awaiting_user', turnNo: 1 } })
      return insertFeedEvent(tx, {
        taskId,
        row: { type: 'feed.question', payload: { v: 1, turn: 1, ...question } as never },
      })
    })
  }

  describe('task.message', () => {
    it('answers the question of the agent: the same attempt goes on under the same reserve', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      const [before] = await activeHolds(taskId)
      const questionId = await asked(taskId, {
        kind: 'agent',
        intro: 'Нужно уточнить.',
        questions: [{ text: 'Какой номер поставить?', options: [] }],
      })
      const requestId = randomUUID()

      const posted = await caller.task.message({ taskId, requestId, text: '+7 900 000-00-00' })

      expect(posted.repeated).toBe(false)
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 1,
      })
      const answer = (await feedOf(taskId)).at(-1)!
      expect(answer).toMatchObject({
        id: BigInt(posted.requestEventId),
        type: 'feed.request',
        payload: { kind: 'answer', requestId, answersEventId: String(questionId) },
      })
      const holds = await activeHolds(taskId)
      expect(holds).toHaveLength(1)
      expect(holds[0]!.expiresAt.getTime()).toBeGreaterThanOrEqual(before!.expiresAt.getTime())
      expect((await outboxOf(taskId)).map((row) => row.dedupeKey)).toContain(
        `turn.run:${taskId}:1:${posted.requestEventId}`,
      )

      // The same message delivered again: the row of the first delivery, nothing new.
      const again = await caller.task.message({ taskId, requestId, text: '+7 900 000-00-00' })
      expect(again).toEqual({ requestEventId: posted.requestEventId, repeated: true })
      expect(await feedOf(taskId)).toHaveLength(3)
    })

    it('goes on in a dialog a pass left open without changes: the words answer its result', async () => {
      // The owner, 26.10.2026: «после того как в работе произошла какая-то работа, не закрывай чат».
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      // An earlier question, answered: the words now answer the result after it.
      await asked(taskId, {
        kind: 'agent',
        intro: 'Нужно уточнить.',
        questions: [{ text: 'О чём рассказать?', options: [] }],
      })
      await caller.task.message({ taskId, requestId: randomUUID(), text: 'О сайте в целом' })
      const resultId = await db.$transaction(async (tx) => {
        await tx.task.update({
          where: { id: taskId },
          data: { status: 'awaiting_user', turnNo: 2 },
        })
        return insertFeedEvent(tx, {
          taskId,
          row: {
            type: 'feed.result',
            payload: {
              v: 1,
              turn: 2,
              message: 'Это сайт учебного комбината.',
              site: 'unchanged',
              next: 'awaiting_user',
              filesChanged: 0,
              changeType: 'none',
              needsApproval: false,
              risk: 'low',
            },
          },
        })
      })

      const posted = await caller.task.message({
        taskId,
        requestId: randomUUID(),
        text: 'А какие плагины стоят?',
      })

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 1,
      })
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        id: BigInt(posted.requestEventId),
        payload: { kind: 'answer', answersEventId: String(resultId) },
      })
      expect(await activeHolds(taskId)).toHaveLength(1)
      // Answered once: while the next pass works, words wait for it.
      await expect(
        caller.task.message({ taskId, requestId: randomUUID(), text: 'И ещё' }),
      ).rejects.toMatchObject({ cause: { code: 'TASK_BUSY' } })
    })

    // Every completed pass is charged when it ends (owner's answer of 26.10.2026): the next
    // words open a new chain, the next attempt with a reserve of its own.
    it('opens the next attempt with a reserve of its own after a charged pass', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      await db.$transaction(
        async (tx) => {
          await tx.task.update({
            where: { id: taskId },
            data: { status: 'awaiting_user', turnNo: 1 },
          })
          await insertFeedEvent(tx, {
            taskId,
            row: {
              type: 'feed.result',
              payload: {
                v: 1,
                turn: 1,
                message: 'Это сайт учебного комбината.',
                site: 'unchanged',
                next: 'awaiting_user',
                filesChanged: 0,
                changeType: 'none',
                needsApproval: false,
                risk: 'low',
              },
            },
          })
          // What core does at the end of the pass: the chain is charged.
          await settleTaskCharge(tx, { taskId, credits: 5, now: new Date() })
        },
        { isolationLevel: 'ReadCommitted' },
      )
      expect(await activeHolds(taskId)).toEqual([])

      const posted = await caller.task.message({
        taskId,
        requestId: randomUUID(),
        text: 'А какие плагины стоят?',
      })

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
      })
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([2])
      expect(await outboxOf(taskId)).toContainEqual(
        expect.objectContaining({
          type: 'turn.run',
          // No tariff: the last place in the queue (plan 71, §2.3).
          payload: { taskId, attempt: 2, requestEventId: posted.requestEventId, priority: 4 },
        }),
      )
    })

    // The owner, 28.10.2026: «никогда не завершай диалог, если произошла ошибка… пользователь
    // может ввести "продолжи" и задача должна продолжиться».

    // The owner, 28.10.2026: «пользователь всегда должен иметь возможность ввести промпт».
    it('goes on with the words after a question about credits, as «Продолжить» does', async () => {
      const { owner, workspaceId } = await chatOwner()
      await paidTariff(workspaceId)
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      const message = () =>
        caller.task.message({ taskId, requestId: randomUUID(), text: 'продолжи' })

      // While the agent works the words wait for it.
      await expect(message()).rejects.toMatchObject({ cause: { code: 'TASK_BUSY' } })
      const questionId = await asked(taskId, {
        kind: 'ceiling',
        reason: 'step',
        spent: 30,
        held: 35,
        left: 5,
      })
      const posted = await message()

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
      })
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        id: BigInt(posted.requestEventId),
        payload: { kind: 'answer', text: 'продолжи', answersEventId: String(questionId) },
      })
      // A continuation: the next attempt beside the reserve of the one before.
      expect((await activeHolds(taskId)).map((hold) => hold.attempt).sort()).toEqual([1, 2])
      // A chain that used its attempts: the words open the next one, «Продолжить» has none.
      const spent = await newDialog(caller)
      await db.$transaction(
        (tx) => settleTaskCharge(tx, { taskId: spent.taskId, credits: 5, now: new Date() }),
        { isolationLevel: 'ReadCommitted' },
      )
      await asked(spent.taskId, {
        kind: 'ceiling',
        reason: 'attempts',
        spent: 120,
        held: 0,
        left: 0,
      })
      await expect(
        caller.task.continue({ taskId: spent.taskId, requestId: randomUUID() }),
      ).rejects.toMatchObject({ cause: { code: 'TASK_ATTEMPTS_EXHAUSTED' } })
      await caller.task.message({ taskId: spent.taskId, requestId: randomUUID(), text: 'продолжи' })
      expect(await db.task.findUniqueOrThrow({ where: { id: spent.taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
      })
      // Answered: «Продолжить» has nothing left to continue.
      await expect(caller.task.continue({ taskId, requestId: randomUUID() })).rejects.toMatchObject(
        { cause: { code: 'TASK_NOTHING_TO_CONTINUE' } },
      )
    })
  })

  describe('task.continue', () => {
    it('places the next attempt beside the reserve of the one before', async () => {
      const { owner, workspaceId } = await chatOwner()
      await paidTariff(workspaceId)
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      const questionId = await asked(taskId, {
        kind: 'ceiling',
        reason: 'step',
        spent: 30,
        held: 35,
        left: 5,
      })
      const requestId = randomUUID()

      const posted = await caller.task.continue({ taskId, requestId })

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
      })
      // A continuation: the reserve of the first attempt stays, the second has its own.
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([1, 2])
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        payload: { kind: 'continue', requestId, questionEventId: String(questionId) },
      })
      expect((await outboxOf(taskId)).map((row) => row.dedupeKey)).toContain(
        `turn.run:${taskId}:2:${posted.requestEventId}`,
      )
      expect(await caller.task.continue({ taskId, requestId })).toEqual({
        ...posted,
        repeated: true,
      })
    })

    it('has nothing to continue without a question about credits', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      await asked(taskId, {
        kind: 'agent',
        intro: 'Нужно уточнить.',
        questions: [{ text: 'Какой номер?', options: [] }],
      })
      await expect(caller.task.continue({ taskId, requestId: randomUUID() })).rejects.toMatchObject(
        {
          cause: { code: 'TASK_NOTHING_TO_CONTINUE' },
        },
      )
    })
  })

  // docs/plan/61-chats-first.md, К31, §5.14: a pass of the agent, as the next words would be.

  // docs/plan/61-chats-first.md, К31, §5.9, on the real rows: a mock cannot see `accessibleSite`.

  // The owner's answer 1 of 18.10.2026 (docs/plan/53, «Попробовать ещё (18.10)»).

  describe('task.cancel', () => {
    // docs/plan/61-chats-first.md, К18; the row is written here until `task.create` takes one.
    it('closes a waiting chat without a project with no word of a site', async () => {
      const { owner, workspaceId } = await chatOwner()
      const caller = callerOf(owner)
      const task = await db.task.create({
        data: {
          workspaceId,
          needsBrowser: false,
          status: 'awaiting_user',
          turnNo: 1,
        },
      })
      taskIds.push(task.id)

      await expect(
        caller.task.cancel({ taskId: task.id, requestId: randomUUID() }),
      ).resolves.toMatchObject({ state: 'cancelled', repeated: false })

      const feed = await feedOf(task.id)
      expect(feed.at(-1)?.payload).toMatchObject({ by: 'customer', site: 'none', credits: null })
    })

    it('asks core to stop a pass that runs, and refuses a release in work', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      await db.task.update({ where: { id: taskId }, data: { status: 'running', turnNo: 1 } })

      const stopping = await caller.task.cancel({ taskId, requestId: randomUUID() })

      expect(stopping).toMatchObject({ state: 'stopping' })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('running')
      expect(await outboxOf(`turn.cancel:${taskId}`)).toEqual([
        {
          topic: 'agent-turns',
          type: 'turn.cancel',
          payload: { taskId, requestEventId: stopping.requestEventId },
          dedupeKey: `turn.cancel:${taskId}:${stopping.requestEventId}`,
        },
      ])

      await db.task.update({ where: { id: taskId }, data: { status: 'deploying' } })
      await expect(caller.task.cancel({ taskId, requestId: randomUUID() })).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'release_in_progress' } },
      })
    })
  })

  // The owner's request of 26.10.2026: a dialog is renamed, deleted, and its level of thinking
  // changed while it goes on; none of it moves the dialog in the list.
  describe('the queue of a chat (docs/plan/75-chat-input-output.md, ВВ1–ВВ5)', () => {
    it('keeps words written while the agent works, changes and removes them, and refuses a dialog that waits', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      const requestId = randomUUID()

      const added = await caller.task.queueAdd({ taskId, requestId, text: '  И поменяйте адрес ' })
      expect(added.repeated).toBe(false)
      // A repeat of the same press finds the same row.
      expect(await caller.task.queueAdd({ taskId, requestId, text: 'И поменяйте адрес' })).toEqual({
        id: added.id,
        repeated: true,
      })
      const listed = (await caller.task.queueList({ taskId })).items
      expect(listed.map((item) => item.text)).toEqual(['И поменяйте адрес'])

      expect(await caller.task.queueEdit({ taskId, id: added.id!, text: 'И часы работы' })).toEqual(
        {
          text: 'И часы работы',
        },
      )
      expect((await caller.task.queueList({ taskId })).items[0]?.text).toBe('И часы работы')
      await expect(
        caller.task.queueAdd({ taskId, requestId: randomUUID(), text: 'пароль: Qwerty12345!' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await expect(callerOf(await person()).task.queueList({ taskId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })

      // A pass that is only planned has nothing to stop: «Отправить сейчас» writes no press.
      expect(await caller.task.queueSendNow({ taskId, requestId: randomUUID() })).toEqual({
        requestEventId: null,
      })
      await db.task.update({ where: { id: taskId }, data: { status: 'running', turnNo: 1 } })
      const pressed = await caller.task.queueSendNow({ taskId, requestId: randomUUID() })
      expect(pressed.requestEventId).not.toBeNull()
      expect(await outboxOf(`turn.cancel:${taskId}:${pressed.requestEventId}`)).toHaveLength(1)

      expect(await caller.task.queueRemove({ taskId, id: added.id! })).toEqual({ removed: true })
      expect((await caller.task.queueList({ taskId })).items).toEqual([])
      await expect(
        caller.task.queueEdit({ taskId, id: added.id!, text: 'Поздно' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_user' } })
      await expect(
        caller.task.queueAdd({ taskId, requestId: randomUUID(), text: 'Уже ждёт' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
    })

    it('takes at most ten words, and «Остановить» takes the queue away', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      for (let index = 0; index < 10; index++)
        await caller.task.queueAdd({ taskId, requestId: randomUUID(), text: `Слова ${index}` })
      await expect(
        caller.task.queueAdd({ taskId, requestId: randomUUID(), text: 'Одиннадцатые' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await caller.task.cancel({ taskId, requestId: randomUUID() })
      expect(await db.taskQueuedMessage.count({ where: { taskId } })).toBe(0)
    })
  })

  describe("the client's own instructions to the agent (docs/plan/76, И1, И3)", () => {
    it('are written, read back, refused with a password, and removed by empty words', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      expect(await caller.user.agentInstructions()).toEqual({ text: '' })
      expect(await caller.user.setAgentInstructions({ text: '  Мы — кофейня у метро  ' })).toEqual({
        text: 'Мы — кофейня у метро',
      })
      expect(await caller.user.agentInstructions()).toEqual({ text: 'Мы — кофейня у метро' })
      await expect(
        caller.user.setAgentInstructions({ text: 'пароль: Qwerty12345!' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await expect(
        caller.user.setAgentInstructions({ text: 'я'.repeat(2001) }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(await caller.user.setAgentInstructions({ text: ' ' })).toEqual({ text: '' })
      expect(await db.agentInstructions.count({ where: { userId: owner.id } })).toBe(0)
    })
  })

  describe('task.rename, task.remove, task.setEffort', () => {
    const updatedAt = async (taskId: string) =>
      (await db.task.findUniqueOrThrow({ where: { id: taskId } })).updatedAt.getTime()

    it('changes the level of thinking of a dialog that waits, from its next turn', async () => {
      const { owner } = await chatOwner()
      const { taskId } = await newDialog(callerOf(owner))
      // Core plans the turn of a queued or running pass with the class it read: no change then.
      await expect(
        callerOf(owner, { client: underRateAndHeavy(db) }).task.setEffort({
          taskId,
          effort: 'max',
        }),
      ).rejects.toMatchObject({ cause: { code: 'TASK_BUSY' } })
      await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_user' } })
      const before = await updatedAt(taskId)
      expect((await callerOf(owner).task.feed({ taskId })).task.effort).toBe('high')

      // No priced model of heavy: the next pass would fail, so the change is refused.
      await expect(callerOf(owner).task.setEffort({ taskId, effort: 'max' })).rejects.toMatchObject(
        {
          cause: { code: 'TASK_NOT_ACCEPTED', details: { reason: 'class_unavailable' } },
        },
      )
      const heavy = callerOf(owner, { client: underRateAndHeavy(db) })
      expect(await heavy.task.setEffort({ taskId, effort: 'max' })).toEqual({ effort: 'max' })

      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).modelClass).toBe('heavy')
      expect((await heavy.task.feed({ taskId })).task.effort).toBe('max')
      expect(await updatedAt(taskId)).toBe(before)
      // The credits set aside for the attempt stay as they were.
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([1])

      await db.task.update({ where: { id: taskId }, data: { status: 'deploying' } })
      await expect(heavy.task.setEffort({ taskId, effort: 'high' })).rejects.toMatchObject({
        cause: { code: 'RELEASE_IN_PROGRESS' },
      })
      await db.task.update({ where: { id: taskId }, data: { status: 'done' } })
      await expect(heavy.task.setEffort({ taskId, effort: 'high' })).rejects.toMatchObject({
        cause: { code: 'TASK_FINISHED' },
      })
      // Someone else's dialog is not found, to change or to delete.
      const stranger = callerOf(await person(), { client: underRateAndHeavy(db) })
      await expect(stranger.task.setEffort({ taskId, effort: 'low' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      await expect(stranger.task.remove({ taskId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).deletedAt).toBeNull()
    })
  })

  describe('task.feed', () => {})

  describe('task.export (docs/plan/61-chats-first.md, §5.14)', () => {
    it('writes the chat out in the words of the feed, under its name', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, 'Поменяйте телефон в шапке')
      await asked(taskId, {
        kind: 'agent',
        intro: 'Нужно уточнить.',
        questions: [{ text: 'Какой телефон поставить?', options: [] }],
      })

      const file = await caller.task.export({ taskId })

      expect(file.fileName).toBe('Поменяйте телефон в шапке.md')
      expect(file.markdown).toMatch(/^# Поменяйте телефон в шапке\n/u)
      expect(file.markdown).toContain('Вопрос агента')
      expect(file.markdown.indexOf('Поменяйте телефон в шапке', 10)).toBeLessThan(
        file.markdown.indexOf('Какой телефон поставить?'),
      )
    })

    it('holds only what the client sees: the journal of the agent stays out', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      // A row of the feed cannot be hidden (`task_events_feed_visible_check`): a row of the journal
      // would be read as unreadable, so only `clientVisible` keeps that line out of the file.
      await db.taskEvent.create({
        data: {
          taskId,
          type: 'turn.output',
          clientVisible: false,
          payload: { turn: 1, events: [{ type: 'message', text: 'слова журнала' }] },
        },
      })

      const { markdown } = await caller.task.export({ taskId })

      expect(markdown).not.toContain('слова журнала')
      expect(markdown).not.toContain(feedRowText.unreadable)
    })

    it('speaks of the site in a chat of a project', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      await insertFeedEvent(db, {
        taskId,
        row: {
          type: 'feed.failure',
          payload: {
            v: 1,
            turn: null,
            code: 'site_held',
            site: 'unchanged',
            credits: null,
            next: 'awaiting_user',
          },
        } as never,
      })

      expect((await caller.task.export({ taskId })).markdown).toContain(
        'При работе с сайтом произошёл сбой',
      )
    })

    it('reads a chat longer than a page of the feed, in order, and all of it', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      const count = feedLimits.page + 5
      await db.$transaction(
        async (tx) => {
          for (let turn = 1; turn <= count; turn += 1)
            await insertFeedEvent(tx, {
              taskId,
              row: {
                type: 'feed.question',
                payload: {
                  v: 1,
                  turn,
                  kind: 'agent',
                  intro: `Вопрос номер ${turn}.`,
                  questions: [{ text: 'Дальше?', options: [] }],
                },
              } as never,
            })
        },
        { timeout: 30_000 },
      )

      const { markdown } = await caller.task.export({ taskId })

      expect(markdown.match(/Вопрос номер \d+\./gu)).toHaveLength(count)
      expect(markdown.indexOf('Вопрос номер 200.')).toBeLessThan(
        markdown.indexOf(`Вопрос номер ${count}.`),
      )
    })

    it('answers a chat of someone else as one that does not exist', async () => {
      const { owner } = await chatOwner()
      const { taskId } = await newDialog(callerOf(owner))
      const other = await person()

      await expect(callerOf(other).task.export({ taskId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('stands a chat that was removed with one that does not exist', async () => {
      const { owner } = await chatOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller)
      await caller.task.remove({ taskId })

      await expect(caller.task.export({ taskId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  describe('chats without a project (docs/plan/61-chats-first.md, §5.9)', () => {
    const newChat = (caller: ReturnType<typeof callerOf>, attachments?: string[]) =>
      caller.task
        .create({
          taskId: chatId(),
          text: 'Что такое каноническая ссылка?',
          ...(attachments === undefined ? {} : { attachments }),
        })
        .then((created) => created.taskId)
    const giftEntries = (userId: string) =>
      db.creditLedger.count({ where: { idempotencyKey: `user:${userId}:signup-gift` } })
    const workspacesOf = (userId: string) => db.workspace.count({ where: { createdById: userId } })
    const startFile = (caller: ReturnType<typeof callerOf>, name = 'Обложка.jpg') =>
      caller.attachment.start({ name, size: 2048, type: 'image/jpeg' })

    it('exports a chat of its own, which speaks of no site', async () => {
      const owner = await person()
      const caller = callerOf(owner)
      const taskId = await newChat(caller)
      await insertFeedEvent(db, {
        taskId,
        row: {
          type: 'feed.failure',
          payload: {
            v: 1,
            turn: null,
            code: 'site_held',
            site: 'none',
            credits: null,
            next: 'awaiting_user',
          },
        } as never,
      })

      const { fileName, markdown } = await caller.task.export({ taskId })

      expect(fileName).toBe('Что такое каноническая ссылка.md')
      expect(markdown).toContain('Что такое каноническая ссылка?')
      expect(markdown).toContain('Подождите минуту, прежде чем писать дальше.')
      expect(markdown).not.toMatch(/сайт/iu)
    })

    /** What core does at the end of a pass: its chain is charged. */
    const charged = (taskId: string) =>
      db.$transaction((tx) => settleTaskCharge(tx, { taskId, credits: 5, now: new Date() }), {
        isolationLevel: 'ReadCommitted',
      })

    describe('`/compact` (docs/plan/61-chats-first.md, К30, §5.14)', () => {
      /** What core leaves of a completed pass: a turn with a session, its row and its charge. */
      async function finishedChat(caller: ReturnType<typeof callerOf>) {
        const taskId = await newChat(caller)
        await db.$transaction(async (tx) => {
          const words = await tx.taskEvent.findFirst({
            where: { taskId },
            orderBy: { id: 'desc' },
            select: { createdAt: true },
          })
          const startedAt = new Date(Math.max(Date.now(), (words?.createdAt.getTime() ?? 0) + 1))
          await tx.taskTurn.create({
            data: {
              taskId,
              turnNo: 1,
              status: 'completed',
              driverId: 'opencode',
              image: 'synthetic/agent:test',
              nativeSessionId: 'ses_0001',
              startedAt,
              finishedAt: startedAt,
            },
          })
          await tx.task.update({
            where: { id: taskId },
            data: { status: 'awaiting_user', turnNo: 1 },
          })
          await insertFeedEvent(tx, {
            taskId,
            row: {
              type: 'feed.result',
              payload: {
                v: 1,
                turn: 1,
                message: 'Готово.',
                site: 'none',
                next: 'awaiting_user',
                filesChanged: 0,
                changeType: 'none',
                needsApproval: false,
                risk: 'low',
              },
            },
          })
        })
        await db.$transaction(
          (tx) => settleTaskCharge(tx, { taskId, credits: 5, now: new Date() }),
          { isolationLevel: 'ReadCommitted' },
        )
        return taskId
      }
      const verdictOf = async (caller: ReturnType<typeof callerOf>, taskId: string) =>
        (await caller.task.commands({ taskId })).find((item) => item.id === 'compact')?.refusal

      it('writes the command and puts a paid pass, like the next words', async () => {
        const caller = callerOf(await person())
        const taskId = await finishedChat(caller)
        expect(await verdictOf(caller, taskId)).toBeNull()
        const requestId = randomUUID()

        const posted = await caller.task.compact({ taskId, requestId })

        expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
          status: 'queued',
          attempt: 2,
        })
        expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toContain(2)
        expect((await feedOf(taskId)).at(-1)).toMatchObject({
          id: BigInt(posted.requestEventId),
          payload: { kind: 'agent_command', command: 'compact', requestId },
        })
        expect((await outboxOf(taskId)).map((row) => row.dedupeKey)).toContain(
          `turn.run:${taskId}:2:${posted.requestEventId}`,
        )
        expect(await caller.task.compact({ taskId, requestId })).toEqual({
          ...posted,
          repeated: true,
        })
      })

      it('has nothing to compact before a turn ended, or in a session that does not stand', async () => {
        const caller = callerOf(await person())
        const fresh = await newChat(caller)
        const rows = (await feedOf(fresh)).length
        await expect(
          caller.task.compact({ taskId: fresh, requestId: randomUUID() }),
        ).rejects.toMatchObject({
          cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'busy' } },
        })
        expect(await feedOf(fresh)).toHaveLength(rows)

        const other = callerOf(await person())
        const taskId = await finishedChat(other)
        const change = (data: object) => db.taskTurn.updateMany({ where: { taskId }, data })
        await change({ status: 'failed' })
        expect(await verdictOf(other, taskId)).toBe('nothing_to_compact')
        await change({ status: 'completed', rejectedAt: new Date() })
        expect(await verdictOf(other, taskId)).toBe('nothing_to_compact')
        await change({ rejectedAt: null, undoneAt: new Date() })
        expect(await verdictOf(other, taskId)).toBe('nothing_to_compact')
        await change({ undoneAt: null, nativeSessionId: null })
        expect(await verdictOf(other, taskId)).toBe('nothing_to_compact')
        await change({ nativeSessionId: 'ses_0001' })
        expect(await verdictOf(other, taskId)).toBeNull()
      })

      /** The turn `turnNo` as core leaves it, finished after every row of the feed so far. */
      async function turnEnded(
        taskId: string,
        turnNo: number,
        options: { compaction?: boolean } = {},
      ) {
        const newest = await db.taskEvent.findFirst({
          where: { taskId },
          orderBy: { id: 'desc' },
          select: { createdAt: true },
        })
        const startedAt = new Date(Math.max(Date.now(), newest!.createdAt.getTime() + 1))
        await db.taskTurn.create({
          data: {
            taskId,
            turnNo,
            status: 'completed',
            driverId: 'opencode',
            image: 'synthetic/agent:test',
            nativeSessionId: 'ses_0001',
            startedAt,
            finishedAt: startedAt,
          },
        })
        await db.turnAssignment.create({
          data: {
            taskId,
            siteId: taskId,
            sessionId: 'synthetic-session',
            turnNo,
            executor: 'local',
            plan: { input: options.compaction ? { action: 'compact' } : {} },
            firstEpoch: 1,
            leaseEpoch: 1,
            deadlineAt: new Date(startedAt.getTime() + 60_000),
            outcome: 'completed',
            finishedAt: startedAt,
          },
        })
        await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_user', turnNo } })
        await db.$transaction((tx) =>
          insertFeedEvent(tx, {
            taskId,
            row: {
              type: 'feed.result',
              payload: {
                v: 1,
                turn: turnNo,
                message: 'Готово.',
                site: 'none',
                next: 'awaiting_user',
                filesChanged: 0,
                changeType: 'none',
                needsApproval: false,
                risk: 'low',
              },
            },
          }),
        )
      }
      /** A row of the client whose pass ended before it opened a turn. */
      async function unanswered(taskId: string, payload: Record<string, unknown>) {
        await db.$transaction((tx) =>
          insertFeedEvent(tx, {
            taskId,
            row: {
              type: 'feed.request',
              payload: {
                v: 1,
                authorId: randomUUID(),
                requestId: randomUUID(),
                ...payload,
              } as never,
            },
          }),
        )
        await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_user' } })
      }

      it('does not pay for the summary of a summary: words must come between', async () => {
        const caller = callerOf(await person())
        const taskId = await finishedChat(caller)
        await caller.task.compact({ taskId, requestId: randomUUID() })
        await db.task.update({ where: { id: taskId }, data: { status: 'running' } })
        expect(await verdictOf(caller, taskId)).toBe('busy')
        await turnEnded(taskId, 2, { compaction: true })
        expect(await verdictOf(caller, taskId)).toBe('nothing_to_compact')

        await caller.task.message({ taskId, requestId: randomUUID(), text: 'И логотип' })
        await db.task.update({ where: { id: taskId }, data: { status: 'running' } })
        await turnEnded(taskId, 3)
        expect(await verdictOf(caller, taskId)).toBeNull()
      })

      it('does not pay for it after a compaction that a retry or «Продолжить» carried out', async () => {
        for (const press of [{ kind: 'retry' }, { kind: 'continue', questionEventId: '1' }]) {
          const caller = callerOf(await person())
          const taskId = await finishedChat(caller)
          await caller.task.compact({ taskId, requestId: randomUUID() })
          await unanswered(taskId, press)
          await turnEnded(taskId, 2, { compaction: true })
          expect(await verdictOf(caller, taskId)).toBe('nothing_to_compact')
        }
      })

      it('takes it again when a compaction ended before it opened a turn: nothing was shortened', async () => {
        const caller = callerOf(await person())
        const taskId = await finishedChat(caller)
        await caller.task.compact({ taskId, requestId: randomUUID() })
        await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_user' } })
        expect(await verdictOf(caller, taskId)).toBeNull()
        await unanswered(taskId, { kind: 'retry' })
        expect(await verdictOf(caller, taskId)).toBeNull()
      })

      it('refuses it while words the session never saw lie in the chat: they would be lost', async () => {
        const caller = callerOf(await person())
        const taskId = await finishedChat(caller)
        await caller.task.message({ taskId, requestId: randomUUID(), text: 'И логотип' })
        await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_user' } })
        expect(await verdictOf(caller, taskId)).toBe('nothing_to_compact')
        const rows = (await feedOf(taskId)).length
        await expect(
          caller.task.compact({ taskId, requestId: randomUUID() }),
        ).rejects.toMatchObject({
          cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'nothing_to_compact' } },
        })
        expect(await feedOf(taskId)).toHaveLength(rows)
      })

      it('counts an `/init` that opened no turn as words: it has not reached the session', async () => {
        const caller = callerOf(await person())
        const taskId = await finishedChat(caller)
        await unanswered(taskId, { kind: 'agent_command', command: 'init' })
        expect(await verdictOf(caller, taskId)).toBe('nothing_to_compact')
      })

      it('asks first for the answer to a question about credits, as `/undo` does', async () => {
        const caller = callerOf(await person())
        const taskId = await finishedChat(caller)
        await asked(taskId, { kind: 'ceiling', reason: 'credits', spent: 5, held: 5, left: 0 })
        expect(await verdictOf(caller, taskId)).toBe('awaiting_answer')
        await expect(
          caller.task.compact({ taskId, requestId: randomUUID() }),
        ).rejects.toMatchObject({
          cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'awaiting_answer' } },
        })
      })


      it('says when the driver has no compaction, and the command goes nowhere', async () => {
        const owner = await person()
        const caller = callerOf(owner)
        const taskId = await finishedChat(caller)
        const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
        const seen = await db
          .$transaction(async (tx) => {
            await tx.agentDriver.updateMany({ data: { capabilities: { resume: true } } })
            const { commands } = await dialogFacts(tx, task, owner.id)
            throw Object.assign(new Error('rolled back'), { commands })
          })
          .catch((error: { commands: ChatCommandFacts }) => error.commands)
        expect(seen.compaction).toBe(false)
        expect(commandRefusal(seen, 'compact')).toBe('no_compaction')
        expect(await verdictOf(caller, taskId)).toBeNull()
      })
    })

    describe('`/undo` (docs/plan/61-chats-first.md, К29, §5.14)', () => {
      /** What core leaves of a completed pass that answered: the turn, the row, the charge. */
      async function answered(taskId: string, turnNo = 1) {
        await db.$transaction(async (tx) => {
          // Past the words it answers, whichever clock is ahead: core stamps it by the database.
          const words = await tx.taskEvent.findFirst({
            where: { taskId },
            orderBy: { id: 'desc' },
            select: { createdAt: true },
          })
          const startedAt = new Date(Math.max(Date.now(), (words?.createdAt.getTime() ?? 0) + 1))
          await tx.taskTurn.create({
            data: {
              taskId,
              turnNo,
              status: 'completed',
              driverId: 'opencode',
              image: 'synthetic/agent:test',
              startedAt,
              finishedAt: startedAt,
            },
          })
          await tx.task.update({
            where: { id: taskId },
            data: { status: 'awaiting_user', turnNo },
          })
          await insertFeedEvent(tx, {
            taskId,
            row: {
              type: 'feed.result',
              payload: {
                v: 1,
                turn: turnNo,
                message: 'Каноническая ссылка — главный адрес страницы.',
                site: 'none',
                next: 'awaiting_user',
                filesChanged: 0,
                changeType: 'none',
                needsApproval: false,
                risk: 'low',
              },
            },
          })
        })
      }
      /** A completed pass of a chat that was charged, as the next words find it. */
      async function chargedChat(caller: ReturnType<typeof callerOf>) {
        const taskId = await newChat(caller)
        await answered(taskId)
        await charged(taskId)
        return taskId
      }
      const verdictOf = async (caller: ReturnType<typeof callerOf>, taskId: string) =>
        (await caller.task.commands({ taskId })).find((item) => item.id === 'turn_undo')?.refusal
      const moneyOf = async (taskId: string, workspaceId: string) => ({
        holds: await db.creditHold.findMany({ where: { taskId }, orderBy: { id: 'asc' } }),
        ledger: await db.creditLedger.findMany({
          where: { account: { workspaceId } },
          orderBy: { id: 'asc' },
        }),
        accounts: await db.billingAccount.findMany({
          where: { workspaceId },
          orderBy: { id: 'asc' },
        }),
      })

      it('takes the last turn back, gives the words to the field and moves no money', async () => {
        const caller = callerOf(await person())
        const taskId = await chargedChat(caller)
        const { workspaceId, attempt } = await db.task.findUniqueOrThrow({ where: { id: taskId } })
        const money = await moneyOf(taskId, workspaceId)
        expect(await verdictOf(caller, taskId)).toBeNull()
        const requestId = randomUUID()

        const undone = await caller.task.undoTurn({ taskId, requestId })

        expect(undone).toMatchObject({
          repeated: false,
          words: 'Что такое каноническая ссылка?',
        })
        const turn = await db.taskTurn.findUniqueOrThrow({
          where: { taskId_turnNo: { taskId, turnNo: 1 } },
        })
        expect(turn.undoneAt).toBeInstanceOf(Date)
        // Not a rejection: that one takes the money off the turn.
        expect(turn.rejectedAt).toBeNull()
        expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
          status: 'awaiting_user',
          turnNo: 1,
          attempt,
        })
        expect((await feedOf(taskId)).slice(-2)).toMatchObject([
          {
            id: BigInt(undone.requestEventId),
            type: 'feed.request',
            payload: { kind: 'command', command: 'turn_undo', requestId },
          },
          { type: 'feed.rewind', payload: { turn: 1, files: false, site: 'none' } },
        ])
        expect(await moneyOf(taskId, workspaceId)).toEqual(money)
        // No job: nothing is put for core, and nothing runs the model.
        expect((await outboxOf(taskId)).map((row) => row.type)).toEqual(['turn.run'])

        // A repeat comes when the first answer was lost: the words must not be lost with it.
        const rows = (await feedOf(taskId)).length
        expect(await caller.task.undoTurn({ taskId, requestId })).toEqual({
          requestEventId: undone.requestEventId,
          repeated: true,
          words: 'Что такое каноническая ссылка?',
        })
        expect(await feedOf(taskId)).toHaveLength(rows)
        expect(await verdictOf(caller, taskId)).toBe('nothing_to_undo')
        await expect(
          caller.task.undoTurn({ taskId, requestId: randomUUID() }),
        ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Отменять пока нечего' })
      })

      it('gives back the words of that turn alone', async () => {
        const caller = callerOf(await person())
        const taskId = await chargedChat(caller)
        await caller.task.message({ taskId, requestId: randomUUID(), text: 'Покажите пример' })
        await answered(taskId, 2)
        await charged(taskId)
        expect(await caller.task.undoTurn({ taskId, requestId: randomUUID() })).toMatchObject({
          words: 'Покажите пример',
        })
      })

      it('gives no words to a repeat once the chat moved on from that `/undo`', async () => {
        const caller = callerOf(await person())
        const taskId = await chargedChat(caller)
        const requestId = randomUUID()
        await caller.task.undoTurn({ taskId, requestId })
        await caller.task.message({ taskId, requestId: randomUUID(), text: 'Другой вопрос' })
        expect(await caller.task.undoTurn({ taskId, requestId })).toMatchObject({
          repeated: true,
          words: null,
        })
      })

      it('takes the turn that answered, not the one before words whose pass never opened a turn', async () => {
        const caller = callerOf(await person())
        const taskId = await chargedChat(caller)
        await caller.task.message({ taskId, requestId: randomUUID(), text: 'Покажите пример' })
        // The pass failed before it opened a turn: `turn_no` stays, nothing is rejected.
        await db.$transaction(async (tx) => {
          await tx.task.update({ where: { id: taskId }, data: { status: 'awaiting_user' } })
          await insertFeedEvent(tx, {
            taskId,
            row: {
              type: 'feed.failure',
              payload: {
                v: 1,
                turn: null,
                code: 'technical',
                site: 'none',
                credits: null,
                next: 'awaiting_user',
              },
            },
          })
        })

        expect(await verdictOf(caller, taskId)).toBe('nothing_to_undo')
        await expect(
          caller.task.undoTurn({ taskId, requestId: randomUUID() }),
        ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Отменять пока нечего' })
        const turn = await db.taskTurn.findUniqueOrThrow({
          where: { taskId_turnNo: { taskId, turnNo: 1 } },
        })
        expect(turn.undoneAt).toBeNull()
      })

      it('gives back the words the turn answered and none written after it started', async () => {
        const caller = callerOf(await person())
        const taskId = await chargedChat(caller)
        await caller.task.message({ taskId, requestId: randomUUID(), text: 'Покажите пример' })
        await answered(taskId, 2)
        await caller.task.message({ taskId, requestId: randomUUID(), text: 'Уже другой вопрос' })
        expect(await wordsOfTurn(db, taskId, 2)).toBe('Покажите пример')
      })

      it('closes a question of the undone turn, and the next words go on from the row', async () => {
        const caller = callerOf(await person())
        const taskId = await chargedChat(caller)
        const question = await db.$transaction((tx) =>
          insertFeedEvent(tx, {
            taskId,
            row: {
              type: 'feed.question',
              payload: {
                v: 1,
                kind: 'agent',
                turn: 1,
                intro: 'Уточните.',
                questions: [{ text: 'Какой адрес?', options: [] }],
              },
            },
          }),
        )
        await caller.task.undoTurn({ taskId, requestId: randomUUID() })
        const rewind = (await feedOf(taskId)).at(-1)!
        expect(rewind.id).toBeGreaterThan(question)
        // The list does not say the chat waits for the client.
        expect((await caller.task.list({})).items).toMatchObject([
          { id: taskId, answered: true, rewound: true },
        ])

        const posted = await caller.task.message({
          taskId,
          requestId: randomUUID(),
          text: 'Другой вопрос',
        })

        expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
          status: 'queued',
          attempt: 2,
        })
        expect((await feedOf(taskId)).at(-1)).toMatchObject({
          id: BigInt(posted.requestEventId),
          payload: { kind: 'answer', answersEventId: String(rewind.id) },
        })
      })

      it('says what stays by the writes of the whole chat, not of the turn', async () => {
        const { owner, workspaceId } = await chatOwner()
        const caller = callerOf(owner)
        const browserChat = async () => {
          const task = await db.task.create({
            data: {
              id: chatId(),
              workspaceId,
              needsBrowser: true,
              status: 'awaiting_user',
            },
          })
          await answered(task.id)
          return task.id
        }
        const quiet = await browserChat()
        await openBrowserSession(db, { taskId: quiet })
        await caller.task.undoTurn({ taskId: quiet, requestId: randomUUID() })
        expect((await feedOf(quiet)).at(-1)?.payload).toMatchObject({ site: 'none' })

        const acted = await browserChat()
        const session = await openBrowserSession(db, { taskId: acted })
        await db.browserSession.update({
          where: { id: session.id },
          data: { wroteAt: new Date() },
        })
        await caller.task.undoTurn({ taskId: acted, requestId: randomUUID() })
        expect((await feedOf(acted)).at(-1)?.payload).toMatchObject({ site: 'elsewhere' })
      })

      it('takes only a turn that completed, with its result taken, while nothing works', async () => {
        const fresh = callerOf(await person())
        const queued = await newChat(fresh)
        expect(await verdictOf(fresh, queued)).toBe('busy')
        await db.task.update({ where: { id: queued }, data: { status: 'awaiting_user' } })
        expect(await verdictOf(fresh, queued)).toBe('nothing_to_undo')

        const caller = callerOf(await person())
        const taskId = await chargedChat(caller)
        await db.taskTurn.updateMany({ where: { taskId }, data: { status: 'failed' } })
        expect(await verdictOf(caller, taskId)).toBe('nothing_to_undo')
        await db.taskTurn.updateMany({
          where: { taskId },
          data: { status: 'completed', rejectedAt: new Date() },
        })
        expect(await verdictOf(caller, taskId)).toBe('nothing_to_undo')
        await db.taskTurn.updateMany({ where: { taskId }, data: { rejectedAt: null } })
        expect(await verdictOf(caller, taskId)).toBeNull()
        await db.task.update({
          where: { id: taskId },
          data: { status: 'cancelled', finishedAt: new Date() },
        })
        expect(await verdictOf(caller, taskId)).toBe('finished')
      })

      it('asks first for the answer to a question about credits: its pass has not run', async () => {
        const caller = callerOf(await person())
        const taskId = await chargedChat(caller)
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
        expect(await verdictOf(caller, taskId)).toBe('awaiting_answer')
      })


      describe('`/redo` (docs/plan/61-chats-first.md, §5.14)', () => {
        const redoVerdict = async (caller: ReturnType<typeof callerOf>, taskId: string) =>
          (await caller.task.commands({ taskId })).find((item) => item.id === 'turn_redo')?.refusal
        const listed = async (caller: ReturnType<typeof callerOf>, taskId: string) =>
          (await caller.task.list({})).items.find((item) => item.id === taskId)
        const question = (taskId: string, turn: number) =>
          db.$transaction((tx) =>
            insertFeedEvent(tx, {
              taskId,
              row: {
                type: 'feed.question',
                payload: {
                  v: 1,
                  kind: 'agent',
                  turn,
                  intro: 'Уточните.',
                  questions: [{ text: 'Какой телефон поставить?', options: [] }],
                },
              },
            }),
          )

        it('brings the turn back: the chat answered again, the words given, no money moved', async () => {
          const caller = callerOf(await person())
          const taskId = await chargedChat(caller)
          const { workspaceId } = await db.task.findUniqueOrThrow({ where: { id: taskId } })
          expect(await redoVerdict(caller, taskId)).toBe('nothing_to_redo')
          await caller.task.undoTurn({ taskId, requestId: randomUUID() })
          expect(await listed(caller, taskId)).toMatchObject({ answered: true, rewound: true })
          expect(await redoVerdict(caller, taskId)).toBeNull()
          const money = await moneyOf(taskId, workspaceId)
          const requestId = randomUUID()

          const redone = await caller.task.redoTurn({ taskId, requestId })

          expect(redone).toMatchObject({ repeated: false, words: 'Что такое каноническая ссылка?' })
          const turn = await db.taskTurn.findUniqueOrThrow({
            where: { taskId_turnNo: { taskId, turnNo: 1 } },
          })
          expect(turn.undoneAt).toBeNull()
          expect((await feedOf(taskId)).slice(-2)).toMatchObject([
            {
              id: BigInt(redone.requestEventId),
              type: 'feed.request',
              payload: { kind: 'command', command: 'turn_redo', requestId },
            },
            { type: 'feed.redo', payload: { v: 1, turn: 1, files: false, open: false } },
          ])
          expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
            status: 'awaiting_user',
            turnNo: 1,
          })
          // As if the two rows were not there: «Агент ответил», not «Запрос отменён».
          expect(await listed(caller, taskId)).toMatchObject({ answered: true, rewound: false })
          expect(await moneyOf(taskId, workspaceId)).toEqual(money)
          expect((await outboxOf(taskId)).map((row) => row.type)).toEqual(['turn.run'])

          const rows = (await feedOf(taskId)).length
          expect(await caller.task.redoTurn({ taskId, requestId })).toEqual({
            ...redone,
            repeated: true,
          })
          expect(await feedOf(taskId)).toHaveLength(rows)
          expect(await redoVerdict(caller, taskId)).toBe('nothing_to_redo')
          await expect(
            caller.task.redoTurn({ taskId, requestId: randomUUID() }),
          ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Возвращать нечего' })
        })

        it('takes the same turn back and forth, and the last press decides', async () => {
          const caller = callerOf(await person())
          const taskId = await chargedChat(caller)
          await caller.task.undoTurn({ taskId, requestId: randomUUID() })
          await caller.task.redoTurn({ taskId, requestId: randomUUID() })
          expect(await verdictOf(caller, taskId)).toBeNull()
          await caller.task.undoTurn({ taskId, requestId: randomUUID() })
          expect(await listed(caller, taskId)).toMatchObject({ rewound: true })
          await caller.task.redoTurn({ taskId, requestId: randomUUID() })
          expect(await listed(caller, taskId)).toMatchObject({ answered: true, rewound: false })
          // The next words answer the result the chat waited after, not the `/undo` it took back.
          const result = await db.taskEvent.findFirstOrThrow({
            where: { taskId, type: 'feed.result' },
          })
          await caller.task.message({ taskId, requestId: randomUUID(), text: 'Покажите пример' })
          expect((await feedOf(taskId)).at(-1)).toMatchObject({
            type: 'feed.request',
            payload: { kind: 'answer', answersEventId: String(result.id) },
          })
        })

        it('opens the question of the turn again, and the words answer it', async () => {
          const caller = callerOf(await person())
          const taskId = await chargedChat(caller)
          const asked = await question(taskId, 1)
          await caller.task.undoTurn({ taskId, requestId: randomUUID() })
          await caller.task.redoTurn({ taskId, requestId: randomUUID() })

          expect(await listed(caller, taskId)).toMatchObject({ answered: false, rewound: false })
          await caller.task.message({ taskId, requestId: randomUUID(), text: '+7 495 000-00-00' })
          expect((await feedOf(taskId)).at(-1)).toMatchObject({
            payload: { kind: 'answer', answersEventId: String(asked) },
          })
        })

        it('brings back nothing after the next words, nor after their turn', async () => {
          const caller = callerOf(await person())
          const taskId = await chargedChat(caller)
          await caller.task.undoTurn({ taskId, requestId: randomUUID() })
          await caller.task.message({ taskId, requestId: randomUUID(), text: 'Другой вопрос' })
          expect(await redoVerdict(caller, taskId)).toBe('nothing_to_redo')
          await expect(
            caller.task.redoTurn({ taskId, requestId: randomUUID() }),
          ).rejects.toMatchObject({ cause: { details: { refusal: 'nothing_to_redo' } } })

          // The pass that followed failed and left the chat open: the words still stand.
          await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_user' } })
          expect(await redoVerdict(caller, taskId)).toBe('nothing_to_redo')

          await answered(taskId, 2)
          await charged(taskId)
          expect(await redoVerdict(caller, taskId)).toBe('nothing_to_redo')
        })

        it('is refused in a chat that ended', async () => {
          const caller = callerOf(await person())
          const taskId = await chargedChat(caller)
          await caller.task.undoTurn({ taskId, requestId: randomUUID() })
          await db.task.update({
            where: { id: taskId },
            data: { status: 'cancelled', finishedAt: new Date() },
          })
          expect(await redoVerdict(caller, taskId)).toBe('finished')
        })

      })
    })

    /** A file of `start` as `PUT /api/attachments/<id>` leaves it. */
    async function storedFile(caller: ReturnType<typeof callerOf>): Promise<string> {
      const { attachmentId } = await startFile(caller)
      await markAttachmentReady(db, {
        id: attachmentId,
        sizeBytes: 2048,
        contentType: 'image/jpeg',
      })
      return attachmentId
    }

    it('gives it the browser where the platform has one', async () => {
      const taskId = await newChat(callerOf(await person(), { browser: true }))
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        needsBrowser: true,
      })
    })

    it('makes one workspace and one gift, whichever of a chat and a file comes first', async () => {
      const user = await person()
      const caller = callerOf(user)

      const fileId = await storedFile(caller)
      expect(await workspacesOf(user.id)).toBe(1)
      expect(await giftEntries(user.id)).toBe(1)

      const taskId = await newChat(caller, [fileId])
      await startFile(caller, 'Второй снимок.jpg')
      expect(await workspacesOf(user.id)).toBe(1)
      expect(await giftEntries(user.id)).toBe(1)
      expect(await db.attachment.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({
        taskId,
        status: 'bound',
      })
    })

    it('makes nothing for a file the rules refuse', async () => {
      const user = await person()
      await expect(
        callerOf(user).attachment.start({
          name: 'скрипт.php',
          size: 2048,
          type: 'image/jpeg',
        }),
      ).rejects.toMatchObject({ cause: { code: 'ATTACHMENT_REFUSED' } })
      expect(await workspacesOf(user.id)).toBe(0)
      expect(await giftEntries(user.id)).toBe(0)
    })

    it('refuses an id of any other version and writes nothing', async () => {
      const user = await person()
      const taskId = randomUUID()
      await expect(callerOf(user).task.create({ taskId, text: 'Вопрос' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'TASK_ID_INVALID' },
      })
      expect(await db.task.count({ where: { id: taskId } })).toBe(0)
      expect(await workspacesOf(user.id)).toBe(0)
    })

    it('never lands in a workspace of client data outside production', async () => {
      const user = await person()
      const earlier = await db.$transaction((tx) =>
        ensurePersonalWorkspace(tx, { userId: user.id, appEnv: 'test' }),
      )
      await db.workspace.update({ where: { id: earlier.id }, data: { dataClass: 'client' } })

      const taskId = await newChat(callerOf(user))

      const { workspace } = await db.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { workspace: { select: { id: true, dataClass: true } } },
      })
      expect(workspace.id).not.toBe(earlier.id)
      expect(workspace.dataClass).toBe('synthetic')
    })

    it('returns the same chat to a repeat, and to nobody else', async () => {
      const user = await person()
      const caller = callerOf(user)
      const taskId = chatId()
      const input = { taskId, text: 'Вопрос' }
      const first = await caller.task.create(input)
      expect(first.created).toBe(true)
      expect(await caller.task.create(input)).toEqual({ ...first, created: false })
      expect(await db.creditHold.count({ where: { taskId } })).toBe(1)

      const { owner } = await chatOwner()
      await expect(callerOf(owner).task.create(input)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('takes the second message and the third, with a file and without one', async () => {
      const user = await person()
      const caller = callerOf(user)
      const taskId = await newChat(caller)
      const question = {
        kind: 'agent',
        intro: 'Нужно уточнить.',
        questions: [{ text: 'Какой сайт вы имеете в виду?', options: [] }],
      }

      // The reserve of the pass is still there: the words go on under it.
      await asked(taskId, question)
      const first = await caller.task.message({ taskId, requestId: randomUUID(), text: 'Этот' })
      expect(first.repeated).toBe(false)
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([1])

      // The pass was charged, as every completed one is: the words open a chain of their own.
      await charged(taskId)
      await asked(taskId, question)
      const fileId = await storedFile(caller)
      await caller.task.message({
        taskId,
        requestId: randomUUID(),
        text: 'Вот снимок',
        attachments: [fileId],
      })
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
      })
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([2])
      expect(await db.attachment.findUniqueOrThrow({ where: { id: fileId } })).toMatchObject({
        taskId,
        status: 'bound',
      })

      await charged(taskId)
      await asked(taskId, question)
      await caller.task.message({ taskId, requestId: randomUUID(), text: 'И ещё' })
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([3])

    })

    it('takes «Продолжить» after a charged pass, in a chain of its own', async () => {
      const user = await person()
      const caller = callerOf(user)
      const taskId = await newChat(caller)
      await charged(taskId)
      await asked(taskId, { kind: 'ceiling', reason: 'step', spent: 30, held: 35, left: 5 })

      await caller.task.continue({ taskId, requestId: randomUUID() })

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
      })
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([2])
    })

    /** Chats of a workspace as rows: the list and the folders read nothing else of them. */
    async function chats(
      workspaceId: string,
      siteId: string | null,
      rows: ReadonlyArray<{ status?: 'done' | 'awaiting_user' | 'awaiting_approval' }>,
    ) {
      const made = []
      for (const row of rows) {
        const id = siteId === null ? chatId() : randomUUID()
        taskIds.push(id)
        made.push(
          await db.task.create({
            data: {
              id,
              workspaceId,
              siteId,
              status: row.status ?? 'done',
              needsBrowser: true,
              title: 'Чат',
            },
          }),
        )
      }
      return made
    }

    /** The order of the list: the latest changed first, the id tells two of one moment apart. */
    const newestFirst = <Row extends { id: string; updatedAt: Date }>(rows: readonly Row[]) =>
      rows
        .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1))
        .map((row) => row.id)

    it('walks the pages of the list by the cursor, in the format it always had', async () => {
      const { owner, workspaceId } = await chatOwner()
      const caller = callerOf(owner)
      const rows = await chats(
        workspaceId,
        null,
        Array.from({ length: 53 }, () => ({})),
      )

      const first = await caller.task.list({})
      expect(first.items).toHaveLength(50)
      expect(first.nextCursor).toMatch(/^\d{1,17}_[0-9a-f-]{36}$/u)
      const second = await caller.task.list({ cursor: first.nextCursor! })
      expect(second.items).toHaveLength(3)
      expect(second.nextCursor).toBeNull()
      expect([...first.items, ...second.items].map((item) => item.id)).toEqual(newestFirst(rows))
    })

    it('reads a page through the index of the workspace, not all of its chats', async () => {
      const { owner, workspaceId } = await chatOwner()
      const rows = await chats(
        workspaceId,
        null,
        Array.from({ length: 60 }, () => ({})),
      )
      const [plain, paged] = await db.$transaction(async (tx) => {
        // A table of a few rows is cheaper read and sorted: these leave the planner what it takes
        // on a full table, the order of the index under the LIMIT (measured on 20 000 chats).
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`
        await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`
        await tx.$executeRaw`SET LOCAL enable_sort = off`
        const explain = async (cursor?: string) => {
          const query = dialogPageQuery({ userId: owner.id, cursor })
          const lines = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(
            Prisma.sql`EXPLAIN (ANALYZE, TIMING OFF, SUMMARY OFF) ${query}`,
          )
          return lines.map((line) => line['QUERY PLAN']).join('\n')
        }
        const middle = rows[0]!.updatedAt.getTime() * 1000 + 1
        return [await explain(), await explain(`${middle}_${rows[0]!.id}`)]
      })
      // 51 of the 60: the rest of the workspace is not read for this page.
      expect(plain).toMatch(/Index Scan using tasks_workspace_updated_idx .* rows=51 /u)
      // The cursor is a condition of the index, not a filter of what it has read.
      expect(paged).toMatch(/tasks_workspace_updated_idx.*\n\s+Index Cond: .*updated_at/u)
    })
  })

  // The owner, 06.11.2026: «при сохранении файл должен сохраняться в агента, а потом по
  // возможности комититься в гит».
  describe('Telegram, the second channel of the chat (docs/plan/80-telegram.md)', () => {
    const base = 9_000_000_000 + randomInt(1_000_000_000)
    let next = 0
    const updateIds: number[] = []
    const chatId = () => 700_000_000 + randomInt(100_000_000)
    afterEach(async () => {
      await db.telegramUpdate.deleteMany({
        where: { updateId: { in: updateIds.splice(0).map(BigInt) } },
      })
      await db.outboxEvent.deleteMany({ where: { topic: 'telegram' } })
    })

    function chatOf(): ChatContext {
      return {
        appEnv: 'test',
        browser: null,
        storage: () => storage,
        secrets: () => vault.secrets,
        telegramBot: 'raditi_bot',
      }
    }

    function deliver(body: unknown, media: TelegramMedia | null = null) {
      const update = readTelegramUpdate(body)
      if (!update) throw new Error('not an update')
      updateIds.push(update.updateId)
      return handleTelegramUpdate(
        { db: underRate(db), chat: chatOf(), appUrl: 'https://raditi.example.ru', media },
        update,
      )
    }

    const words = (from: number, text: string, extra: Record<string, unknown> = {}) => ({
      update_id: base + next++,
      message: {
        message_id: next,
        date: Math.floor(Date.now() / 1000),
        chat: { id: from, type: 'private' },
        from: { id: from, is_bot: false, username: 'client' },
        text,
        ...extra,
      },
    })

    const said = async () =>
      (
        await db.outboxEvent.findMany({
          where: { topic: 'telegram', type: 'telegram.send' },
          orderBy: { id: 'asc' },
          select: { payload: true },
        })
      ).map(({ payload }) => payload as { text: string; chatId: string; buttons?: unknown })

    async function linked(from: number) {
      const { owner, workspaceId } = await chatOwner()
      const caller = callerOf(owner)
      const { url } = await caller.telegram.link()
      const code = new URL(url).searchParams.get('start')!
      expect(url).toBe(`https://t.me/raditi_bot?start=${code}`)
      await deliver(words(from, `/start ${code}`))
      return { owner, workspaceId, caller }
    }

    it('links Telegram by a one-time code and answers once for a repeated update', async () => {
      const from = chatId()
      const { owner, caller } = await linked(from)
      expect(await caller.telegram.status()).toMatchObject({
        available: true,
        bot: 'raditi_bot',
        linked: { username: 'client' },
        notifications: true,
      })
      expect((await said()).at(-1)?.text).toMatch(/^Telegram подключён/u)
      // The same code a second time links nothing.
      const reuse = words(chatId(), '/start AAAAAAAA')
      await deliver(reuse)
      expect((await said()).at(-1)?.text).toMatch(/устарела или уже использована/u)
      // The update handed again by core: nothing more is said.
      const before = (await said()).length
      const update = readTelegramUpdate(reuse)!
      expect(
        await handleTelegramUpdate(
          { db: underRate(db), chat: chatOf(), appUrl: 'https://raditi.example.ru', media: null },
          update,
        ),
      ).toBe('repeated')
      expect(await said()).toHaveLength(before)
      await caller.telegram.unlink()
      expect(
        await db.channelIdentity.count({ where: { userId: owner.id, channel: 'telegram' } }),
      ).toBe(0)
    })

    it('starts a chat once when its update is handed again after a failure, and unlinking unbinds it', async () => {
      const from = chatId()
      const { owner, caller } = await linked(from)
      const first = words(from, 'Поменяйте телефон в шапке')
      // The first delivery started the chat and failed before the update was kept.
      await deliver(first)
      await db.telegramUpdate.deleteMany({ where: { updateId: BigInt(first.update_id) } })
      await deliver(first)
      const tasks = await db.task.findMany({
        where: { createdById: owner.id },
        select: { id: true, chatSessionId: true },
      })
      expect(tasks).toHaveLength(1)
      taskIds.push(tasks[0]!.id)
      expect(await db.taskQueuedMessage.count({ where: { taskId: tasks[0]!.id } })).toBe(0)
      // Unlinking stops the chat going to this Telegram account (rule 1).
      await caller.telegram.unlink()
      expect(
        await db.chatSession.findUniqueOrThrow({
          where: { id: tasks[0]!.chatSessionId! },
          select: { channel: true, externalChatId: true },
        }),
      ).toEqual({ channel: 'telegram', externalChatId: null })
    })

    it('never repeats a password said in a voice, and starts nothing of it', async () => {
      const from = chatId()
      const { owner } = await linked(from)
      const before = (await said()).length
      await deliver(words(from, '', { text: undefined, voice: { file_id: 'v', duration: 4 } }), {
        attach: vi.fn(),
        transcribe: vi.fn(async () => ({ text: 'пароль Qwerty123!' })),
      })
      const answers = (await said()).slice(before).map(({ text }) => text)
      expect(answers.some((text) => text.includes('Qwerty123'))).toBe(false)
      expect(await db.task.count({ where: { createdById: owner.id } })).toBe(0)
    })

    it('takes a file through the media of web and refuses a voice without them', async () => {
      const from = chatId()
      const { owner } = await linked(from)
      await deliver(words(from, '', { text: undefined, voice: { file_id: 'v', duration: 3 } }))
      expect((await said()).at(-1)?.text).toBe(
        'Пока принимаю только текст. Напишите словами, что сделать.',
      )
      const attach = vi.fn<TelegramMedia['attach']>(async () => ({
        refused: 'Такой файл не подходит.',
      }))
      await deliver(
        words(from, '', {
          text: undefined,
          caption: 'Вот прайс',
          document: { file_id: 'd', file_name: 'прайс.exe' },
        }),
        { attach, transcribe: vi.fn() },
      )
      expect(attach).toHaveBeenCalledWith(
        expect.objectContaining({ userId: owner.id, fileId: 'd', name: 'прайс.exe' }),
      )
      expect((await said()).at(-1)?.text).toBe('Такой файл не подходит.')
      expect(await db.task.count({ where: { createdById: owner.id } })).toBe(0)
    })
  })
})
