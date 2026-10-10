import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '@repo/db'
import { describe, expect, it, vi } from 'vitest'

import { sampleBackendId, sampleRoutePath } from '../testing/ids.ts'
import { PostgresGatewayStore } from './store.ts'
import { GatewayRecordRejected, type GatewayAdmitInput, type GatewayFinish } from './types.ts'

const input = (): GatewayAdmitInput => ({
  keyHash: 'a'.repeat(64),
  source: '127.0.0.1',
  backendId: sampleBackendId,
  route: { method: 'POST', path: sampleRoutePath },
  profile: {
    keyId: randomUUID(),
    modelId: randomUUID(),
    model: 'synthetic-model',
    reasoningEffort: 'low',
    cacheKey: `rdt_${'a'.repeat(32)}`,
  },
  requestBytes: 300,
  estimatedInputTokens: 100,
})
const finish = (): GatewayFinish => ({
  state: 'completed',
  usage: { input: 10, cacheRead: 1, cacheWrite: 1, output: 2, reasoning: 1 },
  estimated: false,
  billable: true,
  estimateReason: null,
  responseBytes: 100,
})

describe('gateway persistence boundaries', () => {
  it('keeps backup lost-call allowance at least the gateway collector deadline', () => {
    const db = {} as unknown as Pick<PrismaClient, '$transaction' | '$queryRaw'>
    for (const lostAfterMs of [0, 11 * 60_000 - 1, Infinity, 30 * 60_000 + 0.5]) {
      expect(() => new PostgresGatewayStore(db, { lostAfterMs })).toThrow()
    }
    expect(() => new PostgresGatewayStore(db, { lostAfterMs: 30 * 60_000 })).not.toThrow()
  })

  it('takes only a positive pace and ceiling of the calls of one key', () => {
    const db = {} as unknown as Pick<PrismaClient, '$transaction' | '$queryRaw'>
    for (const options of [
      { maxCallsPerKey30s: 0 },
      { maxCallsPerKey30s: 1.5 },
      { maxCallsPerKey30s: 1001 },
      { maxCallsPerKey: 0 },
      { maxCallsPerKey: Infinity },
      { maxCallsPerKey: 100_001 },
    ])
      expect(() => new PostgresGatewayStore(db, options), JSON.stringify(options)).toThrow()
    expect(
      () => new PostgresGatewayStore(db, { maxCallsPerKey30s: 1, maxCallsPerKey: 1 }),
    ).not.toThrow()
  })

  function fixture() {
    const $transaction = vi.fn()
    const $queryRaw = vi.fn()
    const db = { $transaction, $queryRaw } as unknown as Pick<
      PrismaClient,
      '$transaction' | '$queryRaw'
    >
    return { store: new PostgresGatewayStore(db), $transaction, $queryRaw, db }
  }

  it('rejects malformed hashes and source addresses without touching the database', async () => {
    const { store, $transaction, $queryRaw } = fixture()
    await expect(store.lookup('Bearer secret', '127.0.0.1')).rejects.toThrow()
    await expect(store.lookup('a'.repeat(64), 'example.test')).rejects.toThrow()
    await expect(store.admit({ ...input(), keyHash: 'bad' })).rejects.toThrow()
    await expect(store.admit({ ...input(), source: '127.0.0.1/32' })).rejects.toThrow()
    expect($transaction).not.toHaveBeenCalled()
    expect($queryRaw).not.toHaveBeenCalled()
  })

  it('rejects counts outside storage limits and unverifiable normalization profiles', async () => {
    const { store, $transaction } = fixture()
    for (const requestBytes of [-1, 16 * 1024 * 1024 + 1, 0.5]) {
      await expect(store.admit({ ...input(), requestBytes })).rejects.toThrow()
    }
    await expect(store.admit({ ...input(), estimatedInputTokens: 2_147_483_648 })).rejects.toThrow()
    const value = input()
    await expect(
      store.admit({ ...value, profile: { ...value.profile, cacheKey: 'shared-cache' } }),
    ).rejects.toThrow()
    expect($transaction).not.toHaveBeenCalled()
  })

  it('enforces estimate billing invariants before any call can be closed', async () => {
    const { store, $transaction } = fixture()
    const invalid: GatewayFinish[] = [
      { ...finish(), estimated: true },
      { ...finish(), billable: false },
      { ...finish(), state: 'lost' },
      { ...finish(), estimated: true, estimateReason: 'lost', billable: true },
      { ...finish(), estimated: true, estimateReason: 'no_usage', billable: false },
      { ...finish(), usage: { input: 1, cacheRead: 2, cacheWrite: 0, output: 1, reasoning: 0 } },
      { ...finish(), usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 2 } },
      {
        ...finish(),
        usage: { input: 2_147_483_648, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      },
    ]
    // A rejected outcome is final: the gateway must not retry it or close admission for it.
    for (const outcome of invalid)
      await expect(store.finish(randomUUID(), outcome)).rejects.toBeInstanceOf(
        GatewayRecordRejected,
      )
    await expect(store.finish('synthetic-call', finish())).rejects.toBeInstanceOf(
      GatewayRecordRejected,
    )
    expect($transaction).not.toHaveBeenCalled()
  })

  it('reports a write the database can never accept as rejected and passes transient failures through', async () => {
    const { store, $transaction } = fixture()
    const sqlFailure = (cause: { kind: string; originalCode?: string }) =>
      new Prisma.PrismaClientKnownRequestError('synthetic', {
        code: 'P2010',
        clientVersion: 'synthetic',
        meta: { driverAdapterError: { name: 'DriverAdapterError', cause } },
      })
    let failure: Error = sqlFailure({ kind: 'postgres', originalCode: '23514' })
    $transaction.mockImplementation((work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      work({
        $queryRaw: vi.fn().mockResolvedValue([]),
        llmCall: { findUnique: vi.fn(async () => Promise.reject(failure)) },
      } as unknown as Prisma.TransactionClient),
    )
    for (const cause of [
      { kind: 'postgres', originalCode: '23514' },
      { kind: 'ValueOutOfRange', originalCode: '22003' },
      { kind: 'UniqueConstraintViolation', originalCode: '23505' },
    ]) {
      failure = sqlFailure(cause)
      await expect(store.finish(randomUUID(), finish())).rejects.toBeInstanceOf(
        GatewayRecordRejected,
      )
    }
    failure = new Prisma.PrismaClientKnownRequestError('synthetic', {
      code: 'P2025',
      clientVersion: 'synthetic',
    })
    await expect(store.finish(randomUUID(), finish())).rejects.toBeInstanceOf(GatewayRecordRejected)
    for (const cause of [
      { kind: 'postgres', originalCode: '55P03' },
      { kind: 'postgres', originalCode: '57014' },
      { kind: 'TransactionWriteConflict', originalCode: '40001' },
      { kind: 'DatabaseNotReachable' },
    ]) {
      failure = sqlFailure(cause)
      await expect(store.finish(randomUUID(), finish())).rejects.toBe(failure)
    }
    failure = new Error('synthetic connection reset')
    await expect(store.finish(randomUUID(), finish())).rejects.toBe(failure)
  })

  it('rejects unsupported concurrency limits and refusal values without persistence', async () => {
    const { store, db, $queryRaw } = fixture()
    expect(() => new PostgresGatewayStore(db, { maxRequestsPerKey: 0 })).toThrow()
    expect(() => new PostgresGatewayStore(db, { maxRequestsPerKey: 3 })).toThrow()
    await expect(store.refuse('bad', 'budget')).rejects.toThrow()
    await expect(store.refuse(randomUUID(), 'provider-error-body' as 'budget')).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
  })

  it('names the content-refusal event as a literal, so its partial index always applies', async () => {
    const { store, $transaction } = fixture()
    const sql = vi.fn().mockResolvedValue([])
    $transaction.mockImplementation((work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      work({ $queryRaw: sql } as unknown as Prisma.TransactionClient),
    )
    await store.lookup('a'.repeat(64), '127.0.0.1')
    await store.refuse(randomUUID(), 'policy_flagged')
    const statements = sql.mock.calls
      .map(([query]) => query as { sql?: unknown; values?: unknown })
      .filter(
        (query): query is { sql: string; values: unknown[] } =>
          typeof query.sql === 'string' && query.sql.includes('task_events'),
      )
    // The key read (admission of every request) and the journal of a content refusal.
    expect(statements).toHaveLength(2)
    for (const statement of statements) {
      // A bind parameter would hide the type from the planner of a generic plan.
      expect(statement.sql).toContain("e.type = 'llm.policy_flagged'")
      expect(statement.values).not.toContain('llm.policy_flagged')
    }
  })

  it('lets one lost call or revoked key that cannot be closed now neither stop the pass nor fail it', async () => {
    const warn = vi.fn()
    const $transaction = vi.fn()
    const db = { $transaction, $queryRaw: vi.fn() } as unknown as Pick<
      PrismaClient,
      '$transaction' | '$queryRaw'
    >
    const store = new PostgresGatewayStore(db, { logger: { warn } })
    const [heldCall, freeCall, heldKey, freeKey] = Array.from({ length: 4 }, () => randomUUID())
    const locked = () => Promise.reject(new Error('synthetic lock timeout'))
    const closedKeys: string[] = []
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      if (text.includes('set_config')) return []
      if (text.includes('UPDATE llm_keys')) closedKeys.push(values[0] as string)
      else if (text.includes('SELECT id FROM llm_calls'))
        return [{ id: heldCall }, { id: freeCall }]
      else if (text.includes('usage_closed_at IS NULL LIMIT'))
        return [{ id: heldKey }, { id: freeKey }]
      else if (text.includes('FOR UPDATE') && values[0] === heldKey) return locked()
      return []
    })
    const findUnique = vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === heldCall ? locked() : null,
    )
    $transaction.mockImplementation((work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      work({ $queryRaw: sql, llmCall: { findUnique } } as unknown as Prisma.TransactionClient),
    )
    expect(await store.collectLost()).toBe(0)
    expect(findUnique.mock.calls.map(([query]) => query.where.id)).toEqual([heldCall, freeCall])
    expect(closedKeys).toEqual([freeKey])
    expect(warn.mock.calls).toEqual([
      [JSON.stringify({ event: 'llm_collector_row_failed', kind: 'call' })],
      [JSON.stringify({ event: 'llm_collector_row_failed', kind: 'key' })],
    ])
  })

  it('bounds SQL before every persistence path and fails closed if limits cannot be installed', async () => {
    const { store, $transaction, $queryRaw } = fixture()
    const sql = vi.fn().mockResolvedValue([])
    const tx = {
      $queryRaw: sql,
      llmCall: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as Prisma.TransactionClient
    $transaction.mockImplementation((work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      work(tx),
    )
    const operations = [
      () => store.lookup('a'.repeat(64), '127.0.0.1'),
      () => store.admit(input()),
      () => store.finish(randomUUID(), finish()),
      () => store.refuse(randomUUID(), 'budget'),
      () => store.collectLost(),
    ]
    for (const operation of operations) {
      sql.mockClear()
      await operation()
      expect(sql.mock.calls[0]?.[0].join('')).toContain(
        "set_config('lock_timeout', '1000ms', true)",
      )
      expect(sql.mock.calls[0]?.[0].join('')).toContain(
        "set_config('statement_timeout', '5000ms', true)",
      )
      sql.mockClear()
      sql.mockRejectedValueOnce(new Error('SQL limits unavailable'))
      await expect(operation()).rejects.toThrow('SQL limits unavailable')
      expect(sql).toHaveBeenCalledTimes(1)
    }
    expect($queryRaw).not.toHaveBeenCalled()
  })
})
