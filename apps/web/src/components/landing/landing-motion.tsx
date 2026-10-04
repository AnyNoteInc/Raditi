'use client'

import { useEffect } from 'react'

/** Progressive enhancement: content remains visible without observers or animation support. */
export function LandingMotion() {
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (preference.matches || !('IntersectionObserver' in window)) return
    const animations: Animation[] = []
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          animations.push(
            entry.target.animate(
              [
                { opacity: 0.55, transform: 'translateY(24px)' },
                { opacity: 1, transform: 'translateY(0)' },
              ],
              { duration: 750, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
            ),
          )
          observer.unobserve(entry.target)
        })
      },
      { threshold: 0.12 },
    )
    document.querySelectorAll('#how, #safety, #faq').forEach((element) => observer.observe(element))
    const reduceMotion = () => {
      if (preference.matches) {
        observer.disconnect()
        animations.forEach((animation) => animation.cancel())
      }
    }
    preference.addEventListener('change', reduceMotion)
    return () => {
      observer.disconnect()
      preference.removeEventListener('change', reduceMotion)
      animations.forEach((animation) => animation.cancel())
    }
  }, [])
  return null
}
