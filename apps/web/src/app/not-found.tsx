import type { Metadata } from 'next'
import Link from 'next/link'

import styles from './status-page.module.css'

export const metadata: Metadata = { title: 'Страница не найдена' }

// On plain CSS: the root's boundary ships with every page (docs/plan/96-review-fixes.md, P33.2).
export default function NotFound() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <p className={styles.overline}>Ошибка 404</p>
        <h1 className={styles.title}>Страница не найдена</h1>
        <p className={styles.text}>
          Возможно, в адресе опечатка или страницу перенесли. Начните с главной.
        </p>
        <Link href="/" className={`${styles.button} ${styles.contained}`}>
          На главную
        </Link>
      </main>
    </div>
  )
}
