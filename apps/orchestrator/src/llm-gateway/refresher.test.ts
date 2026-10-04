import type { Prisma, PrismaClient } from '@repo/db'
import type { EgressHttp, LlmBackend, RefreshOutcome, SecretStore } from '@repo/domain'
import { kimiCodeBackend } from '@repo/llm-backends'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCredentialSource, encodeSubscriptionCredential } from './credentials.ts'
import { createControlEgress, EgressNotSentError, type StreamingEgress } from './egress.ts'
import { SubscriptionRefresher } from './refresher.ts'
import type { SubscriptionLocks } from './session-lock.ts'

const HOUR = 3_600_000
const initial = { v: '1', kind: 'kimi_api_key', apiKey: 'synthetic-old-key' }
const rotated = { ...initial, apiKey: 'synthetic-new-key' }
const closing: SubscriptionRefresher[] = []
afterEach(async () => {
  await Promise.all(closing.splice(0).map((refresher) => refresher.close()))
})

function fixture() {
  let now = Date.UTC(2026, 8, 30, 12)
  const row = {
    id: 'account_1',
    enabled: true,
    status: 'active',
    health: 'ok',
    healthReason: null as string | null,
    provider: { slug: 'kimi-code', enabled: true, kind: 'subscription' },
    credentialRefId: 'ref_1',
    credentialRef: { vaultPath: 'subs/kimi-code/account_1', keyVersion: 1 },
    credentialsRevokedAt: null as Date | null,
    credentialVersion: 1,
    credentialExpiresAt: new Date(now + 12 * HOUR),
    credentialRefreshedAt: new Date(now - 24 * HOUR),
    refreshStartedAt: null as Date | null,
    refreshFinishedAt: null as Date | null,
    refreshFailures: 0,
    externalAccountId: null,
    plan: 'synthetic',
    retireRequestedAt: null as Date | null,
  }
  const apply = (data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value)
        Reflect.set(row, key, Number(Reflect.get(row, key)) + Number(value.increment))
      else Reflect.set(row, key, value)
    }
  }
  const updateMany = vi.fn(
    async ({ data, where }: { data: Record<string, unknown>; where?: Record<string, unknown> }) => {
      if (typeof where?.health === 'string' && where.health !== row.health) return { count: 0 }
      if (
        where?.health &&
        typeof where.health === 'object' &&
        'in' in where.health &&
        !(where.health.in as string[]).includes(row.health)
      )
        return { count: 0 }
      if (
        Array.isArray(where?.OR) &&
        !where.OR.some((condition: Record<string, unknown>) =>
          Object.entries(condition).every(([key, expected]) => {
            const actual: unknown = Reflect.get(row, key) ?? null
            if (expected && typeof expected === 'object' && 'in' in expected)
              return (expected.in as unknown[]).includes(actual)
            if (expected && typeof expected === 'object' && 'notIn' in expected)
              return actual !== null && !(expected.notIn as unknown[]).includes(actual)
            if (expected && typeof expected === 'object' && 'lt' in expected)
              return actual !== null && +(actual as Date) < +(expected.lt as Date)
            return expected === actual
          }),
        )
      )
        return { count: 0 }
      if (
        typeof where?.credentialVersion === 'number' &&
        where.credentialVersion !== row.credentialVersion
      )
        return { count: 0 }
      apply(data)
      return { count: 1 }
    },
  )
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    apply(data)
    return row
  })
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn(async () => [{ now: new Date(now) }]),
    subscriptionAccount: {
      findUnique: vi.fn(
        async (_query?: Prisma.SubscriptionAccountFindUniqueArgs): Promise<typeof row | null> => ({
          ...row,
        }),
      ),
      findMany: vi.fn(async (_query?: Prisma.SubscriptionAccountFindManyArgs) => [{ ...row }]),
      updateMany,
      update,
    },
    credentialRef: { update: vi.fn().mockResolvedValue({}) },
  }
  const db = {
    ...tx,
    $transaction: vi.fn(async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx)),
  }
  let vault = { version: 1, data: encodeSubscriptionCredential(initial) }
  const kvRead = vi.fn<SecretStore['kvRead']>(async () => vault)
  const kvWrite = vi.fn<SecretStore['kvWrite']>(async (_path, data, options) => {
    expect(options?.cas).toBe(vault.version)
    vault = { version: vault.version + 1, data }
    return { version: vault.version }
  })
  const secrets = { kvRead, kvWrite } as unknown as SecretStore
  const credentials = createCredentialSource(secrets, { now: () => now })
  const refresh = vi.fn<NonNullable<LlmBackend['refresh']>>().mockResolvedValue({
    kind: 'ok',
    credential: rotated,
  })
  const revoke = vi.fn<NonNullable<LlmBackend['revoke']>>().mockResolvedValue(undefined)
  const http = {
    request: vi
      .fn<EgressHttp['request']>()
      .mockResolvedValue({ status: 200, headers: new Headers(), body: new Uint8Array() }),
  }
  const backend: LlmBackend = {
    ...kimiCodeBackend,
    credentialMetadata: () => ({
      externalAccountId: null,
      plan: 'synthetic',
      accessIssuedAt: new Date(now),
      accessExpiresAt: new Date(now + 48 * HOUR),
    }),
    // Like real adapters: one OAuth request through the given transport, whose failure is
    // folded into an unknown outcome; `refresh` then plays the provider's answer.
    refresh: async (credential, transport) => {
      try {
        await transport.request(
          { url: 'https://auth.invalid/token', method: 'POST', headers: new Headers() },
          { signal: AbortSignal.timeout(1_000) },
        )
      } catch {
        return { kind: 'ambiguous' }
      }
      return refresh(credential, transport)
    },
    revoke,
  }
  const release = vi.fn().mockResolvedValue(undefined)
  const locks: SubscriptionLocks = {
    tryAcquire: vi.fn().mockResolvedValue({ release }),
    close: vi.fn().mockResolvedValue(undefined),
  }
  const channelHealthy = vi.fn(() => true)
  const onRegion = vi.fn()
  const logger = vi.fn()
  const sleep = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
    if (!signal.aborted) now += milliseconds
  })
  const options = {
    prisma: db as unknown as PrismaClient,
    secrets,
    credentials,
    backends: [backend],
    http,
    channelHealthy,
    onRegion,
    locks,
    logger,
    now: () => now,
    random: () => 0.5,
    sleep,
  }
  const refresher = new SubscriptionRefresher(options)
  closing.push(refresher)
  const settled = async () => {
    // A ready credential is intentionally delivered before its persistence job finishes.
    for (let i = 0; i < 30; i += 1) await Promise.resolve()
  }
  return {
    row,
    db,
    tx,
    kvRead,
    kvWrite,
    refresh,
    revoke,
    credentials,
    backend,
    locks,
    release,
    channelHealthy,
    onRegion,
    logger,
    sleep,
    http,
    refresher,
    options,
    settled,
    time: () => now,
    setTime: (value: number) => (now = value),
    setVault: (value: typeof vault) => (vault = value),
  }
}

