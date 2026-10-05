import { createHash, randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@repo/db'
import type { SecretStore, TurnCredentialGrant, TurnCredentialRef } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { GatewayTurnCredentials } from './turn-credentials.ts'

const decimal = (value: string) => ({ toFixed: (digits: number) => Number(value).toFixed(digits) })

function fixture() {
  const now = new Date('2026-09-30T12:00:00Z')
  const accountId = randomUUID()
  const modelId = randomUUID()
  const ref: TurnCredentialRef = {
    taskId: randomUUID(),
    sessionId: 'synthetic-session',
    turn: 1,
    epoch: 1,
  }
  const grant: TurnCredentialGrant = {
    driverId: 'kimi',
    backend: 'kimi-code',
    modelSlug: 'synthetic',
    modelClass: 'standard',
    reasoningEffort: null,
    ttlMs: 600_000,
    deadlineAt: new Date(now.getTime() + 1_200_000),
    budgetRub: '100.00',
    boundSource: null,
  }
  let owned = true
  let revoked = false
  let transaction = false
  let key: Record<string, unknown> | null = null
  let vault: Record<string, string> | null = null
  let metadata = false
  let deleted = false
  const calls: string[] = []
  const tx = {
    $queryRaw: vi.fn(async (query: Prisma.Sql | TemplateStringsArray) => {
      const sql = 'sql' in query ? query.sql : query.join(' ')
      if (sql.includes('FOR UPDATE OF l'))
        return owned ? [{ id: ref.taskId, attempt: 1, dataClass: 'synthetic', now }] : []
      if (sql.includes('SELECT EXISTS')) return [{ owned }]
      if (sql.includes('FROM llm_models'))
        return [{ modelId, providerId: randomUUID(), enabled: true, reserveOutputTokens: 32_768 }]
      if (sql.includes('LEFT JOIN credit_holds'))
        return [{ payg: false, holdRub: null, feeRub: null, markup: null }]
      if (sql.includes('FROM subscription_accounts'))
        return [
          {
            id: accountId,
            enabled: true,
            status: 'active',
            health: 'ok',
            healthReason: null,
            healthChangedAt: null,
            retireRequestedAt: null,
            coolingUntil: null,
            breakerOpenUntil: null,
            limitWindows: [{ name: 'week', usedPct: 10, resetsAt: null }],
            activeTurns: 0n,
            maxConcurrentTurns: 1,
            lastUsedAt: null,
          },
        ]
      return [{ now }]
    }),
    $executeRaw: vi.fn(async (query: Prisma.Sql | TemplateStringsArray) => {
      const sql = 'sql' in query ? query.sql : query.join(' ')
      calls.push('sql')
      if (sql.includes('WITH marker AS')) {
        revoked = true
        if (key) key.revokeRequestedAt = now
      }
      if (sql.includes('usage_closed_at') && key) {
        key.revokedAt = now
        key.usageClosedAt = now
      }
      return 1
    }),
    taskEvent: {
      findFirst: vi.fn(async ({ where }: { where: { type: string } }) =>
        where.type === 'llm.revoke_requested' && revoked ? { id: 1n } : null,
      ),
    },
    turnAssignment: { findFirst: vi.fn(async () => null) },
    llmKey: {
      findUnique: vi.fn(async () => key),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        key = { ...data, id: randomUUID(), revokeRequestedAt: null, revokedAt: null }
        return key
      }),
    },
    llmModelPrice: {
      findFirst: vi.fn(async () => ({
        id: randomUUID(),
        inputPer1m: decimal('10'),
        cacheReadPer1m: null,
        cacheWritePer1m: null,
        outputPer1m: decimal('30'),
      })),
    },
    crossBorderClearance: { findFirst: vi.fn(async () => null) },
    taskAccountBinding: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    subscriptionAccount: { update: vi.fn(async () => ({})) },
  }
  const db = {
    $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => {
      transaction = true
      try {
        return await work(tx)
      } finally {
        transaction = false
      }
    }),
  }
  const secrets = {
    kvRead: vi.fn(async () => {
      expect(transaction).toBe(false)
      return vault && !deleted ? { data: { ...vault }, version: 1 } : null
    }),
    kvMetadata: vi.fn(async () =>
      metadata
        ? { currentVersion: 1, custom: {}, createdTime: now, deleted, destroyed: false }
        : null,
    ),
    kvCreateOnce: vi.fn(async (_path: string, data: Record<string, string>) => {
      expect(transaction).toBe(false)
      calls.push('create')
      if (!vault && !metadata) {
        vault = data
        metadata = true
        return 'created' as const
      }
      return 'exists' as const
    }),
    kvDelete: vi.fn(async () => {
      calls.push('delete')
      deleted = true
    }),
    kvDestroyAll: vi.fn(async () => {
      calls.push('destroy')
      vault = null
      metadata = false
    }),
  }
  const credentials = new GatewayTurnCredentials({
    prisma: db as unknown as PrismaClient,
    secrets: secrets as unknown as SecretStore,
  })
  return {
    credentials,
    ref,
    grant,
    tx,
    db,
    secrets,
    now,
    accountId,
    calls,
    key: () => key,
    vault: () => vault,
    expireFence: () => {
      owned = false
    },
    alterVault: (change: Record<string, string>) => {
      vault = { ...vault!, ...change }
    },
    deleteVault: () => {
      deleted = true
    },
    setMetadata: () => {
      metadata = true
    },
  }
}

