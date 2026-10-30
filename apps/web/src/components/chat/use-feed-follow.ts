'use client'

import { useEffect, type RefObject } from 'react'

/** Within this many pixels of its end the dialog follows what arrives. */
export const FEED_FOLLOW_SLACK = 48

/** Where the client reads: the row at the top of the area, and how far below the top it stands. */
interface ReadPlace {
  row: Element
  offset: number
}

/** The first of the rows, in their order on the screen, that reaches below `top`; null — none. */
function rowBelow(rows: NodeListOf<Element>, top: number): Element | null {
  let low = 0
  let high = rows.length - 1
  let found: Element | null = null
  while (low <= high) {
    const middle = (low + high) >> 1
    const row = rows[middle]!
    if (row.getBoundingClientRect().bottom > top) {
      found = row
      high = middle - 1
    } else low = middle + 1
  }
  return found
}

/**
 * A dialog keeps to its latest words, as a chat does: it opens at its end and follows what
 * arrives — new rows, the live block, an answer drawn — while the client is at the end, not after
 * they scrolled up to read. From `lg` the feed scrolls in its own `area`; below it the page
 * scrolls. `content` is what grows: every change of its height, or of the area's, brings the end
 * into view again. A move up leaves the end at once, however small; coming back near the end
 * follows again.
 *
 * A client who reads above the end keeps their place (docs/plan/59-dialog-tools-panel.md, И19).
 * From `lg` the row at the top of the area stays where it was when the area changes — the panel of
 * the tools opens, switches or closes beside it, the lines wrap anew. Below `lg` an open tool
 * hides the feed: a feed that is not drawn moves nothing, and when it is back the page returns to
 * where the client left it.
 */
export function useFeedFollow(
  area: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const box = area.current
    const grown = content.current
    if (box === null || grown === null || typeof ResizeObserver === 'undefined') return
    // The breakpoint may move while the dialog is open: the scroller is asked for every time.
    const scroller = () => {
      const style = getComputedStyle(box)
      if (style.display === 'none') return null
      return style.overflowY === 'auto' ? box : document.scrollingElement
    }
    let following = true
    // Where the scroller stood after the last scroll, the hook's own included, and which one it was.
    let last = 0
    let lastOf: Element | null = null
    // The feed has not been drawn since the last look at it: a tool took its place.
    let hidden = false
    // From `lg`, where the client reads above the end.
    let place: ReadPlace | null = null

    const readPlace = (): ReadPlace | null => {
      const top = box.getBoundingClientRect().top
      const row = rowBelow(grown.querySelectorAll('[data-feed-row]'), top)
      return row === null ? null : { row, offset: row.getBoundingClientRect().top - top }
    }
    const onScroll = () => {
      const element = scroller()
      if (!element) return
      const top = element.scrollTop
      const gap = element.scrollHeight - top - element.clientHeight
      // A content that shrank pulls the end up with it: that is no move of the client's.
      if (top < last && gap > 1) following = false
      else if (gap < FEED_FOLLOW_SLACK) following = true
      last = top
      lastOf = element
      place = element === box && !following ? readPlace() : null
    }
    const settle = () => {
      const element = scroller()
      if (!element) {
        hidden = true
        return
      }
      const back = hidden
      hidden = false
      if (following) element.scrollTop = element.scrollHeight
      else if (back) {
        // Back from behind a tool: where the client left the feed.
        if (element === lastOf) element.scrollTop = last
      } else if (element === box && place !== null && place.row.isConnected) {
        // The area changed under the client: the row they read stays where it stood.
        const top = box.getBoundingClientRect().top
        const shift = place.row.getBoundingClientRect().top - top - place.offset
        if (shift !== 0) element.scrollTop += shift
      }
      last = element.scrollTop
      lastOf = element
    }
    const observer = new ResizeObserver(settle)
    observer.observe(grown)
    observer.observe(box)
    box.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    settle()
    return () => {
      observer.disconnect()
      box.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
    }
  }, [area, content])
}
