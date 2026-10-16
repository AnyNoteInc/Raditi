import { act } from '@testing-library/react'
import { vi } from 'vitest'

import type { LandingViewer } from '@/server/landing-viewer'

import type { LandingPricingData } from './pricing-calculator'

// What the tests of the landing share: the plans of the seeds, the two visitors, the reading of a
// text with non-breaking spaces, the passing of time and a stub of IntersectionObserver.

export const pricing: LandingPricingData = {
  plans: [
    {
      slug: 'start',
      name: 'Старт',
      price: '4900.00',
      creditsPerMonth: 300,
      tasksPerDay: 5,
      maxSites: 1,
    },
    {
      slug: 'business',
      name: 'Бизнес',
      price: '12900.00',
      creditsPerMonth: 800,
      tasksPerDay: 10,
      maxSites: 3,
    },
    {
      slug: 'agency',
      name: 'Агентство',
      price: '39900.00',
      creditsPerMonth: 2500,
      tasksPerDay: 30,
      maxSites: 15,
    },
  ],
  pack: { price: '1990.00', credits: 100 },
}

export const guest: LandingViewer = { status: 'guest', user: null }
export const member: LandingViewer = {
  status: 'authenticated',
  user: { name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru', image: null },
}

/** The text as it reads: the page sets non-breaking spaces, the expectations are typed with plain ones. */
export const plain = (text: string | null | undefined) => (text ?? '').replaceAll('\u00a0', ' ')

/**
 * A short preposition or conjunction before a plain space: a line may end with it. Written here
 * apart from the list of nbsp.ts, so the tests check that list and do not repeat it.
 */
export const HANGING =
  /(?<![\p{L}\p{N}-])(в|во|с|со|к|ко|о|об|у|и|а|но|на|до|за|по|не|ни|от|из|для|без|при|про|над|под) /iu

/** Lets the fake timers run for the given time, with what React renders in answer. */
export function pass(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

type ObserverEntry = Pick<
  IntersectionObserverEntry,
  'target' | 'isIntersecting' | 'boundingClientRect'
>

/** An IntersectionObserver of a test: it tells what is watched and reports what the test says. */
export class ObserverStub {
  readonly observed = new Set<Element>()
  readonly options: IntersectionObserverInit | undefined
  disconnected = false
  private readonly callback: (entries: ObserverEntry[]) => void
  constructor(callback: (entries: ObserverEntry[]) => void, options?: IntersectionObserverInit) {
    this.callback = callback
    this.options = options
  }
  observe(target: Element) {
    this.observed.add(target)
  }
  unobserve(target: Element) {
    this.observed.delete(target)
  }
  disconnect() {
    this.disconnected = true
    this.observed.clear()
  }
  /** Reports the target as the browser would; `bottom` is the bottom of its box in the window. */
  report(target: Element, isIntersecting: boolean, bottom = 0) {
    const boundingClientRect = { bottom } as DOMRectReadOnly
    act(() => this.callback([{ target, isIntersecting, boundingClientRect }]))
  }
}

/**
 * jsdom has no IntersectionObserver: this puts a stub in its place and returns the observers that
 * the page makes from now on. The test takes the stub away with `vi.unstubAllGlobals()`.
 */
export function stubIntersectionObserver(): ObserverStub[] {
  const observers: ObserverStub[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class extends ObserverStub {
      constructor(
        callback: (entries: ObserverEntry[]) => void,
        options?: IntersectionObserverInit,
      ) {
        super(callback, options)
        observers.push(this)
      }
    },
  )
  return observers
}
