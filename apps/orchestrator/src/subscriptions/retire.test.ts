import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@repo/db'
import { DomainError, type TurnCredentialRef } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { sampleBackendId } from '../testing/ids.ts'
import { SubscriptionRetirement } from './retire.ts'

type TestKey = {
  taskId: string
  sessionId: string
  turnNo: number
  firstEpoch: number
  revokeRequestedAt: Date | null
  revokedAt: Date | null
}
const now = new Date('2026-09-30T15:00:00Z')

function fixture(backend = 'openai-chatgpt') {
  const account = {
    id: randomUUID(),
    enabled: true,
    status: 'active',
    credentialVersion: 1,
    health: 'ok',
    healthReason: null as string | null,
    retireRequestedAt: null as Date | null,
    credentialsRevokedAt: null as Date | null,
    provider: { slug: backend },
    credentialRef: { kind: 'subscription', vaultPath: '', keyVersion: 1 },
  }
  account.credentialRef.vaultPath = `subs/${backend}/${account.id}`
  const keys: TestKey[] = []
  const state = { active: false, open: false }
  const queries: { sql: string; values: unknown[] }[] = []
  let insideTransaction = false
  let leaseHeld = false
  const $queryRaw = vi.fn(
    async (parts: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
      const sql = Array.isArray(parts) ? parts.join('?') : (parts as Prisma.Sql).sql
      queries.push({ sql, values })
      if (sql.includes('AS pending'))
        return [{ ...state, pending: keys.some((key) => key.revokeRequestedAt && !key.revokedAt) }]
      return []
    },
  )
  const $executeRaw = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join('?')
    queries.push({ sql, values })
    if (sql.includes('SET retire_requested_at')) {
      account.retireRequestedAt ??= now
      if (values[0] === true) account.enabled = false
    } else if (sql.includes('UPDATE llm_keys')) {
      for (const key of keys) if (!key.revokedAt) key.revokeRequestedAt ??= now
    } else if (sql.includes('SET credentials_revoked_at')) {
      account.credentialsRevokedAt ??= now
    } else if (sql.includes("SET status = 'retired'")) account.status = 'retired'
    return 1
  })
  const findUnique = vi.fn(async () => ({
    ...account,
    provider: { ...account.provider },
    credentialRef: { ...account.credentialRef },
  }))
  const tx = {
    $queryRaw,
    $executeRaw,
    subscriptionAccount: { findUnique },
    llmKey: {
      findMany: vi.fn(async () => keys.filter((key) => key.revokeRequestedAt && !key.revokedAt)),
    },
  } as unknown as Prisma.TransactionClient
  const $transaction = vi.fn(
    async (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => {
      insideTransaction = true
      try {
        return await work(tx)
      } finally {
        insideTransaction = false
      }
    },
  )
  const revoke = vi.fn(async (ref: TurnCredentialRef) => {
    expect(insideTransaction).toBe(false)
    expect(account.enabled).toBe(false)
    expect(keys.filter((key) => !key.revokedAt).every((key) => key.revokeRequestedAt)).toBe(true)
    const key = keys.find((key) => key.taskId === ref.taskId)
    if (key) key.revokedAt = now
  })
  const kvDestroyAll = vi.fn(async () => {
    expect(insideTransaction).toBe(false)
    expect(leaseHeld).toBe(true)
    expect(account.enabled).toBe(false)
    expect(account.credentialsRevokedAt).toBeInstanceOf(Date)
  })
  const release = vi.fn(async () => {
    leaseHeld = false
  })
  const controller = new AbortController()
  const tryAcquire = vi.fn(async () => {
    leaseHeld = true
    return { signal: controller.signal, release }
  })
  const providerRevoke = vi.fn()
  const options = {
    prisma: { $transaction } as unknown as PrismaClient,
    secrets: { kvDestroyAll },
    credentials: { revoke },
    locks: { tryAcquire, close: vi.fn() },
    backends: [{ id: 'openai-chatgpt' as const, revoke: providerRevoke }, { id: sampleBackendId }],
  }
  const service = new SubscriptionRetirement(options)
  const addKey = (overrides: Partial<TestKey> = {}) => {
    const key = {
      taskId: randomUUID(),
      sessionId: 'immutable-session',
      turnNo: keys.length + 1,
      firstEpoch: 17,
      revokeRequestedAt: null,
      revokedAt: null,
      ...overrides,
    }
    keys.push(key)
    return key
  }
  const ready = () => {
    account.enabled = false
    account.retireRequestedAt = now
    account.credentialsRevokedAt = now
  }
  return {
    service,
    options,
    account,
    keys,
    state,
    queries,
    $transaction,
    $queryRaw,
    $executeRaw,
    findUnique,
    revoke,
    kvDestroyAll,
    release,
    tryAcquire,
    controller,
    providerRevoke,
    addKey,
    ready,
  }
}

