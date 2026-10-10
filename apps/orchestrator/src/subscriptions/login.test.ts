import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@repo/db'
import type { LlmBackend } from '@repo/domain'
import { zaiCodingBackend } from '@repo/llm-backends'
import { describe, expect, it, vi } from 'vitest'

import { sampleDriverId } from '../testing/ids.ts'
import {
  createSubscriptionClientIdentity,
  SubscriptionLogin,
  SubscriptionLoginError,
  type SubscriptionImportInput,
} from './login.ts'

const secret = { v: '1', kind: 'zai_api_key', apiKey: 'synthetic-key-never-log' }
const backend: LlmBackend = {
  ...zaiCodingBackend,
  credentialMetadata: () => ({
    externalAccountId: 'synthetic-account',
    plan: 'synthetic',
    accessExpiresAt: new Date(Date.now() + 86_400_000),
    accessIssuedAt: new Date(Date.now() - 60_000),
  }),
}

function fixture() {
  let account: Record<string, unknown> | null = null
  let ref: Record<string, unknown> | null = null
  let currentVersion = 0
  let inTransaction = false
  let existing: { id: string } | null = null
  const controller = new AbortController()
  const release = vi.fn(async () => undefined)
  const locks = {
    tryAcquire: vi.fn(async () => ({ signal: controller.signal, release })),
    close: vi.fn(async () => undefined),
  }
  const provider = { id: randomUUID(), slug: backend.id, kind: 'subscription', enabled: true }
  const tx = {
    $queryRaw: vi.fn(async (_query: Prisma.Sql | TemplateStringsArray) => [{ now: new Date() }]),
    $executeRaw: vi.fn(async () => 1),
    llmProvider: { findUnique: vi.fn(async () => provider) },
    agentDriver: { findUnique: vi.fn(async () => ({ id: sampleDriverId })) },
    credentialRef: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        ref = { id: randomUUID(), ...data }
        return ref
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(ref!, data)
        return ref
      }),
    },
    subscriptionAccount: {
      findFirst: vi.fn(async () => existing),
      findUnique: vi.fn(async () =>
        account ? { ...account, provider, credentialRef: ref } : null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        account = {
          credentialVersion: 0,
          refreshFinishedAt: null,
          refreshFailures: 0,
          retireRequestedAt: null,
          credentialsRevokedAt: null,
          status: 'active',
          statusReason: null,
          ...data,
        }
        return { ...account, provider, credentialRef: ref }
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(account!, data)
        return account
      }),
    },
  }
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
      const savedAccount = account ? structuredClone(account) : null
      const savedRef = ref ? structuredClone(ref) : null
      inTransaction = true
      try {
        return await work(tx)
      } catch (error) {
        account = savedAccount
        ref = savedRef
        throw error
      } finally {
        inTransaction = false
      }
    }),
  }
  const writer = {
    kvMetadata: vi.fn(async () =>
      currentVersion
        ? {
            currentVersion,
            deleted: false,
            destroyed: false,
            custom: {},
            createdTime: new Date(),
          }
        : null,
    ),
    kvWrite: vi.fn(
      async (_path: string, _data: Record<string, string>, options?: { cas?: number }) => {
        expect(inTransaction).toBe(false)
        expect(account?.health).toBe('needs_relogin')
        expect(options?.cas).toBe(currentVersion)
        currentVersion += 1
        return { version: currentVersion }
      },
    ),
  }
  const service = new SubscriptionLogin({
    prisma: prisma as unknown as Pick<PrismaClient, '$transaction'>,
    writer,
    locks,
    backends: [backend],
  })
  const input: SubscriptionImportInput = {
    backend: backend.id,
    driverId: sampleDriverId,
    credential: secret,
    label: 'synthetic',
    clientIdentity: createSubscriptionClientIdentity(),
  }
  return {
    service,
    input,
    writer,
    locks,
    release,
    tx,
    prisma,
    controller,
    account: () => account!,
    ref: () => ref!,
    setVersion: (value: number) => (currentVersion = value),
    conflict: (id: string) => (existing = { id }),
    relogin: () => ({ backend: backend.id, accountId: account!.id as string, credential: secret }),
  }
}

