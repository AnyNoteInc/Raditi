import { describe, expect, it } from 'vitest'

import {
  absoluteWindow,
  accountWindowForecast,
  forecastErrorRatio,
  isPlanPeak,
  nominalWindowCredits,
  planCreditsOfCall,
  planRatesSchema,
  planWindowCredits,
  type PlanRates,
} from './plan-credits.ts'

// GLM-5.3 on GLM Coding Plan (docs.z.ai/devpack/overview, 11.11.2026): 6.9 / 1.7 / 24 plan credits
// per 10 000 tokens, half outside the peak — Monday to Friday 14:00–18:00 in Singapore.
const glm: PlanRates = {
  inputUncachedPer10k: '6.9',
  cacheReadPer10k: '1.7',
  outputPer10k: '24',
  offPeakShare: '0.5',
  peak: { timeZone: 'Asia/Singapore', days: [1, 2, 3, 4, 5], fromHour: 14, toHour: 18 },
}
// Monday 16.11.2026 10:00 MSK = 15:00 in Singapore: the peak.
const mondayPeak = new Date('2026-11-16T07:00:00.000Z')
// Monday 14:00 MSK = 19:00 in Singapore: after it.
const mondayEvening = new Date('2026-11-16T11:00:00.000Z')
// Saturday 21.11.2026 10:00 MSK: no peak on a weekend.
const saturday = new Date('2026-11-21T07:00:00.000Z')

const tokens = {
  inputUncachedTokens: 10_000,
  cacheReadTokens: 100_000,
  cacheWriteTokens: 0,
  outputTokens: 2_000,
}

describe('plan credits of a call', () => {
  it('reads the peak by the calendar of the provider, 09:00–13:00 MSK on weekdays', () => {
    expect(isPlanPeak(mondayPeak, glm.peak)).toBe(true)
    expect(isPlanPeak(new Date('2026-11-16T06:00:00.000Z'), glm.peak)).toBe(true)
    expect(isPlanPeak(new Date('2026-11-16T05:59:59.000Z'), glm.peak)).toBe(false)
    expect(isPlanPeak(new Date('2026-11-16T10:00:00.000Z'), glm.peak)).toBe(false)
    expect(isPlanPeak(mondayEvening, glm.peak)).toBe(false)
    expect(isPlanPeak(saturday, glm.peak)).toBe(false)
  })

  it('counts (uncached × 6.9 + cache × 1.7 + output × 24) / 10 000 at the peak, half outside it', () => {
    // 6.9 + 17 + 4.8 = 28.7
    expect(planCreditsOfCall(tokens, glm, mondayPeak)).toBe('28.7000')
    expect(planCreditsOfCall(tokens, glm, mondayEvening)).toBe('14.3500')
    expect(planCreditsOfCall(tokens, glm, saturday)).toBe('14.3500')
  })

  it('counts cache writes as uncached input and rounds half up to four places', () => {
    expect(
      planCreditsOfCall(
        { inputUncachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10_000, outputTokens: 0 },
        glm,
        mondayPeak,
      ),
    ).toBe('6.9000')
    expect(
      planCreditsOfCall(
        { inputUncachedTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        glm,
        mondayPeak,
      ),
    ).toBe('0.0007')
  })

  it('refuses rates it cannot read', () => {
    expect(planRatesSchema.safeParse({ ...glm, offPeakShare: '0' }).success).toBe(false)
    expect(planRatesSchema.safeParse({ ...glm, offPeakShare: '1.5' }).success).toBe(false)
    expect(
      planRatesSchema.safeParse({ ...glm, peak: { ...glm.peak, timeZone: 'Mars/Olympus' } })
        .success,
    ).toBe(false)
    expect(
      planRatesSchema.safeParse({ ...glm, peak: { ...glm.peak, fromHour: 18, toHour: 14 } })
        .success,
    ).toBe(false)
    expect(() => planCreditsOfCall({ ...tokens, outputTokens: -1 }, glm, mondayPeak)).toThrow()
  })
})

describe('windows in plan credits', () => {
  it('knows the published sizes of Lite, Pro and Max', () => {
    expect(planWindowCredits.lite).toEqual({ '5h': 2_000, week: 10_000 })
    expect(planWindowCredits.pro).toEqual({ '5h': 12_000, week: 60_000 })
    expect(planWindowCredits.max).toEqual({ '5h': 28_000, week: 140_000 })
    expect(nominalWindowCredits('team', '5h')).toBeNull()
    expect(nominalWindowCredits('max', 'month')).toBeNull()
  })

  it('believes the probe over the nominal size, and falls back to it', () => {
    const probed = {
      name: '5h' as const,
      usedPct: 50,
      resetsAt: null,
      limitCredits: 2_400,
      usedCredits: 1_200,
    }
    expect(absoluteWindow(probed, 'lite')).toEqual({ limitCredits: 2_400, usedCredits: 1_200 })
    expect(absoluteWindow({ name: '5h', usedPct: 50, resetsAt: null }, 'lite')).toEqual({
      limitCredits: 2_000,
      usedCredits: 1_000,
    })
    expect(absoluteWindow({ name: '5h', usedPct: 50, resetsAt: null }, 'unknown')).toBeNull()
  })

  it('forecasts between probes from the closed and the open calls', () => {
    expect(
      accountWindowForecast({
        probedUsedCredits: 1_000,
        closedSinceProbe: '28.7000',
        openReserved: '12.5',
      }),
    ).toBeCloseTo(1_041.2)
    expect(() =>
      accountWindowForecast({ probedUsedCredits: -1, closedSinceProbe: '0', openReserved: '0' }),
    ).toThrow()
    expect(forecastErrorRatio(1_100, 1_000, 2_000)).toBeCloseTo(0.05)
    expect(forecastErrorRatio(900, 1_000, 0)).toBe(0)
  })
})
