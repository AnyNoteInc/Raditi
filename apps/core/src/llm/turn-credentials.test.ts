import { createHash, randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@repo/db'
import type { SecretStore, TurnCredentialGrant, TurnCredentialRef } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { sampleBackendCapacity, sampleBackendId, sampleDriverId } from '../testing/ids.ts'
import { GatewayTurnCredentials, type GatewayTurnCredentialsOptions } from './turn-credentials.ts'

const decimal = (value: string) => ({ toFixed: (digits: number) => Number(value).toFixed(digits) })

interface SiteVariable {
  name: string
  keyVersion: number
  toAgent: boolean
  toPreview: boolean
  agentConsentAt: Date | null
}

function fixture(
  options: Partial<Pick<GatewayTurnCredentialsOptions, 'capacityOf' | 'probeAccounts'>> & {
    /** The stored state of the pool's one account, over the default. */
    account?: Record<string, unknown>
    /** The data class of the site's workspace. */
    dataClass?: 'synthetic' | 'client'
    /** `tasks.needs_browser` of the task: one that works in the browser (plan 57). */
    needsBrowser?: boolean
    /** Rows of `site_env_vars` of the site, as the query would return them. */
    variables?: SiteVariable[]
    /** Vault keys of the site's variables by name: their data and version. */
    values?: Record<string, { data: Record<string, string>; version: number }>
  } = {},
) {
  const now = new Date('2026-09-30T12:00:00Z')
  const siteId = randomUUID()
  const accountId = randomUUID()
  const modelId = randomUUID()
  const ref: TurnCredentialRef = {
    taskId: randomUUID(),
    sessionId: 'synthetic-session',
    turn: 1,
    epoch: 1,
  }
  const grant: TurnCredentialGrant = {
    driverId: sampleDriverId,
    backend: sampleBackendId,
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
        return owned
          ? [
              {
                id: ref.taskId,
                attempt: 1,
                siteId,
                dataClass: options.dataClass ?? 'synthetic',
                needsBrowser: options.needsBrowser ?? false,
                now,
              },
            ]
          : []
      if (sql.includes('SELECT EXISTS')) return [{ owned }]
      if (sql.includes('FROM llm_models'))
        return [{ modelId, providerId: randomUUID(), enabled: true, reserveOutputTokens: 32_000 }]
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
            limitsSeenAt: null,
            activeTurns: 0n,
            maxConcurrentTurns: 1,
            lastUsedAt: null,
            ...options.account,
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
    siteEnvVar: { findMany: vi.fn(async () => options.variables ?? []) },
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
    kvRead: vi.fn(async (path: string) => {
      expect(transaction).toBe(false)
      const variable = /^kv\/sites\/([^/]+)\/env\/([A-Z0-9_]+)$/.exec(path)
      if (variable) {
        expect(variable[1]).toBe(siteId)
        const stored = options.values?.[variable[2]!]
        return stored ? { data: { ...stored.data }, version: stored.version } : null
      }
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
    capacityOf: options.capacityOf ?? (() => sampleBackendCapacity),
    ...(options.probeAccounts ? { probeAccounts: options.probeAccounts } : {}),
  })
  return {
    credentials,
    ref,
    grant,
    siteId,
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

  it.each([
    ['driverId', 'codex'],
    ['driverId', 'kimi'],
    ['driverId', 'qwen'],
    ['backend', 'openai-chatgpt'],
    ['backend', 'kimi-code'],
  ])('recovers no key whose stored policy names the removed %s %s', async (field, id) => {
    // What a turn of a removed shell left in Vault until the sweeper takes it: history, not a
    // key any turn gets back.
    const f = fixture()
    await f.credentials.issue(f.ref, f.grant)
    const stored = JSON.parse(f.vault()!.grant as string) as Record<string, unknown>
    expect(stored[field]).toBe(f.grant[field as 'driverId' | 'backend'])
    f.alterVault({ grant: JSON.stringify({ ...stored, [field]: id }) })
    expect(await f.credentials.recover(f.ref)).toBeNull()
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  // A synthetic declaration: the sample backend read as one without windows (LlmBackend.capacity).
  const windowless = () => 'none' as const
  const oldSnapshot = (now: Date) => new Date(now.getTime() - 60 * 60_000)

  it('issues a key on an account of a backend without windows, with no probe at all', async () => {
    const probeAccounts = vi.fn(async () => {})
    const now = new Date('2026-09-30T12:00:00Z')
    for (const account of [
      { limitWindows: [], limitsSeenAt: null },
      // A probe of such a backend leaves an empty snapshot behind it: no reason to refresh.
      { limitWindows: [], limitsSeenAt: oldSnapshot(now) },
      { limitWindows: [{ name: '5h', usedPct: 100, resetsAt: null }], limitsSeenAt: null },
    ]) {
      const f = fixture({ capacityOf: windowless, probeAccounts, account })
      await f.credentials.issue(f.ref, f.grant)
      expect(f.key()?.subscriptionAccountId).toBe(f.accountId)
    }
    expect(probeAccounts).not.toHaveBeenCalled()
  })

  it('waits on the pauses of an account without windows, and probes nothing for them', async () => {
    const probeAccounts = vi.fn(async () => {})
    const f = fixture({
      capacityOf: windowless,
      probeAccounts,
      account: { limitWindows: [], coolingUntil: new Date('2026-09-30T12:15:00Z') },
    })
    await expect(f.credentials.issue(f.ref, f.grant)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_WAIT',
    })
    expect(probeAccounts).not.toHaveBeenCalled()
    expect(f.tx.llmKey.create).not.toHaveBeenCalled()
  })

  it('reads the same snapshots by their windows for a backend that has them', async () => {
    const probeAccounts = vi.fn(async () => {})
    const now = new Date('2026-09-30T12:00:00Z')
    const unknown = fixture({ probeAccounts, account: { limitWindows: [] } })
    await expect(unknown.credentials.issue(unknown.ref, unknown.grant)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_WAIT',
    })
    expect(probeAccounts).toHaveBeenLastCalledWith([unknown.accountId])
    const old = fixture({
      capacityOf: () => 'windows',
      probeAccounts,
      account: { limitsSeenAt: oldSnapshot(now) },
    })
    await old.credentials.issue(old.ref, old.grant)
    expect(probeAccounts).toHaveBeenLastCalledWith([old.accountId], { stale: true })
  })

  it('is not composed without the capacity of each backend', () => {
    // A stand composes it in plain JS, unchecked: it stops at once, not at its first issue.
    const options = { prisma: {}, secrets: {} } as unknown as GatewayTurnCredentialsOptions
    expect(() => new GatewayTurnCredentials(options)).toThrow(
      'GatewayTurnCredentials needs the capacity of each backend',
    )
  })

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

describe('the client variables of a turn (plan 53, Р13)', () => {
  const consented = new Date('2026-09-29T10:00:00Z')
  const row = (name: string, keyVersion: number, extra: Partial<SiteVariable> = {}) => ({
    name,
    keyVersion,
    toAgent: true,
    toPreview: true,
    agentConsentAt: consented,
    ...extra,
  })

  it('gives the agent the values of its variables at their versions, kept with the turn', async () => {
    const f = fixture({
      variables: [row('HOOK_TOKEN', 3), row('PAYMENT_KEY', 1), row('RENAMED', 2)],
      values: {
        HOOK_TOKEN: { data: { value: 'hook-token-0003' }, version: 3 },
        PAYMENT_KEY: { data: { value: 'pay-secret-0001' }, version: 1 },
        // Written after the row was read: it waits for the next turn.
        RENAMED: { data: { value: 'newer-value-0003' }, version: 3 },
      },
    })
    const values = await f.credentials.issue(f.ref, f.grant)
    expect(values.envValues).toEqual({
      HOOK_TOKEN: 'hook-token-0003',
      PAYMENT_KEY: 'pay-secret-0001',
    })
    // Kept in the turn's own record in Vault, never in SQL.
    expect(JSON.parse(f.vault()!.env!)).toEqual(values.envValues)
    expect(JSON.stringify(f.tx.llmKey.create.mock.calls)).not.toContain('pay-secret-0001')
    // A retry and a recovery return what the sandbox got, whatever the site holds now.
    expect(await f.credentials.issue(f.ref, f.grant)).toEqual(values)
    expect(await f.credentials.recover(f.ref)).toEqual(values)
  })

  it('gives nothing without consent, for a removed variable, or in a workspace of client data', async () => {
    const values = {
      PAYMENT_KEY: { data: { value: 'pay-secret-0001' }, version: 1 },
      REMOVED_KEY: { data: { removed: '2026-09-29T11:00:00.000Z' }, version: 2 },
      OFF_KEY: { data: { value: 'off-value-0001' }, version: 1 },
    }
    const variables = [
      row('PAYMENT_KEY', 1),
      row('REMOVED_KEY', 2),
      row('OFF_KEY', 1, { toAgent: false }),
      row('UNSIGNED_KEY', 1, { agentConsentAt: null }),
    ]
    const synthetic = fixture({ variables, values })
    expect((await synthetic.credentials.issue(synthetic.ref, synthetic.grant)).envValues).toEqual({
      PAYMENT_KEY: 'pay-secret-0001',
    })
    // Past the gate of 152-FZ for its provider (this fake clears every one), a workspace of
    // client data still gives the agent no variable: none is even read.
    const client = fixture({ variables, values, dataClass: 'client' })
    expect(await client.credentials.issue(client.ref, client.grant)).not.toHaveProperty('envValues')
    expect(
      client.secrets.kvRead.mock.calls.filter(([path]) => String(path).startsWith('kv/sites/')),
    ).toEqual([])
    const none = fixture()
    const bare = await none.credentials.issue(none.ref, none.grant)
    expect(bare).not.toHaveProperty('envValues')
    expect(none.vault()).not.toHaveProperty('env')
  })

  it('gives a task in the browser no variable: its `web` tools reach the live site unchecked (plan 57)', async () => {
    const variables = [row('PAYMENT_KEY', 1)]
    const values = { PAYMENT_KEY: { data: { value: 'pay-secret-0001' }, version: 1 } }
    // The same consented variable of a synthetic workspace reaches a repository task's commands.
    const repository = fixture({ variables, values })
    expect(
      (await repository.credentials.issue(repository.ref, repository.grant)).envValues,
    ).toEqual({ PAYMENT_KEY: 'pay-secret-0001' })
    // A task in the browser would type it onto the site through `web_fill` with no candidate or
    // release to refuse it: its turn gets none, and none is even read.
    const browser = fixture({ variables, values, needsBrowser: true })
    const issued = await browser.credentials.issue(browser.ref, browser.grant)
    expect(issued).not.toHaveProperty('envValues')
    expect(browser.vault()).not.toHaveProperty('env')
    expect(browser.tx.siteEnvVar.findMany).not.toHaveBeenCalled()
    expect(
      browser.secrets.kvRead.mock.calls.filter(([path]) => String(path).startsWith('kv/sites/')),
    ).toEqual([])
    // A retry and a recovery return the same record, still without values.
    expect(await browser.credentials.issue(browser.ref, browser.grant)).toEqual(issued)
    expect(await browser.credentials.recover(browser.ref)).toEqual(issued)
  })

  it('carries every set of variables a site may have, and refuses more than that', async () => {
    // 8 KiB of what JSON escapes sixfold: the most one record of the turn has to hold.
    const worst = '\u0001'.repeat(8 * 1024)
    const site = (count: number) => {
      const names = Array.from({ length: count }, (_, i) => `BIG_${i}`)
      return fixture({
        variables: names.map((name) => row(name, 1)),
        values: Object.fromEntries(
          names.map((name) => [name, { data: { value: worst }, version: 1 }]),
        ),
      })
    }
    const full = site(64)
    const issued = await full.credentials.issue(full.ref, full.grant)
    expect(Object.keys(issued.envValues!)).toHaveLength(64)
    expect(await full.credentials.recover(full.ref)).toEqual(issued)
    // Only two writers adding rows at once get a site past 64 variables.
    const over = site(70)
    await expect(over.credentials.issue(over.ref, over.grant)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      details: { reason: 'client_variables_too_large' },
    })
    expect(over.vault()).toBeNull()
  })

  it('takes a stored record with variables that no longer pass their rules for no record', async () => {
    const f = fixture({
      variables: [row('PAYMENT_KEY', 1)],
      values: { PAYMENT_KEY: { data: { value: 'pay-secret-0001' }, version: 1 } },
    })
    await f.credentials.issue(f.ref, f.grant)
    f.alterVault({ env: JSON.stringify({ PATH: '/tmp/planted-0001' }) })
    expect(await f.credentials.recover(f.ref)).toBeNull()
  })
})
