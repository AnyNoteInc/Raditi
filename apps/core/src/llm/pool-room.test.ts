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

  describe('as the issue reads it: with the forecast between probes (19.11.2026)', () => {
    const resetsAt = new Date(now.getTime() + poolPolicy.limitsOutWaitMs + 3_600_000).toISOString()
    const window = (usedCredits: number) => ({
      name: '5h',
      usedPct: usedCredits / 20,
      usedCredits,
      limitCredits: 2_000,
      resetsAt,
    })
    // The probe said 25 of 2 000; the calls of the account since forecast 3 101 more.
    const forecastOut = row({ limitWindows: [window(25)], closedPlanCredits: '3101' })

    it('has no room the probe alone would give it, once a probe did not open it', async () => {
      expect(await poolHasRoom(db([forecastOut]), backend, now, { probed: true })).toBe(false)
      const open = row({ limitWindows: [window(25)], openPlanCredits: '1990' })
      expect(await poolHasRoom(db([open]), backend, now, { probed: true })).toBe(false)
    })

    it('counts a turn at its measured cost', async () => {
      const left = row({ limitWindows: [window(1_600)] })
      expect(await poolHasRoom(db([left]), backend, now)).toBe(true)
      expect(await poolHasRoom(db([left]), backend, now, { turnCostCredits: 519 })).toBe(false)
    })

    it('probes a pool only the forecast closed, and reads it again', async () => {
      const rows = [forecastOut]
      const store = db(rows)
      const probe = vi.fn(async () => {
        rows[0] = row({ limitWindows: [window(300)] })
      })
      expect(await poolHasRoom(store, backend, now, { probe })).toBe(true)
      expect(probe).toHaveBeenCalledWith(['account-1'], { stale: true })
      // Z.ai confirms the forecast: the next backend is the way out.
      rows[0] = forecastOut
      probe.mockImplementation(async () => {
        rows[0] = row({ limitWindows: [window(1_990)] })
      })
      expect(await poolHasRoom(store, backend, now, { probe })).toBe(false)
      // A failed probe opens nothing either.
      rows[0] = forecastOut
      probe.mockRejectedValue(new Error('refused'))
      expect(await poolHasRoom(store, backend, now, { probe })).toBe(false)
    })

    it('leaves a pool only the forecast closed to the issue without a probe of its own', async () => {
      expect(await poolHasRoom(db([forecastOut]), backend, now)).toBe(true)
    })

    it('never probes a window the provider itself reports closed', async () => {
      const probe = vi.fn(async () => {})
      const full = row({ limitWindows: [window(1_990)] })
      expect(await poolHasRoom(db([full]), backend, now, { probe })).toBe(false)
      expect(probe).not.toHaveBeenCalled()
    })
  })
})
