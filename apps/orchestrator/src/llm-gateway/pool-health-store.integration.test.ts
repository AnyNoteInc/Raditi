import { createHash, randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import type { ProbeResult } from '@repo/domain'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { sampleBackendId, sampleProviderSlug, sampleRoutePath } from '../testing/ids.ts'
import { PostgresPoolHealthStore, type PoolHealthAccount } from './pool-health-store.ts'

// Only verify:db's disposable database is allowed; never run against the working database.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
// Within the horizon of a weekly window: a reset further ahead is a broken report.
const reset = new Date(Math.floor(Date.now() / 1000) * 1000 + 3 * 86_400_000)
const probe = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  status: 'ok',
  windows: [{ name: 'week', usedPct: 10, resetsAt: reset }],
  plan: null,
  ...overrides,
})

describe.skipIf(!enabled)('pool health durable snapshots and bounded SQL', () => {
  let db: PrismaClient
  let store: PostgresPoolHealthStore
  let providerId: string
  let driverId: string
  let credentialId: string
  let accountId: string
  let snapshot: PoolHealthAccount
  let workspaceId: string | undefined
  let modelId: string | undefined

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    store = new PostgresPoolHealthStore(db)
    // Other gateway suites own toggling providers; this suite only reads their IDs.
    const provider = await db.llmProvider.findUniqueOrThrow({ where: { slug: sampleProviderSlug } })
    providerId = provider.id
  })

  beforeEach(async () => {
    const suffix = randomUUID().replaceAll('-', '')
    accountId = randomUUID()
    const driver = await db.agentDriver.create({
      data: {
        id: `health-${suffix.slice(0, 16)}`,
        image: 'synthetic.invalid/health',
        capabilities: {},
        enabled: true,
      },
    })
    driverId = driver.id
    const ref = await db.credentialRef.create({
      data: {
        kind: 'subscription',
        vaultPath: `subs/${sampleBackendId}/${accountId}`,
      },
    })
    credentialId = ref.id
    await db.subscriptionAccount.create({
      data: {
        id: accountId,
        providerId,
        driverId,
        label: `health-${suffix}`,
        credentialRefId: credentialId,
        plan: 'synthetic',
        enabled: false,
        credentialVersion: 1,
        maxConcurrentTurns: 1,
        maxConcurrentRequests: 2,
        limitWindows: [{ name: 'week', usedPct: 20, resetsAt: reset.toISOString() }],
        limitsSeenAt: new Date(),
      },
    })
    snapshot = (await store.account(accountId))!
  })

  afterEach(async () => {
    await db.llmCall.deleteMany({ where: { subscriptionAccountId: accountId } })
    await db.llmKey.deleteMany({ where: { subscriptionAccountId: accountId } })
    if (workspaceId) {
      await db.task.deleteMany({ where: { workspaceId } })
      await db.site.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
      workspaceId = undefined
    }
    if (modelId) {
      await db.llmModel.delete({ where: { id: modelId } })
      modelId = undefined
    }
    await db.subscriptionAccount.delete({ where: { id: accountId } })
    await db.credentialRef.delete({ where: { id: credentialId } })
    await db.agentDriver.delete({ where: { id: driverId } })
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it('writes health/capacity without changing the operator switch', async () => {
    await store.probe(snapshot, probe({ status: 'auth' }))
    const account = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
    expect(account).toMatchObject({
      health: 'needs_relogin',
      healthReason: 'auth_confirmed',
      enabled: false,
      status: 'active',
    })
    expect(account.healthChangedAt).toBeInstanceOf(Date)
  })

  it('gives no account of a provider the platform has no backend for: its row is history', async () => {
    // An account of a removed provider stays in the table, switched off by the migration.
    const history = await db.llmProvider.create({
      data: { slug: `history-${randomUUID().slice(0, 8)}`, name: 'History', kind: 'subscription' },
    })
    try {
      await db.subscriptionAccount.update({
        where: { id: accountId },
        data: { providerId: history.id },
      })
      // Nothing to probe with and no error: the pool job passes such a row by.
      expect(await store.account(accountId)).toBeNull()
    } finally {
      await db.subscriptionAccount.update({ where: { id: accountId }, data: { providerId } })
      await db.llmProvider.delete({ where: { id: history.id } })
    }
    expect(await store.account(accountId)).toMatchObject({ backendId: sampleBackendId })
  })

  it('ignores a control response sent with the previous credential version', async () => {
    await db.subscriptionAccount.update({
      where: { id: accountId },
      data: { credentialVersion: 2 },
    })
    expect(await store.probe(snapshot, probe({ status: 'auth' }))).toEqual({
      applied: false,
      alert: null,
    })
    const account = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
    expect(account.health).toBe('ok')
    expect(account.headroomPct).toBeNull()
  })

  it('a late probe cannot replenish a newer exhausted snapshot', async () => {
    await db.subscriptionAccount.update({
      where: { id: accountId },
      data: {
        limitWindows: [{ name: 'week', usedPct: 100, resetsAt: reset.toISOString() }],
        limitsSeenAt: new Date(snapshot.limitsSeenAt!.getTime() + 1),
      },
    })
    await store.probe(snapshot, probe())
    const account = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
    expect(account.headroomPct?.toString()).toBe('0')
    expect(account.limitWindows).toEqual([
      { name: 'week', usedPct: 100, resetsAt: reset.toISOString() },
    ])
    expect(account.coolingUntil).toEqual(new Date(reset.getTime() + 60_000))
  })

  it('applies a probe of unknown windows that a late response overtook', async () => {
    // The windows were unknown when the probe was sent; a late response of the turn then
    // wrote "still unknown" under a newer limits_seen_at. It restored nothing to replenish.
    await db.subscriptionAccount.update({
      where: { id: accountId },
      data: { limitWindows: [], headroomPct: null },
    })
    const unknown = (await store.account(accountId))!
    expect(unknown.windowsKnown).toBe(false)
    const overtakenAt = new Date(unknown.limitsSeenAt!.getTime() + 1)
    await db.subscriptionAccount.update({
      where: { id: accountId },
      data: { limitsSeenAt: overtakenAt },
    })
    const update = await store.probe(unknown, probe())
    const account = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
    expect(account.limitWindows).toEqual([
      { name: 'week', usedPct: 10, resetsAt: reset.toISOString() },
    ])
    expect(account.headroomPct?.toString()).toBe('90')
    expect(account.limitsSeenAt!.getTime()).toBeGreaterThan(overtakenAt.getTime())
    // The pool remembers which state the probe left, to tell a newer one apart.
    expect(update).toEqual({ applied: true, alert: null, limitsSeenAt: account.limitsSeenAt })
  })

  it('leaves windows cleared after the probe was sent unknown until a later probe', async () => {
    expect(snapshot.windowsKnown).toBe(true)
    const clearedAt = new Date(snapshot.limitsSeenAt!.getTime() + 1)
    await db.subscriptionAccount.update({
      where: { id: accountId },
      data: { limitWindows: [], headroomPct: null, limitsSeenAt: clearedAt },
    })
    await store.probe(snapshot, probe())
    expect(
      (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })).limitWindows,
    ).toEqual([])
    // The next probe starts from the cleared state and restores them.
    await store.probe((await store.account(accountId))!, probe())
    expect(
      (
        await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
      ).headroomPct?.toString(),
    ).toBe('90')
  })

  it('never cools an account past the horizon of its windows on a reset no window can have', async () => {
    const day = 86_400_000
    // Seconds read as milliseconds: the year 58692 fits a timestamptz and would never end.
    const corrupted = new Date(1_790_000_000_000_000)
    const exhausted = (resetsAt: Date) =>
      probe({ windows: [{ name: 'week', usedPct: 100, resetsAt }] })
    for (const resetsAt of [corrupted, new Date(Date.now() + 8 * day + 60_000)]) {
      await store.probe((await store.account(accountId))!, exhausted(resetsAt))
      const account = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
      // An unreadable report: capacity unknown until the next probe, and no pause from it.
      expect(account).toMatchObject({ limitWindows: [], headroomPct: null, coolingUntil: null })
    }
    await store.cool(accountId, corrupted)
    const hour = (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } }))
      .coolingUntil!
    expect(hour.getTime() - Date.now()).toBeGreaterThan(59 * 60_000)
    expect(hour.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000)
    // A reset that names no window is bounded like a weekly one, as the gateway store does.
    await store.cool(accountId, new Date(Date.now() + 9 * day))
    const nameless = (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } }))
      .coolingUntil!
    expect(nameless.getTime()).toBeGreaterThanOrEqual(hour.getTime())
    expect(nameless.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000)
    // A month window may reset this far ahead; nothing may pause an account for longer.
    const month = new Date(Date.now() + 31 * day)
    await store.cool(accountId, month, 'month')
    expect(
      (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })).coolingUntil,
    ).toEqual(new Date(month.getTime() + 60_000))
    await store.cool(accountId, new Date(Date.now() + 33 * day), 'month')
    expect(
      (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })).coolingUntil,
    ).toEqual(new Date(month.getTime() + 60_000))
  })

  it('reports the snapshot a probe left, also when it wrote no windows', async () => {
    const update = await store.probe(snapshot, probe({ status: 'auth', windows: null }))
    expect(update).toMatchObject({ applied: true, limitsSeenAt: snapshot.limitsSeenAt })
  })

  it('clears authoritative unknown capacity and leaves the recorded health reason alone', async () => {
    await db.subscriptionAccount.update({
      where: { id: accountId },
      data: { healthReason: 'recorded_before' },
    })
    await store.probe(snapshot, probe({ status: 'unknown', windows: null }))
    const account = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
    expect(account).toMatchObject({
      limitWindows: [],
      headroomPct: null,
      health: 'ok',
      healthReason: 'recorded_before',
    })
  })

  it('limits real account-row lock waiting to one second', async () => {
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${accountId}::uuid FOR UPDATE`
        locked.resolve()
        await release.promise
      },
      { timeout: 10_000 },
    )
    await locked.promise
    const start = Date.now()
    try {
      await expect(store.probe(snapshot, probe())).rejects.toThrow()
      expect(Date.now() - start).toBeLessThan(4_000)
    } finally {
      release.resolve()
      await holder
    }
  })

  /** A key of a task that finished calls are journaled under, as the gateway writes them. */
  async function callJournal() {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic health journal' } })
    workspaceId = workspace.id
    const site = await db.site.create({
      data: { workspaceId, name: 'Synthetic', url: 'https://health.invalid', stack: 'wordpress' },
    })
    const task = await db.task.create({
      data: { workspaceId, siteId: site.id, status: 'running', modelClass: 'standard' },
    })
    const model = await db.llmModel.create({
      data: {
        providerId,
        slug: `health-${randomUUID()}`,
        name: 'Synthetic health',
        providerModelId: 'synthetic',
        modelClass: 'standard',
        reserveOutputTokens: 1_024,
        enabled: false,
      },
    })
    modelId = model.id
    const key = await db.llmKey.create({
      data: {
        keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
        taskId: task.id,
        taskAttempt: 1,
        sessionId: 'health',
        turnNo: 1,
        firstEpoch: 1,
        driverId,
        modelId,
        subscriptionAccountId: accountId,
        budgetRub: '1',
        expiresAt: new Date(Date.now() + 60_000),
        validUntil: new Date(Date.now() + 120_000),
      },
    })
    return (finishedAt: Date, data: { upstreamStatus?: number; signal?: string }) =>
      db.llmCall.create({
        data: {
          keyId: key.id,
          subscriptionAccountId: accountId,
          modelId: model.id,
          route: sampleRoutePath,
          state: 'failed',
          reservedRub: '0',
          requestBytes: 0,
          startedAt: new Date(finishedAt.getTime() - 1),
          finishedAt,
          ...data,
        },
      })
  }

  it('reconstructs the daily payment failure count from the persisted call journal', async () => {
    const journal = await callJournal()
    const failed = (finishedAt: Date) => journal(finishedAt, { upstreamStatus: 402 })
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)
    // Three concurrent 402 responses form one check; a day-old failure is outside the window.
    for (const finishedAt of [
      minutesAgo(60),
      new Date(minutesAgo(60).getTime() + 1_000),
      new Date(minutesAgo(60).getTime() + 2_000),
      minutesAgo(2 * 24 * 60),
    ])
      await failed(finishedAt)
    expect(await store.payment(accountId)).toMatchObject({ count: 1, suspended: false })
    // The next checks follow the five- and fifteen-minute pauses.
    await failed(minutesAgo(50))
    expect(await store.payment(accountId)).toMatchObject({ count: 2, suspended: false })
    await failed(minutesAgo(30))
    const third = await new PostgresPoolHealthStore(db).payment(accountId)
    expect(third).toMatchObject({ count: 3, suspended: true })
    expect(third.at).toBeInstanceOf(Date)
    expect(
      await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } }),
    ).toMatchObject({ health: 'suspended', healthReason: 'payment_pending', enabled: false })
  })
  it('pauses an account whose balance is spent durably, longer with each check of the day', async () => {
    const journal = await callJournal()
    const spent = (finishedAt: Date) => journal(finishedAt, { signal: 'balance_exhausted' })
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)
    const cooling = async () =>
      (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })).coolingUntil
    const pausedFor = (until: Date | null, minutes: number) => {
      // The database clock begins the pause; the test's clock is a little behind it.
      const ahead = until!.getTime() - Date.now()
      expect(ahead).toBeGreaterThan((minutes - 1) * 60_000)
      expect(ahead).toBeLessThanOrEqual(minutes * 60_000 + 5_000)
    }
    // Two answered together form one check; a day-old one and another signal count for nothing.
    await spent(minutesAgo(0))
    await spent(new Date(Date.now() - 500))
    await spent(minutesAgo(2 * 24 * 60))
    await journal(minutesAgo(1), { upstreamStatus: 402, signal: 'transient' })
    const first = await store.balance(accountId)
    expect(first.count).toBe(1)
    pausedFor(first.pausedUntil, 5)
    expect(await cooling()).toEqual(first.pausedUntil)
    // A call answered within that pause begins none of its own.
    expect(await store.balance(accountId)).toEqual({ count: 1, pausedUntil: null })
    expect(await cooling()).toEqual(first.pausedUntil)
    // Once a pause is over, the next spent check pauses longer: 15, 45, then 60 minutes.
    for (const [earlier, count, minutes] of [
      [[6], 2, 15],
      [[30, 20], 3, 45],
      [[200, 190, 170, 120], 5, 60],
    ] as const) {
      await db.llmCall.deleteMany({
        where: { subscriptionAccountId: accountId, signal: 'balance_exhausted' },
      })
      await db.subscriptionAccount.update({
        where: { id: accountId },
        data: { coolingUntil: minutesAgo(1) },
      })
      for (const minutes of earlier) await spent(minutesAgo(minutes))
      await spent(minutesAgo(0))
      const next = await store.balance(accountId)
      expect(next.count).toBe(count)
      pausedFor(next.pausedUntil, minutes)
      expect(await cooling()).toEqual(next.pausedUntil)
    }
    // The account itself stays as it was: no health, no windows, no operator switch.
    expect(
      await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } }),
    ).toMatchObject({ health: 'ok', healthReason: null, enabled: false })
  })
})
