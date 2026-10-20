import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { createPrismaClient, type Prisma, type PrismaClient } from '@repo/db'
import type { LlmBackendId, SecretStore, TurnCredentialGrant } from '@repo/domain'
import { llmBackends, zaiApiBackend } from '@repo/llm-backends'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { SessionSubscriptionLock } from '../gateway/session-lock.ts'
import {
  PostgresGatewayStore,
  CredentialSweeper,
  backendCapacities,
  GatewayTurnCredentials,
} from '@repo/turn-keys'
import {
  sampleBackendCapacity,
  sampleBackendId,
  sampleDriverId,
  sampleRoutePath,
} from '../testing/ids.ts'
import { retirementRefusals, SubscriptionRetirement } from './retire.ts'

// Only verify:db's owned disposable database; no repository env-file is loaded here.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
// As core and the operator's command compose it: what each adapter of the registry declares.
const capacityOf = backendCapacities(llmBackends)

function memoryVault() {
  const entries = new Map<
    string,
    { data: Record<string, string>; custom: Record<string, string>; deleted: boolean }
  >()
  const kvRead = vi.fn(async (path: string) => {
    const entry = entries.get(path)
    return entry && !entry.deleted ? { version: 1, data: { ...entry.data } } : null
  })
  const kvMetadata = vi.fn(async (path: string) => {
    const entry = entries.get(path)
    return entry
      ? {
          currentVersion: 1,
          custom: entry.custom,
          createdTime: new Date(),
          deleted: entry.deleted,
          destroyed: false,
        }
      : null
  })
  const kvCreateOnce = vi.fn(
    async (path: string, data: Record<string, string>, custom: Record<string, string>) => {
      if (entries.has(path)) return 'exists' as const
      entries.set(path, { data, custom, deleted: false })
      return 'created' as const
    },
  )
  const kvDelete = vi.fn(async (path: string) => {
    const entry = entries.get(path)
    if (entry) entry.deleted = true
  })
  const kvDestroyAll = vi.fn(async (path: string) => {
    entries.delete(path)
  })
  const port = {
    kvRead,
    kvMetadata,
    kvCreateOnce,
    kvDelete,
    kvDestroyAll,
    kvList: vi.fn(async () => []),
  } as unknown as SecretStore
  return { entries, kvRead, kvCreateOnce, kvDelete, kvDestroyAll, port }
}

