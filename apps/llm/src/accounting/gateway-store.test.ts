import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@repo/db'
import type { GatewayFinish } from '@repo/turn-keys'
import { describe, expect, it, vi } from 'vitest'

import { sampleBackendCapacity, sampleBackendId, sampleRoutePath } from '../testing/ids.ts'
import { PostgresGatewayStore } from './gateway-store.ts'
import type { GatewayAdmitInput } from './gateway-types.ts'

const input = (): GatewayAdmitInput => ({
  keyHash: 'a'.repeat(64),
  source: '127.0.0.1',
  backendId: sampleBackendId,
  capacity: sampleBackendCapacity,
  route: { method: 'POST', path: sampleRoutePath },
  profile: {
    keyId: randomUUID(),
    modelId: randomUUID(),
    model: 'synthetic-model',
    reasoningEffort: 'low',
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
      store.admit({ ...value, profile: { ...value.profile, modelId: 'shared-model' } }),
    ).rejects.toThrow()
    expect($transaction).not.toHaveBeenCalled()
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
