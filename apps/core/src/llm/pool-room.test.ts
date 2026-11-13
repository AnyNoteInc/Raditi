import { poolPolicy } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { sampleBackendId } from '../testing/ids.ts'
import { poolHasRoom } from './pool-room.ts'

const now = new Date('2026-11-13T12:00:00Z')
const row = (patch: Record<string, unknown> = {}) => ({
  id: 'account-1',
  enabled: true,
  status: 'active',
  health: 'ok',
  healthReason: null,
  healthChangedAt: null,
  retireRequestedAt: null,
  coolingUntil: null,
  breakerOpenUntil: null,
  limitWindows: [
    { name: '5h', usedPct: 10, resetsAt: new Date(now.getTime() + 3_600_000).toISOString() },
  ],
  activeTurns: 0n,
  maxConcurrentTurns: 8,
  lastUsedAt: null,
  providerEnabled: true,
  ...patch,
})
const backend = { id: sampleBackendId, capacity: 'windows' as const }
const db = (rows: unknown[]) => ({ $queryRaw: vi.fn(async () => rows) }) as never

describe('whether a pool may take a turn (plan 70, ВР24)', () => {
  it('has room while an account serves, is busy or has unknown windows', async () => {
    expect(await poolHasRoom(db([row()]), backend, now)).toBe(true)
    expect(await poolHasRoom(db([row({ activeTurns: 8n })]), backend, now)).toBe(true)
    expect(await poolHasRoom(db([row({ limitWindows: [] })]), backend, now)).toBe(true)
  })

  it('has its limits out when its windows reset later than a pass waits for', async () => {
    const full = {
      name: '5h',
      usedPct: 100,
      resetsAt: new Date(now.getTime() + poolPolicy.limitsOutWaitMs + 60_000).toISOString(),
    }
    expect(await poolHasRoom(db([row({ limitWindows: [full] })]), backend, now)).toBe(false)
    // A reset soon is a wait, not limits out: the plan stays.
    const soon = { ...full, resetsAt: new Date(now.getTime() + 60_000).toISOString() }
    expect(await poolHasRoom(db([row({ limitWindows: [soon] })]), backend, now)).toBe(true)
  })

  it('has no room without an enabled provider or an account that could serve', async () => {
    expect(await poolHasRoom(db([]), backend, now)).toBe(false)
    expect(await poolHasRoom(db([row({ providerEnabled: false })]), backend, now)).toBe(false)
    expect(await poolHasRoom(db([row({ enabled: false })]), backend, now)).toBe(false)
    expect(await poolHasRoom(db([row({ status: 'retired' })]), backend, now)).toBe(false)
  })
})
