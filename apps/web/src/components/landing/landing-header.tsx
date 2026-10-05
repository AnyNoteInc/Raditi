'use client'

import { BrandSymbol } from '@repo/ui/brand-symbol'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { UserMenu } from '@/components/application/user-menu'
import type { LandingViewer } from '@/server/landing-viewer'

import styles from './landing.module.css'

const navigation = [
  { href: '#how', label: 'Как это работает' },
  { href: '#possibilities', label: 'Возможности' },
  { href: '#pricing', label: 'Тарифы' },
]

export function LandingHeader({ viewer }: { viewer: LandingViewer }) {
  const [open, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        toggle.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link href="/" aria-label="Радити — на главную" className={styles.wordmark}>
          <BrandSymbol size={35} className={styles.logoSymbol} />
          Радити
        </Link>
        <nav className={styles.desktopNav} aria-label="Основная навигация">
          {navigation.map(({ href, label }) => (
            <a key={href} href={href}>
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
              aria-label={viewer.status === 'unavailable' ? 'Перейти к проектам' : undefined}
            >
              {viewer.status === 'guest' ? 'Войти' : 'Проекты'}{' '}
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 18 18 6M6 6h12v12" stroke="currentColor" strokeWidth="1.6" />
              </svg>
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
            <span data-open={open} />
            <span data-open={open} />
          </button>
        </div>
      </div>
      <nav
        id="landing-navigation"
        className={styles.mobileNav}
        aria-label="Мобильная навигация"
        hidden={!open}
      >
        {navigation.map(({ href, label }) => (
          <a key={href} href={href} onClick={() => setOpen(false)}>
            {label}
          </a>
        ))}
        {viewer.status !== 'authenticated' && (
          <Link href={viewer.status === 'guest' ? '/sign-up' : '/projects'}>
            {viewer.status === 'guest' ? 'Создать аккаунт' : 'Открыть проекты'}
          </Link>
        )}
      </nav>
    </header>
  )
}