const auth = (f: ReturnType<typeof fixture>) => f.refresher.refresh(f.row.id, 'auth', 1)

function poolFixture(kind: 'unsupported' | 'locked' | 'revoke-failed', retiring: boolean) {
  const f = fixture()
  f.row.id = 'account_100'
  f.row.provider.slug = 'openai-chatgpt'
  f.row.credentialRef.vaultPath = `subs/openai-chatgpt/${f.row.id}`
  f.row.enabled = !retiring
  f.row.retireRequestedAt = retiring ? new Date(f.time()) : null
  const backend: LlmBackend = { ...f.backend, id: 'openai-chatgpt' }
  const blockers = Array.from({ length: 100 }, (_, index) => {
    const id = `account_${String(index).padStart(3, '0')}`
    const provider = kind === 'unsupported' ? 'kimi-code' : backend.id
    return {
      ...f.row,
      id,
      provider: { ...f.row.provider, slug: provider },
      credentialRef: { ...f.row.credentialRef, vaultPath: `subs/${provider}/${id}` },
      credentialRefreshedAt: new Date(f.time() - 48 * HOUR),
      retireRequestedAt: retiring ? new Date(f.time() - HOUR) : null,
    }
  })
  const rows = [...blockers, f.row]
  f.tx.subscriptionAccount.findMany.mockImplementation(async (query) => {
    const provider = query?.where?.provider
    const slug = provider && 'slug' in provider ? provider.slug : undefined
    const supported =
      slug && typeof slug === 'object' && 'in' in slug && Array.isArray(slug.in)
        ? slug.in
        : undefined
    const id = query?.where?.id
    const after =
      id && typeof id === 'object' && 'gt' in id && typeof id.gt === 'string' ? id.gt : undefined
    return rows
      .filter(
        (row) =>
          (!supported || supported.includes(row.provider.slug)) &&
          (!after || row.id > after) &&
          row.enabled === !retiring &&
          row.credentialsRevokedAt === null,
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, query?.take ?? rows.length)
      .map((row) => ({ ...row }))
  })
  f.tx.subscriptionAccount.findUnique.mockImplementation(async (query) => {
    const row = rows.find((account) => account.id === query?.where.id)
    if (!row) throw new Error('Synthetic pool account not found')
    return { ...row }
  })
  vi.mocked(f.locks.tryAcquire).mockImplementation(async (id) =>
    kind === 'locked' && id !== f.row.id ? null : { release: f.release },
  )
  if (kind === 'revoke-failed') {
    f.kvRead.mockImplementation(async (path) => ({
      version: 1,
      data: encodeSubscriptionCredential({
        ...initial,
        apiKey: path.endsWith(f.row.id) ? initial.apiKey : 'synthetic-revoke-failure',
      }),
    }))
    f.revoke.mockImplementation(async (credential) => {
      if (credential.apiKey === 'synthetic-revoke-failure')
        throw new Error('Synthetic revoke unavailable')
    })
  }
  const refresher = new SubscriptionRefresher({
    ...f.options,
    backends: [kimiCodeBackend, backend],
  })
  closing.push(refresher)
  return { ...f, refresher }
}

