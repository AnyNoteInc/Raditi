import { createHash, randomInt, randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift, grantTariffCredits } from '@repo/billing'
import { underPrivateCreditRate } from '@repo/billing/testing'
import { createPrismaClient, insertFeedEvent, Prisma, type PrismaClient, type User } from '@repo/db'
import {
  browserScreenshotKey,
  legalDocuments,
  type DbPlanView,
  releaseKeyMaterial,
  type KvMetadata,
  type KvWriteOptions,
  type ObjectStorage,
  type SecretStore,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import { readCheckScreenshot } from '../services/chat/candidates.ts'
import { releaseConfirmKey, type ChatContext } from '../services/chat/context.ts'
import { signConfirmToken } from '../services/chat/releases.ts'
import { signUndoConfirmToken } from '../services/chat/undo.ts'

// The procedures of a dialog on PostgreSQL (docs/plan/53-chat-preview-release.md, R2): what one
// transaction writes together, what a repeat writes again (nothing), and what a refusal leaves
// (nothing). Every test works in a workspace of its own; `cleanup` removes what it wrote.

const databaseUrl = process.env.DATABASE_URL

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)
const ADDRESS = { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 } as const
const KEY = releaseConfirmKey('a-secret-of-the-sessions-of-this-test-of-dialogs')
const SHA = (digit: string) => digit.repeat(40)

/**
 * Vault KV v2 in memory, with CAS and `max_versions`: what `sites-writer` may do, and what the
 * test may look at. Without `maxVersions` a key keeps its history, as the `kv/` mount does.
 */
