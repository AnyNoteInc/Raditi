'use client'

import { BrandSymbol } from '@repo/ui/brand-symbol'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { UserMenu } from '@/components/application/user-menu'
import type { LandingViewer } from '@/server/landing-viewer'

import { LandingIcon } from './landing-icons'
import styles from './landing.module.css'

const navigation = [
  { href: '#how', label: 'Как это работает' },
  { href: '#possibilities', label: 'Возможности' },
  { href: '#pricing', label: 'Тарифы' },
  { href: '#faq', label: 'Вопросы' },
]

export function LandingHeader({ viewer }: { viewer: LandingViewer }) {
  const [open, setOpen] = useState(false)
  // The section of the navigation that the visitor is reading, if it is one of them.
  const [current, setCurrent] = useState<string | null>(null)
  const header = useRef<HTMLElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return
    const crossing = new Set<string>()
    // A thin band just above the middle of the window: the section that crosses it is the one
    // being read. Between the sections of the navigation nothing crosses it, and no link is
    // marked.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          if (isIntersecting) crossing.add(`#${target.id}`)
          else crossing.delete(`#${target.id}`)
        }
        setCurrent(navigation.find(({ href }) => crossing.has(href))?.href ?? null)
      },
      { rootMargin: '-45% 0px -50% 0px' },
    )
    for (const { href } of navigation) {
      const section = document.querySelector(href)
      if (section) observer.observe(section)
    }
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!open) return
    const node = header.current
    const isOutside = (target: EventTarget | null) =>
      target instanceof Node && !node?.contains(target)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        // Without a scroll: the button is in the sticky header, always on the screen, and the
        // browser would move the page to «show» it.
        toggle.current?.focus({ preventScroll: true })
      }
    }
    // A press on the page and the focus going on past the menu both mean the visitor has left
    // it. The focus is not returned to the toggle: it is already where the visitor put it.
    const onPointerDown = (event: PointerEvent) => {
      if (isOutside(event.target)) setOpen(false)
    }
    // Without a related target the focus has left the window or gone to nothing: the menu stays.
    const onFocusOut = (event: FocusEvent) => {
      if (isOutside(event.relatedTarget)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    node?.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
      node?.removeEventListener('focusout', onFocusOut)
    }
  }, [open])
  return (
    <header ref={header} className={styles.header}>
      <div className={styles.headerInner}>
        <Link href="/" aria-label="Радити — на главную" className={styles.wordmark}>
          <BrandSymbol size={35} className={styles.logoSymbol} />
          Радити
        </Link>
        <nav className={styles.desktopNav} aria-label="Основная навигация">
          {navigation.map(({ href, label }) => (
            <a key={href} href={href} aria-current={current === href ? 'true' : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <div className={styles.headerActions}>
          {viewer.status === 'authenticated' ? (
            <div className={styles.headerIdentity}>
              <UserMenu user={viewer.user} />
            </div>
          ) : (
            <Link
              href={viewer.status === 'guest' ? '/sign-in' : '/projects'}
              className={styles.signIn}
            >
              {viewer.status === 'guest' ? 'Войти' : 'Проекты'}{' '}
              <LandingIcon name="arrow-up-right" size={17} strokeWidth={1.6} />
            </Link>
          )}
          {/* CSS shows it from 1100px, where the row still keeps one line. Up to 800px the
              registration is in the mobile menu; between the two the header has neither, and the
              registration is the main action of the first screen. */}
          {viewer.status === 'guest' && (
            <Link href="/sign-up" className={styles.signUp}>
              Зарегистрироваться
            </Link>
          )}
          <button
            ref={toggle}
            type="button"
            className={styles.menuToggle}
            aria-label={open ? 'Закрыть меню' : 'Открыть меню'}
            aria-expanded={open}
            aria-controls="landing-navigation"
            onClick={() => setOpen(!open)}
          >
            <span />
            <span />
          </button>
        </div>
      </div>
      <nav
        id="landing-navigation"
        className={styles.mobileNav}
        aria-label="Мобильная навигация"
        hidden={!open}
        // A closed menu is still shown while it fades out: its links must not take the focus.
        inert={!open}
      >
        {navigation.map(({ href, label }) => (
          <a
            key={href}
            href={href}
            aria-current={current === href ? 'true' : undefined}
            onClick={() => setOpen(false)}
          >
            {label}
          </a>
        ))}
        {viewer.status !== 'authenticated' && (
          <Link href={viewer.status === 'guest' ? '/sign-up' : '/projects'}>
            {viewer.status === 'guest' ? 'Зарегистрироваться' : 'Открыть проекты'}
          </Link>
        )}
      </nav>
    </header>
  )
}
