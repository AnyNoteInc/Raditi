import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import type { LlmBackend, LlmBackendId, SecretStore } from '@repo/domain'
import { zaiCodingBackend } from '@repo/llm-backends'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { SessionSubscriptionLock } from '../llm-gateway/session-lock.ts'
import { SubscriptionLogin } from './login.ts'
import { SubscriptionRetirement } from './retire.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
/**
 * An adapter whose credential names its account, its plan and when it ends: what a plan key
 * has not. What the platform does with these facts — one row an account of the provider, the
 * same account at a relogin, the plan of the credential — is shown on it.
 */
const identifiedSchema = z.strictObject({
  v: z.literal('1'),
  kind: z.literal('synthetic_account'),
  secret: z.string().min(1),
  account: z.string().min(1),
  plan: z.string().min(1),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
})
const identifiedBackend: LlmBackend = {
  ...zaiCodingBackend,
  credentialSchema: identifiedSchema,
  credentialMetadata(value) {
    const parsed = identifiedSchema.parse(value)
    return {
      externalAccountId: parsed.account,
      plan: parsed.plan,
      accessIssuedAt: new Date(parsed.issuedAt),
      accessExpiresAt: new Date(parsed.expiresAt),
    }
  },
}
const identifiedSecret = 'synthetic-secret-not-real'

function credential(accountId: string, plan = 'plus') {
  const issued = Date.now() - 60_000
  return {
    v: '1',
    kind: 'synthetic_account',
    secret: identifiedSecret,
    account: accountId,
    plan,
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + 86_400_000).toISOString(),
  }
}

/** A plan key: every import and relogin brings a new one, and it names no account or expiry. */
const planKey = () => ({
  v: '1',
  kind: 'zai_api_key',
  apiKey: `synthetic-plan-key-${randomUUID()}`,
})

