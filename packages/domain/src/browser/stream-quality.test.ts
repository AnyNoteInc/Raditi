import { describe, expect, it } from 'vitest'

import {
  ackExcessMs,
  browserStreamQualities,
  BrowserStreamQuality,
  type StreamAck,
} from './stream-quality.ts'

/** Acknowledgements every `every` ms from `from` to `to`, each taking `ms`. */
const acks = (from: number, to: number, ms: number | ((at: number) => number), every = 100) => {
  const list: StreamAck[] = []
  for (let at = from; at <= to; at += every)
    list.push({ at, ms: typeof ms === 'number' ? ms : ms(at) })
  return list
}

describe('the qualities of a screencast', () => {
  it('steps down from the configured one, each once, never below the last', () => {
    expect(browserStreamQualities(70)).toEqual([70, 55, 40, 30])
    expect(browserStreamQualities(55)).toEqual([55, 40, 30])
    expect(browserStreamQualities(35)).toEqual([35, 30])
    expect(browserStreamQualities(20)).toEqual([20])
  })
})

describe('the excess of a link', () => {
  it('is the median of 3 s over the fastest of 20 s, from four samples at least', () => {
    const now = 30_000
    // The link's own time is 80 ms; the last three seconds take 300 ms.
    const list = [...acks(10_000, 26_900, 80), ...acks(27_000, now, 300)]
    expect(ackExcessMs(list, now)).toBe(220)
    expect(ackExcessMs(acks(29_000, now, 300, 400), now)).toBeNull()
    // An acknowledgement older than 20 s is no longer the link's own time.
    expect(ackExcessMs([{ at: 5_000, ms: 10 }, ...acks(27_000, now, 120)], now)).toBe(0)
  })
})

describe('the quality by the worst link', () => {
  it('steps down on a thin link, one step every 4 s at most, down to the last', () => {
    const quality = new BrowserStreamQuality(70, 0)
    const thin = (now: number) => [...acks(0, 1_900, 60), ...acks(2_000, now, 400)]
    // Within 4 s of the start nothing changes.
    expect(quality.observe([thin(3_000)], 3_000)).toBeNull()
    expect(quality.observe([thin(4_000)], 4_000)).toBe(55)
    expect(quality.observe([thin(6_000)], 6_000)).toBeNull()
    expect(quality.observe([thin(8_000)], 8_000)).toBe(40)
    expect(quality.observe([thin(12_000)], 12_000)).toBe(30)
    expect(quality.observe([thin(16_000)], 16_000)).toBeNull()
    expect(quality.quality).toBe(30)
  })

  it('steps up after 10 s of good links, and a link in between holds it', () => {
    const quality = new BrowserStreamQuality(70, 0)
    const list = [...acks(0, 1_900, 60), ...acks(2_000, 4_000, 400)]
    expect(quality.observe([list], 4_000)).toBe(55)
    const good = (now: number) => acks(now - 5_000, now, 70)
    expect(quality.observe([good(5_000)], 5_000)).toBeNull()
    expect(quality.observe([good(14_000)], 14_000)).toBeNull()
    expect(quality.observe([good(15_000)], 15_000)).toBe(70)
    // 100 ms over the link's own time: neither good nor thin.
    const fair = (now: number) => [
      ...acks(now - 10_000, now - 3_100, 60),
      ...acks(now - 3_000, now, 160),
    ]
    const again = new BrowserStreamQuality(70, 0)
    again.observe([list], 4_000)
    for (let now = 5_000; now <= 30_000; now += 1_000)
      expect(again.observe([fair(now)], now)).toBeNull()
    expect(again.quality).toBe(55)
  })

  it('takes the worst of the viewers, and holds on a page that sends nothing', () => {
    const quality = new BrowserStreamQuality(70, 0)
    const fast = acks(0, 5_000, 50)
    const slow = [...acks(0, 1_900, 60), ...acks(2_000, 5_000, 500)]
    expect(quality.observe([fast, slow], 5_000)).toBe(55)
    expect(quality.observe([[], []], 20_000)).toBeNull()
    expect(quality.observe([], 40_000)).toBeNull()
    expect(quality.quality).toBe(55)
  })
})
