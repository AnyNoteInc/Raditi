import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@repo/db'
import type { KvMetadata, SecretStore } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { CredentialSweeper } from './credential-sweeper.ts'

const now = new Date('2026-09-30T10:00:00Z')
const key = () => ({
  id: randomUUID(),
  taskId: randomUUID(),
  sessionId: 'synthetic-session',
  turnNo: 1,
  firstEpoch: 1,
})
const name = (value: ReturnType<typeof key>) =>
  `t_${value.taskId}_${value.turnNo}_${value.firstEpoch}`
const metadata = (options: Partial<KvMetadata> = {}): KvMetadata => ({
  currentVersion: 1,
  custom: { validUntil: new Date(now.getTime() - 1_000).toISOString() },
  createdTime: new Date(now.getTime() - 26 * 60_000),
  deleted: false,
  destroyed: false,
  ...options,
})

function fixture() {
  const keys: ReturnType<typeof key>[] = []
  const accounting: { id: string }[] = []
  const accounts: { id: string; backend: string }[] = []
  const queries: { sql: string; values: unknown[] }[] = []
  const $queryRaw = vi.fn(
    async (parts: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
      const sql = Array.isArray(parts) ? parts.join('?') : (parts as Prisma.Sql).sql
      queries.push({ sql, values })
      if (sql.includes('AS now')) return [{ now }]
      if (sql.includes('FROM llm_keys k WHERE k.revoked_at IS NULL')) return keys
      if (sql.includes('FROM llm_keys WHERE revoked_at IS NOT NULL')) return accounting
      if (sql.includes('p.slug AS backend')) return accounts
      return []
    },
  )
  const findUnique = vi.fn().mockResolvedValue(null)
  const tx = { $queryRaw, llmKey: { findUnique } } as unknown as Prisma.TransactionClient
  const $transaction = vi.fn(
    async (
      ...args: [
        work: (db: Prisma.TransactionClient) => Promise<unknown>,
        options?: { maxWait: number; timeout: number },
      ]
    ) => args[0](tx),
  )
  const prisma = { $transaction, $queryRaw } as unknown as PrismaClient
  const kvList = vi.fn().mockResolvedValue([])
  const kvMetadata = vi.fn().mockResolvedValue(metadata())
  const kvDestroyAll = vi.fn().mockResolvedValue(undefined)
  const secrets = { kvList, kvMetadata, kvDestroyAll } as unknown as SecretStore
  const revoke = vi.fn().mockResolvedValue(undefined)
  const collectLost = vi.fn().mockResolvedValue(0)
  const warn = vi.fn()
  const onSwept = vi.fn()
  const sweeper = new CredentialSweeper({
    prisma,
    secrets,
    credentials: { revoke },
    backup: { collectLost },
    logger: { warn },
    onSwept,
  })
  const fiveTicks = async () => {
    for (let i = 0; i < 5; i += 1) await sweeper.tick()
  }
  return {
    sweeper,
    fiveTicks,
    keys,
    accounting,
    accounts,
    queries,
    $transaction,
    $queryRaw,
    findUnique,
    kvList,
    kvMetadata,
    kvDestroyAll,
    revoke,
    collectLost,
    warn,
    onSwept,
  }
}

