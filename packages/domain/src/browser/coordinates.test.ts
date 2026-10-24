import { describe, expect, it } from 'vitest'

import { fitRect, toViewportPoint } from './coordinates.ts'

const window1280 = { width: 1280, height: 800 }

describe('fitRect', () => {
  it('fills an exact fit without margins', () => {
    expect(fitRect({ width: 1280, height: 800 }, window1280)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
      scale: 1,
    })
    expect(fitRect({ width: 640, height: 400 }, window1280)).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 400,
      scale: 0.5,
    })
  })

  it('centres the image with margins left and right in a wide panel', () => {
    expect(fitRect({ width: 1000, height: 400 }, window1280)).toEqual({
      x: 180,
      y: 0,
      width: 640,
      height: 400,
      scale: 0.5,
    })
  })

  it('centres it with margins above and below in a tall one, odd pixel to the bottom', () => {
    expect(fitRect({ width: 640, height: 601 }, window1280)).toEqual({
      x: 0,
      y: 100,
      width: 640,
      height: 400,
      scale: 0.5,
    })
  })

  it('scales up past the window size, and rounds to whole pixels inside the container', () => {
    const rect = fitRect({ width: 1921, height: 1500 }, window1280)
    expect(rect.width).toBe(1921)
    expect(rect.height).toBe(1201)
    expect(rect.scale).toBeCloseTo(1.5008, 4)
    const odd = fitRect({ width: 333, height: 333 }, { width: 390, height: 844 })
    expect(Number.isInteger(odd.x) && Number.isInteger(odd.width)).toBe(true)
    expect(odd.x + odd.width).toBeLessThanOrEqual(333)
    expect(odd.y + odd.height).toBeLessThanOrEqual(333)
  })

  it('is empty when there is nothing to draw into or from', () => {
    const empty = { x: 0, y: 0, width: 0, height: 0, scale: 0 }
    expect(fitRect({ width: 0, height: 500 }, window1280)).toEqual(empty)
    expect(fitRect({ width: 500, height: 500 }, { width: 0, height: 800 })).toEqual(empty)
    expect(fitRect({ width: Number.NaN, height: 500 }, window1280)).toEqual(empty)
    expect(fitRect({ width: 500, height: Number.POSITIVE_INFINITY }, window1280)).toEqual(empty)
    expect(fitRect({ width: -10, height: 500 }, window1280)).toEqual(empty)
  })
})

describe('toViewportPoint', () => {
  const rect = fitRect({ width: 1000, height: 400 }, window1280)

  it('maps a point on the image to the window pixel under it', () => {
    expect(toViewportPoint({ x: 180, y: 0 }, rect, window1280)).toEqual({ x: 0, y: 0 })
    expect(toViewportPoint({ x: 500, y: 200 }, rect, window1280)).toEqual({ x: 640, y: 400 })
    expect(toViewportPoint({ x: 180.6, y: 0.4 }, rect, window1280)).toEqual({ x: 1, y: 0 })
    // The last pixel of the image is the last of the window, never past it.
    expect(toViewportPoint({ x: 819.999, y: 399.999 }, rect, window1280)).toEqual({
      x: 1279,
      y: 799,
    })
  })

  it('sends nothing for a point on a margin or off the canvas', () => {
    for (const point of [
      { x: 179.9, y: 10 },
      { x: 820, y: 10 },
      { x: 500, y: -0.1 },
      { x: 500, y: 400 },
      { x: -5, y: -5 },
      { x: Number.NaN, y: 10 },
    ])
      expect(toViewportPoint(point, rect, window1280), JSON.stringify(point)).toBeNull()
  })

  it('sends nothing when nothing is drawn', () => {
    const empty = fitRect({ width: 0, height: 0 }, window1280)
    expect(toViewportPoint({ x: 0, y: 0 }, empty, window1280)).toBeNull()
    expect(toViewportPoint({ x: 0, y: 0 }, rect, { width: 0, height: 800 })).toBeNull()
  })

  it('is the inverse of the fit at every scale, within a pixel', () => {
    for (const viewport of [window1280, { width: 390, height: 844 }, { width: 1440, height: 900 }])
      for (const container of [
        { width: 300, height: 700 },
        { width: 1600, height: 900 },
        { width: 777, height: 333 },
      ]) {
        const fitted = fitRect(container, viewport)
        for (const [fx, fy] of [
          [0.1, 0.1],
          [0.5, 0.5],
          [0.9, 0.3],
        ] as const) {
          const target = { x: Math.floor(viewport.width * fx), y: Math.floor(viewport.height * fy) }
          const point = {
            x: fitted.x + ((target.x + 0.5) * fitted.width) / viewport.width,
            y: fitted.y + ((target.y + 0.5) * fitted.height) / viewport.height,
          }
          const back = toViewportPoint(point, fitted, viewport)
          expect(Math.abs((back?.x ?? -9) - target.x)).toBeLessThanOrEqual(1)
          expect(Math.abs((back?.y ?? -9) - target.y)).toBeLessThanOrEqual(1)
        }
      }
  })
})