describe.skipIf(!enabled)('operator retirement with disposable PostgreSQL', () => {
  let db: PrismaClient
  const cleanups: (() => Promise<void>)[] = []
  const fixtures: {
    workspaceId: string
    modelId: string
    accountId: string
    credentialId: string
  }[] = []

  beforeAll(async () => {
    // A key is issued only to an enabled driver: the suite stands on the driver of the sample
    // backend as the migrations and the seeds leave it, switched on.
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    for (const f of fixtures.splice(0)) {
      const tasks = { task: { workspaceId: f.workspaceId } }
      await db.tokenUsage.deleteMany({ where: tasks })
      await db.llmCall.deleteMany({ where: { subscriptionAccountId: f.accountId } })
      await db.llmKey.deleteMany({ where: { subscriptionAccountId: f.accountId } })
      await db.taskAccountBinding.deleteMany({ where: tasks })
      await db.taskEvent.deleteMany({ where: tasks })
      await db.siteLease.deleteMany({ where: { site: { workspaceId: f.workspaceId } } })
      await db.task.deleteMany({ where: { workspaceId: f.workspaceId } })
      await db.site.deleteMany({ where: { workspaceId: f.workspaceId } })
      await db.workspace.delete({ where: { id: f.workspaceId } })
      await db.llmModelPrice.deleteMany({ where: { modelId: f.modelId } })
      await db.llmModel.delete({ where: { id: f.modelId } })
      await db.subscriptionAccount.delete({ where: { id: f.accountId } })
      await db.credentialRef.delete({ where: { id: f.credentialId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /**
   * An account whose key the operator revokes in the console of the provider: of the sample
   * backend, or of the one named. Its provider row is switched on for the test and back after.
   */
  async function fixture(backend: LlmBackendId = sampleBackendId) {
    const provider = await db.llmProvider.findUniqueOrThrow({ where: { slug: backend } })
    await db.llmProvider.update({ where: { id: provider.id }, data: { enabled: true } })
    cleanups.push(async () => {
      await db.llmProvider.update({
        where: { id: provider.id },
        data: { enabled: provider.enabled },
      })
    })
    const driverId = sampleDriverId
    const accountId = randomUUID()
    const credential = await db.credentialRef.create({
      data: { kind: 'subscription', vaultPath: `subs/${backend}/${accountId}` },
    })
    const account = await db.subscriptionAccount.create({
      data: {
        id: accountId,
        providerId: provider.id,
        driverId,
        credentialRefId: credential.id,
        label: `retirement-${accountId}`,
        plan: 'synthetic',
        enabled: true,
        credentialVersion: 1,
        maxConcurrentTurns: 4,
        maxConcurrentRequests: 4,
        // An account of a backend without windows keeps none: an import writes none.
        limitWindows:
          capacityOf(backend) === 'windows'
            ? [
                {
                  name: '5h',
                  usedPct: 10,
                  resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
                },
              ]
            : [],
      },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic subscription retirement', dataClass: 'synthetic' },
    })
    const model = await db.llmModel.create({
      data: {
        providerId: provider.id,
        slug: `retirement-${accountId}`,
        name: 'Synthetic',
        providerModelId: 'synthetic',
        modelClass: 'standard',
        reserveOutputTokens: 1_024,
        enabled: true,
      },
    })
    fixtures.push({
      workspaceId: workspace.id,
      modelId: model.id,
      accountId,
      credentialId: credential.id,
    })
    await db.llmModelPrice.create({
      data: {
        modelId: model.id,
        effectiveFrom: new Date(Date.now() - 3_600_000),
        inputPer1m: '2',
        outputPer1m: '10',
        vatRate: '0.22',
        sourceUrl: 'https://synthetic.invalid/rates',
      },
    })
    const vault = memoryVault()
    const credentials = new GatewayTurnCredentials({ prisma: db, secrets: vault.port, capacityOf })
    const locks = new SessionSubscriptionLock(databaseUrl ?? '')
    cleanups.push(() => locks.close())
    const options = {
      prisma: db,
      secrets: { kvDestroyAll: vault.kvDestroyAll },
      credentials,
      locks,
      backends: llmBackends,
    }
    const service = new SubscriptionRetirement(options)
    const sweeper = new CredentialSweeper({ prisma: db, secrets: vault.port, credentials })
    cleanups.push(() => sweeper.close())
    const store = new PostgresGatewayStore(db)
    async function task() {
      const site = await db.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Synthetic',
          url: `https://${randomUUID()}.invalid`,
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
      await db.siteLease.create({
        data: {
          siteId: site.id,
          holderTaskId: task.id,
          epoch: 1,
          operation: 'turn',
          expiresAt: new Date(Date.now() + 1_200_000),
        },
      })
      return { task, ref: { taskId: task.id, sessionId: randomUUID(), turn: 1, epoch: 1 } }
    }
    const initial = await task()
    const grant: TurnCredentialGrant = {
      driverId,
      backend,
      modelSlug: model.slug,
      modelClass: 'standard',
      reasoningEffort: null,
      ttlMs: 600_000,
      deadlineAt: new Date(Date.now() + 1_200_000),
      budgetRub: '100.00',
      boundSource: null,
    }
    async function key(overrides: Partial<Prisma.LlmKeyUncheckedCreateInput> = {}) {
      return db.llmKey.create({
        data: {
          keyHash: hash(randomUUID()),
          taskId: initial.task.id,
          taskAttempt: 1,
          sessionId: initial.ref.sessionId,
          turnNo: 1,
          firstEpoch: 1,
          driverId,
          modelId: model.id,
          subscriptionAccountId: accountId,
          budgetRub: '100',
          expiresAt: new Date(Date.now() + 600_000),
          validUntil: new Date(Date.now() + 900_000),
          ...overrides,
        },
      })
    }
    const current = () => db.subscriptionAccount.findUniqueOrThrow({ where: { id: accountId } })
    const ready = () =>
      db.subscriptionAccount.update({
        where: { id: accountId },
        data: { retireRequestedAt: new Date(), enabled: false, credentialsRevokedAt: new Date() },
      })
    return {
      ...initial,
      account,
      accountId,
      model,
      vault,
      credentials,
      locks,
      options,
      service,
      sweeper,
      store,
      grant,
      taskFixture: task,
      key,
      current,
      ready,
    }
  }

  it('keeps the next gateway request and recovery valid while blocking a new turn on the retired binding', async () => {
    const f = await fixture()
    const values = await f.credentials.issue(f.ref, f.grant)
    expect(await f.service.request({ accountId: f.accountId })).toMatchObject({ stage: 'draining' })
    expect((await f.current()).enabled).toBe(true)
    expect(await f.credentials.recover(f.ref)).toEqual(values)
    await expect(f.credentials.issue({ ...f.ref, turn: 2 }, f.grant)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_WAIT',
    })
    const profile = await f.store.lookup(hash(values.llmApiKey), '127.0.0.1')
    expect(profile).not.toBeNull()
    const admission = await f.store.admit({
      keyHash: hash(values.llmApiKey),
      source: '127.0.0.1',
      backendId: sampleBackendId,
      capacity: sampleBackendCapacity,
      route: { method: 'POST', path: sampleRoutePath },
      profile: profile!,
      requestBytes: 100,
      estimatedInputTokens: 10,
    })
    expect(admission.kind).toBe('admitted')
    expect(
      await db.llmCall.count({ where: { subscriptionAccountId: f.accountId, state: 'open' } }),
    ).toBe(1)
  })

  it('retires an account of the pay-per-token API on the same path: a key and a call drain first', async () => {
    const f = await fixture(zaiApiBackend.id)
    const values = await f.credentials.issue(f.ref, f.grant)
    const profile = await f.store.lookup(hash(values.llmApiKey), '127.0.0.1')
    expect(profile).not.toBeNull()
    const admission = await f.store.admit({
      keyHash: hash(values.llmApiKey),
      source: '127.0.0.1',
      backendId: zaiApiBackend.id,
      capacity: zaiApiBackend.capacity,
      route: zaiApiBackend.routes[0]!,
      profile: profile!,
      requestBytes: 100,
      estimatedInputTokens: 10,
    })
    expect(admission.kind).toBe('admitted')
    expect(await f.service.request({ accountId: f.accountId })).toMatchObject({ stage: 'draining' })
    await expect(f.credentials.issue({ ...f.ref, turn: 2 }, f.grant)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_WAIT',
    })
    await f.credentials.revoke(f.ref)
    await f.sweeper.tick()
    // The call of the key is still open: the account stays in the pool for it.
    expect((await f.current()).enabled).toBe(true)
    await db.llmCall.updateMany({
      where: { subscriptionAccountId: f.accountId, state: 'open' },
      data: { state: 'failed', finishedAt: new Date() },
    })
    await f.sweeper.tick()
    expect(await f.current()).toMatchObject({ enabled: false, credentialsRevokedAt: null })
    expect(await f.service.finalize({ accountId: f.accountId })).toMatchObject({
      stage: 'console_revocation_required',
    })
    expect(
      await f.service.finalize({ accountId: f.accountId, consoleRevoked: true }),
    ).toMatchObject({ stage: 'retired' })
    expect(f.vault.kvDestroyAll).toHaveBeenLastCalledWith(`subs/zai-api/${f.accountId}`)
  })

  it('rejects an abandoned Vault CAS between issuance phases after the account pool fence commits', async () => {
    const f = await fixture()
    let created!: () => void, release!: () => void
    const written = new Promise<void>((resolve) => {
      created = resolve
    })
    const resume = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = f.vault.kvCreateOnce.getMockImplementation()!
    f.vault.kvCreateOnce.mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      created()
      await resume
      return result
    })
    const issued = f.credentials.issue(f.ref, f.grant)
    const outcome = issued.catch((error: unknown) => error)
    try {
      await written
      await f.service.request({ accountId: f.accountId, compromised: true })
    } finally {
      release()
    }
    expect(await outcome).toMatchObject({ code: 'SUBSCRIPTION_WAIT' })
    expect(await db.llmKey.count({ where: { subscriptionAccountId: f.accountId } })).toBe(0)
    expect((await f.current()).enabled).toBe(false)
  })

  it('durably closes every compromised key before a failed Vault revoke and resumes without the emergency flag', async () => {
    const f = await fixture()
    const first = await f.credentials.issue(f.ref, f.grant)
    const another = await f.taskFixture()
    const second = await f.credentials.issue(another.ref, f.grant)
    f.vault.kvDelete.mockRejectedValueOnce(new Error('synthetic outage private response'))
    expect(await f.service.request({ accountId: f.accountId, compromised: true })).toMatchObject({
      stage: 'turn_revocation_pending',
    })
    const rows = await db.llmKey.findMany({ where: { subscriptionAccountId: f.accountId } })
    expect(rows.every((row) => row.revokeRequestedAt !== null)).toBe(true)
    expect(rows.filter((row) => row.revokedAt !== null)).toHaveLength(1)
    expect(await f.store.lookup(hash(first.llmApiKey), '127.0.0.1')).toBeNull()
    expect(await f.store.lookup(hash(second.llmApiKey), '127.0.0.1')).toBeNull()
    expect(
      await new SubscriptionRetirement(f.options).request({ accountId: f.accountId }),
    ).toMatchObject({ stage: 'console_revocation_required' })
    expect(
      (await db.llmKey.findMany({ where: { subscriptionAccountId: f.accountId } })).every(
        (row) => row.revokedAt !== null,
      ),
    ).toBe(true)
  })

  it('preserves the gateway key-before-account lock order during a compromised request', async () => {
    const f = await fixture()
    const key = await f.key()
    let locked!: () => void, continueGateway!: () => void
    const keyLocked = new Promise<void>((resolve) => {
      locked = resolve
    })
    const acquireAccount = new Promise<void>((resolve) => {
      continueGateway = resolve
    })
    const gateway = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM llm_keys WHERE id = ${key.id}::uuid FOR UPDATE`
      locked()
      await acquireAccount
      // A retiring process must wait on our key without already holding our account.
      await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${f.accountId}::uuid FOR UPDATE NOWAIT`
    })
    const gatewayOutcome = gateway.catch((error: unknown) => error)
    await keyLocked
    const retirement = f.service.request({ accountId: f.accountId, compromised: true })
    const retirementOutcome = retirement.catch((error: unknown) => error)
    let waited = false
    try {
      const deadline = Date.now() + 700
      while (Date.now() < deadline) {
        const rows = await db.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND wait_event_type = 'Lock' AND query LIKE '%UPDATE llm_keys%') AS waiting`
        if (rows[0]?.waiting) {
          waited = true
          break
        }
        await sleep(10)
      }
    } finally {
      continueGateway()
    }
    expect(waited).toBe(true)
    expect(await gatewayOutcome).toBeUndefined()
    expect(await retirementOutcome).toMatchObject({ stage: 'console_revocation_required' })
  })

  it('finishes ordinary draining after a core restart only when both keys and open calls have drained', async () => {
    const f = await fixture()
    await f.credentials.issue(f.ref, f.grant)
    const key = await db.llmKey.findFirstOrThrow({ where: { subscriptionAccountId: f.accountId } })
    const call = await db.llmCall.create({
      data: {
        keyId: key.id,
        subscriptionAccountId: f.accountId,
        modelId: f.model.id,
        route: '/synthetic',
        reservedRub: '1',
        requestBytes: 100,
      },
    })
    await f.service.request({ accountId: f.accountId })
    await f.credentials.revoke(f.ref)
    await f.sweeper.tick()
    expect((await f.current()).enabled).toBe(true)
    await db.llmCall.update({
      where: { id: call.id },
      data: { state: 'failed', finishedAt: new Date() },
    })
    const restarted = new CredentialSweeper({
      prisma: db,
      secrets: f.vault.port,
      credentials: f.credentials,
    })
    try {
      await restarted.tick()
    } finally {
      await restarted.close()
    }
    expect(await f.current()).toMatchObject({
      enabled: false,
      status: 'active',
      credentialsRevokedAt: null,
    })
    expect(await f.service.finalize({ accountId: f.accountId })).toMatchObject({
      stage: 'console_revocation_required',
    })
  })

  it('persists console confirmation through a Vault outage and idempotently finishes on the next invocation', async () => {
    const f = await fixture()
    await f.service.request({ accountId: f.accountId, compromised: true })
    f.vault.kvDestroyAll.mockRejectedValueOnce(new Error('synthetic admin Vault outage'))
    await expect(
      f.service.finalize({ accountId: f.accountId, consoleRevoked: true }),
    ).rejects.toMatchObject({ code: 'LLM_GATEWAY_UNAVAILABLE' })
    expect(await f.current()).toMatchObject({
      status: 'active',
      enabled: false,
      credentialsRevokedAt: expect.any(Date),
    })
    const acknowledgedAt = (await f.current()).credentialsRevokedAt
    expect(
      await new SubscriptionRetirement(f.options).finalize({ accountId: f.accountId }),
    ).toMatchObject({ stage: 'retired' })
    expect((await f.current()).credentialsRevokedAt).toEqual(acknowledgedAt)
    expect(await f.service.finalize({ accountId: f.accountId })).toMatchObject({ stage: 'retired' })
    expect(f.vault.kvDestroyAll).toHaveBeenCalledTimes(2)
    expect(f.vault.kvRead).not.toHaveBeenCalled()
  })

  it('keeps finalization waiting for emergency key cleanup and open provider calls', async () => {
    const f = await fixture()
    await f.ready()
    const key = await f.key({ revokeRequestedAt: new Date() })
    expect(await f.service.finalize({ accountId: f.accountId })).toMatchObject({
      stage: 'turn_revocation_pending',
    })
    await db.llmKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } })
    const call = await db.llmCall.create({
      data: {
        keyId: key.id,
        subscriptionAccountId: f.accountId,
        modelId: f.model.id,
        route: '/synthetic',
        reservedRub: '1',
        requestBytes: 100,
      },
    })
    expect(await f.service.finalize({ accountId: f.accountId })).toMatchObject({
      stage: 'draining',
    })
    expect(f.vault.kvDestroyAll).not.toHaveBeenCalled()
    await db.llmCall.update({
      where: { id: call.id },
      data: { state: 'failed', finishedAt: new Date() },
    })
    expect(await f.service.finalize({ accountId: f.accountId })).toMatchObject({ stage: 'retired' })
  })

  it('uses the same session lock as a relogin to exclude destruction while another writer operates', async () => {
    const f = await fixture()
    await f.ready()
    const otherLocks = new SessionSubscriptionLock(databaseUrl ?? '')
    const lease = await otherLocks.tryAcquire(f.accountId)
    expect(lease).not.toBeNull()
    try {
      await expect(f.service.finalize({ accountId: f.accountId })).rejects.toMatchObject({
        code: 'CONFLICT',
      })
      expect(f.vault.kvDestroyAll).not.toHaveBeenCalled()
      expect((await f.current()).status).toBe('active')
    } finally {
      await lease?.release()
      await otherLocks.close()
    }
    expect(await f.service.finalize({ accountId: f.accountId })).toMatchObject({ stage: 'retired' })
  })

  it('never destroys a foreign Vault path even if the database reference was changed', async () => {
    const f = await fixture()
    await f.ready()
    await db.credentialRef.update({
      where: { id: f.account.credentialRefId },
      data: { vaultPath: `subs/${sampleBackendId}/${randomUUID()}` },
    })
    await expect(f.service.finalize({ accountId: f.accountId })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(f.vault.kvDestroyAll).not.toHaveBeenCalled()
    expect((await f.current()).status).toBe('active')
  })

  it('does not finalize a disabled account without an explicit retirement request', async () => {
    const f = await fixture()
    await db.subscriptionAccount.update({
      where: { id: f.accountId },
      data: { enabled: false, credentialsRevokedAt: new Date() },
    })
    await expect(f.service.finalize({ accountId: f.accountId })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(f.vault.kvDestroyAll).not.toHaveBeenCalled()
  })

  it('cancels a mistaken request until the revocation of the key is acknowledged, never afterwards', async () => {
    const f = await fixture()
    expect(await f.service.request({ accountId: f.accountId })).toMatchObject({ stage: 'draining' })
    expect(await f.service.cancel({ accountId: f.accountId })).toMatchObject({ stage: 'cancelled' })
    expect(await f.current()).toMatchObject({ retireRequestedAt: null, enabled: true })
    // The account serves new turns again.
    await f.credentials.issue(f.ref, f.grant)
    expect(await f.service.cancel({ accountId: f.accountId })).toMatchObject({ stage: 'cancelled' })
    await f.ready()
    await expect(f.service.cancel({ accountId: f.accountId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: retirementRefusals.revoked,
    })
    expect((await f.current()).retireRequestedAt).not.toBeNull()
  })

  it('refuses a cancellation while another writer holds the session lock of the account', async () => {
    const f = await fixture()
    await f.service.request({ accountId: f.accountId })
    const lease = await f.locks.tryAcquire(f.accountId)
    try {
      await expect(f.service.cancel({ accountId: f.accountId })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: retirementRefusals.busy,
      })
    } finally {
      await lease!.release()
    }
    expect((await f.current()).retireRequestedAt).not.toBeNull()
  })

  it('refuses a request whose label does not name the account, before changing anything', async () => {
    const f = await fixture()
    await expect(
      f.service.request({ accountId: f.accountId, compromised: true, label: 'another-account' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: retirementRefusals.labelMismatch })
    expect(await f.current()).toMatchObject({ retireRequestedAt: null, enabled: true })
    await expect(
      f.service.finalize({ accountId: f.accountId, label: 'another-account' }),
    ).rejects.toMatchObject({ message: retirementRefusals.labelMismatch })
    expect(
      await f.service.request({ accountId: f.accountId, label: f.account.label }),
    ).toMatchObject({ stage: 'draining' })
  })
})
