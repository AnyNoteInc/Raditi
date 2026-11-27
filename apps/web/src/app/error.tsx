'use client'

import Link from 'next/link'
import { useEffect } from 'react'

import styles from './status-page.module.css'

// On plain CSS: the root's boundary ships with every page, the landing too
// (docs/plan/96-review-fixes.md, P33.2).
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <p className={styles.overline}>Ошибка</p>
        <h1 className={styles.title}>Что-то пошло не так</h1>
        <p className={styles.text}>
          Мы уже разбираемся. Попробуйте обновить страницу немного позже.
        </p>
        {error.digest ? (
          <p className={styles.small}>Код ошибки для поддержки: {error.digest}</p>
        ) : null}
        <div className={styles.actions}>
          <button type="button" onClick={reset} className={`${styles.button} ${styles.contained}`}>
            Попробовать ещё раз
          </button>
          <Link href="/" className={`${styles.button} ${styles.outlined}`}>
            На главную
          </Link>
        </div>
      </main>
    </div>
  )
}
