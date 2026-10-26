import { cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AnimatedBrandSymbol } from './animated-brand-symbol.tsx'
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

describe('AnimatedBrandSymbol', () => {
  it('serves the exact static symbol before hydration without choosing a random variant', () => {
    const random = vi.spyOn(Math, 'random')
    expect(renderToStaticMarkup(<AnimatedBrandSymbol size={35} className="logo" />)).toBe(
      renderToStaticMarkup(<BrandSymbol size={35} className="logo" />),
    )
    expect(random).not.toHaveBeenCalled()
  })

  it('keeps the static symbol when reduced motion is requested', () => {
    Object.defineProperty(preference, 'matches', { value: true })
    const { container } = render(<AnimatedBrandSymbol />)
    expect(symbol(container)).not.toHaveAttribute('data-brand-motion')
    expect(symbol(container).querySelector('g')).toBeNull()
    expect(window.requestAnimationFrame).not.toHaveBeenCalled()
  })

  it('shares one choice across symbols and Strict Mode, excluding the preceding visit', () => {
    sessionStorage.setItem('raditi.brand-motion.previous', 'spiral')
    const write = vi.spyOn(Storage.prototype, 'setItem')
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { container } = render(
      <StrictMode>
        <AnimatedBrandSymbol />
        <AnimatedBrandSymbol size={156} />
      </StrictMode>,
    )
    const symbols = [...container.querySelectorAll('svg')]
    expect(symbols.map((svg) => svg.dataset.brandMotion)).toEqual(['counterflow', 'counterflow'])
    expect(write).toHaveBeenCalledExactlyOnceWith('raditi.brand-motion.previous', 'counterflow')
    expect(symbols.every((svg) => svg.getAttribute('aria-hidden') === 'true')).toBe(true)
  })

  it('pauses offscreen and in a hidden tab, then finishes once in the original logo', () => {
    const { container, rerender } = render(<AnimatedBrandSymbol />)
    const svg = symbol(container)
    const resting = svg.querySelector('path')
    expect(frames.size).toBe(0)

    observers[0]?.report(true)
    step()
    step()
    expect(svg).toHaveAttribute('data-brand-motion-state', 'playing')
    expect(resting).toHaveAttribute('visibility', 'hidden')
    expect(svg.querySelectorAll('line')).toHaveLength(6)

    observers[0]?.report(false)
    expect(frames.size).toBe(0)
    observers[0]?.report(true)
    Object.defineProperty(document, 'hidden', { value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(0)

    Object.defineProperty(document, 'hidden', { value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    for (let i = 0; i < 45; i++) step()
    expect(svg).toHaveAttribute('data-brand-motion-state', 'complete')
    expect(resting).not.toHaveAttribute('visibility')
    expect(svg.querySelector('g')).toBeNull()
    expect(frames.size).toBe(0)

    rerender(<AnimatedBrandSymbol size={40} />)
    expect(svg).toHaveAttribute('width', '40')
    expect(svg).toHaveAttribute('data-brand-motion-state', 'complete')
    expect(frames.size).toBe(0)
  })

  it('returns to the static logo immediately when the motion preference changes', () => {
    const { container, unmount } = render(<AnimatedBrandSymbol />)
    observers[0]?.report(true)
    step()
    Object.defineProperty(preference, 'matches', { value: true })
    preference.dispatchEvent(new Event('change'))
    const svg = symbol(container)
    expect(svg.querySelector('g')).toBeNull()
    expect(svg.querySelector('path')).not.toHaveAttribute('visibility')
    expect(frames.size).toBe(0)
    unmount()
    expect(observers[0]?.targets.size).toBe(0)
  })
})
