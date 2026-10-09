// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LandingAnchor } from './landing-anchor'

// jsdom lays nothing out, scrolls nothing and keeps no record of the navigation: the place of
// the target, its room under the header, the position of the window and the way the visitor
// came are set by the test, and `scrollIntoView` is a spy.

const ROOM = 104
const scrollIntoView = vi.fn()

/** The page: a section above the plans, the plans with their placeholder, a section below. */
function page({ pending = true } = {}) {
  document.body.innerHTML = `
    <section id="how"></section>
    <section id="pricing">${pending ? '<p data-pending>Загружаем тарифы…</p>' : '<div>plans</div>'}<a id="inside"></a></section>
    <section id="faq"></section>`
  const section = (id: string) => {
    const element = document.getElementById(id)
    if (!element) throw new Error(`no #${id}`)
    return element
  }
  return { how: section('how'), pricing: section('pricing'), faq: section('faq') }
}

/** Puts the element this far below its place under the header. */
function standsOff(element: HTMLElement, offset: number) {
  element.getBoundingClientRect = () => ({ top: ROOM + offset }) as DOMRect
}

/** The plans arrive: the placeholder gives its place to them. */
async function plansArrive(pricing: HTMLElement) {
  pricing.querySelector('[data-pending]')?.replaceWith(document.createElement('div'))
  // The observer is told in a microtask.
  await Promise.resolve()
}

/** Enough frames for the window to count as still. */
const frames = (count = 4) => vi.advanceTimersByTime(count * 16)

/**
 * How the visitor came to the document, as the browser records it; `null` for no record. A
 * string, not `NavigationTimingType`: browsers have recorded values that the type has dropped.
 */
function cameBy(type: string | null) {
  Object.defineProperty(performance, 'getEntriesByType', {
    configurable: true,
    value: (kind: string) => (kind === 'navigation' && type ? [{ type }] : []),
  })
}

/** The document opens with the page in it: React takes over the markup of the server. */
const open = (after = 'pricing', options: { reactStrictMode?: boolean } = {}) =>
  render(<LandingAnchor after={after} />, { hydrate: true, ...options })

/** The router draws the page on a transition inside the application: there is no markup to take over. */
const drawnByRouter = () => render(<LandingAnchor after="pricing" />)

/** What the page would set up before a nudge: nothing of it may be there when it does not nudge. */
function setUp() {
  const observe = vi.spyOn(MutationObserver.prototype, 'observe')
  const listen = vi.spyOn(window, 'addEventListener')
  return () => ({
    observed: observe.mock.calls.length,
    listened: listen.mock.calls.filter(([type]) => type === 'wheel').length,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  Element.prototype.scrollIntoView = scrollIntoView
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    scrollMarginTop: `${ROOM}px`,
  } as CSSStyleDeclaration)
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true })
  cameBy('navigate')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  scrollIntoView.mockReset()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  Reflect.deleteProperty(performance, 'getEntriesByType')
  history.replaceState(null, '', '/')
  document.body.replaceChildren()
})

