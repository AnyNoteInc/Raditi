import type { PrismaClient } from '@repo/db'
import type { ProbeResult } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { sampleBackendId } from '../testing/ids.ts'
import { PostgresPoolHealthStore, type PoolHealthAccount } from './pool-health-store.ts'

const now = new Date('2026-09-30T10:00:00Z')
const reset = new Date('2026-10-01T00:00:00Z')
const snapshot: PoolHealthAccount = {
  accountId: '00000000-0000-4000-8000-000000000001',
  backendId: sampleBackendId,
  credentialRef: `subs/${sampleBackendId}/00000000-0000-4000-8000-000000000001`,
  credentialVersion: 1,
  limitsSeenAt: now,
  windowsKnown: true,
}
const result = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  status: 'ok',
  windows: [{ name: 'week', usedPct: 10, resetsAt: reset }],
  plan: null,
  ...overrides,
})

// Finished 402 calls separated by the 5- and 15-minute pauses: one payment check each.
const incidents = (count: number) =>
  [60, 50, 30].slice(0, count).map((minutes) => ({
    finishedAt: new Date(now.getTime() - minutes * 60_000),
  }))

function harness(overrides: Record<string, unknown> = {}) {
  const account = {
    id: snapshot.accountId,
    provider: { slug: snapshot.backendId },
    credentialRef: { vaultPath: snapshot.credentialRef },
    credentialVersion: 1,
    credentialsRevokedAt: null,
    health: 'ok',
    healthReason: null,
    plan: 'synthetic',
    limitWindows: [{ name: 'week', usedPct: 20, resetsAt: reset.toISOString() }],
    limitsSeenAt: now,
    coolingUntil: null,
    ...overrides,
  }
  const update = vi.fn().mockResolvedValue(account)
  const queryRaw = vi.fn().mockResolvedValue([{ instant: now }])
  const failures = vi.fn().mockResolvedValue(incidents(1))
  const tx = {
    $queryRaw: queryRaw,
    subscriptionAccount: { findUnique: vi.fn().mockResolvedValue(account), update },
    llmCall: { findMany: failures },
  }
  const transaction = vi
    .fn()
    .mockImplementation(async (fn: (value: typeof tx) => unknown) => fn(tx))
  const store = new PostgresPoolHealthStore({
    $transaction: transaction,
  } as unknown as PrismaClient)
  return { store, update, queryRaw, failures, transaction }
}

