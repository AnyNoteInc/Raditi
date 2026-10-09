'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'

/** What a visitor does to move the page or to go somewhere on it. */
const INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/** A target further than this from its place was not left there by a late block. */
const NEAR_PX = 120

/** The window has arrived when it has not moved for this many frames. */
const STILL_FRAMES = 3

/** The markup of the server does not change: there is nothing to listen to. */
const never = () => () => {}

/**
 * Whether the visitor came to the document by a link or by its address. After a reload or a step
 * back or forward the browser puts the window where the visitor left it, not at the anchor.
 */
function cameByLink(): boolean {
  const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
  return entry?.type === 'navigate'
}

/**
 * Keeps a link to an anchor honest while a block above the anchor loads. The browser scrolls to
 * the anchor of the address when the page opens; the plans come from the database a moment
 * later, and what stands below them moves. Their placeholder keeps about their height, so the
 * move is small. When the plans are in and the window has stopped, this puts the target into its
 * place, once.
 *
 * It works once for a document, and only for one that the visitor opened by a link or by its
 * address. After a reload, a step back or forward, or a transition inside the application the
 * window stands where the visitor left it: a target a little off its place is there by their
 * will, and a nudge would take them back.
 *
 * It only ever nudges: a target further than `NEAR_PX` from its place is left alone, because a
 * late block did not put it there. And it gives way to the visitor: after a wheel, a touch, a
 * press or a key the page is theirs. The scroll follows the page, smooth where motion is welcome
 * and at once under reduced motion. Nothing is done without an anchor in the address, or for a
 * target that does not stand after the block.
 *
 * @param after The id of the section whose content arrives late, marked `data-pending` until then.
 */
export function LandingAnchor({ after }: { after: string }) {
  // True only while React takes over the markup that came with the document: a page that the
  // router draws on a transition inside the application is rendered, not taken over.
  const cameWithDocument = useSyncExternalStore(
    never,
    () => false,
    () => true,
  )
  // The one chance of the document. It lives longer than the effect, so it stays spent when the
  // effect runs anew, as for a page that the router kept and shows again.
  const chance = useRef(cameWithDocument)

  useEffect(() => {
    if (!chance.current) return
    const spend = () => {
      chance.current = false
    }
    const block = document.getElementById(after)
    const target = cameByLink() ? document.getElementById(location.hash.slice(1)) : null
    if (
      !block ||
      !target ||
      block.contains(target) ||
      !(block.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)
    ) {
      spend()
      return
    }

    let frame = 0
    const settle = () => {
      finish()
      const place = parseFloat(getComputedStyle(target).scrollMarginTop) || 0
      const offset = Math.abs(target.getBoundingClientRect().top - place)
      if (offset >= 1 && offset <= NEAR_PX) target.scrollIntoView()
    }
    // A smooth scroll to the anchor may still be on its way, to where the target stood before
    // the block came: the nudge waits for it to arrive.
    const whenStill = () => {
      let last = window.scrollY
      let still = 0
      const check = () => {
        still = window.scrollY === last ? still + 1 : 0
        last = window.scrollY
        if (still < STILL_FRAMES) frame = requestAnimationFrame(check)
        else settle()
      }
      frame = requestAnimationFrame(check)
    }
    const observer = new MutationObserver(() => {
      if (block.querySelector('[data-pending]')) return
      observer.disconnect()
      whenStill()
    })
    function stop() {
      observer.disconnect()
      cancelAnimationFrame(frame)
      for (const input of INPUTS) window.removeEventListener(input, finish, true)
    }
    // The chance is spent when the place has been checked or the visitor has taken the page
    // over. Not when the effect is merely cleaned up: in development React runs every effect
    // twice, and the second run is the one that lives.
    function finish() {
      stop()
      spend()
    }

    for (const input of INPUTS)
      window.addEventListener(input, finish, { capture: true, passive: true })
    if (block.querySelector('[data-pending]')) observer.observe(block, { childList: true })
    else whenStill()
    return stop
  }, [after])
  return null
}
