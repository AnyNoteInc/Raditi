import { describe, expect, it } from 'vitest'

import { Fling, WheelGatherer } from './touch-scroll'

describe('wheel deltas gathered between animation frames', () => {
  it('sends the whole pixels at the newest point, keeping the fraction for later', () => {
    const wheel = new WheelGatherer()
    expect(wheel.take()).toBeNull()
    wheel.add({ x: 10, y: 20 }, 0.4, 3.3)
    wheel.add({ x: 12, y: 18 }, 0.4, 3.3)
    expect(wheel.take()).toEqual({ x: 12, y: 18, dx: 0, dy: 6 })
    // 0.8 and 0.6 were left; a slow finger still moves the page.
    wheel.add({ x: 12, y: 18 }, 0.4, 0.5)
    expect(wheel.take()).toEqual({ x: 12, y: 18, dx: 1, dy: 1 })
    expect(wheel.take()).toBeNull()
  })

  it('moves both ways, never past the bound of an event, and forgets a gesture on clear', () => {
    const wheel = new WheelGatherer()
    wheel.add({ x: 1, y: 1 }, -5.5, 50_000)
    expect(wheel.take()).toEqual({ x: 1, y: 1, dx: -5, dy: 10_000 })
    wheel.add({ x: 1, y: 1 }, Number.NaN, 1)
    wheel.clear()
    expect(wheel.take()).toBeNull()
  })
})

describe('a page let go mid-swipe', () => {
  it('goes on in the direction of the finger, slower and slower, then stops', () => {
    const fling = new Fling()
    // 2 px a millisecond downwards over the last 80 ms.
    for (let at = 0; at <= 80; at += 16) fling.moved(0, 32, at)
    expect(fling.release(80)).toBe(true)
    let total = 0
    let last = Infinity
    let at = 80
    for (let frame = 0; frame < 400 && fling.active; frame++) {
      at += 16
      const step = fling.step(at)
      if (step === null) break
      expect(step.dx).toBe(0)
      expect(step.dy).toBeGreaterThan(0)
      expect(step.dy).toBeLessThanOrEqual(last)
      last = step.dy
      total += step.dy
    }
    expect(fling.active).toBe(false)
    expect(total).toBeGreaterThan(200)
    expect(total).toBeLessThan(1_000)
    expect(fling.step(at + 16)).toBeNull()
  })

  it('does not coast after a finger that stopped before it was lifted, or barely moved', () => {
    const fling = new Fling()
    fling.moved(0, 40, 0)
    expect(fling.release(500)).toBe(false)
    fling.moved(0, 1, 1_000)
    expect(fling.release(1_016)).toBe(false)
  })

  it('stops at a new touch and cuts a throw too fast to follow', () => {
    const fling = new Fling()
    fling.moved(0, 5_000, 0)
    expect(fling.release(16)).toBe(true)
    const first = fling.step(32)
    expect(first?.dy).toBeLessThanOrEqual(8 * 17)
    fling.stop()
    expect(fling.active).toBe(false)
    expect(fling.step(48)).toBeNull()
  })
})
