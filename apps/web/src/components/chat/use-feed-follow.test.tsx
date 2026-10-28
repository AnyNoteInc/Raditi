// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FEED_FOLLOW_SLACK, useFeedFollow } from './use-feed-follow'

/**
 * The feed as the dialog lays it out: from `lg` an area that scrolls (`overflowY: auto`), below
 * it an area the page scrolls; `display: none` — the panel is shown in its place.
 */
function Feed({ scrolls = true, hidden = false }: { scrolls?: boolean; hidden?: boolean }) {
  const area = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  useFeedFollow(area, content)
  return (
    <div
      ref={area}
      data-testid="area"
      style={{ overflowY: scrolls ? 'auto' : 'visible', display: hidden ? 'none' : 'flex' }}
    >
      <div ref={content} />
    </div>
  )
}

type Sizes = { scrollHeight: number; clientHeight: number }

/** jsdom lays nothing out: the heights are given, the scroll is kept as set. */
function measure(element: Element, sizes: Sizes) {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => sizes.scrollHeight,
  })
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => sizes.clientHeight,
  })
}

/** The client scrolls to `top`. */
function scrollTo(element: Element, top: number, target: Element | Window = element) {
  element.scrollTop = top
  fireEvent.scroll(target)
}

/** The scroller of the page; jsdom has none, a browser gives the root element. */
const page = document.documentElement
Object.defineProperty(document, 'scrollingElement', { configurable: true, get: () => page })

let grow: () => void
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        grow = callback
      }
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('the dialog keeps to its latest words', () => {
  it('opens at the end and follows what arrives while the client is there', () => {
    const sizes = { scrollHeight: 2000, clientHeight: 600 }
    const view = render(<Feed />)
    const area = view.getByTestId('area')
    measure(area, sizes)
    grow()
    expect(area.scrollTop).toBe(2000)
    sizes.scrollHeight = 2600
    grow()
    expect(area.scrollTop).toBe(2600)
  })

  it('stays where the client scrolled up to read, and follows again back at the end', () => {
    const sizes = { scrollHeight: 2000, clientHeight: 600 }
    const view = render(<Feed />)
    const area = view.getByTestId('area')
    measure(area, sizes)
    grow()
    scrollTo(area, 300)
    sizes.scrollHeight = 2400
    grow()
    expect(area.scrollTop).toBe(300)
    // Back within the slack of the end: what arrives is followed again.
    scrollTo(area, 2400 - 600 - FEED_FOLLOW_SLACK + 1)
    sizes.scrollHeight = 2900
    grow()
    expect(area.scrollTop).toBe(2900)
  })

  it('leaves the end on the smallest move up, not only past the slack', () => {
    const sizes = { scrollHeight: 2000, clientHeight: 600 }
    const view = render(<Feed />)
    const area = view.getByTestId('area')
    measure(area, sizes)
    grow()
    // At the very end, then ten pixels up — still inside the slack.
    scrollTo(area, 1400)
    scrollTo(area, 1390)
    sizes.scrollHeight = 2300
    grow()
    expect(area.scrollTop).toBe(1390)
  })

  it('keeps following when the content shrank under the end', () => {
    const sizes = { scrollHeight: 2000, clientHeight: 600 }
    const view = render(<Feed />)
    const area = view.getByTestId('area')
    measure(area, sizes)
    grow()
    // The live block gave way to a shorter answer: the browser pulled the scroll up to the end.
    sizes.scrollHeight = 1800
    scrollTo(area, 1200)
    sizes.scrollHeight = 2500
    grow()
    expect(area.scrollTop).toBe(2500)
  })

  it('scrolls the page below `lg`, where the area does not scroll itself', () => {
    const sizes = { scrollHeight: 3000, clientHeight: 800 }
    measure(page, sizes)
    render(<Feed scrolls={false} />)
    grow()
    expect(page.scrollTop).toBe(3000)
    scrollTo(page, 500, window)
    sizes.scrollHeight = 3400
    grow()
    expect(page.scrollTop).toBe(500)
  })

  it('moves nothing while the feed is not drawn', () => {
    page.scrollTop = 120
    measure(page, { scrollHeight: 3000, clientHeight: 800 })
    render(<Feed scrolls={false} hidden />)
    grow()
    expect(page.scrollTop).toBe(120)
  })
})