function memoryVault() {
  const keys = new Map<string, { version: number; data: Record<string, string> }[]>()
  const store = {
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
  return { secrets: store as unknown as SecretStore, keys }
}

/**
 * The process-wide client with every writing transaction (READ COMMITTED, as the writers of
 * @repo/billing require) run under a credit rate no other transaction sees
 * (`underPrivateCreditRate`): a reserve needs a usable rate, and this database may be shared
 * with suites that expect none. Reads in a snapshot of their own are left as they are.
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
                    (work as (client: typeof tx) => Promise<unknown>)(tx),
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

/** How the class `heavy` stands for a retry (`underHeavyModel`). */
interface HeavyModel {
  /** When its price starts: before any private credit rate unless told otherwise. */
  priceFrom?: Date
  /** false — its provider is left as the seeds have it: switched off. */
  provider?: boolean
}

/**
 * Runs `work` with the seeded model of the class `heavy` and its provider switched on and the
 * model priced, in the caller's transaction alone: the price row is written before the work and
 * deleted after it, and the switches are put back, so the database is left as every other suite
 * expects. «Попробовать ещё» moves a dialog to `heavy` and asks first whether a pass of it could
 * run: the profile the planner takes, with a price. The price starts before any private credit
 * rate (`underPrivateCreditRate`), which so stays usable, unless `priceFrom` says otherwise.
 */
async function underHeavyModel<T>(
  tx: Prisma.TransactionClient,
  work: () => Promise<T>,
  options: HeavyModel = {},
): Promise<T> {
  const model = await tx.llmModel.findFirst({
    where: { modelClass: 'heavy', providerModelId: { not: null } },
    orderBy: [{ slug: 'asc' }, { provider: { slug: 'asc' } }],
    select: { id: true, enabled: true, provider: { select: { id: true, enabled: true } } },
  })
  if (model === null) throw new Error('The seeds have no model of the class heavy')
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

/** `underRate` with the class `heavy` priced as well (`underHeavyModel`). */
function underRateAndHeavy(db: PrismaClient, heavy: HeavyModel = {}): PrismaClient {
  return new Proxy(db, {
    get(target, property) {
      if (property === '$transaction') {
        return (work: unknown, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) =>
          typeof work === 'function' && options?.isolationLevel === 'ReadCommitted'
            ? target.$transaction(
                (tx) =>
                  underPrivateCreditRate(tx, () =>
                    underHeavyModel(
                      tx,
                      () => (work as (client: typeof tx) => Promise<unknown>)(tx),
                      heavy,
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
    const previews = await db.previewEnvironment.findMany({
      where: { taskId: { in: tasks } },
      select: { id: true },
    })
    await db.outboxEvent.deleteMany({
      where: { OR: previews.map(({ id }) => ({ dedupeKey: { contains: id } })) },
    })
    const releases = await db.siteRelease.findMany({
      where: { taskId: { in: tasks } },
      select: { id: true },
    })
    await db.outboxEvent.deleteMany({
      where: { OR: releases.map(({ id }) => ({ dedupeKey: { contains: id } })) },
    })
    const undoPlans = await db.releaseUndoPlan.findMany({
      where: { release: { taskId: { in: tasks } } },
      select: { id: true },
    })
    await db.outboxEvent.deleteMany({
      where: { OR: undoPlans.map(({ id }) => ({ dedupeKey: { contains: id } })) },
    })
    // An undo names the release it undoes and its plan: it goes first.
    await db.siteRelease.deleteMany({ where: { taskId: { in: tasks }, kind: 'undo' } })
    await db.releaseUndoPlan.deleteMany({ where: { id: { in: undoPlans.map(({ id }) => id) } } })
    await db.siteRelease.deleteMany({ where: { taskId: { in: tasks } } })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.giftSiteClaim.deleteMany({ where: owned })
    // The journal of a content write, which a few tests write as core would.
    await db.mcpCall.deleteMany({ where: { turn: { task: owned } } })
    await db.snapshot.deleteMany({ where: { site: owned } })
    await db.turnAssignment.deleteMany({ where: { site: owned } })
    await db.task.deleteMany({ where: owned })
    await db.siteEnvVar.deleteMany({ where: { site: owned } })
    await db.credentialRef.deleteMany({ where: owned })
    await db.site.deleteMany({ where: owned })
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

  function callerOf(user: User, options: { client?: PrismaClient; preview?: boolean } = {}) {
    const chat: ChatContext = {
      appEnv: 'test',
      preview: options.preview === false ? null : { address: ADDRESS, ttlHours: 72 },
      releaseConfirmKey: KEY,
      storage: () => storage,
      secrets: () => vault.secrets,
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

  /** An owner with the gift of the registration and an active site of their workspace. */
  async function siteOwner(options: { database?: boolean } = {}) {
    const owner = await person()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId: owner.id, appEnv: 'test' }),
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
    if (options.database) {
      await db.credentialRef.create({
        data: {
          kind: 'db',
          workspaceId: workspace.id,
          siteId: site.id,
          vaultPath: `kv/sites/${site.id}/db`,
        },
      })
    }
    return { owner, workspaceId: workspace.id, site }
  }

  /**
   * A paid tariff of a month with its credits, for a workspace that needs more than the gift:
   * a plan of its own, never on sale, its paid order and the quota granted by that order.
   */
  async function paidTariff(workspaceId: string) {
    const plan = await db.plan.create({
      data: {
        slug: `test-${randomUUID()}`,
        name: 'Проверочный',
        kind: 'quota',
        price: '4900.00',
        creditsPerMonth: 300,
        maxSites: 3,
        isActive: false,
      },
    })
    planIds.push(plan.id)
    const start = new Date(Date.now() - 24 * 3600 * 1000)
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

  async function newDialog(
    caller: ReturnType<typeof callerOf>,
    siteId: string,
    text = 'Поменяйте телефон в шапке сайта',
  ) {
    const taskId = randomUUID()
    taskIds.push(taskId)
    return { taskId, created: await caller.task.create({ siteId, taskId, text }) }
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

  /**
   * What core does when a pass leaves a candidate: the row and the move. A theme file is changed
   * by default; `media` adds files of the media path, counted in the facts as core counts them.
   */
  async function withCandidate(
    taskId: string,
    revision = 1,
    options: { media?: number; view?: DbPlanView; plan?: { plan: unknown[]; sha256: string } } = {},
  ) {
    const media = Array.from({ length: options.media ?? 0 }, (_, index) => ({
      path: `wp-content/uploads/raditi/photo-${index}.webp`,
      contentType: 'image/webp',
      sizeBytes: 2048,
      sha256: String(index).repeat(64),
    }))
    const candidate = await db.taskCandidate.create({
      data: {
        taskId,
        revision,
        media,
        turnNo: 1,
        baseSha: SHA('a'),
        baseTree: SHA('b'),
        headSha: SHA('c'),
        files: [
          {
            path: 'wp-content/themes/cafe/header.php',
            change: 'modified',
            sizeBytes: 120,
            executable: false,
          },
        ],
        dbPlanSha256: options.plan?.sha256 ?? '0'.repeat(64),
        ...(options.plan ? { dbPlan: options.plan.plan as Prisma.InputJsonValue } : {}),
        ...(options.view
          ? {
              dbView: options.view,
              dbViewSha256: createHash('sha256').update(JSON.stringify(options.view)).digest('hex'),
            }
          : {}),
        // What core proposed (candidateVersionFacts): an added medium makes it minor.
        proposedBump: media.length > 0 ? 'minor' : 'patch',
        proposedVersion: media.length > 0 ? 'v0.1.0' : 'v0.0.1',
        facts: {
          changeType: 'code',
          risk: 'low',
          addedFiles: 0,
          modifiedFiles: 1,
          deletedFiles: 0,
          mediaFiles: media.length,
          dbObjects: 0,
          newFunctionality: false,
        },
      },
    })
    await db.task.update({
      where: { id: taskId },
      data: { status: 'awaiting_approval', turnNo: 1 },
    })
    return candidate
  }

  /**
   * An applied write of the agent to the production site, journaled as the role `mcp` journals
   * it: what a dialog without a preview may leave behind.
   */
  async function productionWrite(taskId: string, siteId: string) {
    const at = new Date()
    const turn = await db.taskTurn.create({
      data: { taskId, turnNo: 1, driverId: 'opencode', image: 'synthetic/agent:test' },
    })
    const assignment = await db.turnAssignment.create({
      data: {
        taskId,
        siteId,
        sessionId: 'synthetic-session',
        turnNo: 1,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(at.getTime() + 60_000),
        outcome: 'completed',
        finishedAt: at,
      },
    })
    const snapshot = await db.snapshot.create({
      data: {
        siteId,
        taskId,
        objectRef: 'page:42',
        s3Key: `snapshots/${randomUUID()}.json`,
        expiresAt: new Date(at.getTime() + 7 * 24 * 3600 * 1000),
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
        writeStartedAt: at,
        appliedStateHash: 'b'.repeat(64),
        objectRef: 'page:42',
        snapshotId: snapshot.id,
        result: 'ok',
        response: {},
        finishedAt: at,
      },
    })
  }

  describe('task.create', () => {
    it('writes the task, its reserve, the words, the pass and the preview together', async () => {
      const { owner, site } = await siteOwner({ database: true })
      const caller = callerOf(owner)

      const { taskId, created } = await newDialog(caller, site.id, 'Поменяйте телефон\nв шапке')

      expect(created).toMatchObject({ taskId, created: true })
      const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task).toMatchObject({
        status: 'queued',
        modelClass: 'standard',
        billable: true,
        attempt: 1,
        mode: 'work',
        title: 'Поменяйте телефон',
        createdById: owner.id,
        alias: created.alias,
      })
      // The gift of the registration is all the workspace has: the reserve takes it.
      const holds = await activeHolds(taskId)
      expect(holds.map((hold) => [hold.attempt, hold.amount.toFixed(0)])).toEqual([[1, '35']])
      expect(holds[0]!.expiresAt.getTime() - Date.now()).toBeGreaterThan(71 * 3600 * 1000)
      const feed = await feedOf(taskId)
      expect(feed).toEqual([
        {
          id: feed[0]!.id,
          type: 'feed.request',
          clientVisible: true,
          payload: {
            v: 1,
            kind: 'first',
            authorId: owner.id,
            requestId: taskId,
            text: 'Поменяйте телефон\nв шапке',
          },
        },
      ])
      const preview = await db.previewEnvironment.findUniqueOrThrow({ where: { taskId } })
      expect(preview).toMatchObject({
        status: 'pending',
        dbMode: 'copy',
        unavailableReason: null,
        revision: 0,
        enqueues: 1,
        hostname: `site-${site.alias}-chat-${created.alias}.localhost`,
      })
      expect(await outboxOf(taskId)).toEqual([
        {
          topic: 'agent-turns',
          type: 'turn.run',
          payload: { taskId, attempt: 1, requestEventId: String(feed[0]!.id) },
          dedupeKey: `turn.run:${taskId}:1:${feed[0]!.id}`,
        },
      ])
      expect(await outboxOf(preview.id)).toEqual([
        {
          topic: 'previews',
          type: 'preview.sync',
          payload: { previewId: preview.id, revision: 0, seq: 1 },
          dedupeKey: `preview.sync:${preview.id}:0:1`,
        },
      ])
    })

    it('says plainly that a site without its database has no preview, and builds nothing', async () => {
      const { owner, site } = await siteOwner()
      const { taskId } = await newDialog(callerOf(owner), site.id)

      const preview = await db.previewEnvironment.findUniqueOrThrow({ where: { taskId } })
      expect(preview).toMatchObject({
        status: 'unavailable',
        unavailableReason: 'no_database',
        dbMode: 'none',
      })
      expect(await outboxOf(preview.id)).toEqual([])
    })

    it('opens no preview where previews are not set up', async () => {
      const { owner, site } = await siteOwner({ database: true })
      const { taskId } = await newDialog(callerOf(owner, { preview: false }), site.id)

      expect(await db.previewEnvironment.count({ where: { taskId } })).toBe(0)
      const feed = await callerOf(owner).task.feed({ taskId })
      expect(feed.preview).toBeNull()
      expect(feed.commands.find((command) => command.id === 'preview')).toEqual({
        id: 'preview',
        available: false,
        refusal: 'no_preview',
      })
    })

    it('returns the same task to a repeat and writes nothing again', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId, created } = await newDialog(caller, site.id)

      const again = await caller.task.create({
        siteId: site.id,
        taskId: taskId.toUpperCase(),
        text: 'Другие слова',
      })

      expect(again).toEqual({ ...created, created: false })
      expect(await activeHolds(taskId)).toHaveLength(1)
      expect(await feedOf(taskId)).toHaveLength(1)
      expect(await outboxOf(taskId)).toHaveLength(1)
    })

    it('answers the id of someone else as if it did not exist', async () => {
      const first = await siteOwner()
      const second = await siteOwner()
      const { taskId } = await newDialog(callerOf(first.owner), first.site.id)

      await expect(
        callerOf(second.owner).task.create({
          siteId: second.site.id,
          taskId,
          text: 'Сделайте фон белым',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        callerOf(second.owner).task.create({
          siteId: first.site.id,
          taskId: randomUUID(),
          text: 'Привет',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('writes nothing at all when the reserve is refused: no task without a reserve', async () => {
      const { owner, site } = await siteOwner({ database: true })
      const taskId = randomUUID()
      taskIds.push(taskId)

      // Without the private credit rate: this database has none, and no task is taken.
      await expect(
        callerOf(owner, { client: db }).task.create({
          siteId: site.id,
          taskId,
          text: 'Добавьте отзывы',
        }),
      ).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        cause: { code: 'BILLING_CREDIT_RATE_MISSING' },
      })

      expect(await db.task.count({ where: { id: taskId } })).toBe(0)
      expect(await db.taskEvent.count({ where: { taskId } })).toBe(0)
      expect(await db.creditHold.count({ where: { taskId } })).toBe(0)
      expect(await db.previewEnvironment.count({ where: { taskId } })).toBe(0)
      expect(await outboxOf(taskId)).toEqual([])
    })

    it('takes no dialog for a site that is not connected or a workspace of client data', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      await db.site.update({ where: { id: site.id }, data: { status: 'onboarding' } })
      const caller = callerOf(owner)
      await expect(newDialog(caller, site.id)).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'TASK_NOT_ACCEPTED', details: { reason: 'site_not_active' } },
      })

      await db.site.update({ where: { id: site.id }, data: { status: 'active' } })
      await db.workspace.update({ where: { id: workspaceId }, data: { dataClass: 'client' } })
      await expect(newDialog(caller, site.id)).rejects.toMatchObject({
        cause: { code: 'TASK_NOT_ACCEPTED', details: { reason: 'not_synthetic' } },
      })
      expect(await db.task.count({ where: { siteId: site.id } })).toBe(0)
    })

    it('refuses words with a password before anything is written', async () => {
      const { owner, site } = await siteOwner()
      await expect(
        newDialog(callerOf(owner), site.id, 'Войдите в админку, пароль: Qwerty123456'),
      ).rejects.toMatchObject({ cause: { code: 'TASK_TEXT_HAS_SECRET' } })
      expect(await db.task.count({ where: { siteId: site.id } })).toBe(0)
    })
  })

  describe('task.message', () => {
    it('answers the question of the agent: the same attempt goes on under the same reserve', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
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

    it('starts a new pass on top of the candidate with the revision the words are about', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId, 2)

      const posted = await caller.task.message({
        taskId,
        requestId: randomUUID(),
        text: 'Сделайте кнопку зелёной',
      })

      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('queued')
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        id: BigInt(posted.requestEventId),
        payload: { kind: 'revision', candidateRevision: 2 },
      })
    })

    it('waits for «Продолжить» after a question about credits, and for the agent while it works', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const message = () => caller.task.message({ taskId, requestId: randomUUID(), text: 'Ещё' })

      await expect(message()).rejects.toMatchObject({ cause: { code: 'TASK_BUSY' } })
      await asked(taskId, { kind: 'ceiling', reason: 'step', spent: 30, held: 35, left: 5 })
      await expect(message()).rejects.toMatchObject({ cause: { code: 'TASK_CONTINUE_REQUIRED' } })
    })

    it('takes the answer to a question after a reset of the preview: a command answers nothing', async () => {
      const { owner, site } = await siteOwner({ database: true })
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await db.previewEnvironment.update({ where: { taskId }, data: { status: 'ready' } })
      const questionId = await asked(taskId, {
        kind: 'agent',
        intro: 'Нужно уточнить.',
        questions: [{ text: 'Какой номер поставить?', options: [] }],
      })
      const first = await db.taskEvent.findFirstOrThrow({
        where: { taskId, type: 'feed.request' },
        orderBy: { id: 'asc' },
      })

      await caller.preview.reset({ taskId, requestId: randomUUID() })

      // The press starts no clock of the agent's work either.
      expect((await caller.task.feed({ taskId })).task.workingSince).toBe(
        first.createdAt.toISOString(),
      )
      const posted = await caller.task.message({
        taskId,
        requestId: randomUUID(),
        text: '+7 900 000-00-00',
      })
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        id: BigInt(posted.requestEventId),
        payload: { kind: 'answer', answersEventId: String(questionId) },
      })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('queued')
    })

    it('still waits for «Продолжить» after a reset of the preview, and continues', async () => {
      const { owner, site, workspaceId } = await siteOwner({ database: true })
      await paidTariff(workspaceId)
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await db.previewEnvironment.update({ where: { taskId }, data: { status: 'ready' } })
      await asked(taskId, { kind: 'ceiling', reason: 'step', spent: 30, held: 35, left: 5 })

      await caller.preview.reset({ taskId, requestId: randomUUID() })

      await expect(
        caller.task.message({ taskId, requestId: randomUUID(), text: 'Ещё' }),
      ).rejects.toMatchObject({ cause: { code: 'TASK_CONTINUE_REQUIRED' } })
      await expect(
        caller.task.continue({ taskId, requestId: randomUUID() }),
      ).resolves.toMatchObject({ repeated: false })
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
      })
    })
  })

  describe('task.continue', () => {
    it('places the next attempt beside the reserve of the one before', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      await paidTariff(workspaceId)
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
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
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
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

  // The owner's answer 1 of 18.10.2026 (docs/plan/53, «Попробовать ещё (18.10)»).
  describe('task.retry', () => {
    /** What core writes when a pass of a dialog with a candidate fails: the row, as it is kept. */
    async function failedPass(taskId: string, code = 'technical') {
      return insertFeedEvent(db, {
        taskId,
        row: {
          type: 'feed.failure',
          payload: {
            v: 1,
            turn: 1,
            code: code as 'technical',
            site: 'unchanged',
            credits: null,
            next: 'awaiting_approval',
          },
        },
      })
    }
    async function keptAfterFailure(code = 'technical') {
      const { owner, site, workspaceId } = await siteOwner({ database: true })
      const caller = callerOf(owner, { client: underRateAndHeavy(db) })
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId)
      const failureId = String(await failedPass(taskId, code))
      return { owner, site, workspaceId, caller, taskId, failureId }
    }
    const retryOf = (commands: { id: string; refusal: string | null }[]) =>
      commands.find((command) => command.id === 'retry')?.refusal

    it('repeats the pass as the next attempt in heavy, with a reserve of its own', async () => {
      const { caller, taskId, failureId, owner } = await keptAfterFailure()
      const before = await caller.task.feed({ taskId })
      expect(before.task.canRetry).toBe(true)
      expect(retryOf(before.commands)).toBeNull()
      const held = await activeHolds(taskId)
      expect(held.map((hold) => hold.attempt)).toEqual([1])
      const requestId = randomUUID()

      const posted = await caller.task.retry({ taskId, requestId, failureEventId: failureId })

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
        modelClass: 'heavy',
      })
      // The reserve of the failed attempt came back; the retry holds what a step of heavy takes
      // of the gift: all 35 credits again.
      expect(
        (await db.creditHold.findMany({ where: { taskId }, orderBy: { attempt: 'asc' } })).map(
          (hold) => [hold.attempt, hold.status, hold.amount.toFixed(2)],
        ),
      ).toEqual([
        [1, 'released', held[0]!.amount.toFixed(2)],
        [2, 'active', '35.00'],
      ])
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        type: 'feed.request',
        payload: { kind: 'retry', requestId, failureEventId: failureId, authorId: owner.id },
      })
      expect((await outboxOf(taskId)).map((row) => row.dedupeKey)).toContain(
        `turn.run:${taskId}:2:${posted.requestEventId}`,
      )
      // The candidate stays: the pass works on top of it.
      expect(
        (await db.taskCandidate.findMany({ where: { taskId } })).map((row) => row.status),
      ).toEqual(['current'])
      // A repeat of the press is the same row; another press finds the agent at work.
      expect(await caller.task.retry({ taskId, requestId, failureEventId: failureId })).toEqual({
        ...posted,
        repeated: true,
      })
      await expect(
        caller.task.retry({ taskId, requestId: randomUUID(), failureEventId: failureId }),
      ).rejects.toMatchObject({ cause: { code: 'TASK_BUSY' } })
      expect(await activeHolds(taskId)).toHaveLength(1)
      expect((await caller.task.feed({ taskId })).task.canRetry).toBe(false)
    })

    it('offers nothing once the failure was answered, and only the failure the screen shows', async () => {
      const { caller, taskId, failureId } = await keptAfterFailure()
      await expect(
        caller.task.retry({
          taskId,
          requestId: randomUUID(),
          failureEventId: String(BigInt(failureId) - 1n),
        }),
      ).rejects.toMatchObject({
        cause: { code: 'TASK_NOTHING_TO_RETRY' },
        message: 'Повторить уже нельзя: в диалоге что-то изменилось',
      })
      // A reset of the preview answers nothing; words do.
      await db.previewEnvironment.update({ where: { taskId }, data: { status: 'ready' } })
      await caller.preview.reset({ taskId })
      expect((await caller.task.feed({ taskId })).task.canRetry).toBe(true)
      await caller.task.message({ taskId, requestId: randomUUID(), text: 'Сделайте иначе' })
      await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_approval' } })
      const feed = await caller.task.feed({ taskId })
      expect(feed.task.canRetry).toBe(false)
      expect(retryOf(feed.commands)).toBe('nothing_to_retry')
      await expect(
        caller.task.retry({ taskId, requestId: randomUUID(), failureEventId: failureId }),
      ).rejects.toMatchObject({ cause: { code: 'TASK_NOTHING_TO_RETRY' } })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).attempt).toBe(1)
    })

    it('offers nothing after a failure that advises another request', async () => {
      const { caller, taskId, failureId } = await keptAfterFailure('timeout')
      expect((await caller.task.feed({ taskId })).task.canRetry).toBe(false)
      await expect(
        caller.task.retry({ taskId, requestId: randomUUID(), failureEventId: failureId }),
      ).rejects.toMatchObject({ cause: { code: 'TASK_NOTHING_TO_RETRY' } })
    })

    it('moves nothing when no model of heavy has a price, or the site is not connected', async () => {
      const { owner, site, taskId, failureId } = await keptAfterFailure()
      // Without the class priced: refused before anything moves.
      const plain = callerOf(owner)
      await expect(
        plain.task.retry({ taskId, requestId: randomUUID(), failureEventId: failureId }),
      ).rejects.toMatchObject({
        cause: { code: 'TASK_NOT_ACCEPTED', details: { reason: 'class_unavailable' } },
      })
      // Priced, but under a provider that is switched off: the planner would find no profile and
      // fail the pass `unavailable` with the reserve held, so the press is refused the same way.
      await expect(
        callerOf(owner, { client: underRateAndHeavy(db, { provider: false }) }).task.retry({
          taskId,
          requestId: randomUUID(),
          failureEventId: failureId,
        }),
      ).rejects.toMatchObject({
        cause: { code: 'TASK_NOT_ACCEPTED', details: { reason: 'class_unavailable' } },
      })
      await db.site.update({ where: { id: site.id }, data: { status: 'paused' } })
      await expect(
        callerOf(owner, { client: underRateAndHeavy(db) }).task.retry({
          taskId,
          requestId: randomUUID(),
          failureEventId: failureId,
        }),
      ).rejects.toMatchObject({
        cause: { code: 'TASK_NOT_ACCEPTED', details: { reason: 'site_not_active' } },
      })
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'awaiting_approval',
        attempt: 1,
        modelClass: 'standard',
      })
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([1])
      expect((await feedOf(taskId)).at(-1)?.type).toBe('feed.failure')
    })

    it('rolls the return of the reserve back when the new one is refused', async () => {
      const { owner, caller, taskId, failureId } = await keptAfterFailure()
      const held = await activeHolds(taskId)
      expect(held.map((hold) => hold.attempt)).toEqual([1])
      // A price of heavy newer than the credit rate: the rate no longer covers the prices in
      // force, and the reserve of the retry is refused after the chain was given back.
      const stale = callerOf(owner, {
        client: underRateAndHeavy(db, { priceFrom: new Date(Date.now() - 60_000) }),
      })

      await expect(
        stale.task.retry({ taskId, requestId: randomUUID(), failureEventId: failureId }),
      ).rejects.toMatchObject({ cause: { code: 'BILLING_CREDIT_RATE_MISSING' } })

      // Nothing moved: the dialog waits with its candidate and the reserve of attempt 1, which
      // keeps its expiry; no press, no pass, no second reserve.
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'awaiting_approval',
        attempt: 1,
        modelClass: 'standard',
      })
      expect(await activeHolds(taskId)).toEqual(held)
      expect(await db.creditHold.count({ where: { taskId, attempt: 2 } })).toBe(0)
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        id: BigInt(failureId),
        type: 'feed.failure',
      })
      expect(
        (await outboxOf(taskId)).filter((row) =>
          row.dedupeKey?.startsWith(`turn.run:${taskId}:2:`),
        ),
      ).toEqual([])
      // The failure still waits for its retry, which goes through once the reserve can be placed.
      expect((await caller.task.feed({ taskId })).task.canRetry).toBe(true)
      await caller.task.retry({ taskId, requestId: randomUUID(), failureEventId: failureId })
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([2])
    })
  })

  describe('task.cancel', () => {
    it('closes a dialog that waits: the reserve comes back and the preview is taken down', async () => {
      const { owner, site, workspaceId } = await siteOwner({ database: true })
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId)
      const requestId = randomUUID()

      const cancelled = await caller.task.cancel({ taskId, requestId })

      expect(cancelled).toMatchObject({ state: 'cancelled', repeated: false })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('cancelled')
      expect(await activeHolds(taskId)).toEqual([])
      const gift = await db.billingAccount.findFirstOrThrow({
        where: { workspaceId, unit: 'credit_gift' },
      })
      expect(gift.held.toFixed(0)).toBe('0')
      const feed = await feedOf(taskId)
      expect(feed.slice(-2).map((row) => row.payload)).toEqual([
        { v: 1, kind: 'command', command: 'cancel', authorId: owner.id, requestId },
        {
          v: 1,
          turn: 1,
          by: 'customer',
          authorId: owner.id,
          site: 'unchanged',
          credits: 'returned',
        },
      ])
      const preview = await db.previewEnvironment.findUniqueOrThrow({ where: { taskId } })
      expect(preview.enqueues).toBe(2)
      expect((await outboxOf(preview.id)).map((row) => row.dedupeKey)).toEqual([
        `preview.sync:${preview.id}:0:1`,
        `preview.sync:${preview.id}:0:2`,
      ])
      expect(await caller.task.cancel({ taskId, requestId })).toMatchObject({
        state: 'cancelled',
        repeated: true,
      })
    })

    it('asks core to stop a pass that runs, and refuses a release in work', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
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

    it('asks to check the site when the agent of a dialog without a preview wrote to it', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner, { preview: false })
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId)
      await productionWrite(taskId, site.id)

      await caller.task.cancel({ taskId, requestId: randomUUID() })

      expect((await feedOf(taskId)).at(-1)!.payload).toMatchObject({
        by: 'customer',
        site: 'check',
      })
    })
  })

  describe('release', () => {
    it('confirms a release once: the row, the move, the decision and the job; a repeat is the same release', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const candidate = await withCandidate(taskId)

      const prepared = await caller.release.prepare({ taskId })
      expect(prepared).toMatchObject({
        candidateId: candidate.id,
        revision: 1,
        base: 'v0.0.0',
        proposal: { version: 'v0.0.1', bump: 'patch' },
        counts: { files: { added: 0, modified: 1, deleted: 0 }, media: 0, records: 0 },
      })
      expect(prepared.choices.map((choice) => choice.version)).toEqual([
        'v0.0.1',
        'v0.1.0',
        'v1.0.0',
      ])
      const minor = prepared.choices.find((choice) => choice.bump === 'minor')!

      const confirmed = await caller.release.confirm({
        taskId,
        confirmToken: minor.confirmToken,
        version: 'v0.1.0',
      })

      expect(confirmed).toMatchObject({ status: 'approved', version: 'v0.1.0', repeated: false })
      const release = await db.siteRelease.findUniqueOrThrow({ where: { id: confirmed.releaseId } })
      expect(release).toMatchObject({
        siteId: site.id,
        candidateId: candidate.id,
        candidateRevision: 1,
        attempt: 1,
        tag: 'v0.1.0',
        bump: 'minor',
        mainBeforeSha: SHA('a'),
        approvedBy: owner.id,
        enqueues: 1,
        releaseKey: createHash('sha256')
          .update(
            releaseKeyMaterial({
              candidateId: candidate.id,
              revision: 1,
              version: 'v0.1.0',
              attempt: 1,
            }),
          )
          .digest('hex'),
      })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('deploying')
      expect((await feedOf(taskId)).at(-1)!.payload).toEqual({
        v: 1,
        kind: 'release',
        authorId: owner.id,
        revision: 1,
        version: 'v0.1.0',
      })
      expect(await outboxOf(release.id)).toEqual([
        {
          topic: 'deploys',
          type: 'release.advance',
          payload: { releaseId: release.id, status: 'approved', step: null, seq: 1 },
          dedupeKey: `release.advance:${release.id}:approved:-:1`,
        },
      ])
      const [hold] = await activeHolds(taskId)
      expect(hold!.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3600 * 1000)
      expect(hold!.expiresAt.getTime() - Date.now()).toBeLessThan(25 * 3600 * 1000)

      const again = await caller.release.confirm({
        taskId,
        confirmToken: minor.confirmToken,
        version: 'v0.1.0',
      })
      expect(again).toEqual({ ...confirmed, repeated: true })
      expect(await db.siteRelease.count({ where: { taskId } })).toBe(1)
      await expect(caller.release.get({ releaseId: release.id })).resolves.toMatchObject({
        id: release.id,
        status: 'approved',
        outcome: null,
        steps: [],
      })
    })

    it('asks to look at every change of a bulk database plan and confirms only the description shown', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      // Twenty-one settings: a bulk edit (rule 4), every card in the description.
      const view: DbPlanView = {
        v: 1,
        planSha256: '0'.repeat(64),
        operations: Array.from({ length: 21 }, (_, index) => ({
          kind: 'option_update' as const,
          index,
          objectRef: `option:setting_${index}`,
          label: 'Название сайта',
          before: 'Цветы у дома',
          after: `Цветы у дома ${index}`,
          truncated: false,
        })),
        truncated: false,
        oversize: false,
      }
      await withCandidate(taskId, 1, { view })
      const shown = await caller.candidate.get({ taskId })
      expect(shown?.databaseView?.operations).toHaveLength(21)
      expect(shown?.databaseView?.operations[20]).toMatchObject({ after: 'Цветы у дома 20' })
      expect(shown?.databaseReview).toBe(true)

      const prepared = await caller.release.prepare({ taskId })
      expect(prepared.review).toBe(true)
      const [choice] = prepared.choices
      const confirm = (reviewed?: boolean) =>
        caller.release.confirm({
          taskId,
          confirmToken: choice!.confirmToken,
          version: choice!.version,
          ...(reviewed === undefined ? {} : { reviewed }),
        })
      await expect(confirm()).rejects.toMatchObject({ cause: { code: 'RELEASE_REVIEW_REQUIRED' } })
      await expect(confirm(false)).rejects.toMatchObject({
        cause: { code: 'RELEASE_REVIEW_REQUIRED' },
      })
      // The description was taken back (a variable declared since): not what the client saw.
      await db.taskCandidate.updateMany({
        where: { taskId },
        data: { dbView: Prisma.DbNull, dbViewSha256: null },
      })
      await expect(confirm(true)).rejects.toMatchObject({
        cause: { code: 'RELEASE_CANDIDATE_CHANGED' },
      })
      expect(await db.siteRelease.count({ where: { taskId } })).toBe(0)
      // Shown again, and confirmed with the client's review.
      await db.taskCandidate.updateMany({
        where: { taskId },
        data: {
          dbView: view,
          dbViewSha256: createHash('sha256').update(JSON.stringify(view)).digest('hex'),
        },
      })
      await expect(confirm(true)).resolves.toMatchObject({ status: 'approved', repeated: false })
    })

    it('offers no release of a database plan the panel says cannot be released', async () => {
      // A dialog of its own owner each: a dialog holds credits of the gift.
      const dialog = async () => {
        const { owner, site } = await siteOwner()
        const caller = callerOf(owner)
        const { taskId } = await newDialog(caller, site.id)
        return { caller, taskId }
      }
      const hash = (digit: string) => digit.repeat(64)
      const value = (n: number) => ({ key: `previews/p/${n}.bin`, sha256: hash('e'), sizeBytes: 9 })
      const plan = {
        sha256: hash('d'),
        plan: [
          {
            kind: 'content_update',
            objectRef: 'page:42',
            fields: ['title'],
            beforeHash: hash('a'),
            afterHash: hash('b'),
            before: value(1),
            after: value(2),
          },
        ],
      }
      const card = {
        kind: 'content_update' as const,
        index: 0,
        objectRef: 'page:42',
        record: { type: 'page', title: 'Контакты' },
        fields: ['title' as const],
      }
      const views: (DbPlanView | undefined)[] = [
        // No description: the values are not shown.
        undefined,
        { v: 1, planSha256: plan.sha256, operations: [], truncated: true, oversize: true },
        {
          v: 1,
          planSha256: plan.sha256,
          operations: [
            { kind: 'content_update', index: 0, objectRef: 'page:42', refused: 'client_variable' },
          ],
          truncated: false,
          oversize: false,
        },
        // Of another plan.
        { v: 1, planSha256: hash('f'), operations: [card], truncated: false, oversize: false },
      ]
      for (const view of views) {
        const { caller, taskId } = await dialog()
        await withCandidate(taskId, 1, { plan, ...(view ? { view } : {}) })
        await expect(caller.release.prepare({ taskId })).rejects.toMatchObject({
          cause: {
            code: 'CHAT_COMMAND_UNAVAILABLE',
            details: { refusal: 'database_not_releasable' },
          },
        })
      }
      // The description of exactly this plan, every card shown: offered.
      const { caller, taskId } = await dialog()
      const view: DbPlanView = {
        v: 1,
        planSha256: plan.sha256,
        operations: [card],
        truncated: false,
        oversize: false,
      }
      await withCandidate(taskId, 1, { plan, view })
      const prepared = await caller.release.prepare({ taskId })
      // A description changed under the confirmation is not confirmed (the token binds it), and
      // one that cannot be released is refused even then.
      await db.taskCandidate.updateMany({
        where: { taskId },
        data: { dbView: { ...view, oversize: true, operations: [] } },
      })
      await expect(
        caller.release.confirm({
          taskId,
          confirmToken: prepared.choices[0]!.confirmToken,
          version: prepared.choices[0]!.version,
        }),
      ).rejects.toMatchObject({
        cause: {
          code: 'CHAT_COMMAND_UNAVAILABLE',
          details: { refusal: 'database_not_releasable' },
        },
      })
    })

    it('lets only an owner or an admin release', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      const member = await person()
      await db.member.create({ data: { workspaceId, userId: member.id, role: 'member' } })
      const { taskId } = await newDialog(callerOf(owner), site.id)
      const candidate = await withCandidate(taskId)

      await expect(callerOf(member).release.prepare({ taskId })).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'not_allowed' } },
      })
      const forged = signConfirmToken(KEY, {
        userId: member.id,
        candidateId: candidate.id,
        revision: 1,
        version: 'v0.0.1',
        dbViewSha256: null,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      })
      await expect(
        callerOf(member).release.confirm({ taskId, confirmToken: forged, version: 'v0.0.1' }),
      ).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'not_allowed' } },
      })
      expect(await db.siteRelease.count({ where: { taskId } })).toBe(0)
    })

    it('refuses a confirmation of another revision, of another user and a number taken meanwhile', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      await paidTariff(workspaceId)
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const first = await withCandidate(taskId)
      const prepared = await caller.release.prepare({ taskId })
      const patch = prepared.choices.find((choice) => choice.bump === 'patch')!

      // Someone else's hands: the token names its user.
      const admin = await person()
      await db.member.create({ data: { workspaceId, userId: admin.id, role: 'admin' } })
      await expect(
        callerOf(admin).release.confirm({
          taskId,
          confirmToken: patch.confirmToken,
          version: 'v0.0.1',
        }),
      ).rejects.toMatchObject({ cause: { code: 'RELEASE_CONFIRMATION_INVALID' } })
      // Another number than the one confirmed.
      await expect(
        caller.release.confirm({ taskId, confirmToken: patch.confirmToken, version: 'v0.1.0' }),
      ).rejects.toMatchObject({ cause: { code: 'RELEASE_CONFIRMATION_INVALID' } })

      // A new pass made revision 2 meanwhile.
      await db.taskCandidate.update({
        where: { id: first.id },
        data: { status: 'superseded', supersededAt: new Date() },
      })
      await withCandidate(taskId, 2)
      await expect(
        caller.release.confirm({ taskId, confirmToken: patch.confirmToken, version: 'v0.0.1' }),
      ).rejects.toMatchObject({ cause: { code: 'RELEASE_CANDIDATE_CHANGED' } })

      // Another dialog of the site released v0.0.1 meanwhile: the number is no choice any more.
      const second = await newDialog(caller, site.id, 'Добавьте адрес в подвал')
      const other = await withCandidate(second.taskId)
      const fresh = await caller.release.prepare({ taskId })
      const otherPrepared = await caller.release.prepare({ taskId: second.taskId })
      await caller.release.confirm({
        taskId: second.taskId,
        confirmToken: otherPrepared.choices[0]!.confirmToken,
        version: otherPrepared.choices[0]!.version,
      })
      expect(other.id).not.toBe(fresh.candidateId)
      await expect(
        caller.release.confirm({
          taskId,
          confirmToken: fresh.choices[0]!.confirmToken,
          version: fresh.choices[0]!.version,
        }),
      ).rejects.toMatchObject({ cause: { code: 'RELEASE_VERSION_NOT_OFFERED' } })
      expect(await db.siteRelease.count({ where: { taskId } })).toBe(0)
    })

    it('sends the confirmation of a candidate the site moved under to «Обновить»', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const candidate = await withCandidate(taskId)
      const [choice] = (await caller.release.prepare({ taskId })).choices
      // A release of another dialog installed meanwhile: the candidate stands on an old version.
      await db.taskCandidate.update({ where: { id: candidate.id }, data: { status: 'stale' } })

      await expect(
        caller.release.confirm({
          taskId,
          confirmToken: choice!.confirmToken,
          version: choice!.version,
        }),
      ).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'needs_update' } },
      })
      expect(await db.siteRelease.count({ where: { taskId } })).toBe(0)
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
        'awaiting_approval',
      )
    })
  })

  describe('«Отменить выпуск»', () => {
    /** A dialog whose release the site runs, installed `ago` ms ago; the dialog is closed. */
    async function installedDialog(ago = 60_000) {
      const { owner, site, workspaceId } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const candidate = await withCandidate(taskId)
      const at = new Date(Date.now() - ago)
      const release = await db.siteRelease.create({
        data: {
          siteId: site.id,
          taskId,
          candidateId: candidate.id,
          candidateRevision: 1,
          attempt: 1,
          releaseKey: createHash('sha256').update(randomUUID()).digest('hex'),
          version: 'v0.1.0',
          tag: 'v0.1.0',
          bump: 'minor',
          mainBeforeSha: SHA('a'),
          installedBeforeSha: SHA('a'),
          approvedSha: SHA('d'),
          mainPushedAt: at,
          status: 'installed',
          committedAt: at,
          approvedAt: at,
          approvedBy: owner.id,
        },
      })
      await db.site.update({
        where: { id: site.id },
        data: {
          installedVersion: 'v0.1.0',
          installedSha: SHA('d'),
          installedAt: at,
          installedReleaseId: release.id,
        },
      })
      await db.taskCandidate.update({ where: { id: candidate.id }, data: { status: 'released' } })
      await db.task.update({ where: { id: taskId }, data: { status: 'done' } })
      return { owner, caller, site, workspaceId, taskId, release }
    }

    /** What core writes when it has made the plan. */
    async function planned(planId: string, items = defaultItems) {
      await db.releaseUndoPlan.update({
        where: { id: planId },
        data: {
          status: 'ready',
          targetTree: SHA('e'),
          files: {
            back: 1,
            removed: 0,
            restored: 0,
            mediaKept: 1,
            paths: [{ path: 'wp-content/themes/cafe/header.php', change: 'back' }],
          },
          items,
          dbPlan: [],
          planSha256: '9'.repeat(64),
          computedAt: new Date(),
        },
      })
    }
    const defaultItems = [
      {
        objectRef: 'page:42',
        productionRef: null,
        kind: 'content_update',
        fields: ['title', 'content'],
        verdict: 'return',
      },
      {
        objectRef: 'page:1000000001',
        productionRef: 'page:900',
        kind: 'post_create',
        fields: ['title', 'content', 'excerpt'],
        verdict: 'kept_dependents',
      },
      {
        objectRef: 'option:blogdescription',
        productionRef: null,
        kind: 'option_update',
        fields: ['value'],
        verdict: 'changed',
      },
      {
        objectRef: 'table:bookings',
        productionRef: null,
        kind: 'schema_migration',
        fields: ['definition'],
        verdict: 'stays',
      },
    ]

    it('asks core for the plan once, shows it with its words and confirms exactly it', async () => {
      const { owner, caller, site, taskId, release } = await installedDialog()
      const commands = await caller.task.commands({ taskId })
      expect(commands.find((command) => command.id === 'undo')).toEqual({
        id: 'undo',
        available: true,
        refusal: null,
      })
      const { planId } = await caller.release.undoPrepare({ taskId, releaseId: release.id })
      // A window opened twice waits for the same plan, with one job.
      expect(await caller.release.undoPrepare({ taskId, releaseId: release.id })).toEqual({
        planId,
      })
      expect(await outboxOf(planId)).toEqual([
        {
          topic: 'deploys',
          type: 'release.undoPlan',
          payload: { planId, seq: 1 },
          dedupeKey: `release.undoPlan:${planId}:1`,
        },
      ])
      await expect(
        caller.release.undoPlan({ taskId, releaseId: release.id, planId }),
      ).resolves.toEqual({ state: 'pending' })

      await planned(planId)
      const shown = await caller.release.undoPlan({ taskId, releaseId: release.id, planId })
      if (shown.state !== 'ready') throw new Error('expected a ready plan')
      expect(shown).toMatchObject({
        undoneVersion: 'v0.1.0',
        returnsTo: 'v0.0.0',
        version: 'v0.1.1',
        nothingToUndo: false,
        review: false,
        files: { back: 1, mediaKept: 1, more: 0 },
      })
      expect(shown.records.map((record) => record.text)).toEqual([
        'Страница 42: вернём заголовок и текст',
        'Страница 900, которую добавил выпуск, останется: на ней уже есть комментарии или на неё ссылается меню',
        'Настройка сайта: не вернём — её изменили на сайте после выпуска',
        'Структура базы данных, которую добавил выпуск, останется',
      ])
      const installedAt = (await db.site.findUniqueOrThrow({ where: { id: site.id } })).installedAt
      expect(shown.until.getTime() - installedAt!.getTime()).toBe(7 * 24 * 3600 * 1000)

      const holdsBefore = await activeHolds(taskId)
      const confirm = () =>
        caller.release.undoConfirm({
          taskId,
          releaseId: release.id,
          confirmToken: shown.confirmToken,
          version: shown.version,
        })
      const confirmed = await confirm()
      expect(confirmed).toMatchObject({ status: 'approved', version: 'v0.1.1', repeated: false })
      const undo = await db.siteRelease.findUniqueOrThrow({ where: { id: confirmed.undoId } })
      expect(undo).toMatchObject({
        kind: 'undo',
        taskId,
        candidateId: null,
        undoesReleaseId: release.id,
        undoPlanId: planId,
        undoPlanSha256: '9'.repeat(64),
        bump: 'patch',
        attempt: 1,
        mainBeforeSha: SHA('d'),
        installedBeforeSha: SHA('d'),
        approvedBy: owner.id,
      })
      expect((await feedOf(taskId)).at(-1)!.payload).toEqual({
        v: 1,
        stage: 'confirmed',
        undoId: undo.id,
        releaseId: release.id,
        undoneVersion: 'v0.1.0',
        version: 'v0.1.1',
        authorId: owner.id,
      })
      expect(await outboxOf(undo.id)).toEqual([
        expect.objectContaining({
          type: 'release.advance',
          payload: { releaseId: undo.id, status: 'approved', step: null, seq: 1 },
        }),
      ])
      // The dialog stays closed, and nothing of its credits moves (rule 7).
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('done')
      expect(await activeHolds(taskId)).toEqual(holdsBefore)
      // A repeat is the same undo; another one is refused while it goes on.
      expect(await confirm()).toEqual({ ...confirmed, repeated: true })
      const feed = await caller.task.feed({ taskId, after: '0' })
      expect(feed.undo).toMatchObject({
        releaseId: release.id,
        installedNow: true,
        run: { id: undo.id, status: 'approved', version: 'v0.1.1', outcome: null },
      })
      expect(feed.release).toMatchObject({ id: release.id })
      expect(feed.commands.find((command) => command.id === 'undo')?.refusal).toBe(
        'release_in_progress',
      )
      const list = await caller.task.list({ siteId: site.id })
      expect(list.items.find((item) => item.id === taskId)?.undo).toBe('running')
    })

    it('refuses a member, a version the site no longer runs, after seven days, and once undone', async () => {
      const first = await installedDialog()
      const member = await person()
      await db.member.create({
        data: { workspaceId: first.workspaceId, userId: member.id, role: 'member' },
      })
      await expect(
        callerOf(member).release.undoPrepare({ taskId: first.taskId, releaseId: first.release.id }),
      ).rejects.toMatchObject({ cause: { details: { refusal: 'not_allowed' } } })

      const old = await installedDialog(7 * 24 * 3600 * 1000 + 60_000)
      expect(
        (await old.caller.task.commands({ taskId: old.taskId })).find(
          (command) => command.id === 'undo',
        )?.refusal,
      ).toBe('undo_expired')
      await expect(
        old.caller.release.undoPrepare({ taskId: old.taskId, releaseId: old.release.id }),
      ).rejects.toMatchObject({ cause: { details: { refusal: 'undo_expired' } } })

      await db.site.update({ where: { id: first.site.id }, data: { installedReleaseId: null } })
      await expect(
        first.caller.release.undoPrepare({ taskId: first.taskId, releaseId: first.release.id }),
      ).rejects.toMatchObject({ cause: { details: { refusal: 'not_installed' } } })

      // A dialog that installed nothing has no undo to offer.
      const fresh = await siteOwner()
      const freshCaller = callerOf(fresh.owner)
      const { taskId } = await newDialog(freshCaller, fresh.site.id)
      expect(
        (await freshCaller.task.commands({ taskId })).find((command) => command.id === 'undo')
          ?.refusal,
      ).toBe('no_release')
    })

    it('takes only a confirmation of an undo, of this plan, its user and its release', async () => {
      const { caller, taskId, release } = await installedDialog()
      const { planId } = await caller.release.undoPrepare({ taskId, releaseId: release.id })
      await planned(planId)
      const shown = await caller.release.undoPlan({ taskId, releaseId: release.id, planId })
      if (shown.state !== 'ready') throw new Error('expected a ready plan')
      const confirm = (confirmToken: string, extra: Record<string, unknown> = {}) =>
        caller.release.undoConfirm({
          taskId,
          releaseId: release.id,
          confirmToken,
          version: shown.version,
          ...extra,
        })
      // The confirmation of a release does not pass as an undo's.
      const releaseToken = signConfirmToken(KEY, {
        userId: (await db.siteRelease.findUniqueOrThrow({ where: { id: release.id } })).approvedBy!,
        candidateId: release.candidateId!,
        revision: 1,
        version: shown.version,
        dbViewSha256: null,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      })
      await expect(confirm(releaseToken)).rejects.toMatchObject({
        cause: { code: 'RELEASE_CONFIRMATION_INVALID' },
      })
      // Of another release of the dialog.
      await expect(
        caller.release.undoConfirm({
          taskId,
          releaseId: randomUUID(),
          confirmToken: shown.confirmToken,
          version: shown.version,
        }),
      ).rejects.toMatchObject({ cause: { code: 'RELEASE_CONFIRMATION_INVALID' } })
      // Signed for another plan hash than the plan holds now.
      await expect(
        confirm(
          signUndoConfirmToken(KEY, {
            userId: (await db.siteRelease.findUniqueOrThrow({ where: { id: release.id } }))
              .approvedBy!,
            releaseId: release.id,
            planId,
            planSha256: '8'.repeat(64),
            version: shown.version,
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: 'RELEASE_UNDO_PLAN_CHANGED' } })
      // A number taken meanwhile by a release of another dialog.
      await db.siteRelease.update({ where: { id: release.id }, data: { version: 'v0.1.0' } })
      await db.site.update({ where: { id: release.siteId }, data: { installedVersion: 'v0.1.1' } })
      await expect(confirm(shown.confirmToken)).rejects.toMatchObject({
        cause: { code: 'RELEASE_UNDO_VERSION_TAKEN' },
      })
      expect(await db.siteRelease.count({ where: { taskId, kind: 'undo' } })).toBe(0)
    })
  })

  describe('siteEnv', () => {
    it('takes back a description of a database plan that holds the value it declares a variable', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const value = 'synthetic-pasted-key-0042'
      const card = (after: string) => ({
        kind: 'option_update' as const,
        index: 0,
        objectRef: 'option:blogdescription',
        label: 'Описание сайта',
        before: null,
        after,
        truncated: false,
      })
      const view = (after: string): DbPlanView => ({
        v: 1,
        planSha256: '0'.repeat(64),
        operations: [card(after)],
        truncated: false,
        oversize: false,
      })
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId, 1, { view: view(`Ключ ${value}`) })
      const declare = (name: string, declared: string) =>
        caller.siteEnv.set({
          siteId: site.id,
          name,
          value: declared,
          hosts: [],
          toPreview: false,
          toAgent: false,
          agentConsent: false,
        })
      const described = async () =>
        (await db.taskCandidate.findFirstOrThrow({ where: { taskId } })).dbViewSha256
      // A variable whose value the description does not hold leaves it.
      await declare('OTHER_KEY', 'synthetic-unrelated-value-77')
      expect(await described()).not.toBeNull()
      await declare('PASTED_KEY', value)
      expect(await described()).toBeNull()
    })

    it('puts the value into Vault only and never gives it back; removes it with a version without it', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const value = 'pk_live_synthetic_value_42'

      const set = await caller.siteEnv.set({
        siteId: site.id,
        name: 'MAPS_KEY',
        value,
        hosts: ['api.maps.example.ru'],
        toPreview: true,
        toAgent: true,
        agentConsent: true,
      })

      expect(set).toMatchObject({
        name: 'MAPS_KEY',
        hosts: ['api.maps.example.ru:443'],
        toAgent: true,
        keyVersion: 1,
      })
      const listed = await caller.siteEnv.list({ siteId: site.id })
      expect(listed).toMatchObject({ agentAllowed: true, variables: [{ name: 'MAPS_KEY' }] })
      expect(JSON.stringify([set, listed])).not.toContain(value)
      const path = `kv/sites/${site.id}/env/MAPS_KEY`
      expect(vault.keys.get(path)).toEqual([{ version: 1, data: { value } }])
      const row = await db.siteEnvVar.findFirstOrThrow({ where: { siteId: site.id } })
      expect(JSON.stringify(row)).not.toContain(value)
      expect(row.agentConsentBy).toBe(owner.id)

      const changed = await caller.siteEnv.set({
        siteId: site.id,
        name: 'MAPS_KEY',
        value: 'another-synthetic-value',
        hosts: [],
        toPreview: true,
        toAgent: false,
        agentConsent: false,
      })
      expect(changed).toMatchObject({ keyVersion: 2, toAgent: false, agentConsentAt: null })
      // One version per key (R8a): the replaced value is gone from Vault with the same write.
      expect(vault.keys.get(path)).toEqual([
        { version: 2, data: { value: 'another-synthetic-value' } },
      ])

      expect(await caller.siteEnv.remove({ siteId: site.id, name: 'MAPS_KEY' })).toEqual({
        removed: true,
      })
      expect(vault.keys.get(path)).toEqual([{ version: 3, data: { removed: expect.any(String) } }])
      expect(await caller.siteEnv.list({ siteId: site.id })).toEqual({
        agentAllowed: true,
        variables: [],
      })
      expect(await caller.siteEnv.remove({ siteId: site.id, name: 'MAPS_KEY' })).toEqual({
        removed: false,
      })
    })

    it('refuses a member, and the agent in a workspace of client data', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      const member = await person()
      await db.member.create({ data: { workspaceId, userId: member.id, role: 'member' } })
      const input = {
        siteId: site.id,
        name: 'CRM_TOKEN',
        value: 'synthetic-token-value',
        hosts: ['crm.example.ru'],
        toPreview: true,
        toAgent: true,
        agentConsent: true,
      }
      await expect(callerOf(member).siteEnv.list({ siteId: site.id })).rejects.toMatchObject({
        cause: { code: 'SITE_ENV_NOT_ALLOWED' },
      })
      await db.workspace.update({ where: { id: workspaceId }, data: { dataClass: 'client' } })
      // The form is told up front: «Передавать агенту» stays off.
      expect(await callerOf(owner).siteEnv.list({ siteId: site.id })).toEqual({
        agentAllowed: false,
        variables: [],
      })
      await expect(callerOf(owner).siteEnv.set(input)).rejects.toMatchObject({
        cause: { code: 'SITE_ENV_AGENT_CLOSED' },
      })
      expect(vault.keys.has(`kv/sites/${site.id}/env/CRM_TOKEN`)).toBe(false)
      await expect(
        callerOf(owner).siteEnv.set({ ...input, toAgent: false, agentConsent: false }),
      ).resolves.toMatchObject({ toAgent: false })
    })

    it('takes no more different hosts for the variables of a site than one proxy holds (Р13)', async () => {
      const { owner, site } = await siteOwner()
      // Sixteen variables of sixteen hosts each: the 256 a sandbox and a preview take.
      await db.siteEnvVar.createMany({
        data: Array.from({ length: 16 }, (_, variable) => ({
          siteId: site.id,
          name: `FULL_${variable}`,
          hosts: Array.from({ length: 16 }, (_, host) => `h${host}.v${variable}.example.ru:443`),
          keyVersion: 1,
          createdBy: owner.id,
        })),
      })
      const input = {
        siteId: site.id,
        name: 'ONE_MORE',
        value: 'synthetic-token-value',
        hosts: ['new.example.ru'],
        toPreview: true,
        toAgent: false,
        agentConsent: false,
      }
      await expect(callerOf(owner).siteEnv.set(input)).rejects.toMatchObject({
        cause: { code: 'SITE_ENV_HOSTS_LIMIT' },
      })
      expect(vault.keys.has(`kv/sites/${site.id}/env/ONE_MORE`)).toBe(false)
      // A host another variable already names adds nothing.
      await expect(
        callerOf(owner).siteEnv.set({ ...input, hosts: ['h0.v0.example.ru'] }),
      ).resolves.toMatchObject({ hosts: ['h0.v0.example.ru:443'] })
    })
  })

  describe('task.feed', () => {
    it('reads the head, the rows after the cursor and the commands from one snapshot', async () => {
      const { owner, site } = await siteOwner({ database: true })
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId)

      const feed = await caller.task.feed({ taskId })

      expect(feed.task).toMatchObject({
        id: taskId,
        status: 'awaiting_approval',
        title: 'Поменяйте телефон в шапке сайта',
        held: false,
        canRetry: false,
      })
      expect(feed.events.map((event) => event.type)).toEqual(['feed.request'])
      expect(feed.cursor).toBe(feed.events[0]!.id)
      expect(feed.more).toBe(false)
      expect(feed.preview).toMatchObject({
        status: 'pending',
        origin: expect.stringMatching(/^http:\/\/site-[0-9a-z]+-chat-[0-9a-z]+\.localhost:8090$/),
      })
      expect(feed.candidate).toMatchObject({
        revision: 1,
        status: 'current',
        checks: { failed: 0 },
      })
      expect(
        Object.fromEntries(feed.commands.map((command) => [command.id, command.refusal])),
      ).toEqual({
        release: null,
        preview: 'preview_not_ready',
        reset: 'preview_not_ready',
        update: 'up_to_date',
        retry: 'nothing_to_retry',
        cancel: null,
        undo: 'no_release',
      })
      expect(feed.undo).toBeNull()
      expect((await caller.task.feed({ taskId, after: feed.cursor })).events).toEqual([])
      expect(await caller.task.commands({ taskId })).toEqual(feed.commands)
      expect(await caller.task.get({ taskId })).toMatchObject({
        ...feed.task,
        siteId: site.id,
        alias: expect.stringMatching(/^[0-9a-z]{4,12}$/),
      })
      expect((await caller.task.list({ siteId: site.id })).items.map((item) => item.id)).toEqual([
        taskId,
      ])
    })
  })

  describe('the preview of a dialog', () => {
    it('opens a served preview with a one-time ticket whose hash alone is kept', async () => {
      const { owner, site } = await siteOwner({ database: true })
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const preview = await db.previewEnvironment.findUniqueOrThrow({ where: { taskId } })

      await expect(caller.preview.ticket({ taskId })).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'preview_not_ready' } },
      })
      await db.previewEnvironment.update({ where: { id: preview.id }, data: { status: 'ready' } })

      const opened = await caller.preview.ticket({ taskId, to: '/contacts/?tab=map' })

      const url = new URL(opened.url)
      expect(url.origin).toBe(`http://${preview.hostname}:8090`)
      expect(url.pathname).toBe('/__raditi/enter')
      expect(url.searchParams.get('to')).toBe('/contacts/?tab=map')
      const ticket = url.searchParams.get('t')!
      const rows = await db.previewTicket.findMany({ where: { previewId: preview.id } })
      expect(rows).toEqual([
        expect.objectContaining({
          userId: owner.id,
          kind: 'user',
          tokenHash: createHash('sha256').update(ticket).digest('hex'),
          usedAt: null,
        }),
      ])
      expect(JSON.stringify(rows)).not.toContain(ticket)
      expect(rows[0]!.expiresAt.getTime() - opened.expiresAt.getTime()).toBe(0)
      await expect(caller.preview.ticket({ taskId, to: '//evil.example' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })

      // A stranger, by the dialog or by the host: as if there were no preview.
      const stranger = await person()
      await expect(callerOf(stranger).preview.ticket({ taskId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      const { openPreview } = await import('../services/chat/previews.ts')
      await expect(
        openPreview(db, ADDRESS, { userId: stranger.id, target: { hostname: preview.hostname } }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        openPreview(db, ADDRESS, { userId: owner.id, target: { hostname: preview.hostname } }),
      ).resolves.toMatchObject({ url: expect.stringContaining('/__raditi/enter?t=') })
    })

    it('builds a stopped preview again when it is opened, and resets it on /reset', async () => {
      const { owner, site } = await siteOwner({ database: true })
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId)
      const preview = await db.previewEnvironment.update({
        where: { taskId },
        data: { status: 'expired', revision: 1 },
      })

      const stillStopped = () =>
        expect(caller.preview.ticket({ taskId })).rejects.toMatchObject({
          cause: { code: 'PREVIEW_NOT_READY' },
        })
      await stillStopped()
      // The screen asks again at once: the request is fresh, no second job.
      await stillStopped()
      expect(await db.previewTicket.count({ where: { previewId: preview.id } })).toBe(0)
      expect(
        (await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })).enqueues,
      ).toBe(2)
      // A minute later, still stopped: core is asked once more.
      await db.$executeRaw`UPDATE preview_environments
        SET last_viewed_at = now() - interval '2 minutes' WHERE id = ${preview.id}::uuid`
      await stillStopped()

      await db.previewEnvironment.update({ where: { id: preview.id }, data: { status: 'ready' } })
      const requestId = randomUUID()
      const reset = await caller.preview.reset({ taskId, requestId })

      expect(
        await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } }),
      ).toMatchObject({
        dirty: true,
        enqueues: 4,
      })
      expect((await outboxOf(preview.id)).map((row) => row.dedupeKey)).toEqual([
        `preview.sync:${preview.id}:0:1`,
        `preview.sync:${preview.id}:1:2`,
        `preview.sync:${preview.id}:1:3`,
        `preview.sync:${preview.id}:1:4`,
      ])
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        id: BigInt(reset.requestEventId!),
        payload: { kind: 'command', command: 'reset', requestId },
      })
      expect(await caller.preview.reset({ taskId, requestId })).toEqual({
        ...reset,
        repeated: true,
      })

      await db.task.update({ where: { id: taskId }, data: { status: 'running' } })
      await expect(caller.preview.reset({ taskId })).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'busy' } },
      })
    })
  })

  describe('the candidate of a dialog', () => {
    it('shows the files, the checks and the numbers it would be released under', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      expect(await caller.candidate.get({ taskId })).toBeNull()
      const candidate = await withCandidate(taskId)
      await db.candidateCheck.create({
        data: {
          candidateId: candidate.id,
          revision: 1,
          kind: 'php_lint',
          status: 'passed',
          finishedAt: new Date(),
        },
      })

      const shown = await caller.candidate.get({ taskId })

      expect(shown).toMatchObject({
        id: candidate.id,
        revision: 1,
        status: 'current',
        files: [{ path: 'wp-content/themes/cafe/header.php', change: 'modified' }],
        media: [],
        database: [],
        checks: [{ kind: 'php_lint', status: 'passed' }],
        proposal: {
          base: 'v0.0.0',
          version: 'v0.0.1',
          bump: 'patch',
          choices: [
            { version: 'v0.0.1', bump: 'patch' },
            { version: 'v0.1.0', bump: 'minor' },
            { version: 'v1.0.0', bump: 'major' },
          ],
        },
      })
      await expect(
        caller.candidate.fileDiff({ candidateId: candidate.id, path: 'wp-config.php' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        caller.candidate.fileDiff({
          candidateId: candidate.id,
          path: 'wp-content/themes/cafe/header.php',
        }),
      ).resolves.toEqual({
        path: 'wp-content/themes/cafe/header.php',
        state: 'missing',
        diff: null,
      })
    })

    it('serves the screenshot of the agent’s check to a member of the dialog alone (Р22)', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const candidate = await withCandidate(taskId)
      const shot = randomUUID()
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
      const objects = new Map([[browserScreenshotKey(taskId, shot), png]])
      const storage = {
        get: async (_bucket: string, key: string) => {
          const bytes = objects.get(key)
          return bytes
            ? (async function* () {
                yield bytes
              })()
            : null
        },
      } as unknown as ObjectStorage
      const check = await db.candidateCheck.create({
        data: {
          candidateId: candidate.id,
          revision: 1,
          kind: 'agent_browser',
          status: 'passed',
          summary: { v: 1, turn: 1, total: 1, passed: 1, failed: 0 },
          artifactKey: browserScreenshotKey(taskId, shot),
          finishedAt: new Date(),
        },
      })
      expect((await caller.candidate.get({ taskId }))?.checks).toEqual([
        expect.objectContaining({ id: check.id, kind: 'agent_browser', screenshot: true }),
      ])
      const read = (userId: string, ids: { taskId: string; checkId: string }) =>
        readCheckScreenshot(db, storage, { userId, ...ids })
      expect(await read(owner.id, { taskId, checkId: check.id })).toEqual(png)
      // Someone else's dialog, another dialog's id, a key that is not the dialog's own.
      const stranger = await person()
      expect(await read(stranger.id, { taskId, checkId: check.id })).toBeNull()
      expect(await read(owner.id, { taskId: randomUUID(), checkId: check.id })).toBeNull()
      expect(await read(owner.id, { taskId: 'not-a-uuid', checkId: check.id })).toBeNull()
      await db.candidateCheck.update({
        where: { id: check.id },
        data: { artifactKey: `candidates/${taskId}/1/patch.diff` },
      })
      expect(await read(owner.id, { taskId, checkId: check.id })).toBeNull()
      // A stale check is of another revision: its look is not shown.
      await db.candidateCheck.update({
        where: { id: check.id },
        data: { artifactKey: browserScreenshotKey(taskId, shot), status: 'stale' },
      })
      expect(await read(owner.id, { taskId, checkId: check.id })).toBeNull()
      expect((await caller.candidate.get({ taskId }))?.checks[0]?.screenshot).toBe(false)
    })

    it('tells how the runtime of the preview stands to the site’s (Р2, Р18)', async () => {
      const { owner, site } = await siteOwner({ database: true })
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId)
      expect((await caller.candidate.get({ taskId }))?.runtime).toBeNull()
      const runtimeMatch = { production: '7.4', preview: '8.3', missing: ['imagick'] }
      const { count } = await db.previewEnvironment.updateMany({
        where: { taskId },
        data: {
          runtime: {
            v: 1,
            database: null,
            web: null,
            seedChecked: false,
            sync: null,
            runtimeMatch,
          },
        },
      })
      expect(count).toBe(1)
      expect((await caller.candidate.get({ taskId }))?.runtime).toEqual(runtimeMatch)
    })

    it('carries a candidate onto the current version only when it stands on an old one', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const candidate = await withCandidate(taskId)

      await expect(
        caller.candidate.update({ taskId, requestId: randomUUID() }),
      ).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'up_to_date' } },
      })
      await db.taskCandidate.update({ where: { id: candidate.id }, data: { status: 'stale' } })
      const requestId = randomUUID()

      const updated = await caller.candidate.update({ taskId, requestId })

      expect(await outboxOf(`candidate.rebase:${taskId}`)).toEqual([
        {
          topic: 'agent-turns',
          type: 'candidate.rebase',
          payload: { taskId, requestEventId: updated.requestEventId },
          dedupeKey: `candidate.rebase:${taskId}:${updated.requestEventId}`,
        },
      ])
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        payload: { kind: 'command', command: 'update', requestId },
      })
      expect(await caller.candidate.update({ taskId, requestId })).toEqual({
        ...updated,
        repeated: true,
      })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
        'awaiting_approval',
      )
    })

    it('waits for the answer to a question before it carries or releases a candidate', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const candidate = await withCandidate(taskId)
      await db.taskCandidate.update({ where: { id: candidate.id }, data: { status: 'stale' } })
      await asked(taskId, {
        kind: 'agent',
        intro: 'Нужно уточнить.',
        questions: [{ text: 'Какой цвет кнопки?', options: [] }],
      })

      for (const press of [
        () => caller.candidate.update({ taskId, requestId: randomUUID() }),
        () => caller.release.prepare({ taskId }),
      ])
        await expect(press()).rejects.toMatchObject({
          cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'awaiting_answer' } },
        })
      expect(await outboxOf(`candidate.rebase:${taskId}`)).toEqual([])
      expect((await feedOf(taskId)).at(-1)!.type).toBe('feed.question')
    })

    it('offers the number core proposed for a candidate that adds media', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId, 1, { media: 1 })

      const feed = await caller.task.feed({ taskId })
      const shown = await caller.candidate.get({ taskId })
      const prepared = await caller.release.prepare({ taskId })

      expect(feed.candidate?.proposedVersion).toBe('v0.1.0')
      expect(shown?.proposal).toMatchObject({ version: 'v0.1.0', bump: 'minor' })
      expect(prepared.proposal).toEqual({ version: 'v0.1.0', bump: 'minor' })
    })
  })
})
