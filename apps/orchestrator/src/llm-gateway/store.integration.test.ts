import { createHash, randomUUID } from 'node:crypto'

import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import type { GatewayRefusal } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  sampleBackendCapacity,
  sampleBackendId,
  sampleProviderSlug,
  sampleRoutePath,
} from '../testing/ids.ts'
import { PostgresGatewayStore } from './store.ts'
import {
  GatewayRecordRejected,
  type GatewayAdmitInput,
  type GatewayCall,
  type GatewayFinish,
} from './types.ts'

// These catalog/clock/locking checks run only in verify:db's disposable database.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const actual = (): GatewayFinish => ({
  state: 'completed',
  usage: { input: 1_000, cacheRead: 200, cacheWrite: 100, output: 50, reasoning: 10 },
  estimated: false,
  billable: true,
  estimateReason: null,
  responseBytes: 450,
  upstreamStatus: 200,
  signal: { kind: 'ok' },
})

describe.skipIf(!enabled)('transactional subscription gateway accounting', () => {
  let db: PrismaClient
  let store: PostgresGatewayStore
  let provider: { id: string; kind: 'api' | 'subscription'; enabled: boolean }
  let createdProvider = false
  const fixtures: {
    workspaceId: string
    driverId?: string
    credentialId?: string
    accountId?: string
    modelId?: string
  }[] = []

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    store = new PostgresGatewayStore(db)
    // The seeded provider of the sample backend. Files with a database run one at a time
    // (vitest.config.ts), and this suite puts the flags of the row back when it ends.
    const existing = await db.llmProvider.findUnique({ where: { slug: sampleProviderSlug } })
    createdProvider = existing === null
    provider =
      existing ??
      (await db.llmProvider.create({
        data: {
          slug: sampleProviderSlug,
          name: 'Synthetic store verification',
          kind: 'subscription',
          enabled: true,
        },
      }))
    await db.llmProvider.update({
      where: { id: provider.id },
      data: { enabled: true, kind: 'subscription' },
    })
  })

  afterEach(async () => {
    for (const f of fixtures.splice(0)) {
      const tasks = { task: { workspaceId: f.workspaceId } }
      await db.tokenUsage.deleteMany({ where: tasks })
      await db.llmCall.deleteMany({ where: { key: tasks } })
      await db.llmKey.deleteMany({ where: tasks })
      await db.task.deleteMany({ where: { workspaceId: f.workspaceId } })
      await db.site.deleteMany({ where: { workspaceId: f.workspaceId } })
      await db.workspace.delete({ where: { id: f.workspaceId } })
      if (f.modelId) {
        await db.llmModelPrice.deleteMany({ where: { modelId: f.modelId } })
        await db.llmModel.delete({ where: { id: f.modelId } })
      }
      if (f.accountId) await db.subscriptionAccount.delete({ where: { id: f.accountId } })
      if (f.credentialId) await db.credentialRef.delete({ where: { id: f.credentialId } })
      if (f.driverId) await db.agentDriver.delete({ where: { id: f.driverId } })
    }
    await db.llmProvider.update({
      where: { id: provider.id },
      data: { enabled: true, kind: 'subscription' },
    })
  })

  afterAll(async () => {
    if (provider) {
      if (createdProvider) await db.llmProvider.delete({ where: { id: provider.id } })
      else
        await db.llmProvider.update({
          where: { id: provider.id },
          data: { enabled: provider.enabled, kind: provider.kind },
        })
    }
    await db.$disconnect()
  })

  async function fixture(
    options: { budget?: string; accountSlots?: number; price?: boolean } = {},
  ) {
    const suffix = randomUUID().replaceAll('-', '')
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic gateway store verification' },
    })
    const tracked: (typeof fixtures)[number] = { workspaceId: workspace.id }
    fixtures.push(tracked)
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Synthetic',
        url: 'https://gateway.invalid',
        stack: 'wordpress',
      },
    })
    const task = await db.task.create({
      data: {
        workspaceId: workspace.id,
        siteId: site.id,
        status: 'running',
        modelClass: 'standard',
      },
    })
    const driver = await db.agentDriver.create({
      data: {
        id: `store-${suffix.slice(0, 16)}`,
        image: 'synthetic.invalid/agent',
        capabilities: {},
        enabled: true,
      },
    })
    tracked.driverId = driver.id
    const credential = await db.credentialRef.create({
      data: { kind: 'subscription', vaultPath: `subs/${sampleBackendId}/${suffix}` },
    })
    tracked.credentialId = credential.id
    const account = await db.subscriptionAccount.create({
      data: {
        providerId: provider.id,
        driverId: driver.id,
        label: `store-${suffix}`,
        credentialRefId: credential.id,
        plan: 'synthetic',
        enabled: true,
        status: 'active',
        health: 'ok',
        credentialVersion: 1,
        maxConcurrentTurns: 2,
        maxConcurrentRequests: options.accountSlots ?? 8,
        limitWindows: [
          { name: 'week', usedPct: 1, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
        ],
        limitsSeenAt: new Date(),
      },
    })
    tracked.accountId = account.id
    const model = await db.llmModel.create({
      data: {
        providerId: provider.id,
        slug: `store-${suffix}`,
        name: 'Synthetic',
        providerModelId: 'synthetic-model',
        modelClass: 'standard',
        reserveOutputTokens: 1_024,
        enabled: true,
      },
    })
    tracked.modelId = model.id
    const price =
      options.price === false
        ? null
        : await db.llmModelPrice.create({
            data: {
              modelId: model.id,
              effectiveFrom: new Date(Date.now() - 3_600_000),
              inputPer1m: '100',
              cacheReadPer1m: '10',
              outputPer1m: '100',
              vatRate: '0.22',
              sourceUrl: 'https://rates.invalid/synthetic',
            },
          })
    let turn = 0
    async function key(overrides: Partial<Prisma.LlmKeyUncheckedCreateInput> = {}) {
      turn += 1
      const keyHash = createHash('sha256').update(`synthetic:${suffix}:${turn}`).digest('hex')
      const row = await db.llmKey.create({
        data: {
          keyHash,
          taskId: task.id,
          taskAttempt: 1,
          sessionId: 'synthetic',
          turnNo: turn,
          firstEpoch: 1,
          driverId: driver.id,
          modelId: model.id,
          subscriptionAccountId: account.id,
          reasoningEffort: 'low',
          budgetRub: options.budget ?? '1',
          boundSource: '127.0.0.1',
          issuedAt: new Date(Date.now() - 10_000),
          expiresAt: new Date(Date.now() + 300_000),
          validUntil: new Date(Date.now() + 600_000),
          ...overrides,
        },
      })
      const profile = await store.lookup(row.keyHash, '127.0.0.1')
      if (!profile) throw new Error('Synthetic key profile missing')
      const input: GatewayAdmitInput = {
        keyHash: row.keyHash,
        source: '127.0.0.1',
        backendId: sampleBackendId,
        capacity: sampleBackendCapacity,
        route: { method: 'POST', path: sampleRoutePath },
        profile,
        requestBytes: 600,
        estimatedInputTokens: 1_000,
      }
      return { row, input }
    }
    return { task, account, model, price, key }
  }

  async function admitted(input: GatewayAdmitInput, target = store): Promise<GatewayCall> {
    const result = await target.admit(input)
    expect(result.kind).toBe('admitted')
    if (result.kind !== 'admitted')
      throw new Error(`Unexpected synthetic refusal: ${result.reason}`)
    return result.call
  }

  async function withRowLock(
    kind: 'key' | 'account' | 'call',
    id: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const locked = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const blocker = db.$transaction(
      async (tx) => {
        if (kind === 'key')
          await tx.$queryRaw`SELECT id FROM llm_keys WHERE id = ${id}::uuid FOR UPDATE`
        else if (kind === 'account')
          await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${id}::uuid FOR UPDATE`
        else await tx.$queryRaw`SELECT id FROM llm_calls WHERE id = ${id}::uuid FOR UPDATE`
        locked.resolve()
        await released.promise
      },
      { timeout: 15_000 },
    )
    void blocker.catch(locked.reject)
    try {
      await locked.promise
      await work()
    } finally {
      released.resolve()
      await blocker
    }
  }

  it.each(['key', 'account'] as const)(
    'cancels admission waiting on a held %s lock without committing a reservation',
    async (kind) => {
      const f = await fixture()
      const k = await f.key()
      await withRowLock(kind, kind === 'key' ? k.row.id : f.account.id, async () => {
        const started = Date.now()
        await expect(store.admit(k.input)).rejects.toMatchObject({
          meta: { driverAdapterError: { cause: { code: '55P03' } } },
        })
        expect(Date.now() - started).toBeLessThan(5_000)
        expect(await db.llmCall.count({ where: { keyId: k.row.id } })).toBe(0)
        expect(
          (await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastCallAt,
        ).toBeNull()
      })
      await admitted(k.input)
      expect(await db.llmCall.count({ where: { keyId: k.row.id } })).toBe(1)
    },
  )

  it('cancels a blocked closure without partially recording usage, then closes once on retry', async () => {
    const f = await fixture()
    const k = await f.key()
    const call = await admitted(k.input)
    await withRowLock('call', call.id, async () => {
      await expect(store.finish(call.id, actual())).rejects.toMatchObject({
        meta: { driverAdapterError: { cause: { code: '55P03' } } },
      })
      expect((await db.llmCall.findUniqueOrThrow({ where: { id: call.id } })).state).toBe('open')
      expect(await db.tokenUsage.count({ where: { gatewayCallId: call.id } })).toBe(0)
    })
    expect(await store.finish(call.id, actual())).toBe(true)
    expect(await store.finish(call.id, actual())).toBe(false)
    expect(await db.tokenUsage.count({ where: { gatewayCallId: call.id } })).toBe(1)
  })

  it('isolates a row the collector cannot close now, finishes the pass and retries the row later', async () => {
    const f = await fixture()
    const [held, free] = await Promise.all([f.key(), f.key()])
    const blocked = await admitted(held.input)
    const other = await admitted(free.input)
    // The held call is the oldest, so a pass that stopped at it would close nothing.
    for (const [call, minutes] of [
      [blocked, 13],
      [other, 12],
    ] as const)
      await db.llmCall.update({
        where: { id: call.id },
        data: { startedAt: new Date(Date.now() - minutes * 60_000) },
      })
    const warnings: string[] = []
    const collector = new PostgresGatewayStore(db, {
      logger: { warn: (message) => warnings.push(message) },
    })
    await withRowLock('key', held.row.id, async () => {
      expect(await collector.collectLost()).toBe(1)
      expect((await db.llmCall.findUniqueOrThrow({ where: { id: blocked.id } })).state).toBe('open')
      expect(await db.tokenUsage.count({ where: { gatewayCallId: blocked.id } })).toBe(0)
      expect((await db.llmCall.findUniqueOrThrow({ where: { id: other.id } })).state).toBe('lost')
    })
    expect(warnings).toEqual([JSON.stringify({ event: 'llm_collector_row_failed', kind: 'call' })])
    expect(await collector.collectLost()).toBe(1)
    expect(
      await db.tokenUsage.findUniqueOrThrow({ where: { gatewayCallId: blocked.id } }),
    ).toMatchObject({
      estimated: true,
      billable: false,
      estimateReason: 'lost',
    })
    const [first, second] = await Promise.all([f.key(), f.key()])
    for (const empty of [first, second])
      await db.llmKey.update({
        where: { id: empty.row.id },
        data: { revokeRequestedAt: new Date(), revokedAt: new Date() },
      })
    const usageClosedAt = async (id: string) =>
      (await db.llmKey.findUniqueOrThrow({ where: { id } })).usageClosedAt
    await withRowLock('key', first.row.id, async () => {
      expect(await collector.collectLost()).toBe(0)
      expect(await usageClosedAt(first.row.id)).toBeNull()
      expect(await usageClosedAt(second.row.id)).toBeInstanceOf(Date)
    })
    expect(warnings.at(-1)).toBe(JSON.stringify({ event: 'llm_collector_row_failed', kind: 'key' }))
    expect(await collector.collectLost()).toBe(0)
    expect(await usageClosedAt(first.row.id)).toBeInstanceOf(Date)
  })

  it('bounds refusal updates without leaving a background write after the deadline', async () => {
    const f = await fixture()
    const k = await f.key()
    await withRowLock('key', k.row.id, async () => {
      await expect(store.refuse(k.row.id, 'budget')).rejects.toMatchObject({
        meta: { driverAdapterError: { cause: { code: '55P03' } } },
      })
      expect(
        (await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastRefusal,
      ).toBeNull()
    })
    await store.refuse(k.row.id, 'transient')
    expect((await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastRefusal).toBe(
      'transient',
    )
  })

  it('cancels slow SQL after an INSERT, rolls back the reserve and restores pooled settings', async () => {
    const f = await fixture()
    const k = await f.key()
    // One fresh pool connection makes the LOCAL-reset check deterministic without
    // altering global PostgreSQL settings or slowing another suite's table.
    const isolated = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    const settings = () => isolated.$queryRaw<
      {
        pid: number
        lock: string
        statement: string
      }[]
    >`SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS lock,
      current_setting('statement_timeout') AS statement`
    try {
      const before = await settings()
      let observed: { lock: string; statement: string }[] = []
      const delayedDb = {
        $queryRaw: isolated.$queryRaw.bind(isolated),
        $transaction: (
          work: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: { maxWait?: number; timeout?: number },
        ) =>
          isolated.$transaction(async (tx) => {
            const delayed = new Proxy(tx, {
              get(target, property, receiver) {
                if (property !== 'llmKey') return Reflect.get(target, property, receiver)
                return new Proxy(target.llmKey, {
                  get(delegate, method, delegateReceiver) {
                    if (method !== 'update') return Reflect.get(delegate, method, delegateReceiver)
                    return async () => {
                      // The admission has already inserted its open call. Emulate a slow
                      // final statement on this same transaction and connection.
                      observed = await tx.$queryRaw`SELECT current_setting('lock_timeout') AS lock,
                      current_setting('statement_timeout') AS statement`
                      await tx.$queryRaw`SELECT pg_sleep(6)::text`
                      throw new Error('PostgreSQL did not enforce statement_timeout')
                    }
                  },
                })
              },
            })
            return work(delayed)
          }, options),
      } as unknown as Pick<PrismaClient, '$transaction' | '$queryRaw'>
      const bounded = new PostgresGatewayStore(delayedDb)
      const started = Date.now()
      await expect(bounded.admit(k.input)).rejects.toMatchObject({
        meta: { driverAdapterError: { cause: { code: '57014' } } },
      })
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(observed).toEqual([{ lock: '1s', statement: '5s' }])
      expect(await settings()).toEqual(before)
      expect(await db.llmCall.count({ where: { keyId: k.row.id } })).toBe(0)
      expect((await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastCallAt).toBeNull()
      await admitted(k.input)
    } finally {
      await isolated.$disconnect()
    }
  }, 15_000)

  it('serializes concurrent requests per key and respects the configured one-request limit', async () => {
    const f = await fixture()
    const k = await f.key()
    const results = await Promise.all(Array.from({ length: 6 }, () => store.admit(k.input)))
    expect(results.filter((r) => r.kind === 'admitted')).toHaveLength(2)
    expect(results.filter((r) => r.kind === 'refused')).toEqual(
      Array.from({ length: 4 }, () =>
        expect.objectContaining({ kind: 'refused', reason: 'transient' }),
      ),
    )
    expect(results.filter((r) => r.kind === 'refused').every((r) => !r.waitForSlot)).toBe(true)
    const other = await f.key()
    const one = new PostgresGatewayStore(db, { maxRequestsPerKey: 1 })
    await admitted(other.input, one)
    expect(await one.admit(other.input)).toMatchObject({ kind: 'refused', reason: 'transient' })
  })

  it('refuses for good a key that asks faster than its pace or more often than its ceiling', async () => {
    const f = await fixture({ budget: '100' })
    const k = await f.key()
    const paced = new PostgresGatewayStore(db, { maxCallsPerKey30s: 3 })
    // Every call is closed at once and costs next to nothing: only the pace is left to refuse.
    for (let call = 0; call < 3; call++)
      await paced.finish((await admitted(k.input, paced)).id, actual())
    expect(await paced.admit(k.input)).toEqual({
      kind: 'refused',
      keyId: k.row.id,
      reason: 'budget',
      limit: 'pace',
    })
    expect((await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastRefusal).toBe(
      'budget',
    )
    // The refusal reserved nothing and opened no call.
    expect(await db.llmCall.count({ where: { keyId: k.row.id } })).toBe(3)
    // Another key of the same account has a pace of its own.
    const other = await f.key()
    await paced.finish((await admitted(other.input, paced)).id, actual())
    // Calls that started more than thirty seconds ago no longer count against the pace...
    await db.llmCall.updateMany({
      where: { keyId: k.row.id },
      data: { startedAt: new Date(Date.now() - 31_000) },
    })
    await paced.finish((await admitted(k.input, paced)).id, actual())
    // ...but every call of the key counts against its ceiling, whenever it was made.
    const capped = new PostgresGatewayStore(db, { maxCallsPerKey: 4 })
    expect(await capped.admit(k.input)).toMatchObject({
      kind: 'refused',
      reason: 'budget',
      limit: 'calls',
    })
    await admitted(k.input, new PostgresGatewayStore(db, { maxCallsPerKey: 5 }))
  })

  it('tells the gateway when the first call of a key meets a window snapshot grown old', async () => {
    const f = await fixture()
    const seen = (minutesAgo: number | null) =>
      db.subscriptionAccount.update({
        where: { id: f.account.id },
        data: {
          limitsSeenAt: minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000),
        },
      })
    const k = await f.key()
    const stale = async () => (await store.lookup(k.row.keyHash, '127.0.0.1'))?.staleWindows
    await seen(9)
    expect(await stale()).toBe(false)
    await seen(11)
    expect(await stale()).toBe(true)
    // Windows nobody has dated are the business of the rule for unknown windows.
    await seen(null)
    expect(await stale()).toBe(false)
    // Once the key has started a call its turn runs on: only the first call asks.
    await seen(11)
    await store.finish((await admitted(k.input)).id, actual())
    expect(await stale()).toBe(false)
    // An old snapshot refuses nothing.
    await seen(600)
    await admitted((await f.key()).input)
    // A provider, a model or an account that is switched off, and an account that is out of
    // use, are refused for good by admission: no refresh is asked for a key that has only that
    // ahead of it, so nothing is sent to a provider on its behalf.
    const idle = await f.key()
    const staleOf = async () => (await store.lookup(idle.row.keyHash, '127.0.0.1'))?.staleWindows
    expect(await staleOf()).toBe(true)
    const switched = async (
      reason: GatewayRefusal,
      off: () => Promise<unknown>,
      on: () => Promise<unknown>,
    ) => {
      await off()
      try {
        expect(await staleOf(), reason).toBe(false)
        expect(await store.admit(idle.input)).toMatchObject({ kind: 'refused', reason })
      } finally {
        await on()
      }
      expect(await staleOf(), reason).toBe(true)
    }
    const providerOf = (enabled: boolean) => () =>
      db.llmProvider.update({ where: { id: provider.id }, data: { enabled } })
    const modelOf = (enabled: boolean) => () =>
      db.llmModel.update({ where: { id: f.model.id }, data: { enabled } })
    const accountOf = (data: Prisma.SubscriptionAccountUncheckedUpdateInput) => () =>
      db.subscriptionAccount.update({ where: { id: f.account.id }, data })
    await switched('provider_off', providerOf(false), providerOf(true))
    await switched('profile', modelOf(false), modelOf(true))
    await switched('account', accountOf({ enabled: false }), accountOf({ enabled: true }))
    for (const health of ['needs_relogin', 'suspended'] as const)
      await switched('account', accountOf({ health }), accountOf({ health: 'ok' }))
    await switched('account', accountOf({ status: 'banned' }), accountOf({ status: 'active' }))
    await switched(
      'account',
      accountOf({ credentialsRevokedAt: new Date() }),
      accountOf({ credentialsRevokedAt: null }),
    )
    await admitted(idle.input)
  })

  it('enforces global account slots across different keys, releasing slots after finish', async () => {
    const f = await fixture({ accountSlots: 1 })
    const keys = await Promise.all([f.key(), f.key()])
    const results = await Promise.all(keys.map((k) => store.admit(k.input)))
    const open = results.find((r) => r.kind === 'admitted')
    const denied = results.find((r) => r.kind === 'refused')
    expect(denied).toMatchObject({ reason: 'transient', waitForSlot: true })
    expect(open?.kind).toBe('admitted')
    if (open?.kind !== 'admitted') throw new Error('Missing admitted call')
    await store.finish(open.call.id, actual())
    const waitingKey = keys.find((k) => k.row.id === denied?.keyId)!
    await admitted(waitingKey.input)
  })

  it('reserves atomically, then replaces the reserve with exact spent cost', async () => {
    const f = await fixture({ budget: '0.3' })
    const k = await f.key()
    const results = await Promise.all([store.admit(k.input), store.admit(k.input)])
    const open = results.find((r) => r.kind === 'admitted')
    expect(results).toContainEqual(
      expect.objectContaining({ kind: 'refused', reason: 'budget', limit: 'money' }),
    )
    if (open?.kind !== 'admitted') throw new Error('Missing admitted call')
    expect(open.call.reservedRub).toBe('0.2024000000')
    expect(await store.finish(open.call.id, actual())).toBe(true)
    const usage = await db.tokenUsage.findUniqueOrThrow({ where: { gatewayCallId: open.call.id } })
    expect(usage.costRub.toFixed(10)).toBe('0.0870000000')
    expect(usage.inputUncachedTokens).toBe(700)
    expect(usage.outputTokens).toBe(50)
    expect(usage.reasoningTokens).toBe(10)
    await admitted(k.input)
  })

  it('closes once under concurrent retries and prices usage at call start', async () => {
    const f = await fixture()
    const k = await f.key()
    const call = await admitted(k.input)
    await db.llmModelPrice.create({
      data: {
        modelId: f.model.id,
        effectiveFrom: new Date(call.startedAt.getTime() + 1),
        inputPer1m: '900',
        outputPer1m: '900',
        vatRate: '0.22',
        sourceUrl: 'https://rates.invalid/later',
      },
    })
    const finishes = await Promise.all(
      Array.from({ length: 5 }, () => store.finish(call.id, actual())),
    )
    expect(finishes.filter(Boolean)).toHaveLength(1)
    expect(await db.tokenUsage.count({ where: { gatewayCallId: call.id } })).toBe(1)
    const usage = await db.tokenUsage.findUniqueOrThrow({ where: { gatewayCallId: call.id } })
    expect(usage.priceId).toBe(f.price!.id)
    expect(usage.costRub.toFixed(10)).toBe('0.0870000000')
    expect(usage.occurredAt).toEqual(call.startedAt)
    expect((await db.llmCall.findUniqueOrThrow({ where: { id: call.id } })).state).toBe('completed')
  })

  it('uses actual completed usage across keys in the same attempt and excludes estimated history', async () => {
    const f = await fixture()
    const first = await admitted((await f.key()).input)
    await store.finish(first.id, {
      ...actual(),
      usage: { input: 1_000, cacheRead: 950, cacheWrite: 0, output: 10, reasoning: 0 },
    })
    const second = await admitted((await f.key()).input)
    // Cache ratio is capped at 90%, with read tokens priced at10; output reserve is unchanged.
    expect(second.reservedRub).toBe('0.1214000000')
    await store.finish(second.id, {
      ...actual(),
      usage: { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 1_024, reasoning: 0 },
      estimated: true,
      estimateReason: 'no_usage',
    })
    const third = await admitted((await f.key()).input)
    expect(third.reservedRub).toBe('0.1214000000')
    const nextAttempt = await admitted((await f.key({ taskAttempt: 2 })).input)
    expect(nextAttempt.reservedRub).toBe('0.2024000000')
  })

  it('rechecks source, revocation, backend, profile and stop flags before reserving', async () => {
    const f = await fixture()
    const k = await f.key()
    expect(await store.lookup(k.row.keyHash, '127.0.0.2')).toBeNull()
    expect(await store.admit({ ...k.input, source: '127.0.0.2' })).toMatchObject({
      reason: 'unauthorized',
    })
    // The key of a provider the platform has no backend for — a row of history, say — opens
    // nothing: the store reads no key from it. (A request for another backend than the key's
    // needs two backends; the role holds that rule on its routes, server.test.ts.)
    await db.llmProvider.update({ where: { id: provider.id }, data: { slug: 'other-provider' } })
    try {
      expect(await store.lookup(k.row.keyHash, k.input.source)).toBeNull()
      expect(await store.admit(k.input)).toMatchObject({ reason: 'profile' })
    } finally {
      await db.llmProvider.update({
        where: { id: provider.id },
        data: { slug: sampleProviderSlug },
      })
    }
    expect(await store.lookup(k.row.keyHash, k.input.source)).not.toBeNull()
    await db.llmKey.update({ where: { id: k.row.id }, data: { reasoningEffort: 'high' } })
    expect(await store.admit(k.input)).toMatchObject({ reason: 'profile' })
    await db.llmKey.update({ where: { id: k.row.id }, data: { reasoningEffort: 'low' } })
    await db.llmModel.update({ where: { id: f.model.id }, data: { enabled: false } })
    expect(await store.admit(k.input)).toMatchObject({ reason: 'profile' })
    await db.llmModel.update({ where: { id: f.model.id }, data: { enabled: true } })
    await db.llmProvider.update({ where: { id: provider.id }, data: { enabled: false } })
    expect(await store.admit(k.input)).toMatchObject({ reason: 'provider_off' })
    await db.llmProvider.update({ where: { id: provider.id }, data: { enabled: true } })
    await db.llmKey.update({ where: { id: k.row.id }, data: { revokeRequestedAt: new Date() } })
    expect(await store.lookup(k.row.keyHash, k.input.source)).toBeNull()
    expect(await store.admit(k.input)).toMatchObject({ reason: 'unauthorized' })
    await db.llmKey.update({ where: { id: k.row.id }, data: { revokedAt: new Date() } })
    expect(await store.admit(k.input)).toMatchObject({ reason: 'unauthorized' })
    expect(await db.llmCall.count({ where: { keyId: k.row.id } })).toBe(0)
  })

  it.each([
    ['disabled', { enabled: false }, 'account'],
    ['banned', { status: 'banned' }, 'account'],
    ['retired', { status: 'retired', enabled: false }, 'account'],
    ['needs login', { health: 'needs_relogin' }, 'account'],
    ['suspended', { health: 'suspended' }, 'account'],
    ['unwritten credential', { credentialVersion: 0 }, 'account'],
    ['credential revoked', { credentialsRevokedAt: new Date() }, 'account'],
    ['cooling', { coolingUntil: new Date(Date.now() + 60_000) }, 'subscription_limit'],
    ['breaker', { breakerOpenUntil: new Date(Date.now() + 60_000) }, 'account'],
    [
      'exhausted window',
      { limitWindows: [{ name: 'week', usedPct: 100, resetsAt: null }] },
      'subscription_limit',
    ],
    [
      'window exhausted until a reset less than a minute ago',
      {
        limitWindows: [
          { name: 'week', usedPct: 100, resetsAt: new Date(Date.now() - 30_000).toISOString() },
        ],
      },
      'subscription_limit',
    ],
  ] as const)('rejects an account with %s without taking a slot', async (_name, update, reason) => {
    const f = await fixture()
    const k = await f.key()
    await db.subscriptionAccount.update({
      where: { id: f.account.id },
      data: update as Prisma.SubscriptionAccountUpdateInput,
    })
    expect(await store.admit(k.input)).toMatchObject({ kind: 'refused', reason })
    expect(await db.llmCall.count({ where: { keyId: k.row.id } })).toBe(0)
    const key = await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })
    expect(key.lastRefusal).toBe(reason)
    expect(key.lastRefusalAt).toBeInstanceOf(Date)
  })

  it.each([
    ['a window past its reset', 1, 1],
    ['an exhausted window more than a minute past its reset', 100, 2],
  ] as const)(
    'admits a running turn across %s: the window has rolled over, nothing confirms a limit',
    async (_name, usedPct, minutesAgo) => {
      const f = await fixture()
      const k = await f.key()
      await db.subscriptionAccount.update({
        where: { id: f.account.id },
        data: {
          limitWindows: [
            {
              name: '5h',
              usedPct,
              resetsAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
            },
            {
              name: 'week',
              usedPct: 50,
              resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        },
      })
      await admitted(k.input)
      expect((await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastRefusal).toBe(
        null,
      )
    },
  )

  it('holds a running turn with unknown windows as short-lived until a probe, never for good', async () => {
    const f = await fixture()
    const k = await f.key()
    for (const limitWindows of [[], [{ name: 'decade', usedPct: 1, resetsAt: null }]]) {
      const { limitsSeenAt } = await db.subscriptionAccount.update({
        where: { id: f.account.id },
        data: { limitWindows },
      })
      expect(limitsSeenAt).toBeInstanceOf(Date)
      expect(await store.admit(k.input)).toEqual({
        kind: 'refused',
        keyId: k.row.id,
        reason: 'transient',
        retryAfterMs: 30_000,
        probeAccount: true,
        // The snapshot whose windows are unknown: a probe older than it does not answer.
        limitsSeenAt,
      })
      expect(await db.llmCall.count({ where: { keyId: k.row.id } })).toBe(0)
      expect((await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastRefusal).toBe(
        'transient',
      )
    }
  })

  it('lets existing keys drain during normal retirement until the account is disabled', async () => {
    const f = await fixture()
    const k = await f.key()
    await db.subscriptionAccount.update({
      where: { id: f.account.id },
      data: { retireRequestedAt: new Date() },
    })
    expect(await store.lookup(k.row.keyHash, k.input.source)).not.toBeNull()
    await admitted(k.input)
    await db.subscriptionAccount.update({ where: { id: f.account.id }, data: { enabled: false } })
    expect(await store.admit(k.input)).toMatchObject({ reason: 'account' })
    expect(await db.llmCall.count({ where: { keyId: k.row.id } })).toBe(1)
  })

  it('fails closed when no historical price exists', async () => {
    const f = await fixture({ price: false })
    const k = await f.key()
    expect(await store.admit(k.input)).toMatchObject({ reason: 'profile' })
    expect(await db.llmCall.count({ where: { keyId: k.row.id } })).toBe(0)
  })

  it('rejects for good a close that can never be priced and keeps the call open', async () => {
    const f = await fixture()
    const k = await f.key()
    const call = await admitted(k.input)
    await db.llmModelPrice.delete({ where: { id: f.price!.id } })
    await expect(store.finish(call.id, actual())).rejects.toBeInstanceOf(GatewayRecordRejected)
    await expect(store.finish(call.id, { ...actual(), billable: false })).rejects.toBeInstanceOf(
      GatewayRecordRejected,
    )
    expect((await db.llmCall.findUniqueOrThrow({ where: { id: call.id } })).state).toBe('open')
    expect(await db.tokenUsage.count({ where: { gatewayCallId: call.id } })).toBe(0)
  })

  it.each(['key', 'provider'] as const)(
    'uses a fresh database clock after waiting on a %s lock',
    async (kind) => {
      const f = await fixture()
      const k = await f.key()
      let acquired!: () => void
      let release!: () => void
      const locked = new Promise<void>((resolve) => {
        acquired = resolve
      })
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      await db.llmKey.update({
        where: { id: k.row.id },
        data: { expiresAt: new Date(Date.now() + 150) },
      })
      const blocker = db.$transaction(async (tx) => {
        if (kind === 'key')
          await tx.$queryRaw`SELECT id FROM llm_keys WHERE id = ${k.row.id}::uuid FOR UPDATE`
        else
          await tx.$queryRaw`SELECT id FROM llm_providers WHERE id = ${provider.id}::uuid FOR UPDATE`
        acquired()
        await released
      })
      await locked
      const pending = store.admit(k.input)
      // Let the key expire while PostgreSQL, rather than a JavaScript timestamp, owns the wait.
      await new Promise((resolve) => setTimeout(resolve, 250))
      release()
      await blocker
      expect(await pending).toMatchObject({ reason: 'unauthorized' })
      expect(await db.llmCall.count({ where: { keyId: k.row.id } })).toBe(0)
    },
  )

  it('collects lost calls once, preserves platform billing and closes revoked usage', async () => {
    const f = await fixture()
    const k = await f.key()
    const call = await admitted(k.input)
    await db.llmCall.update({
      where: { id: call.id },
      data: { startedAt: new Date(Date.now() - 12 * 60_000) },
    })
    await db.llmKey.update({
      where: { id: k.row.id },
      data: { revokeRequestedAt: new Date(), revokedAt: new Date() },
    })
    const collected = await Promise.all([store.collectLost(), store.collectLost()])
    expect(collected.reduce((sum, n) => sum + n, 0)).toBe(1)
    const usage = await db.tokenUsage.findUniqueOrThrow({ where: { gatewayCallId: call.id } })
    // A lost call is estimated like its reserve: est_in at the full input rate plus R_out.
    expect(usage).toMatchObject({
      inputUncachedTokens: 1_000,
      outputTokens: 1_024,
      estimated: true,
      billable: false,
      estimateReason: 'lost',
    })
    expect(usage.costRub.toFixed(10)).toBe('0.2024000000')
    expect(usage.costRub.toFixed(10)).toBe(call.reservedRub)
    expect(
      (await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).usageClosedAt,
    ).toBeInstanceOf(Date)
    expect(await store.finish(call.id, actual())).toBe(false)
    expect(await store.collectLost()).toBe(0)
  })

  it('estimates a lost call from its est_in, never from image or encrypted body bytes', async () => {
    const f = await fixture({ budget: '100' })
    const k = await f.key()
    // Ten screenshots: 3 MiB of base64 in the body, 20,000 tokens in est_in.
    const call = await admitted({
      ...k.input,
      requestBytes: 3 * 1024 * 1024,
      estimatedInputTokens: 20_500,
    })
    expect(
      (await db.llmCall.findUniqueOrThrow({ where: { id: call.id } })).estimatedInputTokens,
    ).toBe(20_500)
    await expect(
      db.llmCall.update({ where: { id: call.id }, data: { estimatedInputTokens: -1 } }),
    ).rejects.toMatchObject({
      meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
    })
    // A call opened before est_in was recorded keeps the byte estimate it was reserved with.
    const legacy = await admitted(k.input)
    await db.llmCall.update({
      where: { id: legacy.id },
      data: { estimatedInputTokens: null },
    })
    await db.llmCall.updateMany({
      where: { id: { in: [call.id, legacy.id] } },
      data: { startedAt: new Date(Date.now() - 12 * 60_000) },
    })
    expect(await store.collectLost()).toBe(2)
    const usage = await db.tokenUsage.findUniqueOrThrow({ where: { gatewayCallId: call.id } })
    expect(usage).toMatchObject({ inputUncachedTokens: 20_500, outputTokens: 1_024 })
    expect(usage.costRub.toFixed(10)).toBe(call.reservedRub)
    expect(
      (await db.tokenUsage.findUniqueOrThrow({ where: { gatewayCallId: legacy.id } }))
        .inputUncachedTokens,
    ).toBe(200)
  })

  it('prices a lost call with the cache share of its reserve and never above that reserve', async () => {
    const f = await fixture({ budget: '100' })
    const k = await f.key()
    const first = await admitted({ ...k.input, estimatedInputTokens: 100_000 })
    expect(first.estimatedCacheReadTokens).toBe(0)
    await store.finish(first.id, {
      ...actual(),
      usage: { input: 100_000, cacheRead: 95_000, cacheWrite: 0, output: 50, reasoning: 0 },
    })
    // The share is capped at 0.9: 150k tokens of context, 135k of them reserved as cache reads.
    const call = await admitted({ ...k.input, estimatedInputTokens: 150_000 })
    expect(call).toMatchObject({ estimatedCacheReadTokens: 135_000, reservedRub: '2.9524000000' })
    // Reserved before est_in was recorded: its byte estimate is far above the reserve.
    const legacy = await admitted({ ...k.input, requestBytes: 300_000 })
    await db.llmCall.update({ where: { id: legacy.id }, data: { estimatedInputTokens: null } })
    // A call completed after the lost ones started says nothing about their reserves.
    const later = await admitted((await f.key()).input)
    await store.finish(later.id, {
      ...actual(),
      usage: { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 50, reasoning: 0 },
    })
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)
    await db.llmCall.update({
      where: { id: first.id },
      data: { startedAt: minutesAgo(15), finishedAt: minutesAgo(14) },
    })
    await db.llmCall.updateMany({
      where: { id: { in: [call.id, legacy.id] } },
      data: { startedAt: minutesAgo(12) },
    })
    expect(await store.collectLost()).toBe(2)
    const usage = await db.tokenUsage.findUniqueOrThrow({ where: { gatewayCallId: call.id } })
    expect(usage).toMatchObject({
      inputUncachedTokens: 15_000,
      cacheReadTokens: 135_000,
      outputTokens: 1_024,
      estimated: true,
      billable: false,
      estimateReason: 'lost',
    })
    expect(usage.costRub.toFixed(10)).toBe(call.reservedRub)
    const legacyUsage = await db.tokenUsage.findUniqueOrThrow({
      where: { gatewayCallId: legacy.id },
    })
    expect(legacyUsage.inputUncachedTokens + legacyUsage.cacheReadTokens).toBe(100_000)
    expect(legacyUsage.costRub.toFixed(10)).toBe(legacy.reservedRub)
  })

  it('closes revoked usage only after the last call and also handles keys with no calls', async () => {
    const f = await fixture()
    const k = await f.key()
    const first = await admitted(k.input)
    const second = await admitted(k.input)
    await db.llmKey.update({
      where: { id: k.row.id },
      data: { revokeRequestedAt: new Date(), revokedAt: new Date() },
    })
    await store.finish(first.id, actual())
    expect(
      (await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).usageClosedAt,
    ).toBeNull()
    await store.finish(second.id, actual())
    expect(
      (await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).usageClosedAt,
    ).toBeInstanceOf(Date)
    const empty = await f.key()
    await db.llmKey.update({
      where: { id: empty.row.id },
      data: { revokeRequestedAt: new Date(), revokedAt: new Date() },
    })
    await store.collectLost()
    expect(
      (await db.llmKey.findUniqueOrThrow({ where: { id: empty.row.id } })).usageClosedAt,
    ).toBeInstanceOf(Date)
  })

  it('persists normalized refusals without an unconfirmed account downgrade, and leaves the windows to the probe', async () => {
    const f = await fixture()
    const k = await f.key()
    const before = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } })
    const call = await admitted(k.input)
    await store.finish(call.id, { ...actual(), state: 'failed', signal: { kind: 'region' } })
    const account = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } })
    expect(account).toMatchObject({ health: 'ok', status: 'active', enabled: true })
    expect(account.lastUsedAt).toBeInstanceOf(Date)
    // A response names no window: what the last probe stored stands, dated as it was.
    expect(account.limitWindows).toEqual(before.limitWindows)
    expect(account.limitsSeenAt).toEqual(before.limitsSeenAt)
    expect(account.headroomPct).toEqual(before.headroomPct)
    expect((await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastRefusal).toBe(
      'egress',
    )
    await store.refuse(k.row.id, 'transient')
    expect((await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastRefusal).toBe(
      'transient',
    )
  })

  it('records a request the provider rejected as its own refusal and leaves the account alone', async () => {
    const f = await fixture()
    const k = await f.key()
    const before = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } })
    const call = await admitted(k.input)
    await store.finish(call.id, {
      ...actual(),
      state: 'failed',
      upstreamStatus: 400,
      signal: { kind: 'request_rejected', code: 'context_length_exceeded' },
    })
    // Not `profile`: the model profile is fine, this one request did not fit.
    expect(await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).toMatchObject({
      lastRefusal: 'request_rejected',
      lastRefusalAt: expect.any(Date),
    })
    expect((await db.llmCall.findUniqueOrThrow({ where: { id: call.id } })).signal).toBe(
      'request_rejected',
    )
    const after = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } })
    expect(after).toMatchObject({
      health: before.health,
      healthReason: before.healthReason,
      coolingUntil: null,
      limitWindows: before.limitWindows,
      limitsSeenAt: before.limitsSeenAt,
    })
    // The key itself stays usable: a shorter request of the same turn is admitted.
    await store.refuse(k.row.id, 'request_rejected')
    await admitted(k.input)
  })

  it('keeps a content refusal of a task through every later refusal and admits no more of it', async () => {
    const f = await fixture()
    const k = await f.key()
    const flagged = await admitted(k.input)
    const parallel = await admitted(k.input)
    const events = () =>
      db.taskEvent.findMany({ where: { taskId: f.task.id, type: 'llm.policy_flagged' } })
    await store.finish(flagged.id, {
      ...actual(),
      state: 'failed',
      signal: { kind: 'policy_flagged', code: 'cyber_policy' },
    })
    expect((await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastRefusal).toBe(
      'policy_flagged',
    )
    expect(await events()).toEqual([
      expect.objectContaining({
        payload: { attempt: 1, turn: k.row.turnNo },
        clientVisible: false,
      }),
    ])
    // Later refusals of the same key replace only the latest reason.
    await store.finish(parallel.id, {
      ...actual(),
      state: 'failed',
      signal: { kind: 'transient', retryAfterMs: 1_000 },
    })
    await store.refuse(k.row.id, 'transient')
    expect((await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastRefusal).toBe(
      'transient',
    )
    // The flagged task sends nothing more of that content to the provider.
    expect(await store.admit(k.input)).toMatchObject({ kind: 'refused', reason: 'policy_flagged' })
    expect(await db.llmCall.count({ where: { keyId: k.row.id, state: 'open' } })).toBe(0)
    expect(await events()).toHaveLength(1)
    const other = await fixture()
    const otherKey = await other.key()
    await store.refuse(otherKey.row.id, 'policy_flagged')
    expect(
      await db.taskEvent.count({ where: { taskId: other.task.id, type: 'llm.policy_flagged' } }),
    ).toBe(1)
    expect(await events()).toHaveLength(1)
  })

  it.each([false, true])(
    'keeps exhaustion closed with an unknown reset, whether the stored windows show it or not (%s)',
    async (shown) => {
      const f = await fixture()
      const k = await f.key()
      const call = await admitted(k.input)
      // What a probe stored while the call was open: a window already spent, or nothing new.
      if (shown)
        await db.subscriptionAccount.update({
          where: { id: f.account.id },
          data: {
            limitWindows: [{ name: 'week', usedPct: 100, resetsAt: null }],
            headroomPct: '0',
          },
        })
      await store.finish(call.id, {
        ...actual(),
        state: 'failed',
        signal: { kind: 'window_exhausted', until: null },
      })
      const account = await db.subscriptionAccount.findUniqueOrThrow({
        where: { id: f.account.id },
      })
      expect(account.health).toBe('ok')
      expect(account.status).toBe('active')
      // A stored spent window stays; spare capacity nobody can vouch for any more is dropped.
      expect(account.headroomPct?.toFixed(2) ?? null).toBe(shown ? '0.00' : null)
      expect(account.limitsSeenAt).toBeInstanceOf(Date)
      expect(await store.admit(k.input)).toMatchObject(
        shown ? { reason: 'subscription_limit' } : { reason: 'transient', probeAccount: true },
      )
    },
  )

  it('does not let another open response revive an unknown exhausted window', async () => {
    const f = await fixture()
    const k = await f.key()
    const exhausted = await admitted(k.input)
    const late = await admitted(k.input)
    await store.finish(exhausted.id, {
      ...actual(),
      state: 'failed',
      signal: { kind: 'window_exhausted', until: null },
    })
    // A response that completes afterwards says nothing of the windows: only a probe does.
    await store.finish(late.id, actual())
    expect(
      (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } }))
        .limitWindows,
    ).toEqual([])
    expect(await store.admit(k.input)).toMatchObject({ reason: 'transient', probeAccount: true })
  })

  it('admits a backend without windows on the account pauses alone', async () => {
    const f = await fixture()
    const k = await f.key()
    // The sample backend, as one without windows would declare itself (LlmBackend.capacity).
    const windowless = { ...k.input, capacity: 'none' as const }
    for (const limitWindows of [
      [],
      [{ name: 'week', usedPct: 100, resetsAt: null }],
      [{ name: '5h', usedPct: 100, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
    ]) {
      await db.subscriptionAccount.update({ where: { id: f.account.id }, data: { limitWindows } })
      await store.finish((await admitted(windowless)).id, actual())
    }
    // The same snapshot holds a turn of a backend that reports windows, as it always did.
    await db.subscriptionAccount.update({ where: { id: f.account.id }, data: { limitWindows: [] } })
    expect(await store.admit(k.input)).toMatchObject({ reason: 'transient', probeAccount: true })
    expect(await store.admit({ ...k.input, capacity: 'windows' })).toMatchObject({
      reason: 'transient',
      probeAccount: true,
    })
    // A durable pause of the account holds either way, and so does the usage breaker.
    await db.subscriptionAccount.update({
      where: { id: f.account.id },
      data: { coolingUntil: new Date(Date.now() + 5 * 60_000) },
    })
    expect(await store.admit(windowless)).toMatchObject({
      kind: 'refused',
      reason: 'subscription_limit',
    })
    expect((await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).lastRefusal).toBe(
      'subscription_limit',
    )
    await db.subscriptionAccount.update({
      where: { id: f.account.id },
      data: { coolingUntil: null, breakerOpenUntil: new Date(Date.now() + 60_000) },
    })
    expect(await store.admit(windowless)).toMatchObject({ kind: 'refused', reason: 'account' })
  })

  it('records an empty balance as the call signal, a final refusal of no capacity', async () => {
    const f = await fixture()
    const k = await f.key()
    const call = await admitted(k.input)
    await store.finish(call.id, {
      ...actual(),
      state: 'failed',
      upstreamStatus: 429,
      signal: { kind: 'balance_exhausted' },
    })
    expect(await db.llmCall.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({
      signal: 'balance_exhausted',
      upstreamStatus: 429,
    })
    expect(await db.llmKey.findUniqueOrThrow({ where: { id: k.row.id } })).toMatchObject({
      lastRefusal: 'subscription_limit',
    })
    // The store itself pauses nothing for it and drops no windows: that is the pool's to do.
    expect(
      await db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } }),
    ).toMatchObject({ coolingUntil: null, limitWindows: f.account.limitWindows })
  })

  it('counts only completed missing-usage terminals and resets the streak on real completed usage', async () => {
    const f = await fixture({ budget: '100' })
    const k = await f.key()
    const finish = async (outcome: GatewayFinish) => {
      const call = await admitted(k.input)
      await store.finish(call.id, outcome)
      return db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } })
    }
    const missing = { ...actual(), estimated: true, estimateReason: 'no_usage' as const }
    expect((await finish(missing)).usageMissingStreak).toBe(1)
    expect((await finish({ ...actual(), state: 'failed' })).usageMissingStreak).toBe(1)
    expect(
      (
        await finish({
          ...missing,
          state: 'aborted',
          billable: false,
          estimateReason: 'aborted_platform',
        })
      ).usageMissingStreak,
    ).toBe(1)
    expect((await finish({ ...missing, estimateReason: 'invalid_usage' })).usageMissingStreak).toBe(
      2,
    )
    expect((await finish(actual())).usageMissingStreak).toBe(0)
    await finish(missing)
    await finish(missing)
    const final = await finish(missing)
    expect(final.usageMissingStreak).toBe(3)
    expect(final.breakerOpenUntil!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000)
    expect(await store.admit(k.input)).toMatchObject({ reason: 'account' })
  })

  it('admits one generation trial across keys after a usage breaker expires', async () => {
    const f = await fixture({ budget: '100' })
    const keys = await Promise.all(Array.from({ length: 4 }, () => f.key()))
    await db.subscriptionAccount.update({
      where: { id: f.account.id },
      data: { usageMissingStreak: 3, breakerOpenUntil: new Date(Date.now() - 1000) },
    })
    const admissions = await Promise.all(keys.map((k) => store.admit(k.input)))
    const trial = admissions.find((value) => value.kind === 'admitted')
    expect(admissions.filter((value) => value.kind === 'admitted')).toHaveLength(1)
    expect(admissions.filter((value) => value.kind === 'refused')).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({ reason: 'account' })),
    )
    if (trial?.kind !== 'admitted') throw new Error('Expected the one usage trial')
    await store.finish(trial.call.id, actual())
    expect(
      await db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } }),
    ).toMatchObject({
      usageMissingStreak: 0,
      breakerOpenUntil: null,
    })
    expect(await store.admit(keys[0]!.input)).toMatchObject({ kind: 'admitted' })
  })

  it('keeps a failed half-open trial blocked and closes missing usage idempotently', async () => {
    const f = await fixture({ budget: '100' })
    const k = await f.key()
    await db.subscriptionAccount.update({
      where: { id: f.account.id },
      data: { usageMissingStreak: 3, breakerOpenUntil: new Date(Date.now() - 1000) },
    })
    const trial = await admitted(k.input)
    const outcome = { ...actual(), estimated: true, estimateReason: 'no_usage' as const }
    expect(await store.finish(trial.id, outcome)).toBe(true)
    expect(await store.finish(trial.id, outcome)).toBe(false)
    const account = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } })
    expect(account.usageMissingStreak).toBe(3)
    expect(account.breakerOpenUntil!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000)
    expect(await store.admit(k.input)).toMatchObject({ reason: 'account' })
  })

  it('cools authoritative exhaustion until reset plus one minute without shortening a later pause', async () => {
    const f = await fixture()
    const k = await f.key()
    const call = await admitted(k.input)
    const overlapping = await admitted(k.input)
    const reset = new Date(Date.now() + 60_000)
    await store.finish(call.id, {
      ...actual(),
      state: 'failed',
      signal: { kind: 'window_exhausted', until: reset },
    })
    expect(
      (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } }))
        .coolingUntil,
    ).toEqual(new Date(reset.getTime() + 60_000))
    expect(await store.admit(k.input)).toMatchObject({ reason: 'subscription_limit' })
    const longer = new Date(Date.now() + 600_000)
    await db.subscriptionAccount.update({
      where: { id: f.account.id },
      data: { coolingUntil: longer },
    })
    await store.finish(overlapping.id, {
      ...actual(),
      state: 'failed',
      signal: { kind: 'window_exhausted', until: reset },
    })
    expect(
      (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } }))
        .coolingUntil,
    ).toEqual(longer)
  })

  it('never writes a pause from a reset further ahead than a window is long', async () => {
    const f = await fixture()
    const k = await f.key()
    const day = 86_400_000
    // Seconds read as milliseconds: the year 58692 fits a timestamptz and would never end.
    const corrupted = new Date(1_790_000_000_000_000)
    for (const until of [corrupted, new Date(Date.now() + 8 * day + 60_000)]) {
      const call = await admitted(k.input)
      await store.finish(call.id, {
        ...actual(),
        state: 'failed',
        signal: { kind: 'window_exhausted', until },
      })
      const account = await db.subscriptionAccount.findUniqueOrThrow({
        where: { id: f.account.id },
      })
      // Exhaustion with no usable reset: no pause from it, capacity unknown until a probe.
      expect(account).toMatchObject({ coolingUntil: null, limitWindows: [], headroomPct: null })
      expect(await store.admit(k.input)).toMatchObject({ reason: 'transient', probeAccount: true })
      await db.subscriptionAccount.update({
        where: { id: f.account.id },
        data: {
          limitWindows: [{ name: 'week', usedPct: 1, resetsAt: null }],
          limitsSeenAt: new Date(Date.now() - 60_000),
        },
      })
    }
  })
})