describe.skipIf(!enabled)('subscription import and relogin on disposable PostgreSQL', () => {
  let db: PrismaClient
  const cleanup: (() => Promise<void>)[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action()
  })
  afterAll(async () => db?.$disconnect())

  /**
   * An account of a key-based backend by default. The other adapter (`fixture(identifiedBackend,
   * credential)`) brings what a key has not: an external identity, an expiry, a plan of its own.
   */
  async function fixture(
    original: LlmBackend = zaiCodingBackend,
    issue: (externalId: string, plan?: string) => Record<string, unknown> = planKey,
  ) {
    const suffix = randomUUID().replaceAll('-', '')
    const backendId = `synthetic-login-${suffix}` as LlmBackendId
    const backend = { ...original, id: backendId }
    const provider = await db.llmProvider.create({
      data: { slug: backendId, name: 'Synthetic import verification', kind: 'subscription' },
    })
    const driver = await db.agentDriver.create({
      data: {
        id: `login-${suffix.slice(0, 16)}`,
        image: 'synthetic.invalid/login',
        capabilities: {},
      },
    })
    cleanup.push(async () => {
      const accounts = await db.subscriptionAccount.findMany({ where: { providerId: provider.id } })
      await db.subscriptionAccount.deleteMany({ where: { providerId: provider.id } })
      await db.credentialRef.deleteMany({
        where: { id: { in: accounts.map((account) => account.credentialRefId) } },
      })
      await db.agentDriver.delete({ where: { id: driver.id } })
      await db.llmProvider.delete({ where: { id: provider.id } })
    })
    const pool = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 3_000 })
    const locks = new SessionSubscriptionLock(pool)
    cleanup.push(async () => {
      await locks.close()
      await pool.end()
    })
    const values = new Map<string, { version: number; data: Record<string, string> }>()
    const writer = {
      kvMetadata: vi.fn<SecretStore['kvMetadata']>(async (path) => {
        const value = values.get(path)
        return value
          ? {
              currentVersion: value.version,
              deleted: false,
              destroyed: false,
              createdTime: new Date(),
              custom: {},
            }
          : null
      }),
      kvWrite: vi.fn<SecretStore['kvWrite']>(async (path, data, options) => {
        const current = values.get(path)?.version ?? 0
        if (options?.cas !== current) throw new Error('Synthetic CAS mismatch')
        const id = path.split('/').at(-1)!
        const row = await db.subscriptionAccount.findUniqueOrThrow({ where: { id } })
        expect(row.health).toBe('needs_relogin')
        const value = { version: current + 1, data }
        values.set(path, value)
        return { version: value.version }
      }),
    }
    const options = { prisma: db, writer, locks, backends: [backend] }
    const service = new SubscriptionLogin(options)
    const externalId = `synthetic-${suffix}`
    const input = {
      backend: backendId,
      driverId: driver.id,
      label: `login-${suffix}`,
      credential: issue(externalId),
      // A key names no plan: the operator does.
      ...(issue === planKey ? { plan: 'lite' } : {}),
      maxConcurrentTurns: 1,
      maxConcurrentRequests: 2,
      paidUntil: new Date('2026-12-31T00:00:00Z'),
    }
    return {
      service,
      input,
      writer,
      values,
      options,
      locks,
      pool,
      externalId,
      provider,
      /** A fresh credential of the same account, as a relogin brings. */
      issue: (plan?: string) => issue(externalId, plan),
    }
  }

  it('imports an account that names itself with CAS0, disabled status and matching SQL metadata without credential contents', async () => {
    const f = await fixture(identifiedBackend, credential)
    const result = await f.service.importAccount(f.input)
    const account = await db.subscriptionAccount.findUniqueOrThrow({
      where: { id: result.accountId },
      include: { credentialRef: true },
    })
    expect(account).toMatchObject({
      enabled: false,
      status: 'active',
      health: 'ok',
      healthReason: null,
      plan: 'plus',
      externalAccountId: f.externalId,
      credentialVersion: 1,
      maxConcurrentTurns: 1,
      maxConcurrentRequests: 2,
      paidUntil: f.input.paidUntil,
    })
    expect(account.credentialExpiresAt?.toISOString()).toBe(f.input.credential.expiresAt)
    expect(account.credentialRef).toMatchObject({
      kind: 'subscription',
      keyVersion: 1,
      vaultPath: `subs/${f.input.backend}/${result.accountId}`,
      workspaceId: null,
      siteId: null,
    })
    expect(f.writer.kvWrite).toHaveBeenCalledExactlyOnceWith(
      account.credentialRef.vaultPath,
      { credential: JSON.stringify(f.input.credential) },
      { cas: 0 },
    )
    expect(f.writer.kvMetadata).not.toHaveBeenCalled()
    expect(JSON.stringify(account)).not.toContain(identifiedSecret)
  })

  it('imports a plan key with the plan the operator names and no invented expiry or external identity', async () => {
    const f = await fixture()
    const result = await f.service.importAccount({
      ...f.input,
      credential: { v: '1', kind: 'zai_api_key', apiKey: 'synthetic-plan-key' },
      plan: 'synthetic',
      maxConcurrentTurns: 2,
      maxConcurrentRequests: 3,
    })
    const row = await db.subscriptionAccount.findUniqueOrThrow({
      where: { id: result.accountId },
    })
    expect(row).toMatchObject({
      enabled: false,
      plan: 'synthetic',
      externalAccountId: null,
      credentialExpiresAt: null,
      maxConcurrentTurns: 2,
      maxConcurrentRequests: 3,
    })
    expect(row.credentialRefreshedAt).not.toBeNull()
  })

  it('rejects the credential of another account of the provider before touching metadata or writing Vault', async () => {
    const f = await fixture(identifiedBackend, credential)
    const imported = await f.service.importAccount(f.input)
    await expect(
      f.service.relogin({
        backend: f.input.backend,
        accountId: imported.accountId,
        credential: credential('synthetic-other-account'),
      }),
    ).rejects.toMatchObject({ code: 'identity_mismatch' })
    expect(f.writer.kvWrite).toHaveBeenCalledOnce()
    expect(f.writer.kvMetadata).not.toHaveBeenCalled()
    const row = await db.subscriptionAccount.findUniqueOrThrow({
      where: { id: imported.accountId },
    })
    expect(row.health).toBe('ok')
    expect(row.credentialVersion).toBe(1)
  })

  it('serializes duplicate external-identity imports under the pool lock before Vault', async () => {
    const f = await fixture(identifiedBackend, credential)
    const outcomes = await Promise.allSettled([
      f.service.importAccount(f.input),
      f.service.importAccount({ ...f.input, label: `${f.input.label}-second` }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')!
    expect(rejected.status === 'rejected' && rejected.reason).toMatchObject({
      code: 'account_conflict',
    })
    expect(f.writer.kvWrite).toHaveBeenCalledOnce()
    expect(await db.subscriptionAccount.count({ where: { providerId: f.provider.id } })).toBe(1)
  })

  it('shares the session lock of the account, and holds it through Vault CAS and SQL finalization', async () => {
    const f = await fixture()
    const imported = await f.service.importAccount(f.input)
    const otherPool = new Pool({ connectionString: databaseUrl, max: 1 })
    const contender = new SessionSubscriptionLock(otherPool)
    cleanup.push(async () => {
      await contender.close()
      await otherPool.end()
    })
    const existing = await contender.tryAcquire(imported.accountId)
    expect(existing).not.toBeNull()
    const request = {
      backend: f.input.backend,
      accountId: imported.accountId,
      credential: f.issue(),
    }
    await expect(f.service.relogin(request)).rejects.toMatchObject({ code: 'busy' })
    expect(f.writer.kvMetadata).not.toHaveBeenCalled()
    await existing!.release()
    const write = f.writer.kvWrite.getMockImplementation()!
    f.writer.kvWrite.mockImplementationOnce(async (...args) => {
      expect(await contender.tryAcquire(imported.accountId)).toBeNull()
      return write(...args)
    })
    const relogged = await f.service.relogin(request)
    expect(relogged.credentialVersion).toBe(2)
    const lease = await contender.tryAcquire(imported.accountId)
    expect(lease).not.toBeNull()
    await lease!.release()
  })

  it('preserves banned operator state while a relogin after a refused key resets health', async () => {
    const f = await fixture(identifiedBackend, credential)
    const imported = await f.service.importAccount(f.input)
    await db.subscriptionAccount.update({
      where: { id: imported.accountId },
      data: {
        enabled: true,
        status: 'banned',
        statusReason: 'operator_block',
        health: 'needs_relogin',
        healthReason: 'auth_confirmed',
      },
    })
    const result = await f.service.relogin({
      backend: f.input.backend,
      accountId: imported.accountId,
      credential: f.issue('pro'),
    })
    expect(result.enabled).toBe(true)
    const row = await db.subscriptionAccount.findUniqueOrThrow({
      where: { id: imported.accountId },
      include: { credentialRef: true },
    })
    expect(row).toMatchObject({
      enabled: true,
      status: 'banned',
      statusReason: 'operator_block',
      health: 'ok',
      healthReason: null,
      plan: 'pro',
      credentialVersion: 2,
    })
    expect(row.credentialRef.keyVersion).toBe(2)
  })

  it('recovers the same disabled stub with CAS0 after a failed first write', async () => {
    const f = await fixture()
    f.writer.kvWrite.mockRejectedValueOnce(new Error('Synthetic writer offline'))
    await expect(f.service.importAccount(f.input)).rejects.toMatchObject({
      code: 'vault_unavailable',
    })
    const stub = await db.subscriptionAccount.findUniqueOrThrow({ where: { label: f.input.label } })
    expect(stub).toMatchObject({ enabled: false, credentialVersion: 0, health: 'needs_relogin' })
    const result = await f.service.relogin({
      backend: f.input.backend,
      accountId: stub.id,
      credential: f.issue(),
    })
    expect(result).toMatchObject({ accountId: stub.id, credentialVersion: 1, enabled: false })
    expect(f.writer.kvWrite.mock.calls.map((call) => call[2]?.cas)).toEqual([0, 0])
  })

  it.each([
    { written: false, retryLogin: false },
    { written: true, retryLogin: false },
    { written: false, retryLogin: true },
    { written: true, retryLogin: true },
  ])(
    'retires an unfinished first import only after console revocation (written=$written, retry=$retryLogin)',
    async ({ written, retryLogin }) => {
      const f = await fixture(identifiedBackend, credential)
      const write = f.writer.kvWrite.getMockImplementation()!
      f.writer.kvWrite.mockImplementationOnce(async (...args) => {
        if (written) await write(...args)
        throw new Error('Synthetic missing Vault acknowledgement')
      })
      await expect(f.service.importAccount(f.input)).rejects.toMatchObject({
        code: 'vault_unavailable',
      })
      const stub = await db.subscriptionAccount.findUniqueOrThrow({
        where: { label: f.input.label },
        include: { credentialRef: true },
      })
      const relogin = {
        backend: f.input.backend,
        accountId: stub.id,
        credential: f.issue(),
      }
      if (retryLogin) {
        f.writer.kvWrite.mockRejectedValueOnce(new Error('Synthetic writer offline'))
        await expect(f.service.relogin(relogin)).rejects.toMatchObject({
          code: 'vault_unavailable',
        })
      }
      const pending = await db.subscriptionAccount.findUniqueOrThrow({
        where: { id: stub.id },
        include: { credentialRef: true },
      })
      expect(pending).toMatchObject({
        enabled: false,
        credentialVersion: 0,
        credentialRef: { keyVersion: 0 },
        health: 'needs_relogin',
        healthReason: retryLogin ? 'relogin_pending' : 'import_pending',
      })
      const path = stub.credentialRef.vaultPath
      expect(f.values.has(path)).toBe(written)
      const kvDestroyAll = vi.fn<SecretStore['kvDestroyAll']>(async (target) => {
        const current = await db.subscriptionAccount.findUniqueOrThrow({
          where: { id: stub.id },
        })
        expect(current.enabled).toBe(false)
        expect(current.retireRequestedAt).not.toBeNull()
        expect(current.credentialsRevokedAt).not.toBeNull()
        f.values.delete(target)
      })
      const retirement = new SubscriptionRetirement({
        prisma: db,
        locks: f.locks,
        backends: f.options.backends,
        secrets: { kvDestroyAll },
        credentials: { revoke: vi.fn() },
      })
      expect(await retirement.request({ accountId: stub.id })).toMatchObject({
        stage: 'console_revocation_required',
      })
      await expect(f.service.relogin(relogin)).rejects.toMatchObject({
        code: 'account_unavailable',
      })
      expect(await retirement.finalize({ accountId: stub.id })).toMatchObject({
        stage: 'console_revocation_required',
      })
      expect(kvDestroyAll).not.toHaveBeenCalled()
      expect(
        (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: stub.id } }))
          .credentialsRevokedAt,
      ).toBeNull()
      expect(await retirement.finalize({ accountId: stub.id, consoleRevoked: true })).toMatchObject(
        { stage: 'retired' },
      )
      expect(kvDestroyAll).toHaveBeenCalledExactlyOnceWith(path)
      expect(f.values.has(path)).toBe(false)
      expect(
        await db.subscriptionAccount.findUniqueOrThrow({ where: { id: stub.id } }),
      ).toMatchObject({ status: 'retired', enabled: false, credentialVersion: 0 })
    },
  )

  it('leaves an ambiguous successful CAS failclosed and uses a fresh explicit relogin at latest metadata', async () => {
    const f = await fixture()
    const imported = await f.service.importAccount(f.input)
    const write = f.writer.kvWrite.getMockImplementation()!
    f.writer.kvWrite.mockImplementationOnce(async (...args) => {
      await write(...args)
      throw new Error('Synthetic lost Vault response')
    })
    const input = {
      backend: f.input.backend,
      accountId: imported.accountId,
      credential: f.issue(),
    }
    await expect(f.service.relogin(input)).rejects.toMatchObject({ code: 'vault_unavailable' })
    const pending = await db.subscriptionAccount.findUniqueOrThrow({
      where: { id: imported.accountId },
    })
    expect(pending).toMatchObject({
      credentialVersion: 1,
      health: 'needs_relogin',
      healthReason: 'relogin_pending',
    })
    expect(f.writer.kvWrite).toHaveBeenCalledTimes(2)
    const result = await f.service.relogin(input)
    expect(result.credentialVersion).toBe(3)
    expect(f.writer.kvWrite.mock.calls[2]?.[2]).toEqual({ cas: 2 })
  })

  it('does not repeat CAS after a SQL outage and can repair an uncommitted import by explicit relogin', async () => {
    const f = await fixture()
    let phase = 0
    const transact = db.$transaction.bind(db) as (...values: unknown[]) => Promise<unknown>
    const brokenPrisma = {
      $transaction: async (...args: unknown[]) => {
        phase += 1
        if (phase > 1) throw new Error('Synthetic SQL outage')
        return transact(...args)
      },
    }
    const importer = new SubscriptionLogin({
      ...f.options,
      prisma: brokenPrisma as unknown as Pick<PrismaClient, '$transaction'>,
    })
    await expect(importer.importAccount(f.input)).rejects.toMatchObject({
      code: 'persistence_failed',
    })
    expect(phase).toBe(4)
    expect(f.writer.kvWrite).toHaveBeenCalledOnce()
    const stub = await db.subscriptionAccount.findUniqueOrThrow({ where: { label: f.input.label } })
    expect(stub).toMatchObject({ enabled: false, health: 'needs_relogin', credentialVersion: 0 })
    const result = await f.service.relogin({
      backend: f.input.backend,
      accountId: stub.id,
      credential: f.issue(),
    })
    expect(result.credentialVersion).toBe(2)
    expect(f.writer.kvWrite.mock.calls[1]?.[2]).toEqual({ cas: 1 })
  })

  it('resolves a lost SQL COMMIT acknowledgement using the confirmed owned CAS without another write', async () => {
    const f = await fixture()
    let phase = 0
    const transact = db.$transaction.bind(db) as (...values: unknown[]) => Promise<unknown>
    const interruptedPrisma = {
      $transaction: async (...args: unknown[]) => {
        phase += 1
        const result = await transact(...args)
        if (phase === 2) throw new Error('Synthetic lost COMMIT reply')
        return result
      },
    }
    const importer = new SubscriptionLogin({
      ...f.options,
      prisma: interruptedPrisma as unknown as Pick<PrismaClient, '$transaction'>,
    })
    const result = await importer.importAccount(f.input)
    expect(result).toMatchObject({ credentialVersion: 1, enabled: false })
    expect(phase).toBe(3)
    expect(f.writer.kvWrite).toHaveBeenCalledOnce()
    const row = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: result.accountId } })
    expect(row).toMatchObject({ credentialVersion: 1, health: 'ok', healthReason: null })
  })

  it('imports the same label and account of the provider again after the old row was retired', async () => {
    const f = await fixture(identifiedBackend, credential)
    const first = await f.service.importAccount(f.input)
    await db.subscriptionAccount.update({
      where: { id: first.accountId },
      data: {
        enabled: false,
        retireRequestedAt: new Date(),
        credentialsRevokedAt: new Date(),
        status: 'retired',
      },
    })
    const retired = await db.subscriptionAccount.findUniqueOrThrow({
      where: { id: first.accountId },
    })
    const second = await f.service.importAccount(f.input)
    expect(second.accountId).not.toBe(first.accountId)
    expect(
      await db.subscriptionAccount.findUniqueOrThrow({ where: { id: second.accountId } }),
    ).toMatchObject({
      label: f.input.label,
      externalAccountId: f.externalId,
      status: 'active',
      health: 'ok',
    })
    expect(
      await db.subscriptionAccount.findUniqueOrThrow({ where: { id: first.accountId } }),
    ).toEqual(retired)
    // An active twin still conflicts, by label or by external identity.
    await expect(
      f.service.importAccount({ ...f.input, label: `${f.input.label}-other` }),
    ).rejects.toMatchObject({ code: 'account_conflict', accountId: second.accountId })
  })

  it('rejects a retirement request occurring between the two SQL phases', async () => {
    const f = await fixture()
    const imported = await f.service.importAccount(f.input)
    const write = f.writer.kvWrite.getMockImplementation()!
    f.writer.kvWrite.mockImplementationOnce(async (...args) => {
      const result = await write(...args)
      await db.subscriptionAccount.update({
        where: { id: imported.accountId },
        data: { retireRequestedAt: new Date() },
      })
      return result
    })
    await expect(
      f.service.relogin({
        backend: f.input.backend,
        accountId: imported.accountId,
        credential: f.issue(),
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' })
    const row = await db.subscriptionAccount.findUniqueOrThrow({
      where: { id: imported.accountId },
    })
    expect(row).toMatchObject({ credentialVersion: 1, health: 'needs_relogin' })
    expect(row.retireRequestedAt).not.toBeNull()
  })
})
