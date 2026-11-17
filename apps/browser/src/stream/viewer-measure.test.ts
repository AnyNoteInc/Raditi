import { describe, expect, it } from 'vitest'

import { MEASURE_SAMPLES, quantile, ViewerMeasure } from './viewer-measure.ts'

const stats = (over: Partial<Parameters<ViewerMeasure['stats']>[0]> = {}) => ({
  t: 'stats' as const,
  frames: 10,
  bytes: 500_000,
  draw: { p50: 8, p95: 20 },
  input: { p50: 150, p95: 300 },
  inputs: 4,
  touch: false,
  ...over,
})

describe('the measure of one viewer', () => {
  it('times a frame from leaving to its acknowledgement, the ones before it leaving unmeasured', () => {
    const measure = new ViewerMeasure(0)
    measure.sent(1, 50_000, 100)
    measure.sent(2, 60_000, 110)
    measure.sent(3, 70_000, 120)
    // The viewer acknowledges 2: 1 leaves with it, but its own acknowledgement never came.
    expect(measure.acked(2, 310)).toBe(200)
    expect(measure.acked(1, 320)).toBeNull()
    expect(measure.acked(3, 400)).toBe(280)
    expect(measure.acked(3, 410)).toBeNull()
    expect(measure.acksSince(0).map((sample) => sample.ms)).toEqual([200, 280])
    expect(measure.acksSince(400).map((sample) => sample.ms)).toEqual([280])
    expect(measure.acksSince(401)).toEqual([])
  })

  it('takes a round trip of a ping stamped on this clock, never one from the future or of old', () => {
    const measure = new ViewerMeasure(0)
    expect(measure.pong(1_000, 1_080)).toBe(80)
    expect(measure.pong(undefined, 1_080)).toBeNull()
    expect(measure.pong(2_000, 1_080)).toBeNull()
    expect(measure.pong(0, 70_000)).toBeNull()
  })

  it('sums up in numbers only: frames, kilobytes, quantiles, the cabinet by its periods', () => {
    const measure = new ViewerMeasure(1_000)
    for (let seq = 1; seq <= 4; seq++) {
      measure.sent(seq, 40_960, seq * 100)
      measure.acked(seq, seq * 100 + seq * 50)
    }
    measure.pong(5_000, 5_090)
    measure.stats(stats())
    measure.stats(stats({ touch: true, draw: { p50: 12, p95: 30 }, input: null, inputs: 0 }))
    measure.stats(stats({ draw: null, input: { p50: 250, p95: 500 } }))
    for (const quality of [70, 70, 55, 40, 55]) measure.quality(quality)
    const summary = measure.summary(61_400, { replaced: 7, stale: 1 })
    expect(summary).toEqual({
      event: 'browser_stream_viewer',
      seconds: 60,
      framesSent: 4,
      frameKbAvg: 40,
      ackMsP50: 100,
      ackMsP95: 200,
      rttMsP50: 90,
      framesDrawn: 30,
      drawMsP50: 8,
      drawMsP95: 20,
      inputMsP50: 150,
      inputMsP95: 300,
      inputs: 8,
      touch: true,
      qualityMin: 40,
      qualityChanges: 3,
      dropped: { replaced: 7, stale: 1 },
    })
    expect(JSON.stringify(summary)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('sums up nothing measured as nothing, never as zero', () => {
    const summary = new ViewerMeasure(0).summary(500, { replaced: 0, stale: 0 })
    expect(summary).toMatchObject({
      seconds: 1,
      framesSent: 0,
      frameKbAvg: null,
      ackMsP50: null,
      rttMsP50: null,
      drawMsP50: null,
      inputMsP50: null,
      touch: false,
    })
  })

  it('keeps the newest samples only', () => {
    const measure = new ViewerMeasure(0)
    for (let seq = 0; seq < MEASURE_SAMPLES + 10; seq++) {
      measure.sent(seq, 1, seq)
      measure.acked(seq, seq + 1)
    }
    const acks = measure.acksSince(0)
    expect(acks).toHaveLength(MEASURE_SAMPLES)
    expect(acks[0]?.at).toBe(11)
  })
})

describe('a quantile by the nearest rank', () => {
  it('reads a median and a 95th percentile, rounded to a millisecond', () => {
    expect(quantile([], 0.5)).toBeNull()
    expect(quantile([42.4], 0.95)).toBe(42)
    expect(quantile([5, 1, 4, 2, 3], 0.5)).toBe(3)
    expect(
      quantile(
        Array.from({ length: 100 }, (_, index) => index + 1),
        0.95,
      ),
    ).toBe(95)
  })
})
