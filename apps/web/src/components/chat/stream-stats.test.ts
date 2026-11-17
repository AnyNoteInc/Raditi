import { describe, expect, it } from 'vitest'

import { quantile, StreamStats } from './stream-stats'

describe('the numbers of the stream in this tab', () => {
  it('gives a period with quantiles once, then starts a new one', () => {
    const stats = new StreamStats()
    expect(stats.period(false)).toBeNull()
    for (const [index, ms] of [4, 6, 30].entries()) stats.drew(51_200, ms, 1_000 + index * 100)
    stats.input(180, 1_250)
    stats.input(420, 1_300)
    expect(stats.period(true)).toEqual({
      frames: 3,
      bytes: 153_600,
      draw: { p50: 6, p95: 30 },
      input: { p50: 180, p95: 420 },
      inputs: 2,
      touch: true,
    })
    expect(stats.period(true)).toBeNull()
  })

  it('reads the last three seconds for the line of numbers', () => {
    const stats = new StreamStats()
    // An old frame falls out of the window; twelve frames of 50 KB in the last three seconds.
    stats.drew(1_000_000, 50, 0)
    for (let index = 0; index < 12; index++) stats.drew(51_200, 8, 5_000 + index * 250)
    stats.input(200, 7_000)
    expect(stats.live(8_000)).toEqual({
      fps: 4,
      kbPerFrame: 50,
      mbps: 1.6,
      drawMs: 8,
      inputMs: 200,
    })
    expect(stats.live(20_000)).toEqual({
      fps: 0,
      kbPerFrame: null,
      mbps: 0,
      drawMs: null,
      inputMs: null,
    })
  })

  it('takes no sample it cannot trust', () => {
    const stats = new StreamStats()
    stats.drew(100, Number.NaN, 0)
    stats.drew(100, -1, 0)
    expect(stats.period(false)).toMatchObject({ frames: 2, draw: null })
  })
})

describe('a quantile by the nearest rank', () => {
  it('rounds to a tenth of a millisecond', () => {
    expect(quantile([], 0.5)).toBeNull()
    expect(quantile([1.26, 9], 0.5)).toBe(1.3)
  })
})
