import { createHash, randomUUID } from 'node:crypto'

import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import type { SecretStore, TurnCredentialRef } from '@repo/domain'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { PostgresGatewayStore } from '../llm-gateway/store.ts'
import { CredentialSweeper } from './credential-sweeper.ts'
import { lockSubscriptionPool } from './turn-key.ts'

// Only verify:db's disposable, shared-user PostgreSQL; no working database or env-file is read.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe.skipIf(!enabled)('core credential cleanup with PostgreSQL', () => {
  let db: PrismaClient
  let sweeper: CredentialSweeper
  let workspaceId: string, taskId: string, providerId: string, backend: string
  let driverId: string, credentialId: string, accountId: string, modelId: string, siteId: string
  let turn = 0
  const revoke = vi.fn()
  const secrets = { kvList: vi.fn().mockResolvedValue([]) } as unknown as SecretStore

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  beforeEach(async () => {
    const suffix = randomUUID().replaceAll('-', '')
    turn = 0
    backend = `sweep-${suffix}`
    providerId = (
      await db.llmProvider.create({
        data: { slug: backend, name: 'Synthetic core sweep', kind: 'subscription' },
      })
    ).id
    driverId = (
      await db.agentDriver.create({
        data: {
          id: `sweep-${suffix.slice(0, 16)}`,
          image: 'synthetic.invalid/sweep',
          capabilities: {},
        },
      })
    ).id
    credentialId = (
      await db.credentialRef.create({
        data: { kind: 'subscription', vaultPath: `subs/${backend}/${suffix}` },
      })
    ).id
    accountId = (
      await db.subscriptionAccount.create({
        data: {
          providerId,
          driverId,
          credentialRefId: credentialId,
          label: `sweep-${suffix}`,
          plan: 'synthetic',
          enabled: true,
          maxConcurrentTurns: 2,
          maxConcurrentRequests: 2,
        },
      })
    ).id
    modelId = (
      await db.llmModel.create({
        data: {
          providerId,
          slug: `sweep-${suffix}`,
          name: 'Synthetic',
          modelClass: 'standard',
          reserveOutputTokens: 1_024,
        },
      })
    ).id
    await db.llmModelPrice.create({
      data: {
        modelId,
        effectiveFrom: new Date(Date.now() - 3_600_000),
        inputPer1m: '2',
        outputPer1m: '10',
        vatRate: '0.22',
        sourceUrl: 'https://rates.invalid/synthetic',
      },
    })
    workspaceId = (await db.workspace.create({ data: { name: 'Synthetic credential sweep' } })).id
    siteId = (
      await db.site.create({
        data: { workspaceId, name: 'Synthetic', url: 'https://sweep.invalid', stack: 'wordpress' },
      })
    ).id
    taskId = (
      await db.task.create({
        data: { workspaceId, siteId, status: 'running', modelClass: 'standard' },
      })
    ).id
    revoke.mockReset()
    revoke.mockImplementation(async (ref: TurnCredentialRef) => {
      await db.llmKey.update({
        where: {
          taskId_turnNo_firstEpoch: { taskId: ref.taskId, turnNo: ref.turn, firstEpoch: ref.epoch },
        },
        data: { revokeRequestedAt: new Date(), revokedAt: new Date() },
      })
    })
    sweeper = new CredentialSweeper({ prisma: db, secrets, credentials: { revoke } })
  })
  afterEach(async () => {
    await sweeper.close()
    await db.tokenUsage.deleteMany({ where: { taskId } })
    await db.llmCall.deleteMany({ where: { subscriptionAccountId: accountId } })
    await db.llmKey.deleteMany({ where: { subscriptionAccountId: accountId } })
    await db.task.delete({ where: { id: taskId } })
    await db.site.deleteMany({ where: { workspaceId } })
    await db.workspace.delete({ where: { id: workspaceId } })
    await db.llmModelPrice.deleteMany({ where: { modelId } })
    await db.llmModel.delete({ where: { id: modelId } })
    await db.subscriptionAccount.delete({ where: { id: accountId } })
    await db.credentialRef.delete({ where: { id: credentialId } })
    await db.agentDriver.delete({ where: { id: driverId } })
    await db.llmProvider.delete({ where: { id: providerId } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function key(
    overrides: Partial<Prisma.LlmKeyUncheckedCreateInput> = {},
    database: Pick<PrismaClient, 'llmKey'> = db,
  ) {
    turn += 1
    return database.llmKey.create({
      data: {
        keyHash: createHash('sha256').update(`${taskId}:${turn}`).digest('hex'),
        taskId,
        taskAttempt: 1,
        sessionId: 'synthetic-session',
        turnNo: turn,
        firstEpoch: 1,
        driverId,
        modelId,
        subscriptionAccountId: accountId,
        budgetRub: '100',
        issuedAt: new Date(Date.now() - 3_600_000),
        expiresAt: new Date(Date.now() + 600_000),
        validUntil: new Date(Date.now() + 900_000),
        ...overrides,
      },
    })
  }
  async function call(keyId: string, startedAt = new Date()) {
    return db.llmCall.create({
      data: {
        keyId,
        subscriptionAccountId: accountId,
        modelId,
        route: '/synthetic',
        requestBytes: 300,
        reservedRub: '1',
        startedAt,
      },
    })
  }

  it('recovers requested and expired revocation and closes their accounting', async () => {
    const requested = await key({ revokeRequestedAt: new Date() })
    const expired = await key({
      expiresAt: new Date(Date.now() - 2_000),
      validUntil: new Date(Date.now() - 1_000),
    })
    const live = await key()
    await sweeper.tick()
    expect(revoke.mock.calls.map(([ref]) => ref.turn).sort()).toEqual([
      requested.turnNo,
      expired.turnNo,
    ])
    for (const value of [requested, expired])
      expect(await db.llmKey.findUniqueOrThrow({ where: { id: value.id } })).toMatchObject({
        revokedAt: expect.any(Date),
        usageClosedAt: expect.any(Date),
      })
    expect(await db.llmKey.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({
      revokedAt: null,
      usageClosedAt: null,
    })
  })

  it('revokes again a live key whose turn assignment has finished', async () => {
    async function assignment(turnNo: number, firstEpoch: number, finished: boolean) {
      await db.turnAssignment.create({
        data: {
          taskId,
          siteId,
          sessionId: 'synthetic-session',
          turnNo,
          executor: 'local',
          plan: {},
          firstEpoch,
          leaseEpoch: firstEpoch,
          deadlineAt: new Date(Date.now() + 600_000),
          ...(finished ? { finishedAt: new Date(), outcome: 'failed' as const } : {}),
        },
      })
    }
    // The owner's revoke failed before its marker: nothing else names this key.
    const abandoned = await key()
    await assignment(abandoned.turnNo, 1, true)
    const running = await key()
    await assignment(running.turnNo, 1, false)
    const unassigned = await key()
    const otherEpoch = await key()
    await assignment(otherEpoch.turnNo, 2, true)
    await sweeper.tick()
    expect(revoke.mock.calls.map(([ref]) => ref)).toEqual([
      { taskId, sessionId: 'synthetic-session', turn: abandoned.turnNo, epoch: 1 },
    ])
    for (const live of [running, unassigned, otherEpoch])
      expect((await db.llmKey.findUniqueOrThrow({ where: { id: live.id } })).revokedAt).toBeNull()
  })

  it('keeps revoked-key accounting open until an in-flight call has closed', async () => {
    const revoked = await key({ revokeRequestedAt: new Date(), revokedAt: new Date() })
    const open = await call(revoked.id)
    await sweeper.tick()
    expect(
      (await db.llmKey.findUniqueOrThrow({ where: { id: revoked.id } })).usageClosedAt,
    ).toBeNull()
    await db.llmCall.update({
      where: { id: open.id },
      data: { state: 'failed', finishedAt: new Date() },
    })
    await sweeper.tick()
    const closed = (await db.llmKey.findUniqueOrThrow({ where: { id: revoked.id } })).usageClosedAt
    expect(closed).toBeInstanceOf(Date)
    await sweeper.tick()
    expect(
      (await db.llmKey.findUniqueOrThrow({ where: { id: revoked.id } })).usageClosedAt,
    ).toEqual(closed)
  })

  it('uses the 30-minute backup deadline and idempotent nonbillable lost accounting', async () => {
    const live = await key()
    const young = await call(live.id, new Date(Date.now() - 12 * 60_000))
    const lost = await call(live.id, new Date(Date.now() - 31 * 60_000))
    await sweeper.tick()
    expect((await db.llmCall.findUniqueOrThrow({ where: { id: young.id } })).state).toBe('open')
    expect((await db.llmCall.findUniqueOrThrow({ where: { id: lost.id } })).state).toBe('lost')
    const usage = await db.tokenUsage.findUniqueOrThrow({ where: { gatewayCallId: lost.id } })
    expect(usage).toMatchObject({
      estimated: true,
      billable: false,
      estimateReason: 'lost',
    })
    expect(usage.inputUncachedTokens).toBe(100)
    expect(usage.cacheReadTokens).toBe(0)
    expect(usage.cacheWriteTokens).toBe(0)
    expect(usage.outputTokens).toBe(1_024)
    expect(usage.reasoningTokens).toBe(0)
    expect(usage.costRub.toFixed(10)).toBe('0.0104400000')
    await sweeper.tick()
    const late = await new PostgresGatewayStore(db).finish(lost.id, {
      state: 'completed',
      usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 },
      estimated: false,
      billable: true,
      estimateReason: null,
      responseBytes: 30,
    })
    expect(late).toBe(false)
    expect(await db.tokenUsage.count({ where: { gatewayCallId: lost.id } })).toBe(1)
  })

  it('drains retirement after active keys and open calls without changing operator status', async () => {
    await db.subscriptionAccount.update({
      where: { id: accountId },
      data: { retireRequestedAt: new Date() },
    })
    const live = await key()
    await sweeper.tick()
    expect(
      (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })).enabled,
    ).toBe(true)
    const open = await call(live.id)
    await db.llmKey.update({ where: { id: live.id }, data: { revokeRequestedAt: new Date() } })
    await sweeper.tick()
    expect(
      (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })).enabled,
    ).toBe(true)
    await db.llmCall.update({
      where: { id: open.id },
      data: { state: 'completed', finishedAt: new Date() },
    })
    await sweeper.tick()
    expect(
      await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } }),
    ).toMatchObject({ enabled: false, status: 'active', credentialsRevokedAt: null })
  })

  it('waits on the issue pool lock and observes a key committed while retirement was waiting', async () => {
    await db.subscriptionAccount.update({
      where: { id: accountId },
      data: { retireRequestedAt: new Date() },
    })
    let entered!: () => void, release!: () => void
    const locked = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const issue = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('pool:' || ${backend}, 0))::text`
        entered()
        await gate
        await key({}, tx)
      },
      { timeout: 8_000 },
    )
    await locked
    const waiting = sweeper.tick()
    try {
      let found = false
      for (let i = 0; i < 100; i += 1) {
        const [state] = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE wait_event = 'advisory'
          AND query LIKE '%pg_advisory_xact_lock%') AS waiting`
        if (state!.waiting) {
          found = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(found).toBe(true)
    } finally {
      release()
    }
    await issue
    await waiting
    expect(
      (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })).enabled,
    ).toBe(true)
  })

  it('cannot disable a drained account while issue, import or retirement holds the pool lock', async () => {
    await db.subscriptionAccount.update({
      where: { id: accountId },
      data: { retireRequestedAt: new Date() },
    })
    const warn = vi.fn()
    const logged = new CredentialSweeper({
      prisma: db,
      secrets,
      credentials: { revoke },
      logger: { warn },
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    // The one spelling of the lock every other holder uses.
    const holder = db.$transaction(
      async (tx) => {
        await lockSubscriptionPool(tx, backend)
        entered.resolve()
        await release.promise
      },
      { timeout: 8_000 },
    )
    await Promise.race([entered.promise, holder])
    try {
      // Nothing is left to drain: only the lock keeps the account enabled past lock_timeout.
      await logged.tick()
      expect(warn).toHaveBeenCalledWith('llm_credentials_sweep_failed kind=retirement')
      expect(
        (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })).enabled,
      ).toBe(true)
    } finally {
      release.resolve()
      await holder
    }
    await logged.tick()
    await logged.close()
    expect(
      (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })).enabled,
    ).toBe(false)
  })
})
