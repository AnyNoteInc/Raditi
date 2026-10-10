'use client'

import { useEffect } from 'react'

/**
 * What is below the window plays once when it comes in: the targets are the elements that the
 * server marked with `data-reveal`. The motion itself belongs to CSS; the script only tells a
 * target where it is. While the target is below the window it carries `data-scene="waiting"`
 * and CSS holds its first frame; when it comes in, the mark turns to `playing` and CSS plays to
 * the final state, which is the one the target has without any mark.
 *
 * A plain target is the heading of a section: it waits put down and rises into its place, moved
 * and never dimmed. A target marked `data-reveal="scene"` has beats of its own, written next to
 * its styles.
 *
 * A progressive enhancement. The page is drawn in its final state, and only a target that is
 * still below the window is marked, before the visitor can see it. What is on the screen at the
 * start is not touched, and neither is anything without scripts or under reduced motion: there
 * the observer is not even made.
 *
 * The helper also tells CSS when the fonts are in, with `data-fonts="ready"` on the root element:
 * only then is the way to an anchor smooth. The browser goes to the anchor of the address at once,
 * so the lines that the fonts rewrap on a first visit cannot move the target while the window is
 * on its way to it.
 */
export function LandingMotion() {
  useEffect(() => {
    const root = document.documentElement
    let left = false
    const ready = 'fonts' in document ? document.fonts.ready : Promise.resolve()
    void ready.then(() => {
      if (!left) root.dataset.fonts = 'ready'
    })
    return () => {
      left = true
      delete root.dataset.fonts
    }
  }, [])
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (preference.matches || !('IntersectionObserver' in window)) return
    const targets = new Set<HTMLElement>()
    for (const target of document.querySelectorAll<HTMLElement>('[data-reveal]')) {
      if (target.getBoundingClientRect().top <= window.innerHeight) continue
      target.dataset.scene = 'waiting'
      targets.add(target)
    }
    // The line is a little above the bottom of the window, so the motion is seen whole. The
    // margin at the top reaches far above the window: a target that a jump of the page carried
    // past the window is reported too, and takes its place without a move that nobody would see.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting, boundingClientRect } of entries) {
          if (!isIntersecting || !(target instanceof HTMLElement)) continue
          if (boundingClientRect.bottom < 0) delete target.dataset.scene
          else target.dataset.scene = 'playing'
          observer.unobserve(target)
        }
      },
      { rootMargin: '100000px 0px -8% 0px', threshold: 0 },
    )
    targets.forEach((target) => observer.observe(target))
    const stop = () => {
      observer.disconnect()
      // Without its mark a target stands in its final state, whether it waited or played.
      targets.forEach((target) => delete target.dataset.scene)
    }
    const reduceMotion = () => {
      if (preference.matches) stop()
    }
    preference.addEventListener('change', reduceMotion)
    return () => {
      stop()
      preference.removeEventListener('change', reduceMotion)
    }
  }, [])
  return null
}
