import { describe, expect, it, vi } from 'vitest'

import { profileWithQuota } from './pass-facts.ts'

// Owner's answer of 13.11.2026: when the quota of the plan is out, the pass goes through the API.
const now = new Date('2026-11-16T09:00:00.000Z')
const plan = { backend: 'plan', modelSlug: 'glm-5.3-standard', providerModelId: 'glm-5.3' }
const api = { backend: 'api', modelSlug: 'glm-5.3-standard', providerModelId: 'glm-5.3' }
const backends = [
  { id: 'plan', capacity: 'windows' },
  { id: 'api', capacity: 'none' },
] as never
const account = (windows: unknown[], change: Record<string, unknown> = {}) => ({
  enabled: true,
  status: 'active',
  health: 'ok',
  retireRequestedAt: null,
  coolingUntil: null,
  breakerOpenUntil: null,
  limitWindows: windows,
  ...change,
})
const spent = [
  {
    name: '5h',
    usedPct: 100,
    resetsAt: new Date(now.getTime() + 4 * 3_600_000).toISOString(),
    limitCredits: 2_000,
    usedCredits: 2_000,
  },
]
const room = [{ name: '5h', usedPct: 40, resetsAt: null, limitCredits: 2_000, usedCredits: 800 }]
const db = (accounts: unknown[]) => {
  const $queryRaw = vi.fn(async () => accounts)
  return { $queryRaw, reader: { $queryRaw } as unknown as Parameters<typeof profileWithQuota>[0] }
}

describe('profileWithQuota', () => {
  it('keeps the plan while it has quota', async () => {
    const { reader, $queryRaw } = db([account(room)])
    expect(await profileWithQuota(reader, backends, [plan, api], now)).toBe(plan)
    expect($queryRaw).toHaveBeenCalledTimes(1)
  })

  it('goes through the API when the quota of the plan is out', async () => {
    expect(await profileWithQuota(db([account(spent)]).reader, backends, [plan, api], now)).toBe(
      api,
    )
  })

  it('stays on the plan when there is no API to go to: the pool tells the client then', async () => {
    expect(await profileWithQuota(db([account(spent)]).reader, backends, [plan], now)).toBe(plan)
    expect(await profileWithQuota(db([]).reader, backends, [], now)).toBeNull()
  })
})
