'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import {
  COOKIE_CONSENT_CHANGE_EVENT,
  COOKIE_SETTINGS_OPEN_EVENT,
  cookieConsentAssignment,
  type CookieConsent,
} from '@/lib/cookie-consent'
import { legalDocumentHref } from '@/lib/legal'

import styles from './cookie-banner.module.css'

/**
 * The notice about cookies on the first visit (privacy policy, section 9). It does not block the
 * page: necessary cookies work either way, the choice decides only analytics. The server opens it
 * when the request carries no choice, so it shows with the first paint and never flashes for a
 * visitor who has chosen; «Настройки cookie» opens it again to change or take back the choice.
 */
export function CookieBanner({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)

  useEffect(() => {
    const reopen = () => setOpen(true)
    window.addEventListener(COOKIE_SETTINGS_OPEN_EVENT, reopen)
    return () => window.removeEventListener(COOKIE_SETTINGS_OPEN_EVENT, reopen)
  }, [])

  if (!open) return null

  const choose = (analyticsAllowed: boolean) => {
    const now = new Date()
    document.cookie = cookieConsentAssignment(
      analyticsAllowed,
      now,
      window.location.protocol === 'https:',
    )
    const consent: CookieConsent = { analyticsAllowed, chosenAt: now }
    window.dispatchEvent(new CustomEvent(COOKIE_CONSENT_CHANGE_EVENT, { detail: consent }))
    setOpen(false)
  }

  return (
    <div role="region" aria-label="Файлы cookie" className={styles.banner}>
      <p className={styles.text}>
        Мы используем файлы cookie. Необходимые нужны, чтобы сайт и&nbsp;вход в&nbsp;кабинет
        работали — без них сайт не&nbsp;откроется. Аналитические помогают понять, как сайтом
        пользуются, и&nbsp;ставятся только с&nbsp;вашего согласия. Подробнее — в&nbsp;
        <Link href={legalDocumentHref('privacy-policy')} className={styles.link}>
          Политике обработки персональных данных
        </Link>
        . Изменить выбор можно по&nbsp;ссылке «Настройки cookie» внизу главной страницы.
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.button} ${styles.outlined}`}
          onClick={() => choose(false)}
        >
          Только необходимые
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.contained}`}
          onClick={() => choose(true)}
        >
          Принять все
        </button>
      </div>
    </div>
  )
}

/** «Настройки cookie» in a footer: opens the banner again. */
export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event(COOKIE_SETTINGS_OPEN_EVENT))}
    >
      Настройки cookie
    </button>
  )
}
