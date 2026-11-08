import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { McpTurnAccess } from '../access/mcp-access.ts'
import { PostgresWebSearchStore } from './web-search-store.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const DAY = 86_400_000

/**
 * The counts of `search_web` on PostgreSQL: limits hold for calls that come together, a turn that
 * is gone or holds no credits gets nothing, and only this calendar month counts. Chats without a project (plan 61,
 * К14): each turn holds the lease of its own task.
 */
describe.skipIf(!enabled)('the web search counts with PostgreSQL', () => {
  let db: PrismaClient
  let store: PostgresWebSearchStore
  let base: {
    workspaceId: string
    driverId: string
    providerId: string
    modelId: string
    credentialId: string
    accountId: string
  }
  const tasks: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    store = new PostgresWebSearchStore(db)
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  beforeEach(async () => {
    const suffix = randomBytes(8).toString('hex')
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic search', dataClass: 'synthetic' },
    })
    const driver = await db.agentDriver.create({
      data: {
        id: `search-${suffix}`,
        image: `synthetic@sha256:${'a'.repeat(64)}`,
        capabilities: {},
        enabled: true,
      },
    })
    const provider = await db.llmProvider.create({
      data: { slug: `search-${suffix}`, name: 'Synthetic', kind: 'subscription' },
    })
    const model = await db.llmModel.create({
      data: {
        providerId: provider.id,
        slug: `search-${suffix}`,
        name: 'Synthetic',
        modelClass: 'standard',
        reserveOutputTokens: 1024,
      },
    })
    const credential = await db.credentialRef.create({
      data: { kind: 'subscription', vaultPath: `subs/synthetic/${suffix}` },
    })
    const account = await db.subscriptionAccount.create({
      data: {
        providerId: provider.id,
        driverId: driver.id,
        label: `search-${suffix}`,
        plan: 'synthetic',
        credentialRefId: credential.id,
        maxConcurrentTurns: 1,
        maxConcurrentRequests: 1,
      },
    })
    base = {
      workspaceId: workspace.id,
      driverId: driver.id,
      providerId: provider.id,
      modelId: model.id,
      credentialId: credential.id,
      accountId: account.id,
    }
  })

  afterEach(async () => {
    await db.creditHold.deleteMany({ where: { taskId: { in: tasks } } })
    await db.billingAccount.deleteMany({ where: { workspaceId: base.workspaceId } })
    for (const taskId of tasks.splice(0)) {
      await db.llmKey.deleteMany({ where: { taskId } })
      await db.siteLease.deleteMany({ where: { siteId: taskId } })
      await db.turnAssignment.deleteMany({ where: { taskId } })
      await db.task.delete({ where: { id: taskId } })
    }
    await db.workspace.delete({ where: { id: base.workspaceId } })
    await db.subscriptionAccount.delete({ where: { id: base.accountId } })
    await db.credentialRef.delete({ where: { id: base.credentialId } })
    await db.llmModel.delete({ where: { id: base.modelId } })
    await db.llmProvider.delete({ where: { id: base.providerId } })
    await db.agentDriver.delete({ where: { id: base.driverId } })
  })

  /**
   * A live first turn of a chat of its own in the workspace: its key, assignment and lease, and,
   * unless `credits` is false, an active reserve of gift credits under its task, as every pass has.
   */
  async function liveTurn({ credits = true } = {}): Promise<McpTurnAccess> {
    const suffix = randomBytes(8).toString('hex')
    const task = await db.task.create({
      data: {
        workspaceId: base.workspaceId,
        status: 'running',
        needsRepository: false,
        needsBrowser: false,
      },
    })
    tasks.push(task.id)
    const key = await db.llmKey.create({
      data: {
        keyHash: hash(randomUUID()),
        mcpTokenHash: hash(randomUUID()),
        taskId: task.id,
        taskAttempt: 1,
        sessionId: suffix,
        turnNo: 1,
        firstEpoch: 1,
        driverId: base.driverId,
        modelId: base.modelId,
        subscriptionAccountId: base.accountId,
        budgetRub: '100',
        issuedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 300_000),
        validUntil: new Date(Date.now() + 600_000),
      },
    })
    await db.turnAssignment.create({
      data: {
        taskId: task.id,
        siteId: task.id,
        sessionId: suffix,
        turnNo: 1,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + 600_000),
      },
    })
    await db.siteLease.create({
      data: {
        siteId: task.id,
        holderTaskId: task.id,
        epoch: 1,
        operation: 'turn',
        expiresAt: new Date(Date.now() + 600_000),
      },
    })
    if (credits) {
      const account = await db.billingAccount.upsert({
        where: { workspaceId_unit: { workspaceId: base.workspaceId, unit: 'credit_gift' } },
        create: { workspaceId: base.workspaceId, unit: 'credit_gift', balance: '50', held: '0' },
        update: {},
      })
      await db.creditHold.create({
        data: {
          accountId: account.id,
          unit: 'credit_gift',
          taskId: task.id,
          amount: '20',
          expiresAt: new Date(Date.now() + 600_000),
        },
      })
    }
    return {
      keyId: key.id,
      taskId: task.id,
      workspaceId: base.workspaceId,
      siteId: null,
      sessionId: suffix,
      turn: 1,
      firstEpoch: 1,
      epoch: 1,
      leaseId: task.id,
      stack: null,
      url: null,
      preview: null,
      requirements: { repository: false, browser: false },
    }
  }

  const serviceMonthNow = async () => {
    const [row] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM web_search_calls
      WHERE created_at >= date_trunc('month', clock_timestamp() AT TIME ZONE 'Europe/Moscow')
        AT TIME ZONE 'Europe/Moscow'`
    return row!.n
  }
  const wide = { turn: 100, serviceMonth: 10_000_000 }

  it('lets exactly the limit of a turn through when ten calls come at once', async () => {
    const turn = await liveTurn()
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.reserve(turn, { ...wide, turn: 3 })),
    )
    expect(results.filter((result) => result.reserved)).toHaveLength(3)
    expect(
      results.filter((result) => !result.reserved && result.refusal === 'turn_limit'),
    ).toHaveLength(7)
    expect(await db.webSearchCall.count({ where: { taskId: turn.taskId } })).toBe(3)
  })

  it('gives a workspace no limit of its own, and counts its calls of the month', async () => {
    const [first, second] = [await liveTurn(), await liveTurn()]
    const results = await Promise.all(
      [first, second, first, second, first, second].map((turn) =>
        store.reserve(turn, { ...wide, turn: 3 }),
      ),
    )
    expect(results.every((result) => result.reserved)).toBe(true)
    const seen = results.map((result) => result.usage?.workspaceMonth).sort()
    expect(seen).toEqual([0, 1, 2, 3, 4, 5])
    expect(await db.webSearchCall.count({ where: { workspaceId: base.workspaceId } })).toBe(6)
  })

  it('gives nothing to a turn whose task holds no credits, and writes nothing for it', async () => {
    const turn = await liveTurn({ credits: false })
    await expect(store.reserve(turn, wide)).resolves.toEqual({
      reserved: false,
      refusal: 'no_credits',
    })
    // A reserve that was spent or returned is no reserve.
    const withCredits = await liveTurn()
    await db.creditHold.updateMany({
      where: { taskId: withCredits.taskId },
      data: { status: 'released', settledAt: new Date() },
    })
    await expect(store.reserve(withCredits, wide)).resolves.toMatchObject({ refusal: 'no_credits' })
    // A reserve of an earlier attempt is not the reserve of this pass.
    const earlier = await liveTurn()
    await db.task.update({ where: { id: earlier.taskId }, data: { attempt: 2 } })
    await db.llmKey.updateMany({ where: { taskId: earlier.taskId }, data: { taskAttempt: 2 } })
    await expect(store.reserve(earlier, wide)).resolves.toMatchObject({ refusal: 'no_credits' })
    expect(
      await db.webSearchCall.count({
        where: { taskId: { in: [turn.taskId, withCredits.taskId] } },
      }),
    ).toBe(0)
  })

  it('holds the ceiling of the whole service', async () => {
    const turn = await liveTurn()
    const serviceMonth = (await serviceMonthNow()) + 2
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.reserve(turn, { ...wide, serviceMonth })),
    )
    expect(results.filter((result) => result.reserved)).toHaveLength(2)
    expect(
      results.filter((result) => !result.reserved && result.refusal === 'service_limit'),
    ).toHaveLength(3)
  })

  it('counts only this calendar month for the workspace', async () => {
    const turn = await liveTurn()
    await db.webSearchCall.create({
      data: {
        workspaceId: base.workspaceId,
        taskId: turn.taskId,
        sessionId: 'earlier',
        turnNo: 1,
        firstEpoch: 1,
        status: 'ok',
        latencyMs: 700,
        createdAt: new Date(Date.now() - 40 * DAY),
        finishedAt: new Date(Date.now() - 40 * DAY),
      },
    })
    const result = await store.reserve(turn, wide)
    expect(result).toMatchObject({ reserved: true, usage: { workspaceMonth: 0 } })
  })

  it('gives nothing to a turn whose key is revoked, and writes nothing for it', async () => {
    const turn = await liveTurn()
    await db.llmKey.update({ where: { id: turn.keyId }, data: { revokeRequestedAt: new Date() } })
    await expect(store.reserve(turn, wide)).resolves.toEqual({
      reserved: false,
      refusal: 'unavailable',
    })
    expect(await db.webSearchCall.count({ where: { taskId: turn.taskId } })).toBe(0)
  })

  it('records how a call ended once, with its latency and no query', async () => {
    const turn = await liveTurn()
    const result = await store.reserve(turn, wide)
    if (!result.reserved) throw new Error('not reserved')
    await store.finish(result.id, 'quota_exhausted', 812.4)
    await store.finish(result.id, 'ok', 1)
    const row = await db.webSearchCall.findUniqueOrThrow({ where: { id: result.id } })
    expect(row).toMatchObject({ status: 'quota_exhausted', latencyMs: 812 })
    expect(row.finishedAt).toBeInstanceOf(Date)
    expect(Object.keys(row).sort()).toEqual(
      [
        'createdAt',
        'finishedAt',
        'firstEpoch',
        'id',
        'latencyMs',
        'sessionId',
        'status',
        'taskId',
        'turnNo',
        'workspaceId',
      ].sort(),
    )
  })

  it('refuses a status the platform does not know, and half a finish', async () => {
    const turn = await liveTurn()
    const result = await store.reserve(turn, wide)
    if (!result.reserved) throw new Error('not reserved')
    await expect(
      db.webSearchCall.update({
        where: { id: result.id },
        data: { status: 'maybe', latencyMs: 1, finishedAt: new Date() },
      }),
    ).rejects.toThrow()
    await expect(
      db.webSearchCall.update({ where: { id: result.id }, data: { status: 'ok' } }),
    ).rejects.toThrow()
  })
})