describe('subscription client identity', () => {
  it('names each new device on its own, never after the service', () => {
    const names = new Set<string>()
    for (let index = 0; index < 50; index += 1) {
      const identity = createSubscriptionClientIdentity()
      expect(identity.deviceName).toMatch(/^[0-9a-f]{12}$/)
      expect(JSON.stringify(identity).toLowerCase()).not.toContain('raditi')
      names.add(identity.deviceName!)
    }
    expect(names.size).toBe(50)
  })
})

describe('checks before a provider issues credentials', () => {
  it('passes with a working writer token and a free label, without writing anything', async () => {
    const f = fixture()
    await f.service.preflight({ backend: backend.id, label: 'synthetic' })
    expect(f.writer.kvMetadata).toHaveBeenCalledOnce()
    expect(f.writer.kvMetadata.mock.calls[0]).toEqual([
      expect.stringMatching(new RegExp(`^subs/${backend.id}/[0-9a-f-]{36}$`)),
    ])
    expect(f.tx.subscriptionAccount.findFirst).toHaveBeenCalledWith({
      where: { label: 'synthetic', status: { not: 'retired' } },
      select: { id: true },
    })
    expect(f.writer.kvWrite).not.toHaveBeenCalled()
    expect(f.tx.subscriptionAccount.create).not.toHaveBeenCalled()
  })

  it('refuses an expired or unauthorized writer token before the device flow', async () => {
    const f = fixture()
    f.writer.kvMetadata.mockRejectedValueOnce(new Error('403 permission denied private-token'))
    await expect(
      f.service.preflight({ backend: backend.id, label: 'synthetic' }),
    ).rejects.toMatchObject({ code: 'vault_unavailable' })
    expect(f.tx.subscriptionAccount.findFirst).not.toHaveBeenCalled()
  })

  it('refuses a label taken by an account that is not retired, and an unknown backend', async () => {
    const f = fixture()
    const id = randomUUID()
    f.conflict(id)
    await expect(
      f.service.preflight({ backend: backend.id, label: 'synthetic' }),
    ).rejects.toMatchObject({ code: 'account_conflict', accountId: id })
    // A relogin keeps its label: only the token is checked.
    await f.service.preflight({ backend: backend.id })
    await expect(f.service.preflight({ backend: 'missing-backend' })).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })
})

