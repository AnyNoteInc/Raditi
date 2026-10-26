'use client'

import { useEffect, useRef } from 'react'

import { brandColors } from '../theme/tokens.ts'
import {
  BRAND_MOTION_DURATION_MS,
  getBrandMotionPose,
  pickBrandMotion,
  type BrandMotionVariant,
} from './brand-motion.ts'
import { BrandSymbol } from './brand-symbol.tsx'

const visitMotions = new WeakMap<Document, BrandMotionVariant>()
const previousMotionKey = 'raditi.brand-motion.previous'

/** One choice per document, including Strict Mode and client-side navigation. */
function getVisitMotion(page: Document): BrandMotionVariant {
  const current = visitMotions.get(page)
  if (current) return current

  let previous: string | null = null
  try {
    previous = page.defaultView?.sessionStorage.getItem(previousMotionKey) ?? null
  } catch {
    // Storage may be disabled; the logo still works without remembering the previous visit.
  }
  const motion = pickBrandMotion(previous)
  visitMotions.set(page, motion)
  try {
    page.defaultView?.sessionStorage.setItem(previousMotionKey, motion)
  } catch {
    // The in-memory choice still keeps all symbols on this page consistent.
  }
  return motion
}

/** A single entrance; the server, reduced-motion mode and final frame share the static symbol. */
export function AnimatedBrandSymbol({
  size = 32,
  className,
}: {
  size?: number
  className?: string
}) {
  const ref = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const svg = ref.current
    if (!svg || typeof window.matchMedia !== 'function') return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (preference.matches || typeof window.requestAnimationFrame !== 'function') return
    const resting = svg.querySelector('path')
    if (!resting) return

    const motion = getVisitMotion(document)
    const namespace = 'http://www.w3.org/2000/svg'
    const group = document.createElementNS(namespace, 'g')
    group.setAttribute('transform', 'translate(30 30)')
    group.setAttribute('fill', 'none')
    group.setAttribute('stroke', brandColors.ink)
    group.setAttribute('stroke-linecap', 'round')
    group.setAttribute('visibility', 'hidden')
    group.setAttribute('data-brand-motion-rays', '')
    const lines = Array.from({ length: 6 }, () => {
      const line = document.createElementNS(namespace, 'line')
      group.append(line)
      return line
    })
    svg.append(group)
    svg.dataset.brandMotion = motion
    svg.dataset.brandMotionState = 'waiting'

    let frame: number | null = null
    let last: number | null = null
    let elapsed = 0
    let complete = false
    let inView = !('IntersectionObserver' in window)
    let observer: IntersectionObserver | undefined

    const pause = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = null
      last = null
    }
    const finish = () => {
      complete = true
      pause()
      group.remove()
      resting.removeAttribute('visibility')
      svg.dataset.brandMotionState = 'complete'
      observer?.disconnect()
    }
    const draw = (progress: number) => {
      getBrandMotionPose(motion, progress).forEach((ray, index) => {
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
      svg.dataset.brandMotionState = 'playing'
    }
    const tick = (now: number) => {
      frame = null
      if (complete || !inView || document.hidden) {
        last = null
        return
      }
      if (last !== null) elapsed += Math.min(now - last, 100)
      last = now
      if (elapsed >= BRAND_MOTION_DURATION_MS) {
        finish()
        return
      }
      draw(elapsed / BRAND_MOTION_DURATION_MS)
      frame = window.requestAnimationFrame(tick)
    }
    const resume = () => {
      if (!complete && inView && !document.hidden && frame === null) {
        frame = window.requestAnimationFrame(tick)
      }
    }
    const onVisibility = () => {
      if (document.hidden) pause()
      else resume()
    }
    const onPreference = () => {
      if (preference.matches) finish()
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
    resume()

    return () => {
      complete = true
      pause()
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      preference.removeEventListener('change', onPreference)
      group.remove()
      resting.removeAttribute('visibility')
      delete svg.dataset.brandMotion
      delete svg.dataset.brandMotionState
    }
  }, [])

  return <BrandSymbol ref={ref} size={size} className={className} />
}
