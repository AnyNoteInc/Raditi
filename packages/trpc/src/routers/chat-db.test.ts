import { createHash, randomInt, randomUUID } from 'node:crypto'

import {
  ensurePersonalWorkspaceWithGift,
  grantTariffCredits,
  releaseTask,
  tariffCreditsOfDay,
} from '@repo/billing'
import { settleTaskCharge, underPrivateCreditRate } from '@repo/billing/testing'
import {
  clearBrowserHelp,
  closeBrowserSession,
  createAttachment,
  createPrismaClient,
  ensurePersonalWorkspace,
  insertFeedEvent,
  markAttachmentReady,
  openBrowserSession,
  Prisma,
  recordBrowserControl,
  recordBrowserHelp,
  type PrismaClient,
  type User,
} from '@repo/db'
import {
  billingDay,
  browserScreenshotKey,
  feedLimits,
  feedRowText,
  legalDocuments,
  type DbPlanView,
  releaseKeyMaterial,
  type KvMetadata,
  type KvWriteOptions,
  type ModelClass,
  type ObjectStorage,
  type SecretStore,
  type ChatCommandFacts,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import { readCheckScreenshot } from '../services/chat/candidates.ts'
import { releaseConfirmKey, type ChatContext } from '../services/chat/context.ts'
import { commandRefusal, dialogFacts } from '../services/chat/dialog-facts.ts'
import { dialogPageQuery } from '../services/chat/dialog-list.ts'
import { lastQuestion, wordsOfTurn } from '../services/chat/dialog-state.ts'
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
const STREAM_URL = 'ws://localhost:8091/v1/browser/stream'
const SHA = (digit: string) => digit.repeat(40)

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
    // Files of messages: a file nobody sent holds its site and workspace.
    await db.attachment.deleteMany({ where: owned })
    await db.gitRepository.deleteMany({ where: { site: owned } })
    await db.snapshot.deleteMany({ where: { site: owned } })
    await db.turnAssignment.deleteMany({ where: { task: owned } })
    await db.task.deleteMany({ where: owned })
    await db.siteEnvVar.deleteMany({ where: { site: owned } })
    await db.siteDatabaseDump.deleteMany({ where: { site: owned } })
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

  function callerOf(
    user: User,
    options: {
      client?: PrismaClient
      preview?: boolean
      /** The cloud browser of the platform (docs/plan/57); off unless asked for. */
      browser?: boolean
      /** Whether the stack of the site has what the browser needs; true unless asked for. */
      browserStack?: boolean
      storage?: ObjectStorage
      /** The environment of the platform; a test one unless asked for. */
      appEnv?: ChatContext['appEnv']
    } = {},
  ) {
    const chat: ChatContext = {
      appEnv: options.appEnv ?? 'test',
      preview: options.preview === false ? null : { address: ADDRESS, ttlHours: 72 },
      browser: options.browser === true ? { streamUrl: STREAM_URL } : null,
      ...(options.browserStack === undefined
        ? {}
        : { browserSupported: () => options.browserStack === true }),
      releaseConfirmKey: KEY,
      storage: () => options.storage ?? storage,
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

  /** The repository of a site, as its first import writes it. */
  const withRepository = (siteId: string) =>
    db.gitRepository.create({
      data: {
        siteId,
        provider: 'gitea',
        owner: 'sites',
        name: `site-${siteId}`,
        url: `https://git.example.ru/sites/site-${siteId}`,
      },
    })

  /**
   * An owner with the gift of the registration and an active site of their workspace, with its
   * repository; `gift: false` — the workspace alone, as a test that counts tariff credits only
   * needs it; `repository: false` — a site without files.
   */
  async function siteOwner(
    options: { database?: boolean; gift?: boolean; repository?: boolean } = {},
  ) {
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
    if (options.repository !== false) await withRepository(site.id)
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
        maxSites: 3,
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
        title: 'Поменяйте телефон',
        createdById: owner.id,
        alias: created.alias,
      })
      // The gift of the registration is all the workspace has: the reserve takes one credit of
      // it — what a pass spends is not bounded by the reserve (КР5–КР8).
      const holds = await activeHolds(taskId)
      expect(holds.map((hold) => [hold.attempt, hold.amount.toFixed(0)])).toEqual([[1, '1']])
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
          payload: { taskId, attempt: 1, requestEventId: String(feed[0]!.id), priority: 4 },
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

    it('builds the copy of a site whose database comes from a dump on its file source', async () => {
      const { owner, site } = await siteOwner()
      await db.siteDatabaseDump.create({ data: { siteId: site.id, path: 'backup.sql' } })
      const { taskId } = await newDialog(callerOf(owner), site.id)

      const preview = await db.previewEnvironment.findUniqueOrThrow({ where: { taskId } })
      expect(preview).toMatchObject({ status: 'pending', dbMode: 'copy', unavailableReason: null })
      expect(await outboxOf(preview.id)).toHaveLength(1)
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

      // Without the private credit rate: this database has none, and no task is taken. The class
      // is priced, so the refusal is the reserve's, not the class's.
      await expect(
        callerOf(owner, { client: underRate(db, { rate: false }) }).task.create({
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

    it('makes the Transit key of the workspace first, and writes nothing when Vault fails', async () => {
      // docs/plan/57, Б32: every turn seals its snapshot with the key; no other step makes it.
      const { owner, site, workspaceId } = await siteOwner({ database: true })
      const key = `ws-${workspaceId}`
      const taskId = randomUUID()
      taskIds.push(taskId)
      const input = { siteId: site.id, taskId, text: 'Добавьте отзывы' }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vault.transit.failing = true
      try {
        await expect(callerOf(owner).task.create(input)).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          cause: { code: 'WORKSPACE_KEY_UNAVAILABLE' },
        })
      } finally {
        vault.transit.failing = false
        warn.mockRestore()
      }
      expect(await db.task.count({ where: { id: taskId } })).toBe(0)
      expect(await db.taskEvent.count({ where: { taskId } })).toBe(0)
      expect(await db.creditHold.count({ where: { taskId } })).toBe(0)
      expect(await db.previewEnvironment.count({ where: { taskId } })).toBe(0)
      expect(await outboxOf(taskId)).toEqual([])
      expect(vault.workspaceKeys).not.toContain(key)

      // The same press again, Vault back: the key is made once and the task is taken.
      await expect(callerOf(owner).task.create(input)).resolves.toMatchObject({ created: true })
      await expect(callerOf(owner).task.create(input)).resolves.toMatchObject({ created: false })
      expect(vault.workspaceKeys.filter((made) => made === key)).toEqual([key])
    })

    it('takes no dialog for a site that is not connected or a workspace of client data', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      await db.site.update({ where: { id: site.id }, data: { status: 'onboarding' } })
      const caller = callerOf(owner)
      // Neither its repository nor a browser: the state of the matrix names the refusal (К8).
      await expect(newDialog(caller, site.id)).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'TASK_NOT_ACCEPTED', details: { reason: 'browser_unavailable' } },
      })
      await db.site.update({ where: { id: site.id }, data: { status: 'paused' } })
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

    it('goes on in a dialog a pass left open without changes: the words answer its result', async () => {
      // The owner, 26.10.2026: «после того как в работе произошла какая-то работа, не закрывай чат».
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
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
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
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
          // No tariff: the last place in the queue (plan 70, §2.3).
          payload: { taskId, attempt: 2, requestEventId: posted.requestEventId, priority: 4 },
        }),
      )
    })

    // The owner, 28.10.2026: «никогда не завершай диалог, если произошла ошибка… пользователь
    // может ввести "продолжи" и задача должна продолжиться».
    it('goes on in a dialog a failed pass left open: the words answer the failure, a new reserve', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const failureId = await db.$transaction(
        async (tx) => {
          // What core does when the first pass fails: the dialog waits, its reserve goes back.
          await tx.task.update({
            where: { id: taskId },
            data: { status: 'awaiting_user', turnNo: 1 },
          })
          await releaseTask(tx, { taskId, now: new Date() })
          // An answer of an earlier pass comes before the failure: the list asks the client again.
          await insertFeedEvent(tx, {
            taskId,
            row: {
              type: 'feed.result',
              payload: {
                v: 1,
                turn: 1,
                message: 'Начинаю публикацию.',
                site: 'unchanged',
                next: 'awaiting_user',
                filesChanged: 0,
                changeType: 'none',
                needsApproval: false,
                risk: 'low',
              },
            },
          })
          return insertFeedEvent(tx, {
            taskId,
            row: {
              type: 'feed.failure',
              payload: {
                v: 1,
                turn: 1,
                code: 'technical',
                site: 'check',
                credits: 'returned',
                next: 'awaiting_user',
              },
            },
          })
        },
        { isolationLevel: 'ReadCommitted' },
      )
      expect(await activeHolds(taskId)).toEqual([])
      const listed = (await caller.task.list({ folder: site.id })).items
      // A failure asks nothing to confirm (06.11.2026): «Ошибка», and the folder is not lit.
      expect(listed.find((item) => item.id === taskId)).toMatchObject({
        status: 'awaiting_user',
        answered: false,
        failed: true,
      })
      expect(
        (await caller.task.folders({})).folders.find((folder) => folder.project?.id === site.id),
      ).toMatchObject({ attention: false })

      const posted = await caller.task.message({
        taskId,
        requestId: randomUUID(),
        text: 'продолжи',
      })

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
      })
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        id: BigInt(posted.requestEventId),
        payload: { kind: 'answer', answersEventId: String(failureId) },
      })
      // Nothing was charged for the failed pass; the words reserve anew, as a new chain.
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([2])
      expect(await outboxOf(taskId)).toContainEqual(
        expect.objectContaining({
          type: 'turn.run',
          // No tariff: the last place in the queue (plan 70, §2.3).
          payload: { taskId, attempt: 2, requestEventId: posted.requestEventId, priority: 4 },
        }),
      )
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

    // The owner, 28.10.2026: «пользователь всегда должен иметь возможность ввести промпт».
    it('goes on with the words after a question about credits, as «Продолжить» does', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      await paidTariff(workspaceId)
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
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
      const spent = await newDialog(caller, site.id)
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

    it('continues with «Продолжить» after a reset of the preview', async () => {
      const { owner, site, workspaceId } = await siteOwner({ database: true })
      await paidTariff(workspaceId)
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await db.previewEnvironment.update({ where: { taskId }, data: { status: 'ready' } })
      await asked(taskId, { kind: 'ceiling', reason: 'step', spent: 30, held: 35, left: 5 })

      await caller.preview.reset({ taskId, requestId: randomUUID() })

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

  // docs/plan/61-chats-first.md, К31, §5.14: a pass of the agent, as the next words would be.
  describe('task.init', () => {
    async function answered(taskId: string) {
      await db.$transaction(async (tx) => {
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
              filesChanged: null,
              changeType: 'none',
              needsApproval: false,
              risk: 'low',
            },
          },
        })
      })
      // The pass was charged: the words after it open the next chain.
      await db.$transaction((tx) => settleTaskCharge(tx, { taskId, credits: 5, now: new Date() }), {
        isolationLevel: 'ReadCommitted',
      })
    }

    it('writes the command, moves the chat on and puts the pass with a reserve of its own', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await answered(taskId)
      const requestId = randomUUID()

      const posted = await caller.task.init({ taskId, requestId })

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
      })
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([2])
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        id: BigInt(posted.requestEventId),
        payload: { kind: 'agent_command', command: 'init', requestId },
      })
      expect((await outboxOf(taskId)).map((row) => row.dedupeKey)).toContain(
        `turn.run:${taskId}:2:${posted.requestEventId}`,
      )
      expect(await caller.task.init({ taskId, requestId })).toEqual({ ...posted, repeated: true })
      expect((await activeHolds(taskId)).map((hold) => hold.attempt)).toEqual([2])
    })

    it('answers an open question as words do: the chat does not wait for it any more', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const question = await asked(taskId, {
        kind: 'agent',
        intro: 'Нужно уточнить.',
        questions: [{ text: 'Какой номер?', options: [] }],
      })

      await caller.task.init({ taskId, requestId: randomUUID() })

      expect(await lastQuestion(db, taskId)).toMatchObject({ id: question, answered: true })
    })

    // The reserve as the next words have it, on the same facts of two chats side by side.
    it.each([
      ['step', { kind: 'ceiling', reason: 'step', spent: 30, held: 35, left: 5 }, false],
      ['attempts', { kind: 'ceiling', reason: 'attempts', spent: 120, held: 0, left: 0 }, true],
    ] as const)(
      'goes on after a question about credits (%s) as the next words do',
      async (_reason, question, charged) => {
        const { owner, site, workspaceId } = await siteOwner()
        await paidTariff(workspaceId)
        const caller = callerOf(owner)
        async function waiting(words: string) {
          const { taskId } = await newDialog(caller, site.id, words)
          if (charged)
            await db.$transaction(
              (tx) => settleTaskCharge(tx, { taskId, credits: 5, now: new Date() }),
              { isolationLevel: 'ReadCommitted' },
            )
          await asked(taskId, question)
          return taskId
        }
        const byWords = await waiting('Поменяйте телефон')
        const byCommand = await waiting('Добавьте адрес')

        await caller.task.message({ taskId: byWords, requestId: randomUUID(), text: 'продолжи' })
        await caller.task.init({ taskId: byCommand, requestId: randomUUID() })

        const stateOf = async (taskId: string) => ({
          ...(await db.task.findUniqueOrThrow({
            where: { id: taskId },
            select: { status: true, attempt: true },
          })),
          attempts: (await activeHolds(taskId)).map((hold) => hold.attempt).sort(),
        })
        const state = await stateOf(byCommand)
        expect(state).toEqual(await stateOf(byWords))
        expect(state).toMatchObject({ status: 'queued', attempt: 2 })
        expect(state.attempts).toEqual(charged ? [2] : [1, 2])
        expect((await lastQuestion(db, byCommand))?.answered).toBe(true)
      },
    )

    it('is refused for credits as the next words are, and leaves nothing', async () => {
      // Tariff credits only: the first chat took 5 of the 6 of the day, the second holds the last.
      const { owner, site, workspaceId } = await siteOwner({ gift: false })
      await paidTariff(workspaceId, { creditsPerDay: 6 })
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await answered(taskId)
      await newDialog(caller, site.id, 'Добавьте баннер на главную')
      const rows = (await feedOf(taskId)).length
      const jobs = (await outboxOf(taskId)).length

      await expect(caller.task.init({ taskId, requestId: randomUUID() })).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'BILLING_DAILY_LIMIT_REACHED' },
      })

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'awaiting_user',
        attempt: 1,
      })
      expect(await feedOf(taskId)).toHaveLength(rows)
      expect(await outboxOf(taskId)).toHaveLength(jobs)
      expect(await activeHolds(taskId)).toEqual([])
    })

    it('runs in a chat that waits with a candidate, and keeps the candidate', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const candidate = await withCandidate(taskId)
      await db.$transaction((tx) => settleTaskCharge(tx, { taskId, credits: 5, now: new Date() }), {
        isolationLevel: 'ReadCommitted',
      })

      const posted = await caller.task.init({ taskId, requestId: randomUUID() })

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
      })
      expect((await feedOf(taskId)).at(-1)).toMatchObject({
        id: BigInt(posted.requestEventId),
        payload: { kind: 'agent_command', command: 'init' },
      })
      expect((await outboxOf(taskId)).map((row) => row.dedupeKey)).toContain(
        `turn.run:${taskId}:2:${posted.requestEventId}`,
      )
      expect(
        await db.taskCandidate.findUniqueOrThrow({ where: { id: candidate.id } }),
      ).toMatchObject({ revision: candidate.revision, headSha: candidate.headSha })
    })

    it('refuses a chat at work, in the words of `task.commands`', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await expect(caller.task.init({ taskId, requestId: randomUUID() })).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'busy' } },
      })
    })

    // As `/compact`: a turn of the command would take the browser from the client (§5.14).
    it('leaves the browser with the client and a request of the agent in it unanswered', async () => {
      const { owner, workspaceId, site } = await siteOwner()
      const caller = callerOf(owner)
      // A chat of the project works with the code and the browser (К11); this suite has no browser
      // to create one with, and the requirements of a task are fixed when it is created.
      const { id: taskId } = await db.task.create({
        data: {
          workspaceId,
          siteId: site.id,
          needsRepository: true,
          needsBrowser: true,
          status: 'awaiting_user',
        },
      })
      taskIds.push(taskId)
      const verdict = async () =>
        (await caller.task.commands({ taskId })).find((item) => item.id === 'init')?.refusal
      const session = await openBrowserSession(db, { taskId })
      expect(await verdict()).toBeNull()

      await recordBrowserHelp(db, {
        sessionId: session.id,
        reason: 'login',
        message: 'Войдите в админку сайта',
      })
      expect(await verdict()).toBe('awaiting_answer')
      await expect(caller.task.init({ taskId, requestId: randomUUID() })).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'awaiting_answer' } },
      })
      await clearBrowserHelp(db, { sessionId: session.id })

      await recordBrowserControl(db, { sessionId: session.id, controller: 'user', controlEpoch: 1 })
      expect(await verdict()).toBe('browser_with_client')
      await expect(caller.task.init({ taskId, requestId: randomUUID() })).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'browser_with_client' } },
      })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
        'awaiting_user',
      )
      expect(await outboxOf(taskId)).toEqual([])

      await recordBrowserControl(db, {
        sessionId: session.id,
        controller: 'agent',
        controlEpoch: 2,
      })
      expect(await verdict()).toBeNull()
    })
  })

  // docs/plan/61-chats-first.md, К31, §5.9, on the real rows: a mock cannot see `accessibleSite`.
  describe('the notes of a project', () => {
    const notes = 'Шапка — `Header.php`, начните с `README.md`.'
    const audits = (siteId: string) =>
      db.auditLog.findMany({ where: { targetId: siteId, action: 'site.agent_notes.change' } })

    async function joined(workspaceId: string, role: 'admin' | 'member') {
      const user = await person()
      await db.member.create({ data: { workspaceId, userId: user.id, role } })
      return callerOf(user)
    }

    it('answers a stranger as about a project that does not exist', async () => {
      const { site } = await siteOwner()
      await db.site.update({ where: { id: site.id }, data: { agentNotes: 'Чужие подсказки' } })
      const stranger = callerOf(await person())

      await expect(stranger.project.agentNotes({ id: site.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      await expect(
        stranger.project.setAgentNotes({ id: site.id, notes, seen: 'Чужие подсказки' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      expect((await db.site.findUniqueOrThrow({ where: { id: site.id } })).agentNotes).toBe(
        'Чужие подсказки',
      )
      expect(await audits(site.id)).toEqual([])
    })

    it('answers about a removed project as about one that does not exist', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      await db.site.update({ where: { id: site.id }, data: { deletedAt: new Date() } })
      await expect(caller.project.agentNotes({ id: site.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      await expect(
        caller.project.setAgentNotes({ id: site.id, notes, seen: null }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('lets a member read them and not change them', async () => {
      const { site, workspaceId } = await siteOwner()
      await db.site.update({
        where: { id: site.id },
        data: { agentNotes: 'Вход по адресу /login' },
      })
      const member = await joined(workspaceId, 'member')

      expect(await member.project.agentNotes({ id: site.id })).toEqual({
        notes: 'Вход по адресу /login',
        canManage: false,
      })
      await expect(
        member.project.setAgentNotes({ id: site.id, notes, seen: 'Вход по адресу /login' }),
      ).rejects.toMatchObject({ cause: { code: 'PROJECT_NOTES_NOT_ALLOWED' } })
      expect((await db.site.findUniqueOrThrow({ where: { id: site.id } })).agentNotes).toBe(
        'Вход по адресу /login',
      )
    })

    it('saves what an owner or an admin left, and audits it without the text', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      const admin = await joined(workspaceId, 'admin')

      expect(await callerOf(owner).project.agentNotes({ id: site.id })).toEqual({
        notes: null,
        canManage: true,
      })
      expect(await admin.project.setAgentNotes({ id: site.id, notes, seen: null })).toEqual({
        notes,
      })
      await callerOf(owner).project.setAgentNotes({ id: site.id, notes: ' ', seen: notes })

      expect((await db.site.findUniqueOrThrow({ where: { id: site.id } })).agentNotes).toBeNull()
      const rows = await audits(site.id)
      expect(rows.map((row) => row.meta).sort()).toEqual(
        expect.arrayContaining([{ cleared: false }, { cleared: true }]),
      )
      expect(JSON.stringify(rows)).not.toContain('README')
    })

    // §5.14: «Прежние подсказки молча не затираются».
    it('replaces no notes but those the window showed', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      await caller.project.setAgentNotes({ id: site.id, notes: 'Подсказки коллеги', seen: null })

      await expect(
        caller.project.setAgentNotes({ id: site.id, notes, seen: null }),
      ).rejects.toMatchObject({ code: 'CONFLICT', cause: { code: 'PROJECT_NOTES_CHANGED' } })

      expect((await db.site.findUniqueOrThrow({ where: { id: site.id } })).agentNotes).toBe(
        'Подсказки коллеги',
      )
      expect(await audits(site.id)).toHaveLength(1)
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

    it.each([
      ['turn_undo', 'TASK_REWINDING'],
      ['turn_redo', 'TASK_REDOING'],
    ] as const)('starts no repeat while %s moves a turn', async (command, code) => {
      const { caller, taskId, failureId, owner } = await keptAfterFailure()
      await db.$transaction((tx) =>
        insertFeedEvent(tx, {
          taskId,
          row: {
            type: 'feed.request',
            payload: {
              v: 1,
              kind: 'command',
              command,
              authorId: owner.id,
              requestId: randomUUID(),
            },
          },
        }),
      )
      await expect(
        caller.task.retry({ taskId, requestId: randomUUID(), failureEventId: failureId }),
      ).rejects.toMatchObject({ cause: { code } })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
        'awaiting_approval',
      )
    })

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
      // The reserve of the failed attempt came back; the retry holds one credit of its own.
      expect(
        (await db.creditHold.findMany({ where: { taskId }, orderBy: { attempt: 'asc' } })).map(
          (hold) => [hold.attempt, hold.status, hold.amount.toFixed(2)],
        ),
      ).toEqual([
        [1, 'released', held[0]!.amount.toFixed(2)],
        [2, 'active', '1.00'],
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
        message: 'Повторить уже нельзя: в чате что-то изменилось',
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

    // The owner, 19.10.2026: the daily limit does not apply to «Попробовать ещё». What the retry
    // takes still counts on the day: «Продолжить» and a new dialog after it meet the day.
    it('repeats a pass the day has no credits left for, and holds what comes after to the day', async () => {
      // Tariff credits only, 1 a day: the failed pass holds 1 of yesterday, another dialog the 1
      // of today, so nothing is left of today — nothing but the retry is taken.
      const { owner, site, workspaceId } = await siteOwner({ database: true, gift: false })
      await paidTariff(workspaceId, { creditsPerDay: 1, startedDaysAgo: 3 })
      const caller = callerOf(owner, { client: underRateAndHeavy(db) })
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId)
      const failureId = String(await failedPass(taskId))
      const yesterday = new Date(billingDay(new Date()).start.getTime() - 60_000)
      await db.creditHold.updateMany({ where: { taskId }, data: { placedAt: yesterday } })
      const { taskId: other } = await newDialog(caller, site.id, 'Добавьте баннер на главную')
      expect((await activeHolds(other)).map((hold) => hold.amount.toFixed(0))).toEqual(['1'])
      expect(await tariffCreditsOfDay(db, { workspaceId, now: new Date() })).toEqual({
        charged: 0,
        held: 1,
      })

      const posted = await caller.task.retry({
        taskId,
        requestId: randomUUID(),
        failureEventId: failureId,
      })

      // The reserve of one credit, a tariff credit the day did not have.
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 2,
        modelClass: 'heavy',
      })
      expect(
        (await db.creditHold.findMany({ where: { taskId }, orderBy: { attempt: 'asc' } })).map(
          (hold) => [hold.attempt, hold.unit, hold.status, hold.amount.toFixed(0)],
        ),
      ).toEqual([
        [1, 'credit_tariff', 'released', '1'],
        [2, 'credit_tariff', 'active', '1'],
      ])
      expect((await outboxOf(taskId)).map((row) => row.dedupeKey)).toContain(
        `turn.run:${taskId}:2:${posted.requestEventId}`,
      )
      // It counts on the day: 2 of 1, nothing left of it.
      expect(await tariffCreditsOfDay(db, { workspaceId, now: new Date() })).toEqual({
        charged: 0,
        held: 2,
      })

      // «Продолжить» of the other dialog is held to the day, and nothing moves.
      await asked(other, { kind: 'ceiling', reason: 'step', spent: 45, held: 45, left: 0 })
      await expect(
        caller.task.continue({ taskId: other, requestId: randomUUID() }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'BILLING_DAILY_LIMIT_REACHED', details: { reason: 'daily_limit' } },
      })
      expect(await db.task.findUniqueOrThrow({ where: { id: other } })).toMatchObject({
        status: 'awaiting_user',
        attempt: 1,
      })
      expect((await activeHolds(other)).map((hold) => hold.attempt)).toEqual([1])
      // So is a new dialog.
      await expect(newDialog(caller, site.id, 'Уберите баннер')).rejects.toMatchObject({
        cause: { code: 'BILLING_DAILY_LIMIT_REACHED' },
      })
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
    // docs/plan/61-chats-first.md, К18; the row is written here until `task.create` takes one.
    it('closes a waiting chat without a project with no word of a site', async () => {
      const { owner, workspaceId } = await siteOwner()
      const caller = callerOf(owner)
      const task = await db.task.create({
        data: {
          workspaceId,
          siteId: null,
          needsRepository: false,
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

  // The owner's request of 26.10.2026: a dialog is renamed, deleted, and its level of thinking
  // changed while it goes on; none of it moves the dialog in the list.
  describe('task.rename, task.remove, task.setEffort', () => {
    const updatedAt = async (taskId: string) =>
      (await db.task.findUniqueOrThrow({ where: { id: taskId } })).updatedAt.getTime()

    it('renames a dialog in its head and the list, and refuses a name it would not store', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const before = await updatedAt(taskId)

      expect(await caller.task.rename({ taskId, title: '  Телефон\n в шапке  ' })).toEqual({
        title: 'Телефон в шапке',
      })

      expect((await caller.task.feed({ taskId })).task.title).toBe('Телефон в шапке')
      const listed = await caller.task.list({ folder: site.id })
      expect(listed.items.find((item) => item.id === taskId)?.title).toBe('Телефон в шапке')
      expect(await updatedAt(taskId)).toBe(before)
      for (const [title, code] of [
        [' \n ', 'TASK_TEXT_EMPTY'],
        ['ы'.repeat(121), 'TASK_TEXT_TOO_LONG'],
        ['пароль Qwerty12345', 'TASK_TEXT_HAS_SECRET'],
      ] as const)
        await expect(caller.task.rename({ taskId, title })).rejects.toMatchObject({
          cause: { code },
        })
      await expect(
        callerOf(await person()).task.rename({ taskId, title: 'Чужой' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('finds a chat without a site for a member of its workspace, and for nobody else', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { id: taskId } = await db.task.create({
        data: {
          workspaceId: site.workspaceId,
          status: 'done',
          needsRepository: false,
          needsBrowser: false,
        },
      })
      const stranger = callerOf(await person())
      await expect(stranger.task.rename({ taskId, title: 'Чужой' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      await expect(stranger.task.remove({ taskId })).rejects.toMatchObject({ code: 'NOT_FOUND' })

      await caller.task.rename({ taskId, title: 'Вопрос' })
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        title: 'Вопрос',
      })
      expect(await caller.task.remove({ taskId })).toEqual({ removed: true })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).deletedAt).not.toBeNull()
    })

    it('deletes a dialog that waits: it is cancelled first, then gone from the cabinet', async () => {
      const { owner, site } = await siteOwner({ database: true })
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)

      expect(await caller.task.remove({ taskId })).toEqual({ removed: true })

      const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.status).toBe('cancelled')
      expect(task.deletedAt).not.toBeNull()
      expect(await activeHolds(taskId)).toEqual([])
      expect((await feedOf(taskId)).at(-1)?.type).toBe('feed.cancelled')
      // The preview is sent to be taken down with the cancel.
      const preview = await db.previewEnvironment.findUniqueOrThrow({ where: { taskId } })
      expect(preview.enqueues).toBe(2)
      expect(
        (await caller.task.list({ folder: site.id })).items.map((item) => item.id),
      ).not.toContain(taskId)
      await expect(caller.task.feed({ taskId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(caller.task.rename({ taskId, title: 'Снова' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      // A repeat after a lost answer: the same answer, nothing written again.
      const rows = (await feedOf(taskId)).length
      expect(await caller.task.remove({ taskId })).toEqual({ removed: true })
      expect(await feedOf(taskId)).toHaveLength(rows)
    })

    it('deletes a dialog at work by asking core to stop it, and refuses one being released', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await db.task.update({ where: { id: taskId }, data: { status: 'running', turnNo: 1 } })

      await caller.task.remove({ taskId })

      const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task.status).toBe('running')
      expect(task.deletedAt).not.toBeNull()
      expect((await outboxOf(`turn.cancel:${taskId}`)).map((row) => row.type)).toEqual([
        'turn.cancel',
      ])

      // Another owner: the first dialog still holds its reserve of the gift while core stops it.
      const second = await siteOwner()
      const releasing = await newDialog(callerOf(second.owner), second.site.id)
      await db.task.update({ where: { id: releasing.taskId }, data: { status: 'deploying' } })
      await expect(
        callerOf(second.owner).task.remove({ taskId: releasing.taskId }),
      ).rejects.toMatchObject({
        cause: { code: 'RELEASE_IN_PROGRESS' },
      })
      expect(
        (await db.task.findUniqueOrThrow({ where: { id: releasing.taskId } })).deletedAt,
      ).toBeNull()
    })

    it('changes the level of thinking of a dialog that waits, from its next turn', async () => {
      const { owner, site } = await siteOwner()
      const { taskId } = await newDialog(callerOf(owner), site.id)
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

    it('keeps a dialog whose release, or its undo, the operator has still to settle', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const candidate = await withCandidate(taskId)
      const at = new Date()
      await db.siteRelease.create({
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
          status: 'unknown',
          committedAt: at,
          approvedAt: at,
          approvedBy: owner.id,
        },
      })
      // The dialog has ended; the outcome of its release waits for the operator in its feed.
      await db.task.update({ where: { id: taskId }, data: { status: 'done' } })

      await expect(caller.task.remove({ taskId })).rejects.toMatchObject({
        cause: { code: 'RELEASE_IN_PROGRESS' },
      })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).deletedAt).toBeNull()
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

    it.each([
      ['turn_undo', 'turn_rewinding'],
      ['turn_redo', 'turn_redoing'],
    ] as const)(
      'takes no confirmation while %s moves the turn of its window',
      async (command, refusal) => {
        const { owner, site } = await siteOwner()
        const caller = callerOf(owner)
        const { taskId } = await newDialog(caller, site.id)
        await withCandidate(taskId)
        const prepared = await caller.release.prepare({ taskId })
        const choice = prepared.choices[0]!
        // Another tab of the same window, or another manager: the token outlives the press.
        const press = await insertFeedEvent(db, {
          taskId,
          row: {
            type: 'feed.request',
            payload: {
              v: 1,
              kind: 'command',
              command,
              authorId: owner.id,
              requestId: randomUUID(),
            },
          },
        })
        const statusBefore = (await db.task.findUniqueOrThrow({ where: { id: taskId } })).status

        await expect(
          caller.release.confirm({
            taskId,
            confirmToken: choice.confirmToken,
            version: choice.version,
          }),
        ).rejects.toMatchObject({
          cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal } },
        })
        expect(await db.siteRelease.count({ where: { taskId } })).toBe(0)
        expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
          statusBefore,
        )

        // The press answered, the chat is free again.
        await db.taskEvent.create({
          data: {
            taskId,
            type: 'candidate.rewind',
            payload: { v: 1, requestEventId: String(press), outcome: 'refused' },
          },
        })
        await expect(
          caller.release.confirm({
            taskId,
            confirmToken: choice.confirmToken,
            version: choice.version,
          }),
        ).resolves.toMatchObject({ status: 'approved' })
      },
    )

    it('says the chat is open to a window that outlived the candidate it was opened for', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId)
      const choice = (await caller.release.prepare({ taskId })).choices[0]!
      const confirm = () =>
        caller.release.confirm({
          taskId,
          confirmToken: choice.confirmToken,
          version: choice.version,
        })

      // `/redo` opened the question of its turn again, and the candidate stands.
      await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_user' } })
      await expect(confirm()).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'awaiting_answer' } },
      })

      // `/undo` left nothing to release.
      await db.taskCandidate.updateMany({
        where: { taskId },
        data: { status: 'superseded', supersededAt: new Date() },
      })
      await expect(confirm()).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'no_candidate' } },
      })
      expect(await db.siteRelease.count({ where: { taskId } })).toBe(0)
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
    async function installedDialog(ago = 60_000, options: { browser?: boolean } = {}) {
      const { owner, site, workspaceId } = await siteOwner()
      const caller = callerOf(owner, { browser: options.browser === true })
      const { taskId } = options.browser
        ? await chatWithTheBrowser(workspaceId, site.id)
        : await newDialog(caller, site.id)
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
      const session = options.browser ? await openBrowserSession(db, { taskId }) : null
      await db.task.update({ where: { id: taskId }, data: { status: 'done' } })
      return { owner, caller, site, workspaceId, taskId, release, session }
    }

    /** The chat `task.create` does not make yet: the code and the browser (docs/plan/61, 61.11). */
    async function chatWithTheBrowser(workspaceId: string, siteId: string) {
      const task = await db.task.create({
        data: {
          workspaceId,
          siteId,
          needsRepository: true,
          needsBrowser: true,
          status: 'awaiting_approval',
          turnNo: 1,
          attempt: 1,
        },
      })
      taskIds.push(task.id)
      return { taskId: task.id }
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

    it('says in the plan whether the browser of the chat acted on the site (§5.8)', async () => {
      const dialog = await installedDialog(60_000, { browser: true })
      const { caller, taskId, release, session } = dialog
      const { planId } = await caller.release.undoPrepare({ taskId, releaseId: release.id })
      await planned(planId)
      const plan = () => caller.release.undoPlan({ taskId, releaseId: release.id, planId })

      expect(await plan()).toMatchObject({ state: 'ready', browserWrote: false })
      await db.browserSession.update({
        where: { id: session!.id },
        data: { wroteAt: new Date() },
      })
      expect(await plan()).toMatchObject({ state: 'ready', browserWrote: true })
    })

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
      const list = await caller.task.list({ folder: site.id })
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

    // docs/plan/61-chats-first.md, К39: «Отменить выпуск» of a closed project answers for itself.
    it.each(['paused', 'disconnected', 'archived'] as const)(
      'takes no undo of a project %s: by its own refusal, and writes nothing',
      async (status) => {
        const { caller, site, taskId, release } = await installedDialog()
        const closeTo = (next: 'active' | typeof status) =>
          db.site.update({ where: { id: site.id }, data: { status: next } })
        const inactive = { cause: { details: { refusal: 'site_inactive' } } }
        const plans = () => db.releaseUndoPlan.count({ where: { releaseId: release.id } })

        await closeTo(status)
        const { commands } = await caller.task.feed({ taskId })
        expect(commands.find((command) => command.id === 'undo')?.refusal).toBe('site_inactive')
        await expect(
          caller.release.undoPrepare({ taskId, releaseId: release.id }),
        ).rejects.toMatchObject(inactive)
        expect(await plans()).toBe(0)

        await closeTo('active')
        const { planId } = await caller.release.undoPrepare({ taskId, releaseId: release.id })
        await planned(planId)
        const shown = await caller.release.undoPlan({ taskId, releaseId: release.id, planId })
        if (shown.state !== 'ready') throw new Error('expected a ready plan')
        const confirm = {
          taskId,
          releaseId: release.id,
          confirmToken: shown.confirmToken,
          version: shown.version,
        }

        await closeTo(status)
        await expect(caller.release.undoConfirm(confirm)).rejects.toMatchObject(inactive)
        expect(await db.siteRelease.count({ where: { siteId: site.id, kind: 'undo' } })).toBe(0)
        expect(await plans()).toBe(1)

        await closeTo('active')
        await expect(caller.release.undoConfirm(confirm)).resolves.toMatchObject({
          repeated: false,
        })
      },
    )

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

    it('never gives the saved sign-in to the agent or a preview, whatever the page sent (Б36)', async () => {
      const { owner, site } = await siteOwner()
      const input = {
        siteId: site.id,
        name: 'SITE_ADMIN_PASSWORD',
        value: 'synthetic-admin-password',
        hosts: [],
        toPreview: false,
        toAgent: true,
        agentConsent: true,
      }
      for (const asked of [
        input,
        { ...input, toAgent: false, agentConsent: false, toPreview: true },
      ])
        await expect(callerOf(owner).siteEnv.set(asked)).rejects.toMatchObject({
          cause: { code: 'SITE_ENV_SIGN_IN_PRIVATE' },
        })
      // Refused before Vault: no value was written.
      expect(vault.keys.has(`kv/sites/${site.id}/env/SITE_ADMIN_PASSWORD`)).toBe(false)
      await expect(
        callerOf(owner).siteEnv.set({ ...input, toAgent: false, agentConsent: false }),
      ).resolves.toMatchObject({ name: 'SITE_ADMIN_PASSWORD', toAgent: false, toPreview: false })
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
        // Asked for while it is made, the preview is shown once ready (27.10.2026).
        preview: null,
        reset: 'preview_not_ready',
        update: 'up_to_date',
        init: null,
        compact: 'nothing_to_compact',
        retry: 'nothing_to_retry',
        cancel: null,
        undo: 'no_release',
        turn_undo: 'nothing_to_undo',
        turn_redo: 'nothing_to_redo',
      })
      expect(feed.undo).toBeNull()
      expect((await caller.task.feed({ taskId, after: feed.cursor })).events).toEqual([])
      expect(await caller.task.commands({ taskId })).toEqual(feed.commands)
      expect(await caller.task.get({ taskId })).toMatchObject({
        ...feed.task,
        siteId: site.id,
        alias: expect.stringMatching(/^[0-9a-z]{4,12}$/),
      })
      expect((await caller.task.list({ folder: site.id })).items.map((item) => item.id)).toEqual([
        taskId,
      ])
    })
  })

  describe('task.export (docs/plan/61-chats-first.md, §5.14)', () => {
    it('writes the chat out in the words of the feed, under its name', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id, 'Поменяйте телефон в шапке')
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
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
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
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
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
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
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
      const { owner, site } = await siteOwner()
      const { taskId } = await newDialog(callerOf(owner), site.id)
      const other = await person()

      await expect(callerOf(other).task.export({ taskId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('reads a chat of a closed project: it is read, not worked in (К39)', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id, 'Поменяйте телефон в шапке')
      await db.site.update({ where: { id: site.id }, data: { status: 'paused' } })

      expect((await caller.task.export({ taskId })).markdown).toContain('Поменяйте телефон')
    })

    it('stands a chat that was removed with one that does not exist', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await caller.task.remove({ taskId })

      await expect(caller.task.export({ taskId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  describe('the preview of a dialog', () => {
    it('opens a served preview with a one-time ticket whose hash alone is kept', async () => {
      const { owner, site } = await siteOwner({ database: true })
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      const preview = await db.previewEnvironment.findUniqueOrThrow({ where: { taskId } })

      // Being made: the frame asks again by itself (PREVIEW_NOT_READY), no ticket is issued.
      await expect(caller.preview.ticket({ taskId })).rejects.toMatchObject({
        cause: { code: 'PREVIEW_NOT_READY' },
      })
      expect(await db.previewTicket.count({ where: { previewId: preview.id } })).toBe(0)
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
  describe('tasks in the browser (docs/plan/57)', () => {
    /** A site added for the browser alone: not connected, no files, no repository. */
    async function browserSite(options: { gift?: boolean } = {}) {
      const owned = await siteOwner({ ...options, repository: false })
      const site = await db.site.update({
        where: { id: owned.site.id },
        data: { status: 'onboarding' },
      })
      return { ...owned, site }
    }

    /** A file announced and stored, as `PUT /api/attachments/<id>` leaves it. */
    async function readyFile(owner: User, site: { id: string; workspaceId: string }, ready = true) {
      const file = await createAttachment(db, {
        workspaceId: site.workspaceId,
        siteId: site.id,
        uploadedById: owner.id,
        fileName: 'Обложка.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 2048,
      })
      if (file === null) throw new Error('The file was not announced')
      if (ready)
        await markAttachmentReady(db, { id: file.id, sizeBytes: 2048, contentType: 'image/jpeg' })
      return file
    }

    async function browserDialog(
      caller: ReturnType<typeof callerOf>,
      siteId: string,
      extra: { attachments?: string[] } = {},
    ) {
      const taskId = randomUUID()
      taskIds.push(taskId)
      const created = await caller.task.create({
        siteId,
        taskId,
        text: 'Добавьте новость о новом меню',
        ...extra,
      })
      return { taskId, created }
    }

    it('takes a task in the browser on a site without files: no preview, only /cancel', async () => {
      const { owner, site } = await browserSite()
      const caller = callerOf(owner, { browser: true })

      const { taskId } = await browserDialog(caller, site.id)

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 1,
        needsRepository: false,
        needsBrowser: true,
      })
      expect(await activeHolds(taskId)).toHaveLength(1)
      expect(await db.previewEnvironment.count({ where: { taskId } })).toBe(0)
      expect((await outboxOf(taskId)).map((row) => row.type)).toEqual(['turn.run'])
      const feed = await caller.task.feed({ taskId })
      expect(feed.task.requirements).toEqual({ repository: false, browser: true })
      expect(feed.browser).toBeNull()
      expect(feed.preview).toBeNull()
      expect(
        feed.commands.filter((command) => command.available).map((command) => command.id),
      ).toEqual(['cancel'])
      expect((await caller.task.get({ taskId })).requirements).toEqual({
        repository: false,
        browser: true,
      })
      expect(await caller.project.get({ id: site.id })).toMatchObject({
        capabilities: { repository: 'absent', browser: 'ready' },
      })
    })

    it('takes the code and the browser in one where both are ready', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner, { browser: true })
      expect((await caller.project.list())[0]).toMatchObject({
        capabilities: { repository: 'ready', browser: 'ready' },
      })

      // What the server reads from the project (К7, К10), with its preview.
      const { taskId } = await newDialog(caller, site.id)

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        needsRepository: true,
        needsBrowser: true,
      })
      expect(await db.previewEnvironment.count({ where: { taskId } })).toBe(1)
    })

    it('refuses a project without files where the platform has no browser, and a closed site', async () => {
      const { owner, site } = await browserSite()
      const stackless = callerOf(owner, { browser: true, browserStack: false })
      // A stack without a browser counts as a browser that is not configured (К8).
      expect((await stackless.project.get({ id: site.id })).capabilities.browser).toBe(
        'unsupported',
      )
      const refusal = (caller: ReturnType<typeof callerOf>) =>
        caller.task.create({ siteId: site.id, taskId: randomUUID(), text: 'Добавьте новость' })
      const reason = (value: string) => ({
        code: 'CONFLICT',
        cause: { code: 'TASK_NOT_ACCEPTED', details: { reason: value } },
      })

      // Neither way is offered: the state of the matrix names the refusal (К8).
      await expect(refusal(stackless)).rejects.toMatchObject(reason('browser_unavailable'))
      await expect(refusal(callerOf(owner))).rejects.toMatchObject(reason('browser_unavailable'))
      const withBrowser = callerOf(owner, { browser: true })
      await db.site.update({ where: { id: site.id }, data: { status: 'paused' } })
      await expect(refusal(withBrowser)).rejects.toMatchObject(reason('site_not_active'))
      expect(await withBrowser.project.get({ id: site.id })).toMatchObject({
        capabilities: { repository: 'inactive', browser: 'closed' },
      })
      expect(await db.task.count({ where: { siteId: site.id } })).toBe(0)
    })

    it('binds the files of the first message with the task, or writes nothing at all', async () => {
      const { owner, site } = await browserSite()
      const caller = callerOf(owner, { browser: true })
      const ready = await readyFile(owner, site)
      const uploading = await readyFile(owner, site, false)

      const refusedId = randomUUID()
      await expect(
        caller.task.create({
          siteId: site.id,
          taskId: refusedId,
          text: 'Добавьте новость',
          attachments: [ready.id, uploading.id],
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message:
          'Не все файлы готовы к отправке. Дождитесь, пока они загрузятся, или прикрепите их заново',
        cause: { code: 'ATTACHMENT_NOT_READY' },
      })
      expect(await db.task.count({ where: { id: refusedId } })).toBe(0)
      expect(await db.creditHold.count({ where: { taskId: refusedId } })).toBe(0)
      expect((await db.attachment.findUniqueOrThrow({ where: { id: ready.id } })).status).toBe(
        'ready',
      )

      const { taskId } = await browserDialog(caller, site.id, { attachments: [ready.id] })

      expect(await db.attachment.findUniqueOrThrow({ where: { id: ready.id } })).toMatchObject({
        status: 'bound',
        taskId,
      })
      expect((await feedOf(taskId))[0]!.payload).toMatchObject({
        kind: 'first',
        attachments: [ready.id],
      })
      expect(await caller.attachment.list({ taskId })).toEqual([
        {
          id: ready.id,
          name: 'Обложка.jpg',
          type: 'image/jpeg',
          size: 2048,
          kind: 'image',
          sentAt: expect.any(Date),
        },
      ])
      // A sent file stays with its task.
      await expect(caller.attachment.remove({ attachmentId: ready.id })).rejects.toMatchObject({
        cause: { code: 'ATTACHMENT_SENT' },
      })
      // Nobody else sees the files of the task.
      const stranger = await siteOwner()
      await expect(callerOf(stranger.owner).attachment.list({ taskId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('gives the work back to no agent while `/undo` takes a turn of the code back', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      const caller = callerOf(owner, { browser: true })
      const { id: taskId } = await db.task.create({
        data: {
          workspaceId,
          siteId: site.id,
          needsRepository: true,
          needsBrowser: true,
          status: 'awaiting_user',
          turnNo: 1,
        },
      })
      await insertFeedEvent(db, {
        taskId,
        row: {
          type: 'feed.request',
          payload: {
            v: 1,
            kind: 'command',
            command: 'turn_undo',
            authorId: owner.id,
            requestId: randomUUID(),
          },
        },
      })
      await expect(
        caller.task.resumeAgent({ taskId, requestId: randomUUID() }),
      ).rejects.toMatchObject({ cause: { code: 'TASK_REWINDING' } })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
        'awaiting_user',
      )
    })

    it('binds the files of an answer, and goes on by «Продолжить работу агента» once', async () => {
      const { owner, site } = await browserSite()
      const caller = callerOf(owner, { browser: true })
      const { taskId } = await browserDialog(caller, site.id)
      const question = await asked(taskId, {
        kind: 'browser',
        reason: 'login',
        message: 'Войдите в админку сайта',
      })
      const file = await readyFile(owner, site)

      const answer = await caller.task.message({
        taskId,
        requestId: randomUUID(),
        text: 'Вошёл, вот фото',
        attachments: [file.id],
      })

      expect((await feedOf(taskId)).at(-1)!.payload).toMatchObject({
        kind: 'answer',
        answersEventId: String(question),
        attachments: [file.id],
      })
      expect(answer.repeated).toBe(false)
      expect((await db.attachment.findUniqueOrThrow({ where: { id: file.id } })).taskId).toBe(
        taskId,
      )

      // The agent asks again; the client signs in and presses «Продолжить работу агента».
      await asked(taskId, { kind: 'browser', reason: 'captcha', message: 'Пройдите проверку' })
      const [before] = await activeHolds(taskId)
      const requestId = randomUUID()
      const resumed = await caller.task.resumeAgent({ taskId, requestId })

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'queued',
        attempt: 1,
      })
      expect((await feedOf(taskId)).at(-1)!.payload).toEqual({
        v: 1,
        kind: 'resume',
        authorId: owner.id,
        requestId,
      })
      expect((await outboxOf(taskId)).map((row) => row.dedupeKey)).toContain(
        `turn.run:${taskId}:1:${resumed.requestEventId}`,
      )
      const holds = await activeHolds(taskId)
      expect(holds).toHaveLength(1)
      expect(holds[0]!.expiresAt.getTime()).toBeGreaterThanOrEqual(before!.expiresAt.getTime())
      expect(await caller.task.resumeAgent({ taskId, requestId })).toEqual({
        requestEventId: resumed.requestEventId,
        repeated: true,
      })
      // Nothing to go on from while the agent works.
      await expect(
        caller.task.resumeAgent({ taskId, requestId: randomUUID() }),
      ).rejects.toMatchObject({ cause: { code: 'TASK_BUSY' } })
      // A question about credits is answered by «Продолжить».
      await asked(taskId, { kind: 'ceiling', reason: 'step', spent: 30, held: 35, left: 5 })
      await expect(
        caller.task.resumeAgent({ taskId, requestId: randomUUID() }),
      ).rejects.toMatchObject({ cause: { code: 'TASK_CONTINUE_REQUIRED' } })
    })

    it('has nothing to resume in a dialog with the repository', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await asked(taskId, {
        kind: 'agent',
        intro: 'Нужно уточнить.',
        questions: [{ text: 'Какой номер поставить?', options: [] }],
      })
      await expect(
        caller.task.resumeAgent({ taskId, requestId: randomUUID() }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'TASK_NOTHING_TO_RESUME' },
      })
    })

    it('asks core to stop a task in the browser in any status: core closes its browser', async () => {
      const { owner, site } = await browserSite()
      const caller = callerOf(owner, { browser: true })
      const { taskId } = await browserDialog(caller, site.id)
      await asked(taskId, { kind: 'browser', reason: 'login', message: 'Войдите в админку' })

      const stopping = await caller.task.cancel({ taskId, requestId: randomUUID() })

      expect(stopping).toMatchObject({ state: 'stopping', repeated: false })
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
        'awaiting_user',
      )
      expect(await activeHolds(taskId)).toHaveLength(1)
      expect(await outboxOf(`turn.cancel:${taskId}`)).toEqual([
        {
          topic: 'agent-turns',
          type: 'turn.cancel',
          payload: { taskId, requestEventId: stopping.requestEventId },
          dedupeKey: `turn.cancel:${taskId}:${stopping.requestEventId}`,
        },
      ])
    })

    describe('of a chat with the code and the browser (docs/plan/61-chats-first.md, §5.9)', () => {
      /** A chat that waits with a candidate: a row, until `task.create` takes it (61.11). */
      async function waitingChat() {
        const { owner, site, workspaceId } = await siteOwner()
        const task = await db.task.create({
          data: {
            workspaceId,
            siteId: site.id,
            needsRepository: true,
            needsBrowser: true,
            status: 'awaiting_approval',
            turnNo: 1,
            attempt: 1,
          },
        })
        taskIds.push(task.id)
        await withCandidate(task.id)
        return { caller: callerOf(owner, { browser: true }), owner, taskId: task.id, workspaceId }
      }
      const finished = { code: 'CONFLICT', cause: { code: 'TASK_FINISHED' } }

      it('takes no release after `/cancel`, even one whose window was already open', async () => {
        const { caller, taskId } = await waitingChat()
        const prepared = await caller.release.prepare({ taskId })
        const [choice] = prepared.choices

        await caller.task.cancel({ taskId, requestId: randomUUID() })

        // core has not closed it yet: the chat still waits with its candidate.
        expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
          'awaiting_approval',
        )
        await expect(
          caller.release.confirm({
            taskId,
            confirmToken: choice!.confirmToken,
            version: choice!.version,
          }),
        ).rejects.toMatchObject(finished)
        await expect(caller.release.prepare({ taskId })).rejects.toMatchObject({ code: 'CONFLICT' })
        expect(await db.siteRelease.count({ where: { taskId } })).toBe(0)
        const commands = await caller.task.commands({ taskId })
        expect(commands.find((item) => item.id === 'release')).toMatchObject({
          available: false,
          refusal: 'finished',
        })
        expect(commands.find((item) => item.id === 'cancel')?.available).toBe(true)
      })

      it('takes no «Попробовать ещё» after `/cancel`: its row would hide the press from core', async () => {
        const { caller, taskId } = await waitingChat()
        await caller.task.cancel({ taskId, requestId: randomUUID() })
        await expect(
          caller.task.retry({ taskId, requestId: randomUUID(), failureEventId: '1' }),
        ).rejects.toMatchObject(finished)
      })

      it('lets `/release` through before `/cancel`', async () => {
        const { caller, taskId } = await waitingChat()
        const commands = await caller.task.commands({ taskId })
        expect(commands.find((item) => item.id === 'release')?.refusal).toBeNull()
      })

      it('knows when anyone acted in the browser of the chat', async () => {
        const { owner, taskId, workspaceId } = await waitingChat()
        const task = await db.task.findUniqueOrThrow({
          where: { id: taskId },
          select: { id: true, workspaceId: true, siteId: true, status: true },
        })
        expect(task.workspaceId).toBe(workspaceId)
        expect((await dialogFacts(db, task, owner.id)).commands.browserWrote).toBe(false)
        const session = await openBrowserSession(db, { taskId })
        expect((await dialogFacts(db, task, owner.id)).commands.browserWrote).toBe(false)
        await db.browserSession.update({
          where: { id: session.id },
          data: { wroteAt: new Date() },
        })
        expect((await dialogFacts(db, task, owner.id)).commands.browserWrote).toBe(true)
      })
    })

    it('takes nothing after «Остановить» until core closes the task: no row hides the press', async () => {
      const { owner, site, workspaceId } = await browserSite()
      // Two dialogs at once: more than the gift holds.
      await paidTariff(workspaceId)
      const caller = callerOf(owner, { browser: true })
      const finished = { code: 'CONFLICT', cause: { code: 'TASK_FINISHED' } }

      // Asked to act in the browser: neither words nor «Продолжить работу агента» undo the stop.
      const { taskId } = await browserDialog(caller, site.id)
      await asked(taskId, { kind: 'browser', reason: 'login', message: 'Войдите в админку' })
      const before = randomUUID()
      const words = await caller.task.message({ taskId, requestId: before, text: 'Сейчас войду' })
      await asked(taskId, { kind: 'browser', reason: 'login', message: 'Войдите в админку' })
      await caller.task.cancel({ taskId, requestId: randomUUID() })

      await expect(
        caller.task.message({ taskId, requestId: randomUUID(), text: 'Вошёл' }),
      ).rejects.toMatchObject(finished)
      await expect(
        caller.task.resumeAgent({ taskId, requestId: randomUUID() }),
      ).rejects.toMatchObject(finished)
      // Words delivered before the press are still recognised when they come again.
      expect(
        await caller.task.message({ taskId, requestId: before, text: 'Сейчас войду' }),
      ).toEqual({ ...words, repeated: true })

      // A question about credits: «Продолжить» does not undo it either.
      const { taskId: ceiling } = await browserDialog(caller, site.id)
      await asked(ceiling, { kind: 'ceiling', reason: 'step', spent: 30, held: 35, left: 5 })
      await caller.task.cancel({ taskId: ceiling, requestId: randomUUID() })
      await expect(
        caller.task.continue({ taskId: ceiling, requestId: randomUUID() }),
      ).rejects.toMatchObject(finished)

      for (const id of [taskId, ceiling]) {
        expect(await db.task.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: 'awaiting_user',
          attempt: 1,
        })
        // The press is the newest request core reads, and no pass was queued after it.
        expect(
          (await feedOf(id)).filter((row) => row.type === 'feed.request').at(-1)!.payload,
        ).toMatchObject({ kind: 'command', command: 'cancel' })
        expect((await outboxOf(id)).map((row) => row.type).at(-1)).toBe('turn.cancel')
      }
      expect((await activeHolds(ceiling)).map((hold) => hold.attempt)).toEqual([1])
    })

    it('shows the browser of a task and opens its stream by a one-time ticket', async () => {
      const { owner, site } = await browserSite()
      const caller = callerOf(owner, { browser: true })
      const { taskId } = await browserDialog(caller, site.id)
      await expect(caller.browser.streamTicket({ taskId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      const session = await openBrowserSession(db, { taskId })
      await recordBrowserHelp(db, {
        sessionId: session.id,
        reason: 'login',
        message: 'Войдите в админку сайта',
      })

      expect((await caller.task.feed({ taskId })).browser).toEqual({
        sessionId: session.id,
        status: 'starting',
        controller: 'agent',
        help: { reason: 'login', message: 'Войдите в админку сайта' },
        closeReason: null,
      })
      const issued = await caller.browser.streamTicket({ taskId })
      expect(issued).toEqual({
        url: STREAM_URL,
        ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        sessionId: session.id,
      })
      const stored = await db.browserStreamTicket.findFirstOrThrow({
        where: { sessionId: session.id },
      })
      expect(stored).toMatchObject({
        userId: owner.id,
        tokenHash: createHash('sha256').update(issued.ticket).digest('hex'),
        usedAt: null,
      })
      expect(JSON.stringify(stored)).not.toContain(issued.ticket)

      // Someone else, and a dialog with the repository, answer as nothing.
      const stranger = await siteOwner()
      await expect(
        callerOf(stranger.owner, { browser: true }).browser.streamTicket({ taskId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const repository = await newDialog(callerOf(stranger.owner), stranger.site.id)
      await expect(
        callerOf(stranger.owner, { browser: true }).browser.streamTicket({
          taskId: repository.taskId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      await closeBrowserSession(db, { sessionId: session.id, status: 'closed', reason: 'idle' })
      expect((await caller.task.feed({ taskId })).browser).toMatchObject({
        status: 'closed',
        closeReason: 'idle',
      })
      await expect(caller.browser.streamTicket({ taskId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    // The chat counts as watching the browser (docs/plan/59, И18; owner's answer of 30.10.2026).
    it('keeps the browser of a task from its idle end while the client looks at its dialog', async () => {
      const { owner, site, workspaceId } = await browserSite()
      const caller = callerOf(owner, { browser: true })
      const { taskId } = await browserDialog(caller, site.id)
      // No session yet: nothing to keep.
      expect(await caller.browser.watch({ taskId })).toEqual({ watched: false })
      const session = await openBrowserSession(db, { taskId })
      const long = new Date(Date.now() - 25 * 60_000)
      await db.browserSession.update({ where: { id: session.id }, data: { lastActivityAt: long } })

      expect(await caller.browser.watch({ taskId })).toEqual({ watched: true })
      const seen = await db.browserSession.findUniqueOrThrow({ where: { id: session.id } })
      expect(seen.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
      // Only the idle time: the deadline, the control and the status stay.
      expect(seen).toMatchObject({
        expiresAt: session.expiresAt,
        controller: session.controller,
        status: session.status,
      })

      // Someone else, and a dialog with the repository, answer as nothing.
      const stranger = await siteOwner()
      await expect(
        callerOf(stranger.owner, { browser: true }).browser.watch({ taskId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const repository = await newDialog(callerOf(stranger.owner), stranger.site.id)
      await expect(
        callerOf(stranger.owner, { browser: true }).browser.watch({ taskId: repository.taskId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      // A member of the workspace looks at the dialog as well as its owner.
      const member = await person()
      await db.member.create({ data: { workspaceId, userId: member.id, role: 'member' } })
      expect(await callerOf(member, { browser: true }).browser.watch({ taskId })).toEqual({
        watched: true,
      })

      // A closed session holds no browser to keep, and its row is not touched.
      await closeBrowserSession(db, { sessionId: session.id, status: 'closed', reason: 'idle' })
      const closed = await db.browserSession.findUniqueOrThrow({ where: { id: session.id } })
      expect(await caller.browser.watch({ taskId })).toEqual({ watched: false })
      expect(
        (await db.browserSession.findUniqueOrThrow({ where: { id: session.id } })).lastActivityAt,
      ).toEqual(closed.lastActivityAt)

      // A deleted dialog answers as nothing.
      await openBrowserSession(db, { taskId })
      await db.task.update({ where: { id: taskId }, data: { deletedAt: new Date() } })
      await expect(caller.browser.watch({ taskId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('holds the browser of a chat without a project: it has no project to close', async () => {
      const { owner, workspaceId } = await siteOwner()
      const caller = callerOf(owner, { browser: true })
      const task = await db.task.create({
        data: { workspaceId, siteId: null, needsRepository: false, needsBrowser: true },
      })
      taskIds.push(task.id)
      const session = await openBrowserSession(db, { taskId: task.id })
      const idle = new Date(Date.now() - 10 * 60_000)
      await db.browserSession.update({
        where: { id: session.id },
        data: { lastActivityAt: idle },
      })

      expect(await caller.browser.watch({ taskId: task.id })).toEqual({ watched: true })
      const seen = await db.browserSession.findUniqueOrThrow({ where: { id: session.id } })
      expect(seen.lastActivityAt.getTime()).toBeGreaterThan(idle.getTime())
    })

    // docs/plan/61-chats-first.md, К39: the ticket is refused in the statement that writes it.
    it.each(['paused', 'disconnected', 'archived'] as const)(
      'opens no stream and holds no browser of a project %s',
      async (status) => {
        const { owner, site } = await browserSite()
        const caller = callerOf(owner, { browser: true })
        const { taskId } = await browserDialog(caller, site.id)
        const session = await openBrowserSession(db, { taskId })
        await db.site.update({ where: { id: site.id }, data: { status } })
        const seen = await db.browserSession.findUniqueOrThrow({ where: { id: session.id } })

        await expect(caller.browser.streamTicket({ taskId })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        })
        expect(await db.browserStreamTicket.count({ where: { sessionId: session.id } })).toBe(0)
        expect(await caller.browser.watch({ taskId })).toEqual({ watched: false })
        expect(
          (await db.browserSession.findUniqueOrThrow({ where: { id: session.id } })).lastActivityAt,
        ).toEqual(seen.lastActivityAt)
      },
    )

    it('announces a file of a site, removes it before it is sent and gives one to the chooser', async () => {
      const { owner, site, workspaceId } = await browserSite()
      const deleted: Array<[string, string]> = []
      const inbox = {
        delete: async (bucket: string, key: string) => {
          deleted.push([bucket, key])
        },
      } as unknown as ObjectStorage
      const caller = callerOf(owner, { browser: true, storage: inbox })

      const started = await caller.attachment.start({
        siteId: site.id,
        name: 'C:\\Users\\anna\\Меню на осень.pdf',
        size: 4096,
        type: 'application/pdf',
      })

      expect(started.uploadPath).toBe(`/api/attachments/${started.attachmentId}`)
      expect(
        await db.attachment.findUniqueOrThrow({ where: { id: started.attachmentId } }),
      ).toMatchObject({
        status: 'uploading',
        fileName: 'Меню на осень.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4096,
        s3Key: `inbox/${workspaceId}/${started.attachmentId}`,
        uploadedById: owner.id,
        siteId: site.id,
      })
      await expect(
        callerOf((await siteOwner()).owner).attachment.start({
          siteId: site.id,
          name: 'photo.jpg',
          size: 10,
          type: 'image/jpeg',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      await caller.attachment.remove({ attachmentId: started.attachmentId })
      expect(
        (await db.attachment.findUniqueOrThrow({ where: { id: started.attachmentId } })).status,
      ).toBe('deleted')
      expect(deleted).toEqual([['inbox', `inbox/${workspaceId}/${started.attachmentId}`]])
      // A delete of the object that failed is repeated by the same call.
      await caller.attachment.remove({ attachmentId: started.attachmentId })
      expect(deleted).toHaveLength(2)

      // «Загрузить новый» in the file chooser of the browser: the file is given to the task.
      const { taskId } = await browserDialog(caller, site.id)
      const file = await readyFile(owner, site)
      await expect(caller.attachment.bind({ taskId, attachmentIds: [file.id] })).resolves.toEqual({
        bound: 1,
      })
      expect((await caller.attachment.list({ taskId })).map((item) => item.id)).toEqual([file.id])
      await expect(
        caller.attachment.bind({ taskId, attachmentIds: [file.id] }),
      ).rejects.toMatchObject({ cause: { code: 'ATTACHMENT_NOT_READY' } })
    })

    // The site of the binding comes from the task (docs/plan/61-chats-first.md, §5.9): a guard
    // there would answer CONFLICT to every file of a chat without a project.
    it('«Загрузить новый» gives a file to a chat in the browser without a project', async () => {
      const { owner, workspaceId } = await siteOwner()
      const caller = callerOf(owner)
      const task = await db.task.create({
        data: { workspaceId, siteId: null, needsRepository: false, needsBrowser: true },
      })
      taskIds.push(task.id)
      const file = await createAttachment(db, {
        workspaceId,
        siteId: null,
        uploadedById: owner.id,
        fileName: 'Обложка.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 2048,
      })
      if (file === null) throw new Error('The file was not announced')
      await markAttachmentReady(db, { id: file.id, sizeBytes: 2048, contentType: 'image/jpeg' })

      await expect(
        caller.attachment.bind({ taskId: task.id, attachmentIds: [file.id] }),
      ).resolves.toEqual({ bound: 1 })
      expect((await caller.attachment.list({ taskId: task.id })).map((item) => item.id)).toEqual([
        file.id,
      ])
    })
  })

  describe('chats without a project (docs/plan/61-chats-first.md, §5.9)', () => {
    /** An id of version 7, the only one a chat without a project takes (К14). */
    const chatId = () => {
      const id = randomUUID().replace(/^(.{14})./u, '$17')
      taskIds.push(id)
      return id
    }
    const newChat = (caller: ReturnType<typeof callerOf>, attachments?: string[]) =>
      caller.task
        .create({
          siteId: null,
          taskId: chatId(),
          text: 'Что такое каноническая ссылка?',
          ...(attachments === undefined ? {} : { attachments }),
        })
        .then((created) => created.taskId)
    const giftEntries = (userId: string) =>
      db.creditLedger.count({ where: { idempotencyKey: `user:${userId}:signup-gift` } })
    const workspacesOf = (userId: string) => db.workspace.count({ where: { createdById: userId } })
    const startFile = (caller: ReturnType<typeof callerOf>, name = 'Обложка.jpg') =>
      caller.attachment.start({ siteId: null, name, size: 2048, type: 'image/jpeg' })

    it('has no `/init`: there is no code to study (docs/plan/61, К31)', async () => {
      const caller = callerOf(await person())
      const taskId = await newChat(caller)
      const rows = (await feedOf(taskId)).length
      await expect(caller.task.init({ taskId, requestId: randomUUID() })).rejects.toMatchObject({
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'no_repository' } },
      })
      expect(await feedOf(taskId)).toHaveLength(rows)
    })

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
        const { siteId } = await db.task.findUniqueOrThrow({ where: { id: taskId } })
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
            siteId: siteId ?? taskId,
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

      it('leaves the browser with the client while the agent waits for them in it', async () => {
        const { owner, workspaceId, site } = await siteOwner()
        const caller = callerOf(owner)
        const { id: taskId } = await db.task.create({
          data: {
            workspaceId,
            siteId: site.id,
            needsRepository: false,
            needsBrowser: true,
            status: 'awaiting_user',
          },
        })
        taskIds.push(taskId)
        await unanswered(taskId, { kind: 'first', text: 'Добавьте новость' })
        await turnEnded(taskId, 1)
        const session = await openBrowserSession(db, { taskId })
        await recordBrowserHelp(db, {
          sessionId: session.id,
          reason: 'login',
          message: 'Войдите в админку сайта',
        })
        expect(await verdictOf(caller, taskId)).toBe('awaiting_answer')
        await clearBrowserHelp(db, { sessionId: session.id })
        expect(await verdictOf(caller, taskId)).toBeNull()
      })

      it('leaves the browser with a client who took it over: no request of the agent stands', async () => {
        const { owner, workspaceId, site } = await siteOwner()
        const caller = callerOf(owner)
        const { id: taskId } = await db.task.create({
          data: {
            workspaceId,
            siteId: site.id,
            needsRepository: false,
            needsBrowser: true,
            status: 'awaiting_user',
          },
        })
        taskIds.push(taskId)
        await unanswered(taskId, { kind: 'first', text: 'Добавьте новость' })
        await turnEnded(taskId, 1)
        const session = await openBrowserSession(db, { taskId })
        expect(await verdictOf(caller, taskId)).toBeNull()

        await recordBrowserControl(db, {
          sessionId: session.id,
          controller: 'user',
          controlEpoch: 1,
        })
        expect(await verdictOf(caller, taskId)).toBe('browser_with_client')
        await expect(
          caller.task.compact({ taskId, requestId: randomUUID() }),
        ).rejects.toMatchObject({
          cause: { code: 'CHAT_COMMAND_UNAVAILABLE', details: { refusal: 'browser_with_client' } },
        })

        await recordBrowserControl(db, {
          sessionId: session.id,
          controller: 'agent',
          controlEpoch: 2,
        })
        expect(await verdictOf(caller, taskId)).toBeNull()
      })

      describe('in a chat with the repository', () => {
        /** A chat of a site whose last turn stands on `head`, with a candidate on `candidate`. */
        async function siteChat(head: string, candidate: string) {
          const { owner, site } = await siteOwner()
          const caller = callerOf(owner)
          const { taskId } = await newDialog(caller, site.id)
          await turnEnded(taskId, 1)
          await db.taskTurn.updateMany({ where: { taskId }, data: { headSha: head } })
          await db.taskCandidate.create({
            data: {
              taskId,
              revision: 1,
              turnNo: 1,
              baseSha: 'a'.repeat(40),
              baseTree: 'd'.repeat(40),
              headSha: candidate,
              dbPlanSha256: '0'.repeat(64),
              proposedBump: 'minor',
              proposedVersion: 'v0.1.0',
              facts: {},
            },
          })
          await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_approval' } })
          return { caller, taskId }
        }

        it('takes it while the candidate stands on the last turn', async () => {
          const { caller, taskId } = await siteChat('b'.repeat(40), 'b'.repeat(40))
          expect(await verdictOf(caller, taskId)).toBeNull()
        })

        it('has nothing to compact once «Обновить» moved the candidate: a new session is next', async () => {
          const { caller, taskId } = await siteChat('b'.repeat(40), 'c'.repeat(40))
          expect(await verdictOf(caller, taskId)).toBe('nothing_to_compact')
        })

        it('has nothing to compact from the press of «Обновить»: the session may be going', async () => {
          const { caller, taskId } = await siteChat('b'.repeat(40), 'b'.repeat(40))
          await unanswered(taskId, { kind: 'command', command: 'update' })
          await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_approval' } })
          expect(await verdictOf(caller, taskId)).toBe('nothing_to_compact')
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

      it('waits for the client in the browser: the request of the agent stands until a turn takes it', async () => {
        const { owner, workspaceId, site } = await siteOwner()
        const caller = callerOf(owner)
        const task = await db.task.create({
          data: {
            workspaceId,
            siteId: site.id,
            needsRepository: false,
            needsBrowser: true,
            status: 'awaiting_user',
          },
        })
        taskIds.push(task.id)
        await answered(task.id)
        const session = await openBrowserSession(db, { taskId: task.id })
        await recordBrowserHelp(db, {
          sessionId: session.id,
          reason: 'login',
          message: 'Войдите, пожалуйста.',
        })
        await db.$transaction((tx) =>
          insertFeedEvent(tx, {
            taskId: task.id,
            row: {
              type: 'feed.question',
              payload: {
                v: 1,
                kind: 'browser',
                turn: 1,
                reason: 'login',
                message: 'Войдите, пожалуйста.',
              },
            },
          }),
        )

        expect(await verdictOf(caller, task.id)).toBe('awaiting_answer')
        await expect(
          caller.task.undoTurn({ taskId: task.id, requestId: randomUUID() }),
        ).rejects.toMatchObject({ code: 'CONFLICT' })
        const turn = await db.taskTurn.findUniqueOrThrow({
          where: { taskId_turnNo: { taskId: task.id, turnNo: 1 } },
        })
        expect(turn.undoneAt).toBeNull()
        const { browser } = await caller.task.feed({ taskId: task.id })
        expect(browser?.help?.reason).toBe('login')

        // «Продолжить работу агента» still has its question: `task.resumeAgent` goes by it.
        expect(await lastQuestion(db, task.id)).toMatchObject({ kind: 'browser', answered: false })
      })

      it('takes no account of a request left in a browser that is gone: nobody waits there', async () => {
        const { owner, workspaceId, site } = await siteOwner()
        const caller = callerOf(owner)
        const task = await db.task.create({
          data: {
            workspaceId,
            siteId: site.id,
            needsRepository: false,
            needsBrowser: true,
            status: 'awaiting_user',
          },
        })
        taskIds.push(task.id)
        await answered(task.id)
        const session = await openBrowserSession(db, { taskId: task.id })
        await recordBrowserHelp(db, {
          sessionId: session.id,
          reason: 'login',
          message: 'Войдите, пожалуйста.',
        })
        await closeBrowserSession(db, { sessionId: session.id, status: 'closed', reason: 'idle' })
        expect(await verdictOf(caller, task.id)).toBeNull()
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
        const { owner, workspaceId } = await siteOwner()
        const caller = callerOf(owner)
        const browserChat = async () => {
          const task = await db.task.create({
            data: {
              id: chatId(),
              workspaceId,
              siteId: null,
              needsRepository: false,
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

      it('tells a chat on a site to check it, and the browser and its sign-in stay', async () => {
        const { owner, workspaceId, site } = await siteOwner()
        const caller = callerOf(owner)
        const task = await db.task.create({
          data: {
            workspaceId,
            siteId: site.id,
            needsRepository: false,
            needsBrowser: true,
            status: 'awaiting_user',
          },
        })
        taskIds.push(task.id)
        await answered(task.id)
        const session = await openBrowserSession(db, { taskId: task.id })
        await db.browserSession.update({
          where: { id: session.id },
          data: { wroteAt: new Date() },
        })
        const before = await db.browserSession.findUniqueOrThrow({ where: { id: session.id } })

        await caller.task.undoTurn({ taskId: task.id, requestId: randomUUID() })

        expect((await feedOf(task.id)).at(-1)?.payload).toMatchObject({ site: 'check' })
        expect(await db.browserSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(
          before,
        )
        expect(await outboxOf(task.id)).toEqual([])
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

      describe('in a chat with the repository (61.22)', () => {
        /** A chat of a site whose last turn left `head` (`candidate` — and that candidate). */
        async function codeChat(options: { candidate?: { turnNo: number; head: string } } = {}) {
          const { owner, site } = await siteOwner()
          const caller = callerOf(owner)
          const { taskId } = await newDialog(caller, site.id)
          await answered(taskId)
          await db.taskTurn.updateMany({ where: { taskId }, data: { headSha: 'b'.repeat(40) } })
          if (options.candidate) {
            await db.taskCandidate.create({
              data: {
                taskId,
                revision: 1,
                turnNo: options.candidate.turnNo,
                baseSha: 'a'.repeat(40),
                baseTree: 'd'.repeat(40),
                headSha: options.candidate.head,
                dbPlanSha256: '0'.repeat(64),
                proposedBump: 'minor',
                proposedVersion: 'v0.1.0',
                facts: {},
              },
            })
            await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_approval' } })
          }
          return { caller, taskId }
        }
        const rewinds = (taskId: string) =>
          db.outboxEvent.findMany({
            where: { type: 'candidate.rewind', dedupeKey: { contains: taskId } },
          })
        /** core's answer to the press, as `candidate.rewind` writes it. */
        const coreAnswers = (taskId: string, requestEventId: string) =>
          db.taskEvent.create({
            data: {
              taskId,
              type: 'candidate.rewind',
              payload: { v: 1, requestEventId, outcome: 'refused' },
            },
          })

        it('leaves the turn to core: the press and its job, the words at once', async () => {
          const { caller, taskId } = await codeChat()
          expect(await verdictOf(caller, taskId)).toBeNull()
          const requestId = randomUUID()
          const undone = await caller.task.undoTurn({ taskId, requestId })
          expect(undone).toMatchObject({
            repeated: false,
            words: 'Поменяйте телефон в шапке сайта',
          })

          const jobs = await rewinds(taskId)
          expect(jobs).toHaveLength(1)
          expect(jobs[0]?.payload).toEqual({ taskId, requestEventId: undone.requestEventId })
          // core writes the undo with the branch: nothing of it yet.
          expect(await db.taskTurn.count({ where: { taskId, undoneAt: { not: null } } })).toBe(0)
          expect(await db.taskEvent.count({ where: { taskId, type: 'feed.rewind' } })).toBe(0)

          // A page that never got the answer gets the words again.
          expect(await caller.task.undoTurn({ taskId, requestId })).toEqual({
            ...undone,
            repeated: true,
          })
          expect(await rewinds(taskId)).toHaveLength(1)
        })

        it('starts nothing while core takes the turn back, and goes on once it answered', async () => {
          const { caller, taskId } = await codeChat()
          const { requestEventId } = await caller.task.undoTurn({ taskId, requestId: randomUUID() })
          expect(await verdictOf(caller, taskId)).toBe('turn_rewinding')
          await expect(
            caller.task.message({ taskId, requestId: randomUUID(), text: 'Ещё слова' }),
          ).rejects.toMatchObject({ cause: { code: 'TASK_REWINDING' } })
          await expect(
            caller.task.undoTurn({ taskId, requestId: randomUUID() }),
          ).rejects.toMatchObject({ cause: { details: { refusal: 'turn_rewinding' } } })

          await coreAnswers(taskId, requestEventId)
          expect(await verdictOf(caller, taskId)).toBeNull()
          await expect(
            caller.task.message({ taskId, requestId: randomUUID(), text: 'Ещё слова' }),
          ).resolves.toMatchObject({ repeated: false })
        })

        it('takes a chat that waits with its candidate', async () => {
          const { caller, taskId } = await codeChat({
            candidate: { turnNo: 1, head: 'b'.repeat(40) },
          })
          expect(await verdictOf(caller, taskId)).toBeNull()
        })

        it('takes a turn that asked while the candidate of the turn before stands', async () => {
          const { caller, taskId } = await codeChat({
            candidate: { turnNo: 1, head: 'e'.repeat(40) },
          })
          await answered(taskId, 2)
          await db.taskTurn.updateMany({
            where: { taskId, turnNo: 2 },
            data: { headSha: 'c'.repeat(40) },
          })
          // The candidate has its own head, and no «Обновить» moved this turn's.
          expect(await verdictOf(caller, taskId)).toBeNull()
        })

        it('refuses past «Обновить»: the candidate no longer stands on the head of the turn', async () => {
          const { caller, taskId } = await codeChat({
            candidate: { turnNo: 1, head: 'e'.repeat(40) },
          })
          expect(await verdictOf(caller, taskId)).toBe('undo_past_update')
          await expect(
            caller.task.undoTurn({ taskId, requestId: randomUUID() }),
          ).rejects.toMatchObject({ cause: { details: { refusal: 'undo_past_update' } } })
        })
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

        describe('in a chat with the repository', () => {
          const revisionRow = {
            type: 'feed.candidate',
            payload: {
              v: 1,
              turn: 1,
              revision: 2,
              version: 'v0.1.0',
              bump: 'minor',
              files: { added: 1, modified: 0, deleted: 0 },
              media: 0,
              records: 0,
            },
          } as const
          /** A chat whose last turn core took back, as `candidate.rewind` leaves it. */
          async function undoneCodeChat(
            options: {
              revision?: boolean
              status?: 'awaiting_user' | 'awaiting_approval'
            } = {},
          ) {
            const { owner, site } = await siteOwner()
            const caller = callerOf(owner)
            const { taskId } = await newDialog(caller, site.id)
            await answered(taskId)
            await db.taskTurn.updateMany({
              where: { taskId },
              data: { headSha: 'b'.repeat(40) },
            })
            const { requestEventId } = await caller.task.undoTurn({
              taskId,
              requestId: randomUUID(),
            })
            await db.taskTurn.updateMany({ where: { taskId }, data: { undoneAt: new Date() } })
            await db.$transaction(async (tx) => {
              await tx.task.update({
                where: { id: taskId },
                data: { status: options.status ?? 'awaiting_user' },
              })
              if (options.revision) await insertFeedEvent(tx, { taskId, row: revisionRow })
              await insertFeedEvent(tx, {
                taskId,
                row: {
                  type: 'feed.rewind',
                  payload: { v: 1, turn: 1, files: true, site: 'unchanged' },
                },
              })
              await tx.taskEvent.create({
                data: {
                  taskId,
                  type: 'candidate.rewind',
                  payload: {
                    v: 1,
                    requestEventId,
                    outcome: 'rewound',
                    before: 'awaiting_user',
                  },
                },
              })
            })
            return { caller, taskId }
          }
          const jobs = (taskId: string) =>
            db.outboxEvent.findMany({
              where: { type: 'candidate.rewind', dedupeKey: { contains: taskId } },
              orderBy: { id: 'asc' },
            })

          it('leaves the turn to core: the press and its job, the words at once', async () => {
            const { caller, taskId } = await undoneCodeChat()
            expect(await redoVerdict(caller, taskId)).toBeNull()
            const requestId = randomUUID()
            const redone = await caller.task.redoTurn({ taskId, requestId })
            expect(redone).toMatchObject({
              repeated: false,
              words: 'Поменяйте телефон в шапке сайта',
            })
            expect((await jobs(taskId)).at(-1)?.payload).toEqual({
              taskId,
              requestEventId: redone.requestEventId,
            })
            // core writes it with the branch: nothing of it yet.
            expect(await db.taskTurn.count({ where: { taskId, undoneAt: null } })).toBe(0)
            expect(await db.taskEvent.count({ where: { taskId, type: 'feed.redo' } })).toBe(0)
            expect(await caller.task.redoTurn({ taskId, requestId })).toEqual({
              ...redone,
              repeated: true,
            })
            expect(await jobs(taskId)).toHaveLength(2)
          })

          it('starts nothing while core brings the turn back, and says so in its own words', async () => {
            const { caller, taskId } = await undoneCodeChat()
            const { requestEventId } = await caller.task.redoTurn({
              taskId,
              requestId: randomUUID(),
            })
            expect(await redoVerdict(caller, taskId)).toBe('turn_redoing')
            expect(await verdictOf(caller, taskId)).toBe('turn_redoing')
            await expect(
              caller.task.message({ taskId, requestId: randomUUID(), text: 'Ещё слова' }),
            ).rejects.toMatchObject({ cause: { code: 'TASK_REDOING' } })

            await db.taskEvent.create({
              data: {
                taskId,
                type: 'candidate.rewind',
                payload: { v: 1, requestEventId, outcome: 'refused' },
              },
            })
            await expect(
              caller.task.message({ taskId, requestId: randomUUID(), text: 'Ещё слова' }),
            ).resolves.toMatchObject({ repeated: false })
          })

          it('brings back nothing past «Обновить»: the press, then the revision it wrote', async () => {
            const pressed = await undoneCodeChat()
            await db.$transaction((tx) =>
              insertFeedEvent(tx, {
                taskId: pressed.taskId,
                row: {
                  type: 'feed.request',
                  payload: {
                    v: 1,
                    kind: 'command',
                    command: 'update',
                    authorId: randomUUID(),
                    requestId: randomUUID(),
                  },
                },
              }),
            )
            expect(await redoVerdict(pressed.caller, pressed.taskId)).toBe('nothing_to_redo')
            // No job: the branch stays on the head «Обновить» wrote.
            const before = await jobs(pressed.taskId)
            await expect(
              pressed.caller.task.redoTurn({ taskId: pressed.taskId, requestId: randomUUID() }),
            ).rejects.toMatchObject({ cause: { details: { refusal: 'nothing_to_redo' } } })
            expect(await jobs(pressed.taskId)).toEqual(before)

            const moved = await undoneCodeChat()
            await db.$transaction((tx) =>
              insertFeedEvent(tx, { taskId: moved.taskId, row: revisionRow }),
            )
            expect(await redoVerdict(moved.caller, moved.taskId)).toBe('nothing_to_redo')
          })

          it('counts no revision of the undo itself: it stands before its row', async () => {
            const { caller, taskId } = await undoneCodeChat({ revision: true })
            expect(await redoVerdict(caller, taskId)).toBeNull()
          })

          it('brings the turn back to a chat that waits with the candidate before it', async () => {
            const { caller, taskId } = await undoneCodeChat({ status: 'awaiting_approval' })
            expect(await redoVerdict(caller, taskId)).toBeNull()
          })

          it('brings back nothing past a release confirmed since, even one that failed', async () => {
            const { caller, taskId } = await undoneCodeChat()
            await withCandidate(taskId)
            const choice = (await caller.release.prepare({ taskId })).choices[0]!
            await caller.release.confirm({
              taskId,
              confirmToken: choice.confirmToken,
              version: choice.version,
            })
            // Its release ended before it wrote anything, and the chat waits as it did.
            await db.siteRelease.updateMany({ where: { taskId }, data: { status: 'failed' } })
            await db.task.update({ where: { id: taskId }, data: { status: 'awaiting_approval' } })
            expect(await db.taskEvent.count({ where: { taskId, type: 'feed.decision' } })).toBe(1)
            expect(await db.taskEvent.count({ where: { taskId, type: 'feed.release' } })).toBe(0)

            const before = await jobs(taskId)
            expect(await redoVerdict(caller, taskId)).toBe('nothing_to_redo')
            await expect(
              caller.task.redoTurn({ taskId, requestId: randomUUID() }),
            ).rejects.toMatchObject({ cause: { details: { refusal: 'nothing_to_redo' } } })
            expect(await jobs(taskId)).toEqual(before)
          })

          it('brings back nothing past the row of a release that failed', async () => {
            const { caller, taskId } = await undoneCodeChat({ status: 'awaiting_approval' })
            await insertFeedEvent(db, {
              taskId,
              row: {
                type: 'feed.release',
                payload: {
                  v: 1,
                  releaseId: randomUUID(),
                  version: 'v0.1.0',
                  outcome: 'failed',
                  reason: null,
                  credits: null,
                },
              },
            })
            expect(await redoVerdict(caller, taskId)).toBe('nothing_to_redo')
          })

          it('takes the next words after a `/redo` that left nothing to release', async () => {
            const { caller, taskId } = await undoneCodeChat()
            // The pass ended with a candidate: its result expects a release, not words.
            const result = await db.taskEvent.findFirstOrThrow({
              where: { taskId, type: 'feed.result' },
            })
            await db.taskEvent.update({
              where: { id: result.id },
              data: {
                payload: {
                  ...(result.payload as Prisma.JsonObject),
                  next: 'awaiting_approval',
                },
              },
            })
            const { requestEventId } = await caller.task.redoTurn({
              taskId,
              requestId: randomUUID(),
            })
            // What core writes when the candidate does not come back.
            const redone = await db.$transaction(async (tx) => {
              await tx.taskTurn.updateMany({ where: { taskId }, data: { undoneAt: null } })
              await tx.taskEvent.create({
                data: {
                  taskId,
                  type: 'candidate.rewind',
                  payload: { v: 1, requestEventId, outcome: 'redone' },
                },
              })
              return insertFeedEvent(tx, {
                taskId,
                row: {
                  type: 'feed.redo',
                  payload: { v: 1, turn: 1, files: true, open: true },
                },
              })
            })
            expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
              status: 'awaiting_user',
            })
            expect(await listed(caller, taskId)).toMatchObject({ answered: true, rewound: false })

            await caller.task.message({ taskId, requestId: randomUUID(), text: 'Ещё слова' })

            expect((await feedOf(taskId)).at(-1)).toMatchObject({
              type: 'feed.request',
              payload: { kind: 'answer', answersEventId: String(redone) },
            })
          })
        })
      })

      it('refuses a turn that wrote to the site itself', async () => {
        const { owner, workspaceId, site } = await siteOwner()
        const caller = callerOf(owner)
        const task = await db.task.create({
          data: {
            workspaceId,
            siteId: site.id,
            needsRepository: false,
            needsBrowser: true,
            status: 'awaiting_user',
            turnNo: 1,
          },
        })
        taskIds.push(task.id)
        await productionWrite(task.id, site.id)
        await db.taskTurn.updateMany({
          where: { taskId: task.id },
          data: { status: 'completed' },
        })
        expect(await verdictOf(caller, task.id)).toBe('content_written')
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

    it('takes the first chat of a new user: the workspace, the gift, the reserve, no preview', async () => {
      const user = await person()
      expect(await workspacesOf(user.id)).toBe(0)
      const caller = callerOf(user)

      const taskId = await newChat(caller)

      const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(task).toMatchObject({
        siteId: null,
        status: 'queued',
        needsRepository: false,
        needsBrowser: false,
        createdById: user.id,
      })
      expect(
        await db.workspace.findUniqueOrThrow({ where: { id: task.workspaceId } }),
      ).toMatchObject({ createdById: user.id, dataClass: 'synthetic' })
      expect(await giftEntries(user.id)).toBe(1)
      expect(await activeHolds(taskId)).toHaveLength(1)
      expect(await db.previewEnvironment.count({ where: { taskId } })).toBe(0)
      expect((await outboxOf(taskId)).map((row) => row.type)).toEqual(['turn.run'])
      expect(vault.workspaceKeys).toContain(`ws-${task.workspaceId}`)

      expect(await caller.task.get({ taskId })).toMatchObject({
        siteId: null,
        project: null,
        requirements: { repository: false, browser: false },
      })
      const feed = await caller.task.feed({ taskId })
      expect(feed.preview).toBeNull()
      expect(feed.events.map((event) => event.type)).toEqual(['feed.request'])
    })

    it('gives it the browser where the platform has one', async () => {
      const taskId = await newChat(callerOf(await person(), { browser: true }))
      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        needsRepository: false,
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
        siteId: null,
        status: 'bound',
      })
    })

    it('makes nothing for a file the rules refuse', async () => {
      const user = await person()
      await expect(
        callerOf(user).attachment.start({
          siteId: null,
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
      await expect(
        callerOf(user).task.create({ siteId: null, taskId, text: 'Вопрос' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', cause: { code: 'TASK_ID_INVALID' } })
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
      const input = { siteId: null, taskId, text: 'Вопрос' }
      const first = await caller.task.create(input)
      expect(first.created).toBe(true)
      expect(await caller.task.create(input)).toEqual({ ...first, created: false })
      expect(await db.creditHold.count({ where: { taskId } })).toBe(1)

      const { owner } = await siteOwner()
      await expect(callerOf(owner).task.create(input)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('takes the same id with another place for another request, of its own author too', async () => {
      // A client that changed the pill got a new id: the old one is not this chat any more.
      const { owner, site, workspaceId } = await siteOwner()
      await paidTariff(workspaceId)
      const caller = callerOf(owner)
      const withoutProject = chatId()
      await caller.task.create({ siteId: null, taskId: withoutProject, text: 'Вопрос' })
      await expect(
        caller.task.create({ siteId: site.id, taskId: withoutProject, text: 'Вопрос' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      const ofProject = chatId()
      await caller.task.create({ siteId: site.id, taskId: ofProject, text: 'Вопрос' })
      await expect(
        caller.task.create({ siteId: null, taskId: ofProject, text: 'Вопрос' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('answers a chat of someone else as one that does not exist', async () => {
      const caller = callerOf(await person())
      const taskId = await newChat(caller)
      const fileId = await storedFile(caller)
      const stranger = callerOf(await person())
      const calls = [
        stranger.task.get({ taskId }),
        stranger.task.feed({ taskId }),
        stranger.task.commands({ taskId }),
        stranger.task.message({ taskId, requestId: randomUUID(), text: 'Да' }),
        stranger.attachment.list({ taskId }),
        stranger.attachment.bind({ taskId, attachmentIds: [fileId] }),
      ]
      for (const refusal of await Promise.all(
        calls.map((call) => call.catch((error: unknown) => error)),
      ))
        expect(refusal).toMatchObject({ code: 'NOT_FOUND' })
      expect((await stranger.task.list({})).items).toEqual([])
      expect((await stranger.task.folders({})).folders).toEqual([])
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
        siteId: null,
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

      // No site: nothing to claim the gift of.
      const { workspaceId } = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      expect(await db.giftSiteClaim.count({ where: { workspaceId } })).toBe(0)
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

    it('takes no file of a project in a chat without one', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const started = await caller.attachment.start({
        siteId: site.id,
        name: 'Обложка.jpg',
        size: 2048,
        type: 'image/jpeg',
      })
      await markAttachmentReady(db, {
        id: started.attachmentId,
        sizeBytes: 2048,
        contentType: 'image/jpeg',
      })
      await expect(newChat(caller, [started.attachmentId])).rejects.toMatchObject({
        cause: { code: 'ATTACHMENT_NOT_READY' },
      })
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
              needsRepository: false,
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

    it('lists every chat of the user, one project or those without one', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      const caller = callerOf(owner)
      const [ofProject] = await chats(workspaceId, site.id, [{}])
      const [ofNone] = await chats(workspaceId, null, [{}])

      const all = (await caller.task.list({})).items
      expect(all.map((item) => item.id).sort()).toEqual([ofProject!.id, ofNone!.id].sort())
      expect(all.find((item) => item.id === ofProject!.id)?.project).toEqual({
        id: site.id,
        name: site.name,
      })
      expect(all.find((item) => item.id === ofNone!.id)?.project).toBeNull()

      expect((await caller.task.list({ folder: site.id })).items.map((item) => item.id)).toEqual([
        ofProject!.id,
      ])
      expect((await caller.task.list({ folder: 'none' })).items.map((item) => item.id)).toEqual([
        ofNone!.id,
      ])
      await expect(callerOf(await person()).task.list({ folder: site.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('hides the chats of a deleted project, its folder and a deleted chat', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      const caller = callerOf(owner)
      await chats(workspaceId, site.id, [{}])
      const [gone] = await chats(workspaceId, null, [{}])
      const [kept] = await chats(workspaceId, null, [{}])
      await db.task.update({ where: { id: gone!.id }, data: { deletedAt: new Date() } })
      await db.site.update({ where: { id: site.id }, data: { deletedAt: new Date() } })

      expect((await caller.task.list({})).items.map((item) => item.id)).toEqual([kept!.id])
      expect((await caller.task.folders({})).folders).toEqual([
        { project: null, count: 1, attention: false },
      ])
      await expect(caller.task.list({ folder: site.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('walks the pages of the list by the cursor, in the format it always had', async () => {
      const { owner, workspaceId } = await siteOwner()
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

    it('merges the pages of two workspaces and loses no chat of either', async () => {
      const { owner, workspaceId } = await siteOwner()
      const other = await siteOwner()
      await db.member.create({
        data: { workspaceId: other.workspaceId, userId: owner.id, role: 'member' },
      })
      const count = Array.from({ length: 55 }, () => ({}))
      const ours = await chats(workspaceId, null, count)
      const theirs = await chats(other.workspaceId, other.site.id, count)
      // In turns, each moment twice: a page of one workspace alone would leave out the other's.
      const start = Date.now()
      const rows = []
      for (const [index, chat] of ours.entries()) {
        const updatedAt = new Date(start - index * 60_000)
        for (const { id } of [chat, theirs[index]!])
          rows.push(await db.task.update({ where: { id }, data: { updatedAt } }))
      }
      const caller = callerOf(owner)

      const pages = []
      let cursor: string | undefined
      do {
        const page = await caller.task.list(cursor === undefined ? {} : { cursor })
        pages.push(page.items.map((item) => item.id))
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)

      expect(pages.map((page) => page.length)).toEqual([50, 50, 10])
      expect(pages.flat()).toEqual(newestFirst(rows))
    })

    it('counts the folders on the server over all the chats, «Без проекта» last', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      const second = await db.site.create({
        data: {
          name: 'Пекарня',
          url: `https://${randomUUID()}.example.ru`,
          stack: 'wordpress',
          status: 'active',
          workspaceId,
        },
      })
      await chats(workspaceId, site.id, [{}, { status: 'awaiting_approval' }])
      const [waits, answered] = await chats(workspaceId, second.id, [
        { status: 'awaiting_user' },
        { status: 'awaiting_user' },
      ])
      await db.task.update({ where: { id: answered!.id }, data: { turnNo: 1 } })
      await db.$transaction((tx) =>
        insertFeedEvent(tx, {
          taskId: answered!.id,
          row: {
            type: 'feed.result',
            payload: {
              v: 1,
              turn: 1,
              message: 'Готово.',
              site: 'unchanged',
              next: 'awaiting_user',
              filesChanged: 0,
              changeType: 'none',
              needsApproval: false,
              risk: 'low',
            },
          },
        }),
      )
      // The latest changed of all, and still the last folder.
      await chats(
        workspaceId,
        null,
        Array.from({ length: 52 }, () => ({})),
      )
      const caller = callerOf(owner)
      const { folders } = await caller.task.folders({})

      expect(folders).toEqual([
        { project: { id: second.id, name: 'Пекарня' }, count: 2, attention: true },
        { project: { id: site.id, name: site.name }, count: 2, attention: true },
        { project: null, count: 52, attention: false },
      ])

      // A chat the agent answered waits for no one: the folder says so once nothing else waits.
      await db.task.update({ where: { id: waits!.id }, data: { status: 'done' } })
      const after = (await caller.task.folders({})).folders
      expect(after.find((folder) => folder.project?.id === second.id)?.attention).toBe(false)
    })

    it('reads a page through the index of the workspace, not all of its chats', async () => {
      const { owner, workspaceId } = await siteOwner()
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

    it('answers what a chat without a site does not have without a failure of the server', async () => {
      const caller = callerOf(await person())
      const taskId = await newChat(caller)
      await expect(caller.preview.ticket({ taskId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(caller.release.prepare({ taskId })).rejects.toMatchObject({
        code: 'CONFLICT',
        cause: { code: 'CHAT_COMMAND_UNAVAILABLE' },
      })
      expect(await caller.candidate.get({ taskId })).toBeNull()
      const { commands } = await caller.task.feed({ taskId })
      expect(commands.map((item) => item.refusal)).not.toContain('project_closed')
    })
  })

  describe('a chat of a closed project (docs/plan/61-chats-first.md, К39)', () => {
    const closed = ['paused', 'disconnected', 'archived'] as const
    const refused = { code: 'CONFLICT', cause: { details: { reason: 'site_not_active' } } }

    it.each(closed)('reads, and takes no words, when the project is %s', async (status) => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await asked(taskId, {
        kind: 'agent',
        intro: 'Нужно уточнить.',
        questions: [{ text: 'Какой телефон поставить?', options: [] }],
      })
      await db.site.update({ where: { id: site.id }, data: { status } })

      await expect(
        caller.task.message({ taskId, requestId: randomUUID(), text: 'Этот' }),
      ).rejects.toMatchObject(refused)

      expect(await db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        status: 'awaiting_user',
      })
      expect((await caller.task.feed({ taskId })).task.status).toBe('awaiting_user')
      expect(await caller.task.get({ taskId })).toMatchObject({
        siteId: site.id,
        project: { id: site.id, name: site.name, url: site.url, closed: true },
      })
    })

    it('answers a repeat of the words it took, though the project has closed since', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await asked(taskId, {
        kind: 'agent',
        intro: 'Нужно уточнить.',
        questions: [{ text: 'Какой телефон поставить?', options: [] }],
      })
      const input = { taskId, requestId: randomUUID(), text: 'Этот' }
      const posted = await caller.task.message(input)
      await db.site.update({ where: { id: site.id }, data: { status: 'paused' } })

      expect(await caller.task.message(input)).toEqual({ ...posted, repeated: true })
    })

    const commandRefused = {
      code: 'CONFLICT',
      cause: {
        code: 'CHAT_COMMAND_UNAVAILABLE',
        details: { refusal: 'project_closed' },
      },
    }

    /** A chat that waits with its changes and a served preview, `/release` opened over them. */
    async function waitingWithChanges() {
      const { owner, site } = await siteOwner({ database: true })
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await withCandidate(taskId)
      await db.previewEnvironment.update({ where: { taskId }, data: { status: 'ready' } })
      const choice = (await caller.release.prepare({ taskId })).choices[0]!
      return {
        site,
        caller,
        taskId,
        confirm: { confirmToken: choice.confirmToken, taskId, version: choice.version },
      }
    }

    it.each(closed)('takes no command when the project is %s', async (status) => {
      const { site, caller, taskId, confirm } = await waitingWithChanges()
      const failureEventId = String(
        await insertFeedEvent(db, {
          taskId,
          row: {
            type: 'feed.failure',
            payload: {
              v: 1,
              turn: 1,
              code: 'technical',
              site: 'unchanged',
              credits: null,
              next: 'awaiting_approval',
            },
          },
        }),
      )
      await db.site.update({ where: { id: site.id }, data: { status } })
      const rows = (await feedOf(taskId)).length
      const jobs = (await outboxOf(taskId)).length

      const feed = await caller.task.feed({ taskId })
      expect(Object.fromEntries(feed.commands.map((item) => [item.id, item.refusal]))).toEqual({
        release: 'project_closed',
        preview: 'project_closed',
        reset: 'project_closed',
        update: 'project_closed',
        init: 'project_closed',
        compact: 'project_closed',
        retry: 'project_closed',
        cancel: null,
        undo: 'no_release',
        turn_undo: 'project_closed',
        turn_redo: 'project_closed',
      })
      await expect(caller.release.prepare({ taskId })).rejects.toMatchObject(commandRefused)
      await expect(caller.release.confirm(confirm)).rejects.toMatchObject(commandRefused)
      await expect(
        caller.candidate.update({ taskId, requestId: randomUUID() }),
      ).rejects.toMatchObject(commandRefused)
      await expect(caller.preview.reset({ taskId, requestId: randomUUID() })).rejects.toMatchObject(
        commandRefused,
      )
      await expect(caller.task.init({ taskId, requestId: randomUUID() })).rejects.toMatchObject(
        commandRefused,
      )
      await expect(caller.preview.ticket({ taskId })).rejects.toMatchObject(commandRefused)
      await expect(
        caller.task.retry({ taskId, requestId: randomUUID(), failureEventId }),
      ).rejects.toMatchObject(refused)

      // Nothing was written, and the number was not spent.
      expect(await db.siteRelease.count({ where: { siteId: site.id } })).toBe(0)
      expect((await db.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
        'awaiting_approval',
      )
      const preview = await db.previewEnvironment.findUniqueOrThrow({ where: { taskId } })
      expect(preview.dirty).toBe(false)
      expect(await db.previewTicket.count({ where: { previewId: preview.id } })).toBe(0)
      expect((await feedOf(taskId)).length).toBe(rows)
      expect((await outboxOf(taskId)).length).toBe(jobs)

      await db.site.update({ where: { id: site.id }, data: { status: 'active' } })
      expect(await caller.release.confirm(confirm)).toMatchObject({
        version: confirm.version,
        repeated: false,
      })
    })

    it.each(closed)('stops a chat when the project is %s', async (status) => {
      const { site, caller, taskId } = await waitingWithChanges()
      await db.site.update({ where: { id: site.id }, data: { status } })

      await expect(caller.task.cancel({ taskId, requestId: randomUUID() })).resolves.toMatchObject({
        state: 'cancelled',
        repeated: false,
      })

      // A chat that has ended is closed with its project, by the same refusal: not `finished`.
      await expect(caller.preview.ticket({ taskId })).rejects.toMatchObject(commandRefused)
      await db.site.update({ where: { id: site.id }, data: { status: 'active' } })
      await expect(caller.preview.ticket({ taskId })).resolves.toMatchObject({
        url: expect.stringContaining('/__raditi/enter?t='),
      })
    })

    // As `refusalOf` says it in the feed: what the window shows is what the press answers.
    it('refuses a release for its project before anything else that is wrong with the press', async () => {
      const close = (siteId: string) =>
        db.site.update({ where: { id: siteId }, data: { status: 'paused' } })

      // A member, who may not release at all.
      const opened = await waitingWithChanges()
      const member = await person()
      await db.member.create({
        data: { workspaceId: opened.site.workspaceId, userId: member.id, role: 'member' },
      })
      const candidate = await db.taskCandidate.findFirstOrThrow({
        where: { taskId: opened.taskId },
      })
      const ofMember = signConfirmToken(KEY, {
        userId: member.id,
        candidateId: candidate.id,
        revision: candidate.revision,
        version: opened.confirm.version,
        dbViewSha256: null,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      })
      await close(opened.site.id)
      await expect(
        callerOf(member).release.confirm({ ...opened.confirm, confirmToken: ofMember }),
      ).rejects.toMatchObject(commandRefused)

      // `/cancel` pressed, the chat not closed yet: a row, until `task.create` makes one (61.11).
      const { owner, site, workspaceId } = await siteOwner()
      const task = await db.task.create({
        data: {
          workspaceId,
          siteId: site.id,
          needsRepository: true,
          needsBrowser: true,
          status: 'awaiting_approval',
          turnNo: 1,
          attempt: 1,
        },
      })
      taskIds.push(task.id)
      await withCandidate(task.id)
      const caller = callerOf(owner, { browser: true })
      const choice = (await caller.release.prepare({ taskId: task.id })).choices[0]!
      await caller.task.cancel({ taskId: task.id, requestId: randomUUID() })
      await close(site.id)
      await expect(
        caller.release.confirm({
          taskId: task.id,
          confirmToken: choice.confirmToken,
          version: choice.version,
        }),
      ).rejects.toMatchObject(commandRefused)

      // A chat that has ended.
      const ended = await waitingWithChanges()
      await db.task.update({ where: { id: ended.taskId }, data: { status: 'cancelled' } })
      await close(ended.site.id)
      await expect(ended.caller.release.confirm(ended.confirm)).rejects.toMatchObject(
        commandRefused,
      )
    })

    it('answers a repeat of a release it took, though the project has closed since', async () => {
      const { site, caller, confirm } = await waitingWithChanges()
      const confirmed = await caller.release.confirm(confirm)
      await db.site.update({ where: { id: site.id }, data: { status: 'paused' } })

      expect(await caller.release.confirm(confirm)).toEqual({ ...confirmed, repeated: true })
      expect(await db.siteRelease.count({ where: { siteId: site.id } })).toBe(1)
    })

    it('leaves a project still being connected as it was', async () => {
      const { site, caller, taskId, confirm } = await waitingWithChanges()
      await db.site.update({ where: { id: site.id }, data: { status: 'onboarding' } })

      const { commands } = await caller.task.feed({ taskId })
      expect(commands.map((item) => item.refusal)).not.toContain('project_closed')
      await expect(caller.release.prepare({ taskId })).resolves.toMatchObject({ revision: 1 })
      await expect(caller.release.confirm(confirm)).resolves.toMatchObject({ repeated: false })
    })

    it('says the project is open while it is', async () => {
      const { owner, site } = await siteOwner()
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      expect((await caller.task.get({ taskId })).project?.closed).toBe(false)
    })

    it('refuses «Продолжить» and «Продолжить работу агента», and answers a repeat as before', async () => {
      const { owner, site, workspaceId } = await siteOwner()
      await paidTariff(workspaceId)
      const caller = callerOf(owner)
      const { taskId } = await newDialog(caller, site.id)
      await asked(taskId, { kind: 'ceiling', reason: 'step', spent: 30, held: 35, left: 5 })
      const requestId = randomUUID()
      const posted = await caller.task.continue({ taskId, requestId })
      await asked(taskId, { kind: 'ceiling', reason: 'step', spent: 30, held: 35, left: 5 })
      await db.site.update({ where: { id: site.id }, data: { status: 'paused' } })

      await expect(caller.task.continue({ taskId, requestId: randomUUID() })).rejects.toMatchObject(
        refused,
      )
      expect(await caller.task.continue({ taskId, requestId })).toEqual({
        ...posted,
        repeated: true,
      })

      const browser = await siteOwner()
      const inBrowser = callerOf(browser.owner, { browser: true })
      await db.site.update({ where: { id: browser.site.id }, data: { status: 'onboarding' } })
      const chat = await newDialog(inBrowser, browser.site.id)
      const resumed = { taskId: chat.taskId, requestId: randomUUID() }
      await asked(chat.taskId, { kind: 'browser', reason: 'captcha', message: 'Пройдите проверку' })
      const given = await inBrowser.task.resumeAgent(resumed)
      await asked(chat.taskId, { kind: 'browser', reason: 'captcha', message: 'Пройдите проверку' })
      await db.site.update({ where: { id: browser.site.id }, data: { status: 'disconnected' } })
      await expect(
        inBrowser.task.resumeAgent({ taskId: chat.taskId, requestId: randomUUID() }),
      ).rejects.toMatchObject(refused)
      expect(await inBrowser.task.resumeAgent(resumed)).toEqual({ ...given, repeated: true })
    })
  })

  describe('a project a chat cannot work with (docs/plan/61-chats-first.md, §5.9, К8)', () => {
    /** A site of the wizard on an address the browser of production does not open. */
    async function plainAddress(status: 'active' | 'onboarding') {
      const fixture = await siteOwner({ repository: false })
      await db.site.update({
        where: { id: fixture.site.id },
        data: { url: `http://${randomUUID()}.example.ru`, status },
      })
      return fixture
    }
    const create = (caller: ReturnType<typeof callerOf>, siteId: string) => {
      const taskId = randomUUID()
      taskIds.push(taskId)
      return caller.task.create({ siteId, taskId, text: 'Добавьте новость' })
    }

    it.each(['active', 'onboarding'] as const)(
      'names the address of a %s site in production, with the browser ready',
      async (status) => {
        const { owner, site } = await plainAddress(status)
        const caller = callerOf(owner, { appEnv: 'production', browser: true })
        await expect(create(caller, site.id)).rejects.toMatchObject({
          cause: { details: { reason: 'browser_insecure' } },
        })
      },
    )

    it('names the browser when the platform has none, whatever the address', async () => {
      const { owner, site } = await plainAddress('onboarding')
      await expect(
        create(callerOf(owner, { appEnv: 'production' }), site.id),
      ).rejects.toMatchObject({ cause: { details: { reason: 'browser_unavailable' } } })
    })
  })

  describe('project.list', () => {
    it('says of every project what a new chat of it works with', async () => {
      const { owner, site } = await siteOwner({ repository: false })
      expect((await callerOf(owner).project.list())[0]?.chat).toEqual({
        state: 'unavailable',
        requirements: null,
      })
      expect((await callerOf(owner, { browser: true }).project.list())[0]?.chat).toEqual({
        state: 'ready',
        requirements: { repository: false, browser: true },
      })
      await db.site.update({ where: { id: site.id }, data: { status: 'archived' } })
      expect((await callerOf(owner, { browser: true }).project.list())[0]?.chat).toEqual({
        state: 'closed',
        requirements: null,
      })
    })
  })

  // The owner, 06.11.2026: «при сохранении файл должен сохраняться в агента, а потом по
  // возможности комититься в гит».
  describe('the edit of a file of a chat in «Терминал»', () => {
    it('keeps the text in the inbox and asks core to commit it, once the agent took the chat', async () => {
      const { owner, site } = await siteOwner()
      const put = vi.fn(async () => {})
      const caller = callerOf(owner, {
        storage: { get: async () => null, put } as unknown as ObjectStorage,
      })
      const { taskId } = await newDialog(caller, site.id)
      const edit = {
        siteId: site.id,
        taskId,
        path: 'wp-content/themes/kadence/style.css',
        baseSha: 'a'.repeat(40),
        text: 'body { color: red; }\n',
      }
      // No turn yet: no working copy to change.
      await expect(caller.siteFiles.save(edit)).rejects.toMatchObject({
        cause: { code: 'SITE_FILE_EDIT_NO_TURN' },
      })
      await db.task.update({ where: { id: taskId }, data: { turnNo: 1, status: 'awaiting_user' } })
      const { editId } = await caller.siteFiles.save(edit)
      expect(put).toHaveBeenCalledWith(
        'inbox',
        `site-edits/${taskId}/${editId}.json`,
        expect.any(Buffer),
        expect.objectContaining({ contentType: 'application/json' }),
      )
      const body = JSON.parse(
        (put.mock.calls[0] as unknown as [string, string, Buffer])[2].toString(),
      )
      expect(body).toMatchObject({
        v: 1,
        taskId,
        path: edit.path,
        baseSha: edit.baseSha,
        text: edit.text,
      })
      expect(
        await db.outboxEvent.findMany({
          where: { type: 'candidate.edit', payload: { path: ['taskId'], equals: taskId } },
        }),
      ).toEqual([expect.objectContaining({ topic: 'agent-turns', payload: { taskId, editId } })])
      expect(await caller.siteFiles.editState({ siteId: site.id, taskId, editId })).toEqual({
        state: 'pending',
      })
      // A chat that ended takes none, and another user sees no chat at all.
      await db.task.update({ where: { id: taskId }, data: { status: 'done' } })
      await expect(caller.siteFiles.save(edit)).rejects.toMatchObject({
        cause: { code: 'SITE_FILE_EDIT_CLOSED' },
      })
      const stranger = callerOf(await person())
      await expect(stranger.siteFiles.save(edit)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })
})