describe('write-only subscription login', () => {
  it('creates a disabled stub before CAS0 and persists matching metadata without reading credentials', async () => {
    const f = fixture()
    const result = await f.service.importAccount(f.input)
    expect(result).toMatchObject({ backend: backend.id, credentialVersion: 1, enabled: false })
    expect(f.writer.kvWrite).toHaveBeenCalledExactlyOnceWith(
      `subs/${backend.id}/${result.accountId}`,
      { credential: JSON.stringify(secret) },
      { cas: 0 },
    )
    expect(f.writer.kvMetadata).not.toHaveBeenCalled()
    expect(f.account()).toMatchObject({
      externalAccountId: 'synthetic-account',
      plan: 'synthetic',
      credentialVersion: 1,
      health: 'ok',
      healthReason: null,
      clientIdentity: f.input.clientIdentity,
      refreshStartedAt: null,
      refreshFinishedAt: null,
      refreshFailures: 0,
    })
    expect(f.ref().keyVersion).toBe(1)
    expect(f.release).toHaveBeenCalledOnce()
    const queryText = f.tx.$queryRaw.mock.calls.map(([query]) =>
      'sql' in query ? query.sql : query.join(' '),
    )
    expect(queryText.some((sql) => sql?.includes('pg_advisory_xact_lock'))).toBe(true)
  })

  async function refusedBeforeWrites(override: object) {
    const f = fixture()
    await expect(f.service.importAccount({ ...f.input, ...override })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    expect(f.prisma.$transaction).not.toHaveBeenCalled()
    expect(f.writer.kvWrite).not.toHaveBeenCalled()
  }

  it.each([
    { label: '' },
    { label: 'bad\nlabel' },
    { driverId: '../../escape' },
    { maxConcurrentTurns: 9 },
    { maxConcurrentRequests: 17 },
    { paidUntil: new Date(NaN) },
    { plan: 'free' },
    { credential: { ...secret, token: 'synthetic-private-extra' } },
    { clientIdentity: { installationId: 'only-one' } },
  ])('rejects malformed import %j before SQL or Vault', refusedBeforeWrites)

  // Named, not printed with %j: JSON leaves C1 controls raw, and the reporter would write them
  // to the terminal and the CI log.
  it.each([
    ['U+009B, an 8-bit CSI', 'bad\u009blabel'],
    ['U+0085, a next-line', 'bad\u0085label'],
    ['U+007F, a delete', 'bad\u007flabel'],
  ])('rejects a label with %s before SQL or Vault', (_name, label) =>
    refusedBeforeWrites({ label }),
  )

  it('requires an explicit plan when provider metadata lacks one', async () => {
    const f = fixture()
    const service = new SubscriptionLogin({
      prisma: f.prisma as unknown as Pick<PrismaClient, '$transaction'>,
      writer: f.writer,
      locks: f.locks,
      backends: [zaiCodingBackend],
    })
    await expect(service.importAccount(f.input)).rejects.toMatchObject({ code: 'invalid_input' })
    const result = await service.importAccount({ ...f.input, plan: 'synthetic' })
    expect(result.enabled).toBe(false)
    expect(f.account().externalAccountId).toBeNull()
  })

  it('rejects duplicate label or external identity before any credential write', async () => {
    const f = fixture()
    const duplicate = randomUUID()
    f.conflict(duplicate)
    await expect(f.service.importAccount(f.input)).rejects.toMatchObject({
      code: 'account_conflict',
      accountId: duplicate,
    })
    expect(f.writer.kvWrite).not.toHaveBeenCalled()
    expect(f.tx.credentialRef.create).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('leaves a failed CAS0 import disabled and recovers its same stub via relogin CAS0', async () => {
    const f = fixture()
    f.writer.kvWrite.mockRejectedValueOnce(new Error('synthetic-secret-in-error'))
    await expect(f.service.importAccount(f.input)).rejects.toMatchObject({
      code: 'vault_unavailable',
    })
    expect(f.account()).toMatchObject({
      enabled: false,
      credentialVersion: 0,
      health: 'needs_relogin',
      healthReason: 'import_pending',
    })
    const accountId = f.account().id
    const result = await f.service.relogin(f.relogin())
    expect(result).toMatchObject({ accountId, enabled: false, credentialVersion: 1 })
    expect(f.writer.kvWrite.mock.calls.map((call) => call[2]?.cas)).toEqual([0, 0])
  })

  it('uses only current metadata CAS and preserves the operator status, enabled flag and client identity', async () => {
    const f = fixture()
    await f.service.importAccount(f.input)
    Object.assign(f.account(), {
      enabled: true,
      status: 'banned',
      statusReason: 'operator_reason',
      health: 'suspended',
      healthReason: 'plan_changed',
      refreshFailures: 7,
    })
    const result = await f.service.relogin(f.relogin())
    expect(result).toMatchObject({ enabled: true, credentialVersion: 2 })
    expect(f.writer.kvMetadata).toHaveBeenCalledExactlyOnceWith(f.ref().vaultPath)
    expect(f.writer.kvWrite.mock.calls[1]?.[2]).toEqual({ cas: 1 })
    expect(f.account()).toMatchObject({
      status: 'banned',
      statusReason: 'operator_reason',
      enabled: true,
      clientIdentity: f.input.clientIdentity,
      health: 'ok',
      healthReason: null,
      refreshFailures: 0,
    })
    expect(f.ref().keyVersion).toBe(2)
  })

  it('refuses another account identity before metadata lookup and before any pending marker', async () => {
    const f = fixture()
    await f.service.importAccount(f.input)
    f.account().externalAccountId = 'another-account'
    await expect(f.service.relogin(f.relogin())).rejects.toMatchObject({
      code: 'identity_mismatch',
    })
    expect(f.writer.kvMetadata).not.toHaveBeenCalled()
    expect(f.writer.kvWrite).toHaveBeenCalledOnce()
    expect(f.account().health).toBe('ok')
  })

  it.each([
    { status: 'retired' },
    { retireRequestedAt: new Date() },
    { credentialsRevokedAt: new Date() },
  ])('refuses relogin during or after retirement %j', async (override) => {
    const f = fixture()
    await f.service.importAccount(f.input)
    Object.assign(f.account(), override)
    await expect(f.service.relogin(f.relogin())).rejects.toMatchObject({
      code: 'account_unavailable',
    })
    expect(f.writer.kvMetadata).not.toHaveBeenCalled()
    expect(f.writer.kvWrite).toHaveBeenCalledOnce()
  })

  it.each([{ deleted: true }, { destroyed: true }, { currentVersion: 0 }])(
    'refuses deleted, destroyed or regressed Vault metadata %j',
    async (override) => {
      const f = fixture()
      await f.service.importAccount(f.input)
      f.writer.kvMetadata.mockResolvedValueOnce({
        currentVersion: 1,
        deleted: false,
        destroyed: false,
        custom: {},
        createdTime: new Date(),
        ...override,
      })
      await expect(f.service.relogin(f.relogin())).rejects.toMatchObject({
        code: 'vault_unavailable',
      })
      expect(f.writer.kvWrite).toHaveBeenCalledOnce()
    },
  )

  it('does not infer success after an ambiguous CAS; an explicit retry writes fresh credentials at current metadata version', async () => {
    const f = fixture()
    await f.service.importAccount(f.input)
    f.writer.kvWrite.mockImplementationOnce(async () => {
      f.setVersion(2)
      throw new Error('synthetic-private-timeout')
    })
    await expect(f.service.relogin(f.relogin())).rejects.toMatchObject({
      code: 'vault_unavailable',
    })
    expect(f.account()).toMatchObject({
      credentialVersion: 1,
      health: 'needs_relogin',
      healthReason: 'relogin_pending',
    })
    expect(f.writer.kvWrite).toHaveBeenCalledTimes(2)
    const result = await f.service.relogin({
      ...f.relogin(),
      credential: { ...secret, apiKey: 'synthetic-fresh-login' },
    })
    expect(result.credentialVersion).toBe(3)
    expect(f.writer.kvWrite.mock.calls[2]?.[2]).toEqual({ cas: 2 })
  })

  it('retries only SQL after a confirmed Vault write and never repeats CAS', async () => {
    const f = fixture()
    f.tx.subscriptionAccount.update.mockRejectedValueOnce(new Error('transient SQL'))
    const result = await f.service.importAccount(f.input)
    expect(result.credentialVersion).toBe(1)
    expect(f.writer.kvWrite).toHaveBeenCalledOnce()
    expect(f.tx.subscriptionAccount.update).toHaveBeenCalledTimes(2)
  })

  it('exhausts bounded SQL retries with a safe stub and sanitized error account id', async () => {
    const f = fixture()
    f.tx.subscriptionAccount.update.mockRejectedValue(new Error('synthetic-private-sql'))
    let caught: unknown
    try {
      await f.service.importAccount(f.input)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SubscriptionLoginError)
    expect(caught).toMatchObject({ code: 'persistence_failed', accountId: f.account().id })
    expect(String(caught)).not.toContain('synthetic-private')
    expect(f.writer.kvWrite).toHaveBeenCalledOnce()
    expect(f.tx.subscriptionAccount.update).toHaveBeenCalledTimes(3)
    expect(f.account().health).toBe('needs_relogin')
    expect(f.account().credentialVersion).toBe(0)
  })

  it('cannot publish SQL admission after the single-writer session is lost', async () => {
    const f = fixture()
    f.writer.kvWrite.mockImplementationOnce(async () => {
      f.controller.abort()
      return { version: 1 }
    })
    await expect(f.service.importAccount(f.input)).rejects.toMatchObject({
      code: 'persistence_failed',
    })
    expect(f.account()).toMatchObject({
      enabled: false,
      credentialVersion: 0,
      health: 'needs_relogin',
    })
    expect(f.tx.subscriptionAccount.update).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('does no persistence when the refresher already owns the account session lock', async () => {
    const f = fixture()
    await f.service.importAccount(f.input)
    f.locks.tryAcquire.mockResolvedValueOnce(null as never)
    const count = f.prisma.$transaction.mock.calls.length
    await expect(f.service.relogin(f.relogin())).rejects.toMatchObject({ code: 'busy' })
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(count)
    expect(f.writer.kvWrite).toHaveBeenCalledOnce()
  })

  it('bounds the stored envelope and never includes parser or Vault error details', async () => {
    const f = fixture()
    await expect(
      f.service.importAccount({
        ...f.input,
        credential: { ...secret, apiKey: 'x'.repeat(40_000) },
      }),
    ).rejects.toThrow('Subscription login failed: invalid_input')
    f.writer.kvWrite.mockRejectedValueOnce(new Error('synthetic-key-never-log'))
    await expect(f.service.importAccount(f.input)).rejects.toThrow(
      'Subscription login failed: vault_unavailable',
    )
  })
})