describe('operator subscription retirement', () => {
  it('fences fresh issuance under the pool lock while normal retirement preserves live admission', async () => {
    const f = fixture()
    f.state.active = true
    f.addKey()
    expect(await f.service.request({ accountId: f.account.id })).toMatchObject({
      stage: 'draining',
    })
    expect(f.account).toMatchObject({ enabled: true, status: 'active', retireRequestedAt: now })
    expect(f.keys[0]!.revokeRequestedAt).toBeNull()
    expect(f.revoke).not.toHaveBeenCalled()
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
    const lock = f.queries.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock'))
    const update = f.queries.findIndex(({ sql }) => sql.includes('SET retire_requested_at'))
    expect(lock).toBeGreaterThan(-1)
    expect(f.queries[lock]!.values).toEqual(['pool:openai-chatgpt'])
    expect(update).toBeGreaterThan(lock)
  })

  it('immediately disables compromised admission and commits all retry markers before revoking immutable refs', async () => {
    const f = fixture()
    const first = f.addKey(),
      second = f.addKey({ firstEpoch: 31, sessionId: 'second-session' })
    expect(await f.service.request({ accountId: f.account.id, compromised: true })).toMatchObject({
      stage: 'provider_revocation_pending',
    })
    expect(f.account.enabled).toBe(false)
    expect(f.revoke.mock.calls.map(([value]) => value)).toEqual(
      [first, second].map((key) => ({
        taskId: key.taskId,
        sessionId: key.sessionId,
        turn: key.turnNo,
        epoch: key.firstEpoch,
      })),
    )
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
    expect(f.providerRevoke).not.toHaveBeenCalled()
    const keyUpdate = f.queries.findIndex(({ sql }) => sql.includes('UPDATE llm_keys'))
    const accountLock = f.queries.findIndex(({ sql }) =>
      sql.includes('FROM subscription_accounts WHERE id'),
    )
    expect(keyUpdate).toBeGreaterThan(-1)
    expect(accountLock).toBeGreaterThan(keyUpdate)
  })

  it('persists failed emergency revocation and keeps processing other keys without propagating secret errors', async () => {
    const f = fixture()
    const first = f.addKey(),
      second = f.addKey()
    f.revoke.mockRejectedValueOnce(new Error('private token and provider response'))
    expect(await f.service.request({ accountId: f.account.id, compromised: true })).toMatchObject({
      stage: 'turn_revocation_pending',
    })
    expect(first.revokeRequestedAt).toBe(now)
    expect(first.revokedAt).toBeNull()
    expect(second.revokedAt).toBe(now)
    expect(await f.service.request({ accountId: f.account.id })).toMatchObject({
      stage: 'provider_revocation_pending',
    })
    expect(first.revokedAt).toBe(now)
    expect(f.revoke).toHaveBeenCalledTimes(3)
  })

  it('preserves the original request timestamp and operator status on repeat requests', async () => {
    const f = fixture()
    const original = new Date('2026-09-30T14:00:00Z')
    f.account.retireRequestedAt = original
    f.account.status = 'banned'
    await f.service.request({ accountId: f.account.id })
    await f.service.request({ accountId: f.account.id, compromised: true })
    expect(f.account).toMatchObject({
      status: 'banned',
      retireRequestedAt: original,
      enabled: false,
    })
  })

  it('keeps already disabled normal accounts disabled and waits for provider retirement', async () => {
    const f = fixture()
    f.account.enabled = false
    expect(await f.service.request({ accountId: f.account.id })).toMatchObject({
      stage: 'provider_revocation_pending',
    })
    expect(f.account.enabled).toBe(false)
  })

  it('rejects malformed request inputs before touching any storage', async () => {
    const f = fixture()
    await expect(f.service.request({ accountId: '../subs/private' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(f.service.finalize({ accountId: 'secret-value' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(f.$transaction).not.toHaveBeenCalled()
    expect(f.tryAcquire).not.toHaveBeenCalled()
  })

  it('refuses unsupported accounts without changing retirement state', async () => {
    const f = fixture('unregistered-backend')
    await expect(f.service.request({ accountId: f.account.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(f.$executeRaw).not.toHaveBeenCalled()
  })

  it('requires an explicit retirement request before destructive finalization', async () => {
    const f = fixture()
    f.account.enabled = false
    f.account.credentialsRevokedAt = now
    await expect(f.service.finalize({ accountId: f.account.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('waits for core to disable ordinary retirement instead of doing it during admin finalization', async () => {
    const f = fixture()
    f.account.retireRequestedAt = now
    f.account.credentialsRevokedAt = now
    expect(await f.service.finalize({ accountId: f.account.id })).toMatchObject({
      stage: 'draining',
    })
    expect(f.account.enabled).toBe(true)
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
  })

  it.each(['active', 'open'] as const)(
    'does not destroy subscription credentials while %s admission remains',
    async (kind) => {
      const f = fixture()
      f.ready()
      f.state[kind] = true
      expect(await f.service.finalize({ accountId: f.account.id })).toMatchObject({
        stage: 'draining',
      })
      expect(f.kvDestroyAll).not.toHaveBeenCalled()
    },
  )

  it('waits for failed turn destruction before removing subscription versions', async () => {
    const f = fixture()
    f.ready()
    f.addKey({ revokeRequestedAt: now })
    expect(await f.service.finalize({ accountId: f.account.id })).toMatchObject({
      stage: 'turn_revocation_pending',
    })
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
  })

  it('requires automatic provider revocation to finish and rejects a console acknowledgement bypass', async () => {
    const f = fixture()
    f.account.enabled = false
    f.account.retireRequestedAt = now
    expect(await f.service.finalize({ accountId: f.account.id })).toMatchObject({
      stage: 'provider_revocation_pending',
    })
    await expect(
      f.service.finalize({ accountId: f.account.id, consoleRevoked: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
    expect(f.account.credentialsRevokedAt).toBeNull()
  })

  it.each(['import_pending', 'relogin_pending'])(
    'requires explicit console revocation to retire an unfinished initial login in %s',
    async (healthReason) => {
      const f = fixture()
      Object.assign(f.account, {
        enabled: false,
        credentialVersion: 0,
        health: 'needs_relogin',
        healthReason,
      })
      f.account.credentialRef.keyVersion = 0
      expect(await f.service.request({ accountId: f.account.id })).toMatchObject({
        stage: 'console_revocation_required',
      })
      expect(await f.service.finalize({ accountId: f.account.id })).toMatchObject({
        stage: 'console_revocation_required',
      })
      expect(f.account.credentialsRevokedAt).toBeNull()
      expect(f.kvDestroyAll).not.toHaveBeenCalled()
      expect(
        await f.service.finalize({ accountId: f.account.id, consoleRevoked: true }),
      ).toMatchObject({ stage: 'retired' })
      expect(f.account.credentialsRevokedAt).toBe(now)
      expect(f.kvDestroyAll).toHaveBeenCalledExactlyOnceWith(`subs/openai-chatgpt/${f.account.id}`)
      expect(f.providerRevoke).not.toHaveBeenCalled()
    },
  )

  it.each(['enabled', 'active', 'open', 'pending'] as const)(
    'cannot acknowledge an unfinished import while %s admission remains',
    async (kind) => {
      const f = fixture()
      Object.assign(f.account, {
        enabled: kind === 'enabled',
        retireRequestedAt: now,
        credentialVersion: 0,
        health: 'needs_relogin',
        healthReason: 'import_pending',
      })
      f.account.credentialRef.keyVersion = 0
      if (kind === 'pending') f.addKey({ revokeRequestedAt: now })
      if (kind === 'active' || kind === 'open') f.state[kind] = true
      expect(
        await f.service.finalize({ accountId: f.account.id, consoleRevoked: true }),
      ).toMatchObject({ stage: kind === 'pending' ? 'turn_revocation_pending' : 'draining' })
      expect(f.account.credentialsRevokedAt).toBeNull()
      expect(f.kvDestroyAll).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      credentialVersion: 1,
      keyVersion: 1,
      health: 'needs_relogin',
      healthReason: 'relogin_pending',
    },
    {
      credentialVersion: 0,
      keyVersion: 1,
      health: 'needs_relogin',
      healthReason: 'import_pending',
    },
    {
      credentialVersion: 1,
      keyVersion: 0,
      health: 'needs_relogin',
      healthReason: 'import_pending',
    },
    { credentialVersion: 0, keyVersion: 0, health: 'ok', healthReason: 'import_pending' },
    {
      credentialVersion: 0,
      keyVersion: 0,
      health: 'needs_relogin',
      healthReason: 'refresh_ambiguous',
    },
  ])(
    'does not expand the console exception to $healthReason ($credentialVersion/$keyVersion)',
    async (state) => {
      const f = fixture()
      Object.assign(f.account, {
        enabled: false,
        retireRequestedAt: now,
        credentialVersion: state.credentialVersion,
        health: state.health,
        healthReason: state.healthReason,
      })
      f.account.credentialRef.keyVersion = state.keyVersion
      expect(await f.service.finalize({ accountId: f.account.id })).toMatchObject({
        stage: 'provider_revocation_pending',
      })
      await expect(
        f.service.finalize({ accountId: f.account.id, consoleRevoked: true }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(f.account.credentialsRevokedAt).toBeNull()
      expect(f.kvDestroyAll).not.toHaveBeenCalled()
    },
  )

  it('requires a console revocation acknowledgement for backends without revoke capability', async () => {
    const f = fixture(sampleBackendId)
    f.account.enabled = false
    f.account.retireRequestedAt = now
    expect(await f.service.finalize({ accountId: f.account.id })).toMatchObject({
      stage: 'console_revocation_required',
    })
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
    expect(f.account.credentialsRevokedAt).toBeNull()
  })

  it('persists console acknowledgement before Vault destruction and retries an outage without a second console action', async () => {
    const f = fixture(sampleBackendId)
    f.account.enabled = false
    f.account.retireRequestedAt = now
    f.kvDestroyAll.mockRejectedValueOnce(new Error('secret provider token response'))
    await expect(
      f.service.finalize({ accountId: f.account.id, consoleRevoked: true }),
    ).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
      message: 'Subscription gateway is unavailable',
    })
    expect(f.account.credentialsRevokedAt).toBe(now)
    expect(f.account.status).toBe('active')
    expect(await f.service.finalize({ accountId: f.account.id })).toMatchObject({
      stage: 'retired',
    })
    expect(f.kvDestroyAll).toHaveBeenCalledTimes(2)
    expect(f.account.status).toBe('retired')
  })

  it('cannot acknowledge console revocation while retirement still drains', async () => {
    const f = fixture(sampleBackendId)
    f.account.retireRequestedAt = now
    expect(
      await f.service.finalize({ accountId: f.account.id, consoleRevoked: true }),
    ).toMatchObject({ stage: 'draining' })
    expect(f.account.credentialsRevokedAt).toBeNull()
  })

  it('destroys only the exact account path, outside SQL locks but under the single-writer lock, then marks retired', async () => {
    const f = fixture()
    f.ready()
    expect(await f.service.finalize({ accountId: f.account.id })).toEqual({
      accountId: f.account.id,
      backend: 'openai-chatgpt',
      stage: 'retired',
    })
    expect(f.tryAcquire).toHaveBeenCalledExactlyOnceWith(f.account.id)
    expect(f.kvDestroyAll).toHaveBeenCalledExactlyOnceWith(`subs/openai-chatgpt/${f.account.id}`)
    expect(f.release).toHaveBeenCalledOnce()
  })

  it.each([
    'subs/openai-chatgpt/another-account',
    'turns/a-secret',
    '../subs/openai-chatgpt/account',
  ])('rejects a mismatched path %s before any destruction', async (path) => {
    const f = fixture()
    f.ready()
    f.account.credentialRef.vaultPath = path
    await expect(f.service.finalize({ accountId: f.account.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
  })

  it('rejects a subscription reference with a different credential kind', async () => {
    const f = fixture()
    f.ready()
    f.account.credentialRef.kind = 'ssh'
    await expect(f.service.finalize({ accountId: f.account.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
  })

  it('keeps the finalization marker retryable after Vault succeeds but database persistence fails', async () => {
    const f = fixture()
    f.ready()
    const execute = f.$executeRaw.getMockImplementation()!
    let fail = true
    f.$executeRaw.mockImplementation(async (...args) => {
      if (fail && args[0].join('?').includes("SET status = 'retired'")) {
        fail = false
        throw new Error('database private details')
      }
      return execute(...args)
    })
    await expect(f.service.finalize({ accountId: f.account.id })).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
    })
    expect(f.account.status).toBe('active')
    expect(await f.service.finalize({ accountId: f.account.id })).toMatchObject({
      stage: 'retired',
    })
    expect(f.kvDestroyAll).toHaveBeenCalledTimes(2)
  })

  it('does not repeat any destructive operations for an already retired account', async () => {
    const f = fixture()
    f.ready()
    f.account.status = 'retired'
    expect(await f.service.request({ accountId: f.account.id, compromised: true })).toMatchObject({
      stage: 'retired',
    })
    expect(await f.service.finalize({ accountId: f.account.id })).toMatchObject({
      stage: 'retired',
    })
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
    expect(f.revoke).not.toHaveBeenCalled()
    expect(f.$executeRaw).not.toHaveBeenCalled()
  })

  it('does not touch Vault when another writer holds the account lock', async () => {
    const f = fixture()
    f.ready()
    f.tryAcquire.mockResolvedValueOnce(null as never)
    await expect(f.service.finalize({ accountId: f.account.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
    expect(f.$transaction).not.toHaveBeenCalled()
  })

  it('does not mark retired after losing the account lock during secret destruction', async () => {
    const f = fixture()
    f.ready()
    f.kvDestroyAll.mockImplementationOnce(async () => {
      f.controller.abort(new Error('Connection lost'))
    })
    await expect(f.service.finalize({ accountId: f.account.id })).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
    })
    expect(f.account.status).toBe('active')
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('sanitizes even domain-shaped errors from external admin capabilities', async () => {
    const f = fixture()
    f.ready()
    f.kvDestroyAll.mockRejectedValueOnce(
      new DomainError('BAD_REQUEST', 'private provider token', 400),
    )
    await expect(f.service.finalize({ accountId: f.account.id })).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
      message: 'Subscription gateway is unavailable',
    })
    expect(f.account.status).toBe('active')
  })

  it('applies bounded SQL settings to every operation and sanitizes unexpected database failures', async () => {
    const f = fixture()
    await f.service.request({ accountId: f.account.id })
    expect(f.queries.filter(({ sql }) => sql.includes('statement_timeout')).length).toBe(
      f.$transaction.mock.calls.length,
    )
    f.findUnique.mockRejectedValueOnce(new Error('private token database response'))
    await expect(f.service.request({ accountId: f.account.id })).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
      message: 'Subscription gateway is unavailable',
    })
  })
})
