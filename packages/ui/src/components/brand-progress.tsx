'use client'

import { useEffect, useRef } from 'react'

import { brandColors } from '../theme/tokens.ts'
import {
  BRAND_MOTION_DURATION_MS,
  BRAND_MOTION_VARIANTS,
  getBrandMotionPose,
} from './brand-motion.ts'
import { BrandSymbol } from './brand-symbol.tsx'

/** One trajectory of the loop: faster than the entrance of the logo — this one says «working». */
export const BRAND_PROGRESS_CYCLE_MS = Math.round(BRAND_MOTION_DURATION_MS * 0.6)

/**
 * The mark as a loading indicator (owner's request of 09.11.2026: «моушен дизайн анимированных
 * картинок raditi, который зациклены на progress»): the four approved trajectories of the logo play
 * one after another, without end. Each starts and ends in the resting pose, so the loop has no
 * seam. The server and reduced-motion mode draw the still mark; a hidden page or one out of view
 * does not draw at all. With `label` it is an indeterminate progress bar of that name; without one —
 * a decoration beside words that say it.
 */
export function BrandProgress({
  size = 24,
  label,
  className,
}: {
  size?: number
  label?: string
  className?: string
}) {
  const ref = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const svg = ref.current
    if (!svg || typeof window.matchMedia !== 'function') return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (typeof window.requestAnimationFrame !== 'function') return
    const resting = svg.querySelector('path')
    if (!resting) return

    const namespace = 'http://www.w3.org/2000/svg'
    const group = document.createElementNS(namespace, 'g')
    group.setAttribute('transform', 'translate(30 30)')
    group.setAttribute('fill', 'none')
    group.setAttribute('stroke', brandColors.ink)
    group.setAttribute('stroke-linecap', 'round')
    group.setAttribute('visibility', 'hidden')
    const lines = Array.from({ length: 6 }, () => {
      const line = document.createElementNS(namespace, 'line')
      group.append(line)
      return line
    })
    svg.append(group)

    let frame: number | null = null
    let last: number | null = null
    let elapsed = 0
    let inView = !('IntersectionObserver' in window)
    let observer: IntersectionObserver | undefined

    const still = () => {
      group.setAttribute('visibility', 'hidden')
      resting.removeAttribute('visibility')
      svg.dataset.brandProgress = 'still'
    }
    const pause = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = null
      last = null
    }
    const draw = () => {
      const cycle = Math.floor(elapsed / BRAND_PROGRESS_CYCLE_MS)
      const variant = BRAND_MOTION_VARIANTS[cycle % BRAND_MOTION_VARIANTS.length] ?? 'spiral'
      const progress = (elapsed % BRAND_PROGRESS_CYCLE_MS) / BRAND_PROGRESS_CYCLE_MS
      getBrandMotionPose(variant, progress).forEach((ray, index) => {
        const line = lines[index]
        if (!line) return
        line.setAttribute('x1', String(ray.x1))
        line.setAttribute('y1', String(ray.y1))
        line.setAttribute('x2', String(ray.x2))
        line.setAttribute('y2', String(ray.y2))
        line.setAttribute('stroke-width', String(ray.width))
        line.setAttribute('opacity', String(ray.opacity))
      })
      resting.setAttribute('visibility', 'hidden')
      group.removeAttribute('visibility')
      svg.dataset.brandProgress = 'playing'
    }
    const tick = (now: number) => {
      frame = null
      if (!inView || document.hidden || preference.matches) {
        last = null
        return
      }
      if (last !== null) elapsed += Math.min(now - last, 100)
      last = now
      draw()
      frame = window.requestAnimationFrame(tick)
    }
    const resume = () => {
      if (inView && !document.hidden && !preference.matches && frame === null)
        frame = window.requestAnimationFrame(tick)
    }
    const onVisibility = () => {
      if (document.hidden) pause()
      else resume()
    }
    const onPreference = () => {
      if (preference.matches) {
        pause()
        still()
      } else resume()
    }
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => {
        inView = entries.some((entry) => entry.isIntersecting)
        if (inView) resume()
        else pause()
      })
      observer.observe(svg)
    }
    document.addEventListener('visibilitychange', onVisibility)
    preference.addEventListener('change', onPreference)
    if (preference.matches) still()
    resume()

    return () => {
      pause()
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      preference.removeEventListener('change', onPreference)
      group.remove()
      resting.removeAttribute('visibility')
      delete svg.dataset.brandProgress
    }
  }, [])

  const symbol = <BrandSymbol ref={ref} size={size} className={className} />
  return label === undefined ? (
    symbol
  ) : (
    <span role="progressbar" aria-label={label} style={{ display: 'inline-flex', flex: 'none' }}>
      {symbol}
    </span>
  )
}
