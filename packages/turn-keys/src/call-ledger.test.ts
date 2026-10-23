import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '@repo/db'
import { describe, expect, it, vi } from 'vitest'

import { LlmCallLedger, recordRefusal } from './call-ledger.ts'
import { GatewayRecordRejected, type GatewayFinish } from './gateway-types.ts'

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
      expect(() => new LlmCallLedger(db, { lostAfterMs })).toThrow()
    }
    expect(() => new LlmCallLedger(db, { lostAfterMs: 30 * 60_000 })).not.toThrow()
  })

  function fixture() {
    const $transaction = vi.fn()
    const $queryRaw = vi.fn()
    const db = { $transaction, $queryRaw } as unknown as Pick<
      PrismaClient,
      '$transaction' | '$queryRaw'
    >
    return { ledger: new LlmCallLedger(db), $transaction, $queryRaw, db }
  }

  it('enforces estimate billing invariants before any call can be closed', async () => {
    const { ledger, $transaction } = fixture()
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
      await expect(ledger.finish(randomUUID(), outcome)).rejects.toBeInstanceOf(
        GatewayRecordRejected,
      )
    await expect(ledger.finish('synthetic-call', finish())).rejects.toBeInstanceOf(
      GatewayRecordRejected,
    )
    expect($transaction).not.toHaveBeenCalled()
  })

  it('reports a write the database can never accept as rejected and passes transient failures through', async () => {
    const { ledger, $transaction } = fixture()
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
      await expect(ledger.finish(randomUUID(), finish())).rejects.toBeInstanceOf(
        GatewayRecordRejected,
      )
    }
    failure = new Prisma.PrismaClientKnownRequestError('synthetic', {
      code: 'P2025',
      clientVersion: 'synthetic',
    })
    await expect(ledger.finish(randomUUID(), finish())).rejects.toBeInstanceOf(
      GatewayRecordRejected,
    )
    for (const cause of [
      { kind: 'postgres', originalCode: '55P03' },
      { kind: 'postgres', originalCode: '57014' },
      { kind: 'TransactionWriteConflict', originalCode: '40001' },
      { kind: 'DatabaseNotReachable' },
    ]) {
      failure = sqlFailure(cause)
      await expect(ledger.finish(randomUUID(), finish())).rejects.toBe(failure)
    }
    failure = new Error('synthetic connection reset')
    await expect(ledger.finish(randomUUID(), finish())).rejects.toBe(failure)
  })

  it('journals a content refusal with its event type as a literal, so its partial index always applies', async () => {
    const sql = vi.fn().mockResolvedValue([])
    await recordRefusal(
      { $queryRaw: sql } as unknown as Prisma.TransactionClient,
      randomUUID(),
      'budget',
    )
    // Any other refusal only overwrites the latest reason of the key.
    expect(sql).toHaveBeenCalledTimes(1)
    sql.mockClear()
    await recordRefusal(
      { $queryRaw: sql } as unknown as Prisma.TransactionClient,
      randomUUID(),
      'policy_flagged',
    )
    const statements = sql.mock.calls
      .map(([query]) => query as { sql?: unknown; values?: unknown })
      .filter(
        (query): query is { sql: string; values: unknown[] } =>
          typeof query.sql === 'string' && query.sql.includes('task_events'),
      )
    expect(statements).toHaveLength(1)
    // A bind parameter would hide the type from the planner of a generic plan.
    expect(statements[0]!.sql).toContain("e.type = 'llm.policy_flagged'")
    expect(statements[0]!.values).not.toContain('llm.policy_flagged')
  })

  it('lets one lost call or revoked key that cannot be closed now neither stop the pass nor fail it', async () => {
    const warn = vi.fn()
    const $transaction = vi.fn()
    const db = { $transaction, $queryRaw: vi.fn() } as unknown as Pick<
      PrismaClient,
      '$transaction' | '$queryRaw'
    >
    const ledger = new LlmCallLedger(db, { logger: { warn } })
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
    expect(await ledger.collectLost()).toBe(0)
    expect(findUnique.mock.calls.map(([query]) => query.where.id)).toEqual([heldCall, freeCall])
    expect(closedKeys).toEqual([freeKey])
    expect(warn.mock.calls).toEqual([
      [JSON.stringify({ event: 'llm_collector_row_failed', kind: 'call' })],
      [JSON.stringify({ event: 'llm_collector_row_failed', kind: 'key' })],
    ])
  })

  it('bounds SQL before closing a call or collecting lost ones and fails closed if limits cannot be installed', async () => {
    const { ledger, $transaction, $queryRaw } = fixture()
    const sql = vi.fn().mockResolvedValue([])
    const tx = {
      $queryRaw: sql,
      llmCall: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as Prisma.TransactionClient
    $transaction.mockImplementation((work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      work(tx),
    )
    const operations = [() => ledger.finish(randomUUID(), finish()), () => ledger.collectLost()]
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
