'use client'

import { useEffect, type RefObject } from 'react'

/** Within this many pixels of its end the dialog follows what arrives. */
export const FEED_FOLLOW_SLACK = 48

/**
 * A dialog keeps to its latest words, as a chat does: it opens at its end and follows what
 * arrives — new rows, the live block, an answer drawn — while the client is at the end, not after
 * they scrolled up to read. From `lg` the feed scrolls in its own `area`; below it the page
 * scrolls. `content` is what grows: every change of its height, or of the area's, brings the end
 * into view again. A move up leaves the end at once, however small; coming back near the end
 * follows again. A feed that is not drawn (on a phone, the panel shown in its place) moves nothing.
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
    // Where the scroller stood after the last scroll, the hook's own included.
    let last = 0
    const onScroll = () => {
      const element = scroller()
      if (!element) return
      const top = element.scrollTop
      const gap = element.scrollHeight - top - element.clientHeight
      // A content that shrank pulls the end up with it: that is no move of the client's.
      if (top < last && gap > 1) following = false
      else if (gap < FEED_FOLLOW_SLACK) following = true
      last = top
    }
    const toEnd = () => {
      const element = scroller()
      if (!element || !following) return
      element.scrollTop = element.scrollHeight
      last = element.scrollTop
    }
    const observer = new ResizeObserver(toEnd)
    observer.observe(grown)
    observer.observe(box)
    box.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    toEnd()
    return () => {
      observer.disconnect()
      box.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
    }
  }, [area, content])
}