describe('durable turn credentials', () => {
  it('writes secrets outside SQL, admits only their hash, and returns the same values on retry', async () => {
    const f = fixture()
    const values = await f.credentials.issue(f.ref, f.grant)
    expect(values.llmApiKey).toMatch(/^sk-rdt-[A-Za-z0-9_-]{43}$/)
    expect(values.mcpToken).toMatch(/^mcp_[a-f0-9]{64}$/)
    expect(f.key()?.keyHash).toBe(createHash('sha256').update(values.llmApiKey).digest('hex'))
    expect(f.key()?.mcpTokenHash).toBe(createHash('sha256').update(values.mcpToken).digest('hex'))
    expect(JSON.stringify(f.tx.llmKey.create.mock.calls)).not.toContain(values.llmApiKey)
    expect(JSON.stringify(f.tx.llmKey.create.mock.calls)).not.toContain(values.mcpToken)
    const original = { ...f.key() }
    expect(
      await f.credentials.issue(f.ref, { ...f.grant, budgetRub: '750.00', ttlMs: 1_200_000 }),
    ).toEqual(values)
    expect(f.key()).toEqual(original)
    expect(f.tx.llmKey.create).toHaveBeenCalledTimes(1)
  })

  it('refuses a stale owner before reading or writing Vault', async () => {
    const f = fixture()
    f.expireFence()
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(f.secrets.kvRead).not.toHaveBeenCalled()
    expect(f.secrets.kvCreateOnce).not.toHaveBeenCalled()
  })

  it('checks the fence again after a durable Vault write', async () => {
    const f = fixture()
    const write = f.secrets.kvCreateOnce.getMockImplementation()!
    f.secrets.kvCreateOnce.mockImplementation(async (...args) => {
      const result = await write(...args)
      f.expireFence()
      return result
    })
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(f.vault()).not.toBeNull()
    expect(f.tx.llmKey.create).not.toHaveBeenCalled()
  })

  it('does not revive a removed write-once secret', async () => {
    const f = fixture()
    f.setMetadata()
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.secrets.kvCreateOnce).not.toHaveBeenCalled()
  })

  it.each(['sessionId', 'accountId', 'llmApiKey', 'mcpToken'])(
    'recovery rejects a changed %s',
    async (field) => {
      const f = fixture()
      await f.credentials.issue(f.ref, f.grant)
      f.alterVault({
        [field]:
          field === 'accountId'
            ? randomUUID()
            : field === 'llmApiKey'
              ? `sk-rdt-${'a'.repeat(43)}`
              : field === 'mcpToken'
                ? `mcp_${'a'.repeat(64)}`
                : 'another-session',
      })
      expect(await f.credentials.recover(f.ref)).toBeNull()
    },
  )

  it('recovers a running key without consulting current pool eligibility', async () => {
    const f = fixture()
    const values = await f.credentials.issue(f.ref, f.grant)
    f.tx.$queryRaw.mockClear()
    expect(await f.credentials.recover(f.ref)).toEqual(values)
    expect(
      f.tx.$queryRaw.mock.calls.some(([query]) =>
        ('sql' in query ? query.sql : query.join(' ')).includes('subscription_accounts'),
      ),
    ).toBe(false)
    f.deleteVault()
    expect(await f.credentials.recover(f.ref)).toBeNull()
  })

  it('retains credentials for finalization after admission expiry, but never beyond validUntil', async () => {
    const f = fixture()
    const values = await f.credentials.issue(f.ref, f.grant)
    f.key()!.expiresAt = new Date(f.now.getTime() - 1)
    expect(await f.credentials.recover(f.ref)).toEqual(values)
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'CONFLICT' })
    f.key()!.validUntil = new Date(f.now.getTime() - 1)
    expect(await f.credentials.recover(f.ref)).toBeNull()
  })

  it('throws a sanitized outage on transport errors rather than returning unrecoverable', async () => {
    const f = fixture()
    f.secrets.kvRead.mockRejectedValue(new Error('token=private-provider-body'))
    await expect(f.credentials.recover(f.ref)).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
      message: 'Subscription gateway is unavailable',
    })
  })

  it('closes SQL admission before Vault deletion and leaves durable intent when deletion fails', async () => {
    const f = fixture()
    await f.credentials.issue(f.ref, f.grant)
    f.calls.splice(0)
    f.secrets.kvDelete.mockRejectedValueOnce(new Error('vault outage'))
    await expect(f.credentials.revoke(f.ref)).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
    })
    expect(f.key()?.revokeRequestedAt).toEqual(f.now)
    expect(f.secrets.kvDestroyAll).not.toHaveBeenCalled()
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'CONFLICT' })
    await f.credentials.revoke(f.ref)
    expect(f.calls).toEqual(['sql', 'sql', 'delete', 'sql', 'destroy'])
    expect(await f.credentials.recover(f.ref)).toBeNull()
    await f.credentials.revoke(f.ref)
  })

  it('a revocation marker closes even a turn whose Vault value did not exist yet', async () => {
    const f = fixture()
    await f.credentials.revoke(f.ref)
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.tx.llmKey.create).not.toHaveBeenCalled()
  })

  it('requires the persisted assignment deadline and identity', async () => {
    const f = fixture()
    f.tx.turnAssignment.findFirst.mockResolvedValue({
      sessionId: f.ref.sessionId,
      firstEpoch: 1,
      leaseEpoch: 1,
      deadlineAt: new Date(f.grant.deadlineAt.getTime() + 1),
    } as never)
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.secrets.kvCreateOnce).not.toHaveBeenCalled()
  })
})
