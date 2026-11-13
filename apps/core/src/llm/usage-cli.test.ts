import { describe, expect, it } from 'vitest'

import { usageReport, usageReportText, type UsageFacts } from './usage-cli.ts'

// The report of `llm:usage` (docs/plan/71-usage-limits.md, §4.4) from what was read.
const now = new Date('2026-11-16T09:00:00.000Z')
const peak = { timeZone: 'Asia/Singapore', days: [1, 2, 3, 4, 5], fromHour: 14, toHour: 18 }
const facts = (change: Partial<UsageFacts> = {}): UsageFacts => ({
  now,
  accounts: [
    {
      label: 'zai-coding-1',
      plan: 'lite',
      backend: 'zai-coding',
      health: 'ok',
      enabled: true,
      limitsSeenAt: new Date(now.getTime() - 4 * 60_000),
      limitWindows: [
        {
          name: '5h',
          usedPct: 50,
          resetsAt: '2026-11-16T12:00:00.000Z',
          limitCredits: 2_000,
          usedCredits: 1_000,
        },
        {
          name: 'week',
          usedPct: 10,
          resetsAt: '2026-11-20T12:00:00.000Z',
          limitCredits: 10_000,
          usedCredits: 1_000,
        },
      ],
      sinceProbe: 100,
    },
    {
      label: 'zai-coding-2',
      plan: 'max',
      backend: 'zai-coding',
      health: 'ok',
      enabled: true,
      limitsSeenAt: null,
      limitWindows: [{ name: '5h', usedPct: 0, resetsAt: null }],
      sinceProbe: 0,
    },
  ],
  hours: [
    // Monday 15:00 in Singapore: the peak.
    { hour: new Date('2026-11-16T07:00:00.000Z'), planCredits: 326, customerCredits: 10 },
    // Saturday: outside it.
    { hour: new Date('2026-11-14T07:00:00.000Z'), planCredits: 163, customerCredits: 10 },
  ],
  peakRates: {
    inputUncachedPer10k: '6.9',
    cacheReadPer10k: '1.7',
    outputPer10k: '24',
    offPeakShare: '0.5',
    peak,
  },
  demand: [
    { tier: 'none', workspaces: 2, weeklyLimits: 100, spent7d: 30, p95FiveHours: 12 },
    { tier: 'start', workspaces: 10, weeklyLimits: 550, spent7d: 200, p95FiveHours: 18 },
    { tier: 'business', workspaces: 0, weeklyLimits: 0, spent7d: 0, p95FiveHours: 0 },
    { tier: 'agency', workspaces: 0, weeklyLimits: 0, spent7d: 0, p95FiveHours: 0 },
  ],
  ...change,
})

describe('llm:usage', () => {
  it('reads each account in plan credits, with its forecast and the age of its probe', () => {
    const report = usageReport(facts())
    expect(report.accounts[0]).toMatchObject({
      label: 'zai-coding-1',
      probeAgeMinutes: 4,
      windows: [
        { name: '5h', used: 1_000, limit: 2_000, usedPct: 50, forecast: 1_100 },
        { name: 'week', used: 1_000, limit: 10_000, forecast: 1_100 },
      ],
    })
    // An account whose probe named a share only has no size: the code knows none (13.11.2026).
    expect(report.accounts[1]?.windows).toEqual([])
    expect(report.pool['5h']).toEqual({ used: 1_100, limit: 2_000, freePct: 45 })
  })

  it('measures plan credits per credit of the customer at the peak and outside it', () => {
    const report = usageReport(facts())
    expect(report.ratio).toEqual({ peak: 32.6, offPeak: 16.3, all: 24.45 })
    expect(report.weeklyPowerCredits).toBe(Math.floor(10_000 / 24.45))
    expect(report.coverage).toBe(0.63)
    expect(report.advice).toMatch(
      /Не хватает 242 кредитов клиента в неделю — около 5917 кредитов плана/,
    )
    expect(usageReportText(report).join('\n')).toContain('Покрытие: 0.63')
  })

  it('says the pool is not measured while no call carries plan credits', () => {
    const report = usageReport(facts({ hours: [] }))
    expect(report.ratio.all).toBeNull()
    expect(report.coverage).toBeNull()
    expect(report.advice).toMatch(/не измерена/)
  })
})