describe('single-writer subscription token rotation', () => {
  it('commits a durable marker before OAuth, installs the result, CAS-writes once and commits metadata', async () => {
    const f = fixture()
    f.refresh.mockImplementation(async () => {
      expect(f.row.refreshStartedAt).toEqual(new Date(f.time()))
      expect(f.row.refreshFinishedAt).toBeNull()
      expect(f.kvWrite).not.toHaveBeenCalled()
      return { kind: 'ok', credential: rotated }
    })
    expect(await auth(f)).toEqual(rotated)
    await f.settled()
    expect(f.kvWrite).toHaveBeenCalledExactlyOnceWith(
      f.row.credentialRef.vaultPath,
      encodeSubscriptionCredential(rotated),
      { cas: 1 },
    )
    expect(f.row.credentialVersion).toBe(2)
    expect(f.row.refreshFinishedAt).toEqual(new Date(f.time()))
    expect(f.tx.credentialRef.update).toHaveBeenCalledWith({
      where: { id: 'ref_1' },
      data: { keyVersion: 2 },
    })
    expect(f.release).toHaveBeenCalledTimes(1)
  })

  it('coalesces simultaneous auth refreshes and skips a later 401 from the old version', async () => {
    const f = fixture()
    expect(await Promise.all([auth(f), auth(f), auth(f)])).toEqual([rotated, rotated, rotated])
    await f.settled()
    expect(await auth(f)).toEqual(rotated)
    expect(f.refresh).toHaveBeenCalledTimes(1)
  })

  it('repairs Vvault > Vdb without rotating, including unfinished crash markers', async () => {
    const f = fixture()
    f.row.refreshStartedAt = new Date(f.time() - HOUR)
    f.row.healthReason = 'refresh_ambiguous'
    f.setVault({ version: 2, data: encodeSubscriptionCredential(rotated) })
    expect(await auth(f)).toEqual(rotated)
    await f.settled()
    expect(f.refresh).not.toHaveBeenCalled()
    expect(f.kvWrite).not.toHaveBeenCalled()
    expect(f.row.credentialVersion).toBe(2)
    expect(f.row.healthReason).toBeNull()
  })

  it.each(['scheduled', 'auth'] as const)(
    'never repeats an equal-version interrupted refresh for %s',
    async (reason) => {
      const f = fixture()
      f.row.refreshStartedAt = new Date(f.time() - HOUR)
      expect(await f.refresher.refresh(f.row.id, reason, 1)).toBeNull()
      expect(f.refresh).not.toHaveBeenCalled()
      expect(f.row.healthReason).toBe('refresh_ambiguous')
      expect(f.row.health).toBe(reason === 'auth' ? 'needs_relogin' : 'ok')
      expect(f.row.refreshFinishedAt).toBeNull()
    },
  )

  it('does not reopen an ambiguous account after a prior 401 required a new login', async () => {
    const f = fixture()
    f.row.refreshStartedAt = new Date(f.time() - HOUR)
    expect(await auth(f)).toBeNull()
    expect(f.row.health).toBe('needs_relogin')
    await f.refresher.tick()
    expect(f.row.health).toBe('needs_relogin')
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it('keeps a concurrent risk suspension after an ambiguous provider response', async () => {
    const f = fixture()
    f.refresh.mockImplementation(async () => {
      f.row.health = 'suspended'
      f.row.healthReason = 'account_risk'
      return { kind: 'ambiguous' }
    })
    expect(await auth(f)).toBeNull()
    expect(f.row.health).toBe('suspended')
    expect(f.row.healthReason).toBe('account_risk')
    expect(f.row.refreshStartedAt).not.toBeNull()
    expect(f.row.refreshFinishedAt).toBeNull()
  })

  it('marks an expired ambiguous credential needs_relogin', async () => {
    const f = fixture()
    f.backend.credentialMetadata = () => ({
      externalAccountId: null,
      plan: 'synthetic',
      accessIssuedAt: null,
      accessExpiresAt: new Date(f.time() - 1),
    })
    f.row.refreshStartedAt = new Date(f.time() - HOUR)
    await f.refresher.refresh(f.row.id, 'scheduled')
    expect(f.row.health).toBe('needs_relogin')
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it.each([{ kind: 'ambiguous' }, { kind: 'final', reason: 'auth' }] as RefreshOutcome[])(
    'preserves the marker rules for %j',
    async (outcome) => {
      const f = fixture()
      f.refresh.mockResolvedValue(outcome)
      expect(await auth(f)).toBeNull()
      expect(f.kvWrite).not.toHaveBeenCalled()
      expect(f.row.refreshFailures).toBe(1)
      if (outcome.kind === 'ambiguous') {
        expect(f.row.refreshFinishedAt).toBeNull()
        expect(f.row.health).toBe('needs_relogin')
      } else {
        expect(f.row.health).toBe('needs_relogin')
        expect(f.row.refreshFinishedAt).not.toBeNull()
      }
    },
  )

  it('retries a structural region refusal after ten minutes instead of waiting six hours', async () => {
    const f = fixture()
    f.row.credentialRefreshedAt = new Date(f.time() - HOUR)
    f.refresh.mockResolvedValueOnce({ kind: 'final', reason: 'region' })
    await auth(f)
    // The account it was confirmed for is the one the egress rechecks before reopening.
    expect(f.onRegion).toHaveBeenCalledExactlyOnceWith(f.row.id)
    expect(f.row.refreshFinishedAt).not.toBeNull()
    expect(f.row.healthReason).toBe('refresh_region')
    await f.refresher.tick()
    expect(f.refresh).toHaveBeenCalledTimes(1)
    f.setTime(f.time() + 600_000)
    await f.refresher.tick()
    expect(f.refresh).toHaveBeenCalledTimes(2)
    expect(f.row.healthReason).toBeNull()
  })

  it('requires a healthy channel before sending an OAuth request', async () => {
    const f = fixture()
    f.channelHealthy.mockReturnValue(false)
    await auth(f)
    expect(f.refresh).not.toHaveBeenCalled()
    expect(f.row.refreshStartedAt).toBeNull()
  })

  it('skips when another process holds the account session lock', async () => {
    const f = fixture()
    vi.mocked(f.locks.tryAcquire).mockResolvedValue(null)
    expect(await auth(f)).toBeNull()
    expect(f.kvRead).not.toHaveBeenCalled()
    expect(f.refresh).not.toHaveBeenCalled()
  })

  it('observes the six-hour minimum for scheduled refresh but allows auth', async () => {
    const f = fixture()
    f.row.credentialRefreshedAt = new Date(f.time() - 5 * HOUR)
    f.row.credentialExpiresAt = new Date(f.time() + 1)
    await f.refresher.tick()
    expect(f.refresh).not.toHaveBeenCalled()
    expect(await auth(f)).toEqual(rotated)
  })

  it('refreshes after eight days without relying on a known expiry', async () => {
    const f = fixture()
    f.row.credentialRefreshedAt = new Date(f.time() - 9 * 24 * HOUR)
    Reflect.set(f.row, 'credentialExpiresAt', null)
    await f.refresher.tick()
    expect(f.refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps a stable injected jitter for repeated scheduler passes', async () => {
    const f = fixture()
    const random = vi.fn(() => 1)
    const scheduled = new SubscriptionRefresher({ ...f.options, random })
    closing.push(scheduled)
    f.row.credentialRefreshedAt = new Date(f.time() - 10 * HOUR)
    f.row.credentialExpiresAt = new Date(f.time() + 20 * HOUR)
    await scheduled.tick()
    await scheduled.tick()
    expect(f.refresh).not.toHaveBeenCalled()
    expect(random).toHaveBeenCalledTimes(1)
  })

  it('delivers the pinned new token before unavailable Vault recovers and never rotates twice', async () => {
    const f = fixture()
    f.kvWrite.mockRejectedValue(new Error('synthetic-secret-never-logged'))
    let wake!: () => void
    f.sleep.mockImplementation(
      (_milliseconds, signal) =>
        new Promise((resolve) => {
          wake = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
        }),
    )
    expect(await auth(f)).toEqual(rotated)
    await f.settled()
    expect(
      await f.credentials.get(
        {
          accountId: f.row.id,
          credentialRef: f.row.credentialRef.vaultPath,
          credentialVersion: 1,
        },
        f.backend,
      ),
    ).toEqual(rotated)
    expect(await auth(f)).toEqual(rotated)
    expect(f.refresh).toHaveBeenCalledTimes(1)
    expect(f.release).not.toHaveBeenCalled()
    f.kvWrite.mockImplementation(async (_path, data) => {
      f.setVault({ version: 2, data })
      return { version: 2 }
    })
    wake()
    await f.settled()
    expect(f.row.credentialVersion).toBe(2)
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.logger.mock.calls)).not.toContain('secret')
  })

  it('reconciles an unknown CAS response by reading back the exact new value', async () => {
    const f = fixture()
    f.kvWrite.mockImplementation(async (_path, data) => {
      f.setVault({ version: 2, data })
      throw new Error('Lost synthetic response')
    })
    expect(await auth(f)).toEqual(rotated)
    await f.settled()
    expect(f.kvWrite).toHaveBeenCalledTimes(1)
    expect(f.row.credentialVersion).toBe(2)
    expect(f.refresh).toHaveBeenCalledTimes(1)
  })

  it('fails closed if CAS instead reveals a different credential at the new version', async () => {
    const f = fixture()
    f.kvWrite.mockImplementation(async () => {
      f.setVault({
        version: 2,
        data: encodeSubscriptionCredential({ ...initial, apiKey: 'synthetic-third' }),
      })
      throw new Error('CAS mismatch')
    })
    await auth(f)
    await f.settled()
    expect(f.row.health).toBe('needs_relogin')
    expect(f.row.healthReason).toBe('refresh_conflict')
    expect(f.refresh).toHaveBeenCalledTimes(1)
  })

  it.each(['plan', 'externalAccountId'] as const)(
    'suspends a changed %s while preserving its rotated credential in Vault',
    async (field) => {
      const f = fixture()
      const metadata = f.backend.credentialMetadata(initial)
      f.backend.credentialMetadata = (credential) => ({
        ...metadata,
        ...(credential.apiKey === rotated.apiKey ? { [field]: 'changed' } : {}),
      })
      expect(await auth(f)).toBeNull()
      await f.settled()
      expect(f.row.health).toBe('suspended')
      expect(f.row.healthReason).toBe(
        field === 'plan' ? 'plan_changed' : 'external_account_changed',
      )
      expect(f.row.credentialVersion).toBe(2)
      expect(f.kvWrite).toHaveBeenCalledTimes(1)
    },
  )

  it('reports persistence trouble after two minutes and bounds the retry delay at sixty seconds', async () => {
    const f = fixture()
    f.kvWrite.mockRejectedValue(new Error('synthetic Vault outage'))
    f.sleep.mockImplementation(async (milliseconds) => {
      f.setTime(f.time() + milliseconds)
      if (f.time() - +f.row.refreshStartedAt! > 240_000)
        f.kvWrite.mockImplementation(async (_path, data) => {
          f.setVault({ version: 2, data })
          return { version: 2 }
        })
    })
    expect(await auth(f)).toEqual(rotated)
    for (let i = 0; i < 15; i += 1) await f.settled()
    expect(f.logger).toHaveBeenCalledWith('vault_write_pending')
    expect(Math.max(...f.sleep.mock.calls.map(([delay]) => delay))).toBe(60_000)
    expect(f.row.credentialVersion).toBe(2)
  })

  it('preserves a concurrent confirmed suspension while Vault is unavailable and after it recovers', async () => {
    const f = fixture()
    f.kvWrite.mockRejectedValue(new Error('synthetic Vault outage'))
    f.sleep.mockImplementation(async (milliseconds) => {
      f.setTime(f.time() + milliseconds)
      f.row.health = 'suspended'
      f.row.healthReason = 'account_risk'
      if (f.time() - +f.row.refreshStartedAt! > 240_000)
        f.kvWrite.mockImplementation(async (_path, data) => {
          f.setVault({ version: 2, data })
          return { version: 2 }
        })
    })
    expect(await auth(f)).toEqual(rotated)
    for (let i = 0; i < 30; i += 1) await f.settled()
    expect(f.logger).toHaveBeenCalledWith('vault_write_pending')
    expect(f.row.credentialVersion).toBe(2)
    expect(f.row.health).toBe('suspended')
    expect(f.row.healthReason).toBe('account_risk')
  })

  it('revokes only explicitly retired and disabled OAuth accounts under the same session lock', async () => {
    const f = fixture()
    f.row.enabled = false
    f.row.retireRequestedAt = new Date(f.time())
    await f.refresher.retire()
    expect(f.revoke).toHaveBeenCalledTimes(1)
    expect(f.row.credentialsRevokedAt).toEqual(new Date(f.time()))
    expect(f.locks.tryAcquire).toHaveBeenCalledWith(f.row.id)
    f.row.enabled = true
    f.row.credentialsRevokedAt = null
    await f.refresher.retire()
    expect(f.revoke).toHaveBeenCalledTimes(1)
  })

  it('reports a failed revocation and retries it after 1, 5 and then every 15 minutes', async () => {
    const f = fixture()
    f.row.enabled = false
    f.row.retireRequestedAt = new Date(f.time())
    f.revoke.mockRejectedValue(new Error('synthetic revoke refusal with secret-token'))
    const attemptsAfter = async (minutes: number) => {
      f.setTime(f.time() + minutes * 60_000)
      await f.refresher.retire()
      return f.revoke.mock.calls.length
    }
    expect(await attemptsAfter(0)).toBe(1)
    expect(f.logger).toHaveBeenCalledExactlyOnceWith('revoke_failed')
    expect(await attemptsAfter(0.5)).toBe(1)
    expect(await attemptsAfter(0.5)).toBe(2)
    expect(await attemptsAfter(4)).toBe(2)
    expect(await attemptsAfter(1)).toBe(3)
    expect(await attemptsAfter(14)).toBe(3)
    expect(await attemptsAfter(1)).toBe(4)
    expect(await attemptsAfter(15)).toBe(5)
    expect(JSON.stringify(f.logger.mock.calls)).not.toContain('secret')
    f.revoke.mockResolvedValue(undefined)
    expect(await attemptsAfter(15)).toBe(6)
    expect(f.row.credentialsRevokedAt).toEqual(new Date(f.time()))
  })

  it('leaves API-key retirement for the operator when the backend has no revoke', async () => {
    const f = fixture()
    delete f.backend.revoke
    f.row.enabled = false
    f.row.retireRequestedAt = new Date(f.time())
    await f.refresher.retire()
    expect(f.row.credentialsRevokedAt).toBeNull()
    expect(f.revoke).not.toHaveBeenCalled()
  })

  it.each(['unsupported', 'locked'] as const)(
    'refreshes the next account behind a full page of %s accounts',
    async (kind) => {
      const f = poolFixture(kind, false)
      await f.refresher.tick()
      await f.refresher.tick()
      expect(f.refresh).toHaveBeenCalledTimes(1)
      expect(f.row.credentialVersion).toBe(2)
    },
  )

  it('a final auth refusal overrides a credit warning and is not sent again', async () => {
    const f = fixture()
    f.row.healthReason = 'credits_balance'
    f.refresh.mockResolvedValue({ kind: 'final', reason: 'auth' })
    await f.refresher.tick()
    expect(f.row).toMatchObject({ health: 'needs_relogin', healthReason: 'refresh_auth' })
    f.tx.subscriptionAccount.findMany.mockImplementation(async () =>
      f.row.health === 'ok' ? [{ ...f.row }] : [],
    )
    f.setTime(f.time() + 5 * 60_000)
    await f.refresher.tick()
    expect(f.refresh).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ kind: 'ambiguous' }, 'refresh_ambiguous'],
    [{ kind: 'final', reason: 'region' }, 'refresh_region'],
  ] as const)('records %j over a credit warning as %s', async (outcome, reason) => {
    const f = fixture()
    f.row.healthReason = 'credits_balance'
    f.refresh.mockResolvedValue(outcome)
    await f.refresher.refresh(f.row.id, 'scheduled')
    expect(f.row.healthReason).toBe(reason)
  })

  describe('a refresh request that provably never left the process', () => {
    it.each([
      [
        'refused by the egress tunnel',
        (f: ReturnType<typeof fixture>) =>
          f.http.request.mockRejectedValue(new EgressNotSentError()),
      ],
      [
        'stopped by a channel that failed after the marker',
        (f: ReturnType<typeof fixture>) =>
          f.channelHealthy.mockReturnValueOnce(true).mockReturnValue(false),
      ],
    ])('when %s closes its marker and is retried later', async (_name, arrange) => {
      const f = fixture()
      arrange(f)
      expect(await f.refresher.refresh(f.row.id, 'scheduled')).toBeNull()
      expect(f.row).toMatchObject({
        health: 'ok',
        healthReason: null,
        refreshFailures: 1,
        refreshFinishedAt: new Date(f.time()),
      })
      expect(f.logger).toHaveBeenCalledWith('refresh_not_sent')
      expect(f.logger).not.toHaveBeenCalledWith('refresh_ambiguous')
      f.channelHealthy.mockReturnValue(true)
      f.http.request.mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: new Uint8Array(),
      })
      f.setTime(f.time() + 5 * 60_000)
      await f.refresher.tick()
      expect(f.refresh).toHaveBeenCalledTimes(1)
      expect(f.row.credentialVersion).toBe(2)
    })

    it('stays ambiguous once the request may have reached the provider', async () => {
      const f = fixture()
      f.http.request.mockRejectedValue(new Error('Subscription egress unavailable'))
      await f.refresher.refresh(f.row.id, 'scheduled')
      expect(f.row).toMatchObject({ healthReason: 'refresh_ambiguous', refreshFinishedAt: null })
      expect(f.logger).not.toHaveBeenCalledWith('refresh_not_sent')
    })

    // Like the adapters' controlRequest (20 s): its own deadline answers at once, while the
    // transport promise is still unsettled.
    const deadlineRefresh: NonNullable<LlmBackend['refresh']> = async (_credential, transport) => {
      const controller = new AbortController()
      try {
        await Promise.race([
          transport.request(
            { url: 'https://auth.invalid/token', method: 'POST', headers: new Headers() },
            { signal: controller.signal },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => {
              controller.abort()
              reject(new Error('Synthetic control deadline'))
            }, 20),
          ),
        ])
      } catch {
        return { kind: 'ambiguous' }
      }
      return { kind: 'ok', credential: rotated }
    }

    it('stays ambiguous when the control deadline cuts an answer whose body never completes', async () => {
      const f = fixture()
      const aborted = Promise.withResolvers<void>()
      // The provider has the request and answered with headers; the body stalls. An abort fails
      // that read only on a later turn of the event loop, as the CONNECT transport does.
      const stalled: StreamingEgress = {
        request: async (_request, { signal }) => ({
          status: 200,
          headers: new Headers(),
          rawHeaders: [],
          body: (async function* (): AsyncGenerator<Uint8Array> {
            yield new TextEncoder().encode('{"access_token":"')
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => setImmediate(resolve), { once: true }),
            )
            aborted.resolve()
            throw new Error('Subscription egress unavailable')
          })(),
          close: () => undefined,
        }),
      }
      f.http.request.mockImplementation(createControlEgress(stalled).request)
      f.backend.refresh = deadlineRefresh
      expect(await f.refresher.refresh(f.row.id, 'scheduled')).toBeNull()
      await aborted.promise
      await f.settled()
      expect(f.logger).toHaveBeenCalledWith('refresh_ambiguous')
      expect(f.logger).not.toHaveBeenCalledWith('refresh_not_sent')
      expect(f.row).toMatchObject({
        health: 'ok',
        healthReason: 'refresh_ambiguous',
        refreshFinishedAt: null,
      })
      // The single-use refresh token is not sent a second time.
      f.setTime(f.time() + 5 * 60_000)
      await f.refresher.tick()
      expect(f.http.request).toHaveBeenCalledTimes(1)
    })

    it('stays unsent when the deadline cuts a request the transport then proves never left', async () => {
      const f = fixture()
      // A CONNECT that never answers: nothing was written to the provider. The transport says
      // so only after the adapter's deadline has already answered — on a later turn of the
      // event loop here, a few microtasks later in production.
      const hanging: StreamingEgress = {
        request: (_request, { signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => setImmediate(() => reject(new EgressNotSentError())),
              { once: true },
            ),
          ),
      }
      f.http.request.mockImplementation(createControlEgress(hanging).request)
      f.backend.refresh = deadlineRefresh
      expect(await f.refresher.refresh(f.row.id, 'scheduled')).toBeNull()
      expect(f.logger).toHaveBeenCalledWith('refresh_not_sent')
      expect(f.logger).not.toHaveBeenCalledWith('refresh_ambiguous')
      // The refresh token is still the only valid one: the marker closes and a later tick retries.
      expect(f.row).toMatchObject({
        health: 'ok',
        healthReason: null,
        refreshFailures: 1,
        refreshFinishedAt: new Date(f.time()),
      })
    })

    it('reads a request that never settles as sent, after a bounded wait', async () => {
      const f = fixture()
      // A transport that ignores cancellation proves nothing: the token may be at the provider.
      f.http.request.mockReturnValue(new Promise(() => undefined))
      f.backend.refresh = deadlineRefresh
      const started = Date.now()
      expect(await f.refresher.refresh(f.row.id, 'scheduled')).toBeNull()
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(f.logger).toHaveBeenCalledWith('refresh_ambiguous')
      expect(f.row).toMatchObject({ healthReason: 'refresh_ambiguous', refreshFinishedAt: null })
    })
  })

  describe('a provider-issued rotation is never discarded', () => {
    const withLease = (f: ReturnType<typeof fixture>) => {
      const lost = new AbortController()
      vi.mocked(f.locks.tryAcquire).mockResolvedValue({ release: f.release, signal: lost.signal })
      return lost
    }

    it('persists tokens answered after the PostgreSQL session lock was lost', async () => {
      const f = fixture()
      const lost = withLease(f)
      f.refresh.mockImplementation(async () => {
        lost.abort()
        return { kind: 'ok', credential: rotated }
      })
      expect(await auth(f)).toEqual(rotated)
      await f.settled()
      expect(f.kvWrite).toHaveBeenCalledTimes(1)
      expect(f.row.credentialVersion).toBe(2)
    })

    it('keeps writing Vault after losing the lock during an outage', async () => {
      const f = fixture()
      const lost = withLease(f)
      f.kvWrite.mockRejectedValue(new Error('synthetic Vault outage'))
      f.sleep.mockImplementation(async (milliseconds) => {
        f.setTime(f.time() + milliseconds)
        lost.abort()
        f.kvWrite.mockImplementation(async (_path, data) => {
          f.setVault({ version: 2, data })
          return { version: 2 }
        })
      })
      expect(await auth(f)).toEqual(rotated)
      for (let i = 0; i < 5; i += 1) await f.settled()
      expect(f.row.credentialVersion).toBe(2)
      expect(f.release).toHaveBeenCalledTimes(1)
    })

    it('lets an OAuth request in flight finish at shutdown and writes its result once', async () => {
      const f = fixture()
      const answer = Promise.withResolvers<RefreshOutcome>()
      f.refresh.mockReturnValue(answer.promise)
      const waiting = auth(f)
      await vi.waitFor(() => expect(f.refresh).toHaveBeenCalled())
      const closed = f.refresher.close()
      expect(await waiting).toBeNull()
      answer.resolve({ kind: 'ok', credential: rotated })
      await closed
      expect(f.kvWrite).toHaveBeenCalledTimes(1)
      expect(f.row.credentialVersion).toBe(2)
    })

    it('reports a rotation that could not be written before shutdown', async () => {
      const f = fixture()
      f.kvWrite.mockRejectedValue(new Error('synthetic Vault outage'))
      f.sleep.mockImplementation(
        (_milliseconds, signal) =>
          new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          ),
      )
      expect(await auth(f)).toEqual(rotated)
      await f.settled()
      await f.refresher.close()
      expect(f.kvWrite).toHaveBeenCalledTimes(2)
      expect(f.logger).toHaveBeenCalledWith('refresh_unpersisted')
    })

    it.each(['lock loss', 'shutdown'] as const)(
      'closes a committed marker as not sent after %s before the request',
      async (cause) => {
        const f = fixture()
        const lost = withLease(f)
        f.tx.subscriptionAccount.updateMany.mockImplementationOnce(async ({ data }) => {
          Object.assign(f.row, data)
          if (cause === 'lock loss') lost.abort()
          else void f.refresher.close()
          return { count: 1 }
        })
        expect(await f.refresher.refresh(f.row.id, 'scheduled')).toBeNull()
        await f.settled()
        expect(f.http.request).not.toHaveBeenCalled()
        expect(f.row).toMatchObject({ refreshFinishedAt: new Date(f.time()), healthReason: null })
        expect(f.logger).toHaveBeenCalledWith('refresh_not_sent')
      },
    )
  })

  describe('a rotation whose persistence can never succeed', () => {
    it.each([
      ['replaced by a newer login', () => ({ credentialVersion: 3 })],
      ['deleted', () => null],
    ])('stops retrying when the account was %s', async (_name, current) => {
      const f = fixture()
      let sleeps = 0
      f.sleep.mockImplementation((_milliseconds, signal) => {
        sleeps += 1
        // Old behaviour retried forever; park it so the assertion below can fail instead.
        return sleeps < 3
          ? Promise.resolve()
          : new Promise((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            )
      })
      f.tx.subscriptionAccount.findUnique.mockImplementation(async (query) =>
        query && 'include' in query && query.include
          ? { ...f.row }
          : current() && { ...f.row, ...current() },
      )
      expect(await auth(f)).toEqual(rotated)
      for (let i = 0; i < 10; i += 1) await f.settled()
      expect(f.logger).toHaveBeenCalledWith('refresh_conflict')
      expect(sleeps).toBe(0)
      expect(f.release).toHaveBeenCalledTimes(1)
      expect(
        await f.credentials
          .get(
            {
              accountId: f.row.id,
              credentialRef: f.row.credentialRef.vaultPath,
              credentialVersion: 1,
            },
            f.backend,
          )
          .catch(() => null),
      ).not.toEqual(rotated)
    })

    it('does not overwrite a newer login when CAS reveals another credential', async () => {
      const f = fixture()
      f.kvWrite.mockImplementation(async () => {
        f.setVault({
          version: 2,
          data: encodeSubscriptionCredential({ ...initial, apiKey: 'synthetic-relogin' }),
        })
        f.row.credentialVersion = 2
        throw new Error('CAS mismatch')
      })
      await auth(f)
      await f.settled()
      expect(f.row).toMatchObject({ health: 'ok', healthReason: null, credentialVersion: 2 })
      expect(f.logger).toHaveBeenCalledWith('refresh_conflict')
    })

    it('revokes a retired account while another rotation still waits for Vault', async () => {
      const f = fixture()
      f.kvWrite.mockRejectedValue(new Error('synthetic Vault outage'))
      f.sleep.mockImplementation(
        (_milliseconds, signal) =>
          new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          ),
      )
      expect(await auth(f)).toEqual(rotated)
      await f.settled()
      f.row.enabled = false
      f.row.retireRequestedAt = new Date(f.time())
      await f.refresher.retire()
      expect(f.revoke).toHaveBeenCalledTimes(1)
      expect(f.row.credentialsRevokedAt).toEqual(new Date(f.time()))
    })
  })

  it('a region refusal never shortens an existing longer cooling period', async () => {
    const f = fixture()
    const longer = new Date(f.time() + 5 * 24 * HOUR)
    Reflect.set(f.row, 'coolingUntil', longer)
    f.refresh.mockResolvedValue({ kind: 'final', reason: 'region' })
    await auth(f)
    expect(f.row.healthReason).toBe('refresh_region')
    expect(Reflect.get(f.row, 'coolingUntil')).toEqual(longer)
    Reflect.set(f.row, 'coolingUntil', null)
    f.row.healthReason = null
    await auth(f)
    expect(Reflect.get(f.row, 'coolingUntil')).toEqual(new Date(f.time() + 10 * 60_000))
  })

  it.each(['unsupported', 'locked', 'revoke-failed'] as const)(
    'revokes the next account behind a full page of %s accounts',
    async (kind) => {
      const f = poolFixture(kind, true)
      await f.refresher.retire()
      await f.refresher.retire()
      expect(f.row.credentialsRevokedAt).toEqual(new Date(f.time()))
      expect(
        f.revoke.mock.calls.filter(([credential]) => credential.apiKey === initial.apiKey),
      ).toHaveLength(1)
    },
  )
})