describe('bounded pool health SQL mutations', () => {
  it('looks up only validated provider-neutral non-secret metadata', async () => {
    const h = harness()
    expect(await h.store.account(snapshot.accountId)).toEqual(snapshot)
    expect(h.transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 1000,
      timeout: 8000,
    })
    const parts = h.queryRaw.mock.calls[0]![0] as TemplateStringsArray
    expect(parts.join('')).toContain("set_config('lock_timeout', '1000ms', true)")
    expect(parts.join('')).toContain("set_config('statement_timeout', '5000ms', true)")
  })

  it.each([
    { credentialVersion: 0 },
    { credentialsRevokedAt: now },
    { provider: { slug: 'unknown' } },
  ])('rejects unusable account metadata %j', async (overrides) => {
    expect(await harness(overrides).store.account(snapshot.accountId)).toBeNull()
  })

  it('replenishes capacity from a fresh probe, preserving operator fields', async () => {
    const h = harness()
    expect(await h.store.probe(snapshot, result())).toEqual({
      applied: true,
      alert: null,
      limitsSeenAt: now,
    })
    expect(h.update).toHaveBeenCalledWith({
      where: { id: snapshot.accountId },
      data: {
        limitWindows: [{ name: 'week', usedPct: 10, resetsAt: reset.toISOString() }],
        headroomPct: '90',
        limitsSeenAt: now,
      },
    })
  })

  it('cannot replenish a newer snapshot or delete omitted limiting windows', async () => {
    const h = harness({
      limitsSeenAt: new Date(now.getTime() + 1),
      limitWindows: [
        { name: 'week', usedPct: 100, resetsAt: reset.toISOString() },
        { name: 'month', usedPct: 80, resetsAt: new Date(reset.getTime() + 1).toISOString() },
      ],
    })
    await h.store.probe(snapshot, result())
    const data = h.update.mock.calls[0]![0].data
    expect(data.headroomPct).toBe('0')
    expect(data.limitWindows).toEqual([
      { name: 'week', usedPct: 100, resetsAt: reset.toISOString() },
      { name: 'month', usedPct: 80, resetsAt: new Date(reset.getTime() + 1).toISOString() },
    ])
  })

  it('cannot restore authoritative unknown capacity observed after the probe started', async () => {
    const overtakenAt = new Date(now.getTime() + 1)
    const h = harness({ limitsSeenAt: overtakenAt, limitWindows: [] })
    // The state the probe left is still the one that overtook it: it answers no newer caller.
    expect(await h.store.probe(snapshot, result())).toMatchObject({
      applied: true,
      limitsSeenAt: now,
    })
    expect(h.update.mock.calls[0]![0].data).toMatchObject({ limitWindows: [], headroomPct: null })
  })

  it('restores windows that were unknown before the probe, though a late response overtook it', async () => {
    const h = harness({ limitsSeenAt: new Date(now.getTime() + 1), limitWindows: [] })
    await h.store.probe({ ...snapshot, windowsKnown: false }, result())
    expect(h.update.mock.calls[0]![0].data).toMatchObject({
      limitWindows: [{ name: 'week', usedPct: 10, resetsAt: reset.toISOString() }],
      headroomPct: '90',
      limitsSeenAt: now,
    })
  })

  it('reads whether the windows were known into the snapshot', async () => {
    for (const limitWindows of [[], null, [{ name: 'decade', usedPct: 1, resetsAt: null }]])
      expect(await harness({ limitWindows }).store.account(snapshot.accountId)).toMatchObject({
        windowsKnown: false,
      })
  })

  it('clears capacity for an authoritative unknown probe without changing health', async () => {
    const h = harness()
    await h.store.probe(snapshot, result({ status: 'unknown', windows: null }))
    expect(h.update).toHaveBeenCalledWith({
      where: { id: snapshot.accountId },
      data: { limitWindows: [], headroomPct: null, limitsSeenAt: now },
    })
  })

  it('ignores stale unknowns after a newer snapshot and all probes after the credential was replaced', async () => {
    const newer = harness({ limitsSeenAt: new Date(now.getTime() + 1) })
    await newer.store.probe(snapshot, result({ status: 'unknown', windows: null }))
    expect(newer.update).not.toHaveBeenCalled()
    const replaced = harness({ credentialVersion: 2 })
    expect(await replaced.store.probe(snapshot, result({ status: 'auth' }))).toEqual({
      applied: false,
      alert: null,
    })
    expect(replaced.update).not.toHaveBeenCalled()
  })

  it.each([
    ['auth', 'needs_relogin', 'auth_confirmed'],
    ['suspended', 'suspended', 'risk_confirmed'],
  ] as const)('confirms %s with independent control evidence', async (status, health, reason) => {
    const h = harness()
    expect(await h.store.probe(snapshot, result({ status }))).toEqual({
      applied: true,
      alert: reason,
      limitsSeenAt: now,
    })
    expect(h.update.mock.calls[0]![0].data).toEqual({
      health,
      healthReason: reason,
      healthChangedAt: now,
    })
  })

  it('suspends a changed plan and preserves an existing suspension', async () => {
    const h = harness()
    expect(await h.store.probe(snapshot, result({ plan: 'free' }))).toEqual({
      applied: true,
      alert: 'plan_changed',
      limitsSeenAt: now,
    })
    expect(h.update.mock.calls[0]![0].data).toMatchObject({
      health: 'suspended',
      healthReason: 'plan_changed',
      healthChangedAt: now,
    })
    const suspended = harness({ health: 'suspended', healthReason: 'risk_confirmed' })
    await suspended.store.probe(snapshot, result({ plan: 'free' }))
    expect(suspended.update.mock.calls[0]![0].data).not.toHaveProperty('healthReason')
  })

  it('counts persisted finished 402 checks over one day and suspends at three', async () => {
    const h = harness()
    h.failures.mockResolvedValue(incidents(3))
    expect(await h.store.payment(snapshot.accountId)).toEqual({
      count: 3,
      suspended: true,
      at: now,
    })
    expect(h.failures).toHaveBeenCalledWith({
      where: {
        subscriptionAccountId: snapshot.accountId,
        upstreamStatus: 402,
        state: { not: 'open' },
        finishedAt: { gte: new Date(now.getTime() - 86_400_000) },
      },
      select: { finishedAt: true },
      orderBy: { finishedAt: 'asc' },
      take: 1_000,
    })
    expect(h.update.mock.calls[0]![0].data).toEqual({
      health: 'suspended',
      healthReason: 'payment_pending',
      healthChangedAt: now,
    })
  })

  it('counts 402 responses inside one pause as a single payment check', async () => {
    const h = harness()
    const first = now.getTime() - 30 * 60_000
    // Three concurrent requests, then one admitted 14 minutes into the 15-minute second pause.
    h.failures.mockResolvedValue(
      [0, 1_000, 2_000, 5 * 60_000, 19 * 60_000].map((offset) => ({
        finishedAt: new Date(first + offset),
      })),
    )
    expect(await h.store.payment(snapshot.accountId)).toEqual({
      count: 2,
      suspended: false,
      at: now,
    })
    expect(h.update).not.toHaveBeenCalled()
  })

  it('treats a reset no window can have as unknown: an hour, never years', async () => {
    const day = 86_400_000
    const hour = new Date(now.getTime() + 3_600_000)
    // [the reset, the window it belongs to, whether it is a reset that window can have]
    const cases = [
      // A signal names no window: the weekly horizon, as in the gateway store.
      [8 * day, undefined, true],
      [8 * day + 1, undefined, false],
      [6 * 3_600_000, '5h', true],
      [6 * 3_600_000 + 1, '5h', false],
      [8 * day + 1, 'week', false],
      [32 * day, 'month', true],
      [32 * day + 1, 'month', false],
    ] as const
    for (const [ahead, window, plausible] of cases) {
      const h = harness()
      const until = new Date(now.getTime() + ahead)
      await h.store.cool(snapshot.accountId, until, window)
      expect(h.update.mock.calls[0]![0].data.coolingUntil).toEqual(
        plausible ? new Date(until.getTime() + 60_000) : hour,
      )
    }
  })

  it('drops the capacity of a probe whose window resets further ahead than the window is long', async () => {
    const h = harness()
    const windows = [
      {
        name: 'week' as const,
        usedPct: 100,
        resetsAt: new Date(now.getTime() + 8 * 86_400_000 + 1),
      },
    ]
    await h.store.probe(snapshot, result({ windows }))
    expect(h.update.mock.calls[0]![0].data).toEqual({
      limitWindows: [],
      headroomPct: null,
      limitsSeenAt: now,
    })
  })

  it('extends unknown exhaustion by an hour and never shortens existing cooling', async () => {
    const h = harness()
    await h.store.cool(snapshot.accountId, null)
    expect(h.update.mock.calls[0]![0].data.coolingUntil).toEqual(
      new Date(now.getTime() + 3_600_000),
    )
    const cooled = harness({ coolingUntil: reset })
    await cooled.store.cool(snapshot.accountId, null)
    expect(cooled.update).not.toHaveBeenCalled()
  })
})