describe('anchor of the address while the plans load', () => {
  it('puts the target into its place once the plans are in and the window is still', async () => {
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    standsOff(faq, 0)
    open()

    // Nothing while the plans are on their way, however long.
    frames(20)
    expect(scrollIntoView).not.toHaveBeenCalled()

    standsOff(faq, 38)
    await plansArrive(pricing)
    expect(scrollIntoView).not.toHaveBeenCalled()
    frames()
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(scrollIntoView.mock.contexts[0]).toBe(faq)

    // Once: what changes in the section later is not its business.
    pricing.append(document.createElement('div'))
    await Promise.resolve()
    frames(20)
    expect(scrollIntoView).toHaveBeenCalledOnce()
  })

  it('waits for a scroll that is still on its way', async () => {
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    open()
    await plansArrive(pricing)

    // The window travels: every frame finds it at another position.
    standsOff(faq, 900)
    for (let frame = 1; frame <= 10; frame += 1) {
      Object.assign(window, { scrollY: frame * 90 })
      frames(1)
    }
    expect(scrollIntoView).not.toHaveBeenCalled()
    // It has arrived where the target stood before the plans came.
    standsOff(faq, 38)
    frames()
    expect(scrollIntoView).toHaveBeenCalledOnce()
  })

  it('checks the place at once when the plans were there before the script', () => {
    const { faq } = page({ pending: false })
    history.replaceState(null, '', '/#faq')
    standsOff(faq, 25)
    open()

    frames()
    expect(scrollIntoView).toHaveBeenCalledOnce()
  })

  it('leaves a target that stands in its place', async () => {
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    standsOff(faq, 0.4)
    open()
    await plansArrive(pricing)

    frames()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('only nudges: a target far from its place is not brought back', async () => {
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    standsOff(faq, -700)
    open()
    await plansArrive(pricing)

    frames()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])(
    'gives way to a visitor after a %s',
    async (input) => {
      const { pricing, faq } = page()
      history.replaceState(null, '', '/#faq')
      standsOff(faq, 38)
      open()

      window.dispatchEvent(new Event(input))
      await plansArrive(pricing)
      frames(20)
      expect(scrollIntoView).not.toHaveBeenCalled()
    },
  )

  it('gives way to a visitor who acts while the window is on its way', async () => {
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    standsOff(faq, 38)
    open()
    await plansArrive(pricing)

    frames(1)
    document.body.dispatchEvent(new Event('wheel', { bubbles: true }))
    frames(20)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it.each([
    ['no anchor in the address', '/'],
    ['an anchor that names nothing', '/#nothing'],
    ['a target above the plans', '/#how'],
    ['the plans themselves', '/#pricing'],
    ['a target inside the plans', '/#inside'],
  ])('does nothing for %s', async (_, address) => {
    const { pricing, how, faq } = page()
    history.replaceState(null, '', address)
    for (const section of [how, pricing, faq]) standsOff(section, 38)
    const done = setUp()
    open()
    await plansArrive(pricing)

    frames(20)
    expect(scrollIntoView).not.toHaveBeenCalled()
    // Not even a listener: the page pays nothing for a visit without such an anchor.
    expect(done()).toEqual({ observed: 0, listened: 0 })
  })

  it('takes its listeners away when the page goes', async () => {
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    standsOff(faq, 38)
    const { unmount } = open()

    unmount()
    await plansArrive(pricing)
    frames(20)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})

describe('anchor of the address: one opening of a document by a link', () => {
  // The visitor has scrolled a little past the questions; the browser or the router has put the
  // window back there. A nudge would take them to the start of the questions again.
  const PAST = -60

  it.each(['reload', 'back_forward', 'prerender'] as const)(
    'leaves the window where the browser put it after a %s',
    async (type) => {
      const { pricing, faq } = page()
      history.replaceState(null, '', '/#faq')
      standsOff(faq, PAST)
      cameBy(type)
      const done = setUp()
      open()
      await plansArrive(pricing)

      frames(20)
      expect(scrollIntoView).not.toHaveBeenCalled()
      expect(done()).toEqual({ observed: 0, listened: 0 })
    },
  )

  it('does nothing when the browser keeps no record of the way to the document', async () => {
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    standsOff(faq, PAST)
    cameBy(null)
    open()
    await plansArrive(pricing)

    frames(20)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('does nothing on a transition inside the application', async () => {
    // The document was opened by a link, at another page; the router draws the landing later.
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    standsOff(faq, 38)
    const done = setUp()
    drawnByRouter()
    await plansArrive(pricing)

    frames(20)
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(done()).toEqual({ observed: 0, listened: 0 })
  })

  it('nudges once for a document: not when the visitor comes back to the page', async () => {
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    standsOff(faq, 38)
    const { unmount } = open()
    await plansArrive(pricing)
    frames()
    expect(scrollIntoView).toHaveBeenCalledOnce()

    // To another page and back: the router draws the landing anew and restores the place.
    unmount()
    standsOff(faq, PAST)
    drawnByRouter()
    frames(20)
    expect(scrollIntoView).toHaveBeenCalledOnce()
  })

  it('keeps the chance spent when its effect runs anew', async () => {
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    standsOff(faq, 38)
    const { rerender } = open()
    await plansArrive(pricing)
    frames()
    expect(scrollIntoView).toHaveBeenCalledOnce()

    // The same page with its effect set up again, as when a kept page is shown once more.
    standsOff(faq, PAST)
    const done = setUp()
    rerender(<LandingAnchor after="how" />)
    frames(20)
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(done()).toEqual({ observed: 0, listened: 0 })
  })

  it('spends the chance on a visitor who took the page over', async () => {
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    standsOff(faq, 38)
    const { rerender } = open()
    window.dispatchEvent(new Event('wheel'))

    rerender(<LandingAnchor after="how" />)
    await plansArrive(pricing)
    frames(20)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('spends the chance on an opening without an anchor', () => {
    const { faq } = page({ pending: false })
    standsOff(faq, PAST)
    const { rerender } = open()

    // A link of the page itself brings the anchor into the address later.
    history.replaceState(null, '', '/#faq')
    rerender(<LandingAnchor after="how" />)
    frames(20)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('works when React runs every effect twice, as it does in development', async () => {
    const { pricing, faq } = page()
    history.replaceState(null, '', '/#faq')
    standsOff(faq, 38)
    open('pricing', { reactStrictMode: true })
    await plansArrive(pricing)

    frames()
    expect(scrollIntoView).toHaveBeenCalledOnce()
  })
})
