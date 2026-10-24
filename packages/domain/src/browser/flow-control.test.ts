import { describe, expect, it } from 'vitest'

import { FrameFlow, type FlowFrame } from './flow-control.ts'

const current = { pageId: 1, viewportVersion: 1 }
const frame = (seq: number, overrides: Partial<FlowFrame> = {}): FlowFrame => ({
  seq,
  pageId: 1,
  viewportVersion: 1,
  bytes: 50_000,
  ...overrides,
})

describe('FrameFlow', () => {
  it('sends a waiting frame at once and is idle without one', () => {
    const flow = new FrameFlow()
    expect(flow.next(0, 0, current)).toEqual({ kind: 'idle' })
    flow.offer(frame(1))
    expect(flow.next(0, 0, current)).toEqual({ kind: 'send', frame: frame(1) })
    expect(flow.next(0, 0, current)).toEqual({ kind: 'idle' })
    expect(flow.unacknowledged).toBe(1)
  })

  it('keeps only the newest waiting frame', () => {
    const flow = new FrameFlow()
    flow.offer(frame(1))
    flow.offer(frame(2))
    flow.offer(frame(3))
    expect(flow.next(0, 0, current)).toEqual({ kind: 'send', frame: frame(3) })
    expect(flow.drops).toEqual({ replaced: 2, stale: 0 })
  })

  it('sends no more than its rate, telling how long to wait', () => {
    const flow = new FrameFlow({ maxFps: 12 })
    flow.offer(frame(1))
    expect(flow.next(0, 0, current).kind).toBe('send')
    flow.ack(1)
    flow.offer(frame(2))
    expect(flow.next(10, 0, current)).toEqual({ kind: 'wait', ms: 74 })
    expect(flow.next(83, 0, current)).toEqual({ kind: 'wait', ms: 1 })
    expect(flow.next(84, 0, current)).toEqual({ kind: 'send', frame: frame(2) })
  })

  it('holds frames while its window is full until an acknowledgement, however late it comes', () => {
    const flow = new FrameFlow({ window: 2, maxFps: 1_000 })
    flow.offer(frame(1))
    flow.next(0, 0, current)
    flow.offer(frame(2))
    flow.next(10, 0, current)
    flow.offer(frame(3))
    expect(flow.next(20, 0, current)).toEqual({ kind: 'idle' })
    // A slow link, not a lost frame: a minute on, the place is still taken.
    expect(flow.next(60_000, 0, current)).toEqual({ kind: 'idle' })
    expect(flow.unacknowledged).toBe(2)
    expect(flow.ack(1)).toBe(true)
    expect(flow.next(60_001, 0, current)).toEqual({ kind: 'send', frame: frame(3) })
    expect(flow.unacknowledged).toBe(2)
  })

  it('takes an acknowledgement as covering the frames sent before it', () => {
    const flow = new FrameFlow({ window: 3, maxFps: 1_000 })
    for (const seq of [1, 2, 3]) {
      flow.offer(frame(seq))
      flow.next(seq * 10, 0, current)
    }
    expect(flow.ack(99)).toBe(false)
    expect(flow.unacknowledged).toBe(3)
    expect(flow.ack(2)).toBe(true)
    expect(flow.unacknowledged).toBe(1)
    expect(flow.ack(3)).toBe(true)
    expect(flow.unacknowledged).toBe(0)
    expect(flow.ack(3)).toBe(false)
    expect(flow.unacknowledged).toBe(0)
  })

  it('drops a frame of another page or window size before it is sent', () => {
    const flow = new FrameFlow()
    flow.offer(frame(1, { pageId: 1 }))
    expect(flow.next(0, 0, { pageId: 2, viewportVersion: 1 })).toEqual({ kind: 'idle' })
    flow.offer(frame(2, { viewportVersion: 1 }))
    expect(flow.next(0, 0, { pageId: 1, viewportVersion: 2 })).toEqual({ kind: 'idle' })
    expect(flow.drops.stale).toBe(2)
    expect(flow.unacknowledged).toBe(0)
  })

  it('waits while the socket buffers, but never holds a frame from an empty socket', () => {
    const flow = new FrameFlow({ maxBufferedBytes: 1_048_576 })
    flow.offer(frame(1, { bytes: 200_000 }))
    expect(flow.next(0, 900_000, current)).toEqual({ kind: 'wait', ms: 84 })
    expect(flow.next(0, 800_000, current).kind).toBe('send')
    flow.ack(1)
    flow.offer(frame(2, { bytes: 3_000_000 }))
    expect(flow.next(1_000, 0, current).kind).toBe('send')
  })

  it('refuses settings that would never send', () => {
    for (const options of [{ maxFps: 0 }, { window: 0 }, { window: 1.5 }, { maxBufferedBytes: 0 }])
      expect(() => new FrameFlow(options), JSON.stringify(options)).toThrow(RangeError)
  })

  /**
   * Chromium paints every 33 ms for ten seconds; the viewer acknowledges a frame `ackDelay` ms
   * after it left, through a link of `bytesPerMs`. Whatever the link, the viewer always gets the
   * newest frame, its lag does not grow, and no more than the window of frames is ever on the
   * link: a slow one carries them late, never a pile of them.
   */
  function simulate(ackDelay: number, bytesPerMs: number, bytes = 60_000) {
    const flow = new FrameFlow()
    const offeredAt = new Map<number, number>()
    const acks: { at: number; seq: number }[] = []
    const sent: { seq: number; at: number; lag: number }[] = []
    let latest = 0
    let buffered = 0
    let peakUnacked = 0
    let peakBuffered = 0
    for (let now = 0; now < 10_000; now++) {
      buffered = Math.max(0, buffered - bytesPerMs)
      if (now % 33 === 0) {
        latest++
        offeredAt.set(latest, now)
        flow.offer(frame(latest, { bytes }))
      }
      while (acks.length > 0 && (acks[0]?.at ?? Infinity) <= now) flow.ack(acks.shift()?.seq ?? 0)
      const decision = flow.next(now, buffered, current)
      if (decision.kind === 'send') {
        const { seq } = decision.frame
        expect(seq).toBe(latest)
        sent.push({ seq, at: now, lag: now - (offeredAt.get(seq) ?? now) })
        buffered += bytes
        peakBuffered = Math.max(peakBuffered, buffered)
        // Delivered once the link has carried it, drawn, then acknowledged.
        acks.push({ at: now + Math.ceil(buffered / bytesPerMs) + ackDelay, seq })
      }
      peakUnacked = Math.max(peakUnacked, flow.unacknowledged)
    }
    return { flow, sent, peakUnacked, peakBuffered }
  }

  it('gives a slow viewer the newest frame without a growing lag', () => {
    for (const [ackDelay, bytesPerMs, bytes] of [
      [20, 10_000, 60_000],
      [400, 10_000, 60_000],
      [100, 100, 60_000],
      [2_500, 50, 60_000],
      // A weak mobile link: a 150 KB frame takes 2.5 s, the second one more than 3 s.
      [20, 60, 150_000],
    ] as const) {
      const { flow, sent, peakUnacked, peakBuffered } = simulate(ackDelay, bytesPerMs, bytes)
      const label = `ack ${ackDelay} ms, ${bytesPerMs} B/ms, ${bytes} B`
      expect(peakUnacked, label).toBeLessThanOrEqual(2)
      expect(peakBuffered, label).toBeLessThanOrEqual(2 * bytes)
      expect(sent.length, label).toBeGreaterThan(0)
      // A frame left at most one paint interval after it was painted, first second or last.
      expect(Math.max(...sent.map((entry) => entry.lag)), label).toBeLessThanOrEqual(33)
      // Never faster than 12 a second.
      for (const [index, entry] of sent.entries())
        if (index > 0)
          expect(entry.at - (sent[index - 1]?.at ?? 0), label).toBeGreaterThanOrEqual(83)
      expect(flow.drops.replaced, label).toBeGreaterThan(0)
    }
  })

  it('sends close to its rate to a fast viewer', () => {
    const { sent, flow } = simulate(5, 100_000)
    expect(sent.length).toBeGreaterThanOrEqual(110)
    expect(sent.length).toBeLessThanOrEqual(121)
    expect(flow.unacknowledged).toBeLessThanOrEqual(1)
  })
})
