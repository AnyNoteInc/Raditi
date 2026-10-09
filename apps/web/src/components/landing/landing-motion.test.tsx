// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LandingMotion } from './landing-motion'
import { EASE_OUT, MOVE_MS, RISE_PX } from './motion'

// jsdom has neither an IntersectionObserver nor the Web Animations API: both are stubbed, and
// the test tells which targets the helper prepares and what it does when the observer reports.

type Entry = Pick<IntersectionObserverEntry, 'target' | 'isIntersecting' | 'boundingClientRect'>

const WINDOW_HEIGHT = 768
let observers: ObserverStub[] = []

class ObserverStub {
  observed = new Set<Element>()
  disconnected = false
  private readonly callback: (entries: Entry[]) => void
  constructor(callback: (entries: Entry[]) => void) {
    this.callback = callback
    observers.push(this)
  }
  observe(target: Element) {
    this.observed.add(target)
  }
  unobserve(target: Element) {
    this.observed.delete(target)
  }
  disconnect() {
    this.disconnected = true
  }
  report(target: Element, isIntersecting: boolean, bottom: number) {
    this.callback([{ target, isIntersecting, boundingClientRect: { bottom } as DOMRectReadOnly }])
  }
}

const animation = () => ({ pause: vi.fn(), play: vi.fn(), cancel: vi.fn() })

/** A target with its top at the given distance from the top of the window. */
function target(top: number) {
  const element = document.createElement('div')
  element.setAttribute('data-reveal', '')
  element.getBoundingClientRect = () => ({ top }) as DOMRect
  const handle = animation()
  const animate = vi.fn(() => handle)
  Object.assign(element, { animate })
  document.body.append(element)
  return { element, animate, handle }
}

/** A scene: a target that is not moved, only told where it is. */
function scene(top: number) {
  const made = target(top)
  made.element.setAttribute('data-reveal', 'scene')
  return made
}

let preferenceListeners: (() => void)[] = []
let prefersReduced = false

function reducedMotion(matches: boolean) {
  prefersReduced = matches
  preferenceListeners = []
  vi.stubGlobal('matchMedia', (media: string) => ({
    get matches() {
      return prefersReduced
    },
    media,
    addEventListener: (_: string, listener: () => void) => preferenceListeners.push(listener),
    removeEventListener: () => undefined,
  }))
}

/** The visitor turns reduced motion on while the page is open. */
function turnReducedMotionOn() {
  prefersReduced = true
  preferenceListeners.forEach((listener) => listener())
}

describe('LandingMotion', () => {
  beforeEach(() => {
    observers = []
    vi.stubGlobal('innerHeight', WINDOW_HEIGHT)
    vi.stubGlobal('IntersectionObserver', ObserverStub)
    // The helper asks the prototype whether the browser animates at all.
    Object.assign(Element.prototype, { animate: () => animation() })
    reducedMotion(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(Element.prototype, 'animate')
    document.body.replaceChildren()
  })

  it('prepares only the targets below the window, and only with a shift', () => {
    const visible = target(120)
    const atTheEdge = target(WINDOW_HEIGHT)
    const below = target(WINDOW_HEIGHT + 1)
    render(<LandingMotion />)

    expect(visible.animate).not.toHaveBeenCalled()
    expect(atTheEdge.animate).not.toHaveBeenCalled()
    expect(below.animate).toHaveBeenCalledExactlyOnceWith(
      { transform: [`translateY(${RISE_PX}px)`, 'none'] },
      { duration: MOVE_MS, easing: EASE_OUT, fill: 'backwards' },
    )
    expect(below.handle.pause).toHaveBeenCalledOnce()
    expect(below.handle.play).not.toHaveBeenCalled()
    expect(observers).toHaveLength(1)
    expect([...(observers[0]?.observed ?? [])]).toEqual([below.element])
  })

  it('plays a target once when it comes into the window', () => {
    const below = target(WINDOW_HEIGHT + 200)
    render(<LandingMotion />)
    const observer = observers[0]

    observer?.report(below.element, false, WINDOW_HEIGHT + 300)
    expect(below.handle.play).not.toHaveBeenCalled()
    observer?.report(below.element, true, 500)
    expect(below.handle.play).toHaveBeenCalledOnce()
    expect(below.handle.cancel).not.toHaveBeenCalled()
    expect(observer?.observed.size).toBe(0)
  })

  it('puts a target that a jump carried past the window in its place without a move', () => {
    const below = target(WINDOW_HEIGHT + 200)
    render(<LandingMotion />)

    observers[0]?.report(below.element, true, -40)
    expect(below.handle.cancel).toHaveBeenCalledOnce()
    expect(below.handle.play).not.toHaveBeenCalled()
  })

  it('makes no observer and touches nothing under reduced motion', () => {
    reducedMotion(true)
    const below = target(WINDOW_HEIGHT + 200)
    const waiting = scene(WINDOW_HEIGHT + 400)
    render(<LandingMotion />)

    expect(observers).toHaveLength(0)
    expect(below.animate).not.toHaveBeenCalled()
    expect(waiting.element).not.toHaveAttribute('data-scene')
  })

  it('does not move a scene: it marks one below the window as waiting and plays it once', () => {
    const visible = scene(120)
    const below = scene(WINDOW_HEIGHT + 200)
    render(<LandingMotion />)
    const observer = observers[0]

    // A scene on the screen at the start stays in its final state, as CSS draws it.
    expect(visible.element).not.toHaveAttribute('data-scene')
    expect(below.element).toHaveAttribute('data-scene', 'waiting')
    expect(below.animate).not.toHaveBeenCalled()
    expect([...(observer?.observed ?? [])]).toEqual([below.element])

    observer?.report(below.element, false, WINDOW_HEIGHT + 300)
    expect(below.element).toHaveAttribute('data-scene', 'waiting')
    observer?.report(below.element, true, 500)
    expect(below.element).toHaveAttribute('data-scene', 'playing')
    expect(observer?.observed.size).toBe(0)
  })

  it('leaves a scene that a jump carried past the window in its final state', () => {
    const below = scene(WINDOW_HEIGHT + 200)
    render(<LandingMotion />)

    observers[0]?.report(below.element, true, -40)
    expect(below.element).not.toHaveAttribute('data-scene')
  })

  it('takes the marks off the scenes when reduced motion is turned on or the page is left', () => {
    const waiting = scene(WINDOW_HEIGHT + 200)
    const playing = scene(WINDOW_HEIGHT + 600)
    const { unmount } = render(<LandingMotion />)
    observers[0]?.report(playing.element, true, 500)

    turnReducedMotionOn()
    expect(waiting.element).not.toHaveAttribute('data-scene')
    expect(playing.element).not.toHaveAttribute('data-scene')
    expect(observers[0]?.disconnected).toBe(true)

    unmount()
    expect(waiting.element).not.toHaveAttribute('data-scene')
  })

  it('leaves the page as it is in a browser without the Web Animations API', () => {
    Reflect.deleteProperty(Element.prototype, 'animate')
    const below = target(WINDOW_HEIGHT + 200)
    render(<LandingMotion />)

    expect(observers).toHaveLength(0)
    expect(below.animate).not.toHaveBeenCalled()
  })

  it('gives the targets back when it leaves the page', () => {
    const below = target(WINDOW_HEIGHT + 200)
    const { unmount } = render(<LandingMotion />)
    unmount()

    expect(observers[0]?.disconnected).toBe(true)
    expect(below.handle.cancel).toHaveBeenCalledOnce()
  })
})
