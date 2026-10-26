import { describe, expect, it } from 'vitest'

import {
  BRAND_MOTION_VARIANTS,
  getBrandMotionPose,
  pickBrandMotion,
  type BrandMotionRay,
} from './brand-motion.ts'

/** Ignore ray order and endpoint direction when comparing the assembled mark. */
function geometry(rays: BrandMotionRay[]): string[] {
  const point = (x: number, y: number) =>
    JSON.stringify([Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])
  return rays.map(({ x1, y1, x2, y2 }) => [point(x1, y1), point(x2, y2)].sort().join(':')).sort()
}

const mark = [
  [0, -12.5],
  [10.825, -6.25],
  [10.825, 6.25],
  [0, 12.5],
  [-10.825, 6.25],
  [-10.825, -6.25],
].map(([x, y]) => ({ x1: 0, y1: 0, x2: x!, y2: y!, width: 8.3, opacity: 1 }))

describe('brand motion', () => {
  it.each([null, '', 'unknown'])('can choose all four variants with previous=%s', (previous) => {
    const picks = [0, 0.25, 0.5, 0.75].map((sample) => pickBrandMotion(previous, () => sample))
    expect(picks).toEqual(BRAND_MOTION_VARIANTS)
  })

  it.each(BRAND_MOTION_VARIANTS)('never repeats %s on the next visit', (previous) => {
    const picks = [1 / 6, 0.5, 5 / 6].map((sample) => pickBrandMotion(previous, () => sample))
    expect(picks).toEqual(BRAND_MOTION_VARIANTS.filter((variant) => variant !== previous))
    expect(picks).not.toContain(previous)
  })

  it.each(BRAND_MOTION_VARIANTS)('%s starts and finishes as the original mark', (variant) => {
    for (const progress of [-1, 0, 1, 2]) {
      const pose = getBrandMotionPose(variant, progress)
      expect(geometry(pose)).toEqual(geometry(mark))
      for (const ray of pose) {
        expect(ray.width).toBeCloseTo(8.3, 8)
        expect(ray.opacity).toBe(1)
      }
    }
  })

  it.each(BRAND_MOTION_VARIANTS)('%s keeps its six rays finite and within the icon', (variant) => {
    for (let frame = 0; frame <= 100; frame++) {
      const pose = getBrandMotionPose(variant, frame / 100)
      expect(pose).toHaveLength(6)
      for (const ray of pose) {
        expect(Object.values(ray).every(Number.isFinite)).toBe(true)
        expect(ray.width).toBeGreaterThan(0)
        expect(ray.opacity).toBeGreaterThanOrEqual(0)
        expect(ray.opacity).toBeLessThanOrEqual(1)
        // Include the round cap's radius, allowing a small tolerance around the 30-unit disc.
        expect(Math.hypot(ray.x1, ray.y1) + ray.width / 2).toBeLessThan(32)
        expect(Math.hypot(ray.x2, ray.y2) + ray.width / 2).toBeLessThan(32)
      }
    }
  })

  it('gives the four variants distinct active frames', () => {
    const poses = BRAND_MOTION_VARIANTS.map((variant) =>
      JSON.stringify(geometry(getBrandMotionPose(variant, 0.42))),
    )
    expect(new Set(poses).size).toBe(BRAND_MOTION_VARIANTS.length)
  })
})