describe('restart-safe core credential cleanup', () => {
  it('emits only bounded aggregate kinds for each successful cleanup', async () => {
    const f = fixture()
    const requested = Object.assign(key(), { revokeRequestedAt: now })
    f.keys.push(requested, Object.assign(key(), { expired: true }), key())
    f.collectLost.mockResolvedValueOnce(2)
    await f.sweeper.tick()
    expect(f.onSwept.mock.calls).toEqual([
      ['lost'],
      ['lost'],
      ['requested'],
      ['expired'],
      ['finished'],
    ])
  })

  it('reports a row the default backup collector cannot close through its own logger', async () => {
    const warn = vi.fn()
    const $queryRaw = vi.fn(async (parts: TemplateStringsArray) =>
      parts.join('?').includes('FROM llm_calls') ? [{ id: randomUUID() }] : [],
    )
    // No llmCall delegate: closing the lost call fails after the list was read.
    const tx = { $queryRaw }
    const prisma = {
      $queryRaw,
      $transaction: vi.fn(async (work: (db: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as PrismaClient
    const sweeper = new CredentialSweeper({
      prisma,
      secrets: { kvList: vi.fn().mockResolvedValue([]) } as unknown as SecretStore,
      credentials: { revoke: vi.fn() },
      logger: { warn },
    })
    await sweeper.tick()
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ event: 'llm_collector_row_failed', kind: 'call' }),
    )
  })

  it('retries requested and expired keys and retains the immutable turn reference', async () => {
    const f = fixture()
    const requested = key(),
      expired = key()
    f.keys.push(requested, expired)
    await f.sweeper.tick()
    expect(f.revoke.mock.calls.map(([ref]) => ref)).toEqual(
      [requested, expired].map((row) => ({
        taskId: row.taskId,
        sessionId: row.sessionId,
        turn: row.turnNo,
        epoch: row.firstEpoch,
      })),
    )
    expect(f.collectLost).toHaveBeenCalledOnce()
    expect(f.kvList).not.toHaveBeenCalled()
    expect(f.queries.some(({ sql }) => sql.includes('valid_until <= clock_timestamp()'))).toBe(true)
    expect(f.$transaction.mock.calls.every(([, options]) => options !== undefined)).toBe(true)
  })

  it('keeps processing other keys after a failed revoke and never logs thrown secret text', async () => {
    const f = fixture()
    f.keys.push(key(), key())
    f.revoke.mockRejectedValueOnce(new Error('secret-token account-private-body'))
    f.collectLost.mockRejectedValueOnce(new Error('secret-token account-private-body'))
    await f.sweeper.tick()
    expect(f.revoke).toHaveBeenCalledTimes(2)
    expect(f.warn.mock.calls).toEqual([
      ['llm_credentials_sweep_failed kind=backup'],
      ['llm_credentials_sweep_failed kind=revoke'],
    ])
  })

  it('closes revoked accounting only after the key lock and a fresh open-call check', async () => {
    const f = fixture()
    f.accounting.push({ id: randomUUID() })
    await f.sweeper.tick()
    const lock = f.queries.findIndex(({ sql }) =>
      sql.includes('FROM llm_keys WHERE id = ?::uuid FOR UPDATE'),
    )
    const closed = f.queries.findIndex(({ sql }) => sql.includes('SET usage_closed_at'))
    expect(lock).toBeGreaterThan(-1)
    expect(closed).toBeGreaterThan(lock)
    expect(f.queries[closed]!.sql).toContain("c.state = 'open'")
    expect(f.queries[closed]!.sql).toContain('k.revoked_at IS NOT NULL')
  })

  it('on the fifth tick cleans expired orphan/revoked entries and revokes an active row', async () => {
    const f = fixture()
    const orphan = key(),
      revoked = key(),
      active = key(),
      future = key(),
      fallback = key()
    f.kvList.mockResolvedValue([orphan, revoked, active, future, fallback].map(name))
    f.kvMetadata.mockImplementation(async (path: string) =>
      path === `turns/${name(future)}`
        ? metadata({ custom: { validUntil: new Date(now.getTime() + 1_000).toISOString() } })
        : path === `turns/${name(fallback)}`
          ? metadata({ custom: {} })
          : metadata(),
    )
    f.findUnique.mockImplementation(
      async (query: { where: { taskId_turnNo_firstEpoch: { taskId: string } } }) => {
        if (query.where.taskId_turnNo_firstEpoch.taskId === active.taskId)
          return { ...active, revokedAt: null }
        if (query.where.taskId_turnNo_firstEpoch.taskId === revoked.taskId)
          return { ...revoked, revokedAt: now }
        return null
      },
    )
    await f.fiveTicks()
    expect(f.kvList).toHaveBeenCalledExactlyOnceWith('turns/', { limit: 100 })
    expect(f.kvDestroyAll.mock.calls.map(([path]) => path)).toEqual(
      [orphan, revoked, fallback].map((value) => `turns/${name(value)}`),
    )
    expect(f.revoke).toHaveBeenCalledExactlyOnceWith({
      taskId: active.taskId,
      sessionId: active.sessionId,
      turn: 1,
      epoch: 1,
    })
  })

  it('does not interpret a nested or malformed Vault key as a turn', async () => {
    const f = fixture()
    f.kvList.mockResolvedValue([
      'subs/',
      '../subs/secret',
      't_invalid_1_1',
      `t_${randomUUID()}_0_1`,
      `t_${randomUUID()}_2147483648_1`,
    ])
    await f.fiveTicks()
    expect(f.kvMetadata).not.toHaveBeenCalled()
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
    expect(f.revoke).not.toHaveBeenCalled()
  })

  it('advances LIST pages of 100 and resets the cursor when a page is exhausted', async () => {
    const f = fixture()
    const first = Array.from({ length: 100 }, () => name(key())).sort()
    f.kvList.mockResolvedValueOnce(first).mockResolvedValue([])
    f.kvMetadata.mockResolvedValue(
      metadata({ custom: { validUntil: new Date(now.getTime() + 1_000).toISOString() } }),
    )
    await f.fiveTicks()
    await f.fiveTicks()
    await f.fiveTicks()
    expect(f.kvList.mock.calls).toEqual([
      ['turns/', { limit: 100 }],
      ['turns/', { after: first.at(-1), limit: 100 }],
      ['turns/', { limit: 100 }],
    ])
  })

  it('retries a page whose Vault cleanup failed without advancing past the orphan', async () => {
    const f = fixture()
    const first = Array.from({ length: 100 }, () => name(key())).sort()
    f.kvList.mockResolvedValue(first)
    f.kvDestroyAll.mockRejectedValueOnce(new Error('Vault temporarily unavailable'))
    await f.fiveTicks()
    await f.fiveTicks()
    expect(f.kvList.mock.calls).toEqual([
      ['turns/', { limit: 100 }],
      ['turns/', { limit: 100 }],
    ])
    expect(f.kvDestroyAll.mock.calls.filter(([path]) => path === `turns/${first[0]}`).length).toBe(
      2,
    )
  })

  it('takes the issue pool lock and fresh account lock before disabling drained retirement', async () => {
    const f = fixture()
    const account = { id: randomUUID(), backend: 'synthetic-backend' }
    f.accounts.push(account)
    await f.sweeper.tick()
    const lock = f.queries.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock'))
    const accountLock = f.queries.findIndex(({ sql }) =>
      sql.includes('FROM subscription_accounts WHERE id = ?::uuid FOR UPDATE'),
    )
    const disabled = f.queries.findIndex(({ sql }) => sql.includes('SET enabled = false'))
    expect(lock).toBeGreaterThan(-1)
    expect(accountLock).toBeGreaterThan(lock)
    expect(disabled).toBeGreaterThan(accountLock)
    // The key issue, import and retirement lock: built here, never assembled in SQL.
    expect(f.queries[lock]!.values).toEqual(['pool:synthetic-backend'])
    expect(f.queries[disabled]!.sql).toContain('k.revoke_requested_at IS NULL')
    expect(f.queries[disabled]!.sql).toContain('k.expires_at > clock_timestamp()')
    expect(f.queries[disabled]!.sql).toContain("c.state = 'open'")
    expect(f.kvDestroyAll).not.toHaveBeenCalled()
  })

  it('coalesces overlapping timer runs', async () => {
    const f = fixture()
    let release!: (value: number) => void
    f.collectLost.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        release = resolve
      }),
    )
    const first = f.sweeper.tick()
    const second = f.sweeper.tick()
    expect(second).toBe(first)
    release(0)
    await first
    expect(f.collectLost).toHaveBeenCalledOnce()
  })

  it('stops a pending Vault wait and starts no new work after close', async () => {
    const f = fixture()
    let entered!: () => void
    const listed = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.kvList.mockImplementation(async () => {
      entered()
      return new Promise<string[]>(() => {})
    })
    for (let i = 0; i < 4; i += 1) await f.sweeper.tick()
    const pending = f.sweeper.tick()
    await listed
    await f.sweeper.close()
    await pending
    const transactions = f.$transaction.mock.calls.length
    await f.sweeper.tick()
    expect(f.$transaction).toHaveBeenCalledTimes(transactions)
    expect(f.kvMetadata).not.toHaveBeenCalled()
    expect(f.warn).not.toHaveBeenCalled()
  })
})
