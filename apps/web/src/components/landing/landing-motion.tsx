'use client'

import { useEffect } from 'react'

import { EASE_OUT, MOVE_MS, RISE_PX } from './motion'

/**
 * The headings of the sections rise into the window, once each: the targets are the elements
 * that the server marked with `data-reveal`.
 *
 * A progressive enhancement. The page is drawn in its final state, and only a target that is
 * still below the window is put down, before the visitor can see it; it is moved, never dimmed.
 * What is on the screen at the start is not touched, and neither is anything without scripts,
 * without the Web Animations API or under reduced motion: there the observer is not even made.
 *
 * A target marked `data-reveal="scene"` is not moved. It is a scene that plays once, and its
 * beats belong to CSS: the script only tells the scene where it is. While the scene is below
 * the window it carries `data-scene="waiting"` and CSS holds its first frame; when it comes in,
 * the mark turns to `playing` and CSS plays the beats to the final state that it has without
 * any mark.
 */
export function LandingMotion() {
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (
      preference.matches ||
      !('IntersectionObserver' in window) ||
      !('animate' in Element.prototype)
    ) {
      return
    }
    const prepared = new Map<Element, Animation>()
    const scenes = new Set<HTMLElement>()
    for (const target of document.querySelectorAll<HTMLElement>('[data-reveal]')) {
      if (target.getBoundingClientRect().top <= window.innerHeight) continue
      if (target.dataset.reveal === 'scene') {
        target.dataset.scene = 'waiting'
        scenes.add(target)
        continue
      }
      const animation = target.animate(
        { transform: [`translateY(${RISE_PX}px)`, 'none'] },
        // Paused on its first frame, the animation keeps the target put down. It fills
        // backwards only: when the rise has ended, nothing of it stays on the element.
        { duration: MOVE_MS, easing: EASE_OUT, fill: 'backwards' },
      )
      animation.pause()
      prepared.set(target, animation)
    }
    // The line is a little above the bottom of the window, so the rise is seen whole. The margin
    // at the top reaches far above the window: a target that a jump of the page carried past the
    // window is reported too, and takes its place without a move that nobody would see.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting, boundingClientRect } of entries) {
          if (!isIntersecting) continue
          const passed = boundingClientRect.bottom < 0
          if (target instanceof HTMLElement && scenes.has(target)) {
            if (passed) delete target.dataset.scene
            else target.dataset.scene = 'playing'
          } else {
            const animation = prepared.get(target)
            if (passed) animation?.cancel()
            else animation?.play()
          }
          observer.unobserve(target)
        }
      },
      { rootMargin: '100000px 0px -8% 0px', threshold: 0 },
    )
    prepared.forEach((_, target) => observer.observe(target))
    scenes.forEach((scene) => observer.observe(scene))
    const stop = () => {
      observer.disconnect()
      prepared.forEach((animation) => animation.cancel())
      // Without its mark a scene stands in its final state, whether it waited or played.
      scenes.forEach((scene) => delete scene.dataset.scene)
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
