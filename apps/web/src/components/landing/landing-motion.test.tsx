// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LandingMotion } from './landing-motion'
import { stubIntersectionObserver, type ObserverStub } from './testing'

// jsdom has no IntersectionObserver: it is stubbed, and the test tells which targets the helper
// marks and what it does when the observer reports. The motion itself is CSS: css-modules.test.ts
// reads its rules, and the browser checks of the landing watch it play.

const WINDOW_HEIGHT = 768
let observers: ObserverStub[] = []

/** A target with its top at the given distance from the top of the window. */
function target(top: number, kind = '') {
  const element = document.createElement('div')
  element.setAttribute('data-reveal', kind)
  element.getBoundingClientRect = () => ({ top }) as DOMRect
  // A script that moved the target itself would be seen here.
  const animate = vi.fn()
  Object.assign(element, { animate })
  document.body.append(element)
  return { element, animate }
}

// A heading and a scene differ only in what CSS plays on them: the helper treats them alike.
const kinds = [['a heading', ''] as const, ['a scene', 'scene'] as const]

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
    vi.stubGlobal('innerHeight', WINDOW_HEIGHT)
    observers = stubIntersectionObserver()
    reducedMotion(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  describe.each(kinds)('%s', (_, kind) => {
    it('is marked as waiting only below the window, and is not moved by the script', () => {
      const visible = target(120, kind)
      const atTheEdge = target(WINDOW_HEIGHT, kind)
      const below = target(WINDOW_HEIGHT + 1, kind)
      render(<LandingMotion />)

      // What is on the screen at the start stays in its final state, as CSS draws it.
      expect(visible.element).not.toHaveAttribute('data-scene')
      expect(atTheEdge.element).not.toHaveAttribute('data-scene')
      expect(below.element).toHaveAttribute('data-scene', 'waiting')
      expect(below.animate).not.toHaveBeenCalled()
      expect(below.element).not.toHaveAttribute('style')
      expect(observers).toHaveLength(1)
      expect([...(observers[0]?.observed ?? [])]).toEqual([below.element])
    })

    it('plays once when it comes into the window', () => {
      const below = target(WINDOW_HEIGHT + 200, kind)
      render(<LandingMotion />)
      const observer = observers[0]

      observer?.report(below.element, false, WINDOW_HEIGHT + 300)
      expect(below.element).toHaveAttribute('data-scene', 'waiting')
      observer?.report(below.element, true, 500)
      expect(below.element).toHaveAttribute('data-scene', 'playing')
      // Not watched any more: the way back and forth starts nothing.
      expect(observer?.observed.size).toBe(0)
    })

    it('takes its place without a move when a jump carried it past the window', () => {
      const below = target(WINDOW_HEIGHT + 200, kind)
      render(<LandingMotion />)

      observers[0]?.report(below.element, true, -40)
      expect(below.element).not.toHaveAttribute('data-scene')
      expect(observers[0]?.observed.size).toBe(0)
    })

    it('is not touched under reduced motion: no observer is made', () => {
      reducedMotion(true)
      const below = target(WINDOW_HEIGHT + 200, kind)
      render(<LandingMotion />)

      expect(observers).toHaveLength(0)
      expect(below.element).not.toHaveAttribute('data-scene')
    })

    it('loses its mark when reduced motion is turned on', () => {
      const waiting = target(WINDOW_HEIGHT + 200, kind)
      const playing = target(WINDOW_HEIGHT + 600, kind)
      render(<LandingMotion />)
      observers[0]?.report(playing.element, true, 500)

      turnReducedMotionOn()
      expect(waiting.element).not.toHaveAttribute('data-scene')
      expect(playing.element).not.toHaveAttribute('data-scene')
      expect(observers[0]?.disconnected).toBe(true)
    })

    it('is given back when the helper leaves the page', () => {
      const waiting = target(WINDOW_HEIGHT + 200, kind)
      const playing = target(WINDOW_HEIGHT + 600, kind)
      const { unmount } = render(<LandingMotion />)
      observers[0]?.report(playing.element, true, 500)
      unmount()

      expect(observers[0]?.disconnected).toBe(true)
      expect(waiting.element).not.toHaveAttribute('data-scene')
      expect(playing.element).not.toHaveAttribute('data-scene')
    })
  })

  it('watches the headings and the scenes with one observer', () => {
    const heading = target(WINDOW_HEIGHT + 200)
    const scene = target(WINDOW_HEIGHT + 400, 'scene')
    render(<LandingMotion />)

    expect(observers).toHaveLength(1)
    expect([...(observers[0]?.observed ?? [])]).toEqual([heading.element, scene.element])
  })

  it('leaves the page as it is in a browser without an IntersectionObserver', () => {
    Reflect.deleteProperty(window, 'IntersectionObserver')
    const below = target(WINDOW_HEIGHT + 200)
    render(<LandingMotion />)

    expect(below.element).not.toHaveAttribute('data-scene')
  })

  describe('the mark of the fonts', () => {
    const root = document.documentElement
    let fontsAreIn: () => void = () => undefined

    beforeEach(() => {
      const ready = new Promise<void>((resolve) => {
        fontsAreIn = resolve
      })
      Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } })
    })

    afterEach(() => {
      Reflect.deleteProperty(document, 'fonts')
    })

    it('is set on the root element only when the fonts are in', async () => {
      render(<LandingMotion />)
      await Promise.resolve()
      expect(root).not.toHaveAttribute('data-fonts')

      fontsAreIn()
      await vi.waitFor(() => expect(root).toHaveAttribute('data-fonts', 'ready'))
    })

    it('is set under reduced motion too: CSS decides what it means there', async () => {
      reducedMotion(true)
      render(<LandingMotion />)
      fontsAreIn()

      await vi.waitFor(() => expect(root).toHaveAttribute('data-fonts', 'ready'))
    })

    it('is taken away when the helper leaves the page', async () => {
      const { unmount } = render(<LandingMotion />)
      fontsAreIn()
      await vi.waitFor(() => expect(root).toHaveAttribute('data-fonts', 'ready'))

      unmount()
      expect(root).not.toHaveAttribute('data-fonts')
    })

    it('is not set by fonts that came after the helper left', async () => {
      const { unmount } = render(<LandingMotion />)
      unmount()
      fontsAreIn()
      await Promise.resolve()
      await Promise.resolve()

      expect(root).not.toHaveAttribute('data-fonts')
    })

    it('is set at once in a browser that does not tell about its fonts', async () => {
      Reflect.deleteProperty(document, 'fonts')
      render(<LandingMotion />)

      await vi.waitFor(() => expect(root).toHaveAttribute('data-fonts', 'ready'))
    })
  })
})
