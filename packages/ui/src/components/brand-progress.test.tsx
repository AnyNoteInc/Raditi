import { cleanup, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BRAND_MOTION_VARIANTS } from './brand-motion.ts'
import { BRAND_PROGRESS_CYCLE_MS, BrandProgress } from './brand-progress.tsx'
import { BrandSymbol } from './brand-symbol.tsx'

class VisibilityObserver {
  readonly targets = new Set<Element>()
  private readonly callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    observers.push(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  disconnect() {
    this.targets.clear()
  }
  report(isIntersecting: boolean) {
    this.callback(
      [...this.targets].map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    )
  }
}

let observers: VisibilityObserver[] = []
let frames = new Map<number, FrameRequestCallback>()
let frameId = 0
let now = 0
let preference: MediaQueryList

function step(ms = 100) {
  now += ms
  const callbacks = [...frames.values()]
  frames.clear()
  callbacks.forEach((callback) => callback(now))
}

function symbol(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg')
  if (!svg) throw new Error('The brand symbol is missing')
  return svg
}

beforeEach(() => {
  observers = []
  frames = new Map()
  frameId = 0
  now = 0
  preference = new EventTarget() as MediaQueryList
  Object.defineProperty(preference, 'matches', { value: false, configurable: true })
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => preference),
  )
  vi.stubGlobal('IntersectionObserver', VisibilityObserver)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback)
      return frameId
    }),
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => frames.delete(id)),
  )
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (document as { hidden?: boolean }).hidden
})

const rays = (svg: SVGSVGElement) =>
  [...svg.querySelectorAll('line')].map((line) => line.getAttribute('x1')).join(' ')

describe('BrandProgress', () => {
  it('serves the still mark before hydration', () => {
    expect(renderToStaticMarkup(<BrandProgress size={24} />)).toBe(
      renderToStaticMarkup(<BrandSymbol size={24} />),
    )
  })

  it('names itself an indeterminate progress bar when given a label', () => {
    const { getByRole } = render(<BrandProgress label="Агент работает" />)
    const bar = getByRole('progressbar', { name: 'Агент работает' })
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
  })

  it('loops one trajectory without end, not a carousel of all four', () => {
    const { container } = render(<BrandProgress variant="orbits" />)
    const svg = symbol(container)
    observers.at(-1)?.report(true)
    step(16)
    expect(svg.dataset.brandProgress).toBe('playing')
    const variants = new Set<string>()
    const poses = new Set<string>()
    for (let at = 0; at < BRAND_MOTION_VARIANTS.length * 2 * BRAND_PROGRESS_CYCLE_MS; at += 100) {
      step(100)
      variants.add(svg.dataset.brandVariant ?? '')
      poses.add(rays(svg))
    }
    expect([...variants]).toEqual(['orbits'])
    expect(frames.size).toBe(1)
    expect(poses.size).toBeGreaterThan(10)
  })

  it('takes a new trajectory at the end of the running cycle', () => {
    const { container, rerender } = render(<BrandProgress variant="orbits" />)
    const svg = symbol(container)
    observers.at(-1)?.report(true)
    step(16)
    const advance = (ms: number) => {
      for (let at = 0; at < ms; at += 100) step(100)
    }
    advance(BRAND_PROGRESS_CYCLE_MS / 2)
    rerender(<BrandProgress variant="spiral" />)
    step(100)
    expect(svg.dataset.brandVariant).toBe('orbits')
    advance(BRAND_PROGRESS_CYCLE_MS / 2)
    expect(svg.dataset.brandVariant).toBe('spiral')
  })

  it('stays still under reduced motion and draws nothing while hidden or out of view', () => {
    Object.defineProperty(preference, 'matches', { value: true, configurable: true })
    const { container, unmount } = render(<BrandProgress />)
    expect(symbol(container).dataset.brandProgress).toBe('still')
    expect(frames.size).toBe(0)
    unmount()

    Object.defineProperty(preference, 'matches', { value: false, configurable: true })
    const second = render(<BrandProgress />)
    observers.at(-1)?.report(true)
    step(16)
    observers.at(-1)?.report(false)
    expect(frames.size).toBe(0)
    observers.at(-1)?.report(true)
    expect(frames.size).toBe(1)
    expect(symbol(second.container).dataset.brandProgress).toBe('playing')
  })
})
