'use client'

import { useState } from 'react'

import styles from './landing.module.css'

export function SafetyDemo() {
  const [reverted, setReverted] = useState(false)
  return (
    <div className={styles.safetyDemo}>
      <div className={styles.savedVersion} aria-hidden="true">
        <span>Предыдущая версия сохранена</span>
        <span>Капучино · 250 ₽</span>
      </div>
      <div className={styles.versionCard} data-reverted={reverted}>
        <div className={styles.versionTop}>
          <span>КРОШКА / МЕНЮ</span>
          <span>Демо</span>
        </div>
        <div className={styles.versionItem}>
          <span>
            Капучино<small>Двойной эспрессо, нежная молочная пена</small>
          </span>
          <strong key={String(reverted)}>
            {reverted ? '250' : '290'}
            <small>₽</small>
          </strong>
        </div>
        <div className={styles.versionLine}>
          <span>Снимок</span>
          <i />
          <span>Правка</span>
          <i />
          <span>Проверка</span>
        </div>
        <p className={styles.versionStatus} role="status">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {reverted ? 'Прежняя цена возвращена' : 'Новая цена на сайте. Снимок сохранён.'}
        </p>
        <button type="button" onClick={() => setReverted(!reverted)} className={styles.undoButton}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m8 3-5 5 5 5M3 8h10a6 6 0 0 1 0 12h-3"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {reverted ? 'Повторить правку' : 'Отменить правку'}
        </button>
      </div>
      <span className={styles.safetyCaption}>Можно передумать. Это нормально.</span>
    </div>
  )
}
