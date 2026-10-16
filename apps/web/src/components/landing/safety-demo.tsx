'use client'

import { useState } from 'react'

import { nbsp } from '@/lib/nbsp'

import { LandingIcon } from './landing-icons'
import { cafe, story } from './landing-story'
import styles from './landing.module.css'

const SAFETY_NOTE = 'Так будет устроена защита сайта.'

/** The card of the safety block and the note that invites to press its button. */
export function SafetyDemo() {
  const [reverted, setReverted] = useState(false)
  return (
    <>
      <div className={styles.safetyDemo} data-reverted={reverted}>
        <div className={styles.savedVersion} aria-hidden="true">
          <span>Копия сохранена</span>
          <span>
            {cafe.item}&nbsp;· {story.before}
          </span>
        </div>
        <div className={styles.versionCard}>
          <div className={styles.versionTop}>
            <span>{cafe.name} / МЕНЮ</span>
            <span>Демо</span>
          </div>
          <div className={styles.versionItem}>
            <span>
              {cafe.item}
              <small>Двойной эспрессо, нежная молочная пена</small>
            </span>
            {/* A new node each time: the price plays its gesture, whose direction the state gives. */}
            <strong key={String(reverted)}>
              {reverted ? story.amount.before : story.amount.after}
              <small>₽</small>
            </strong>
          </div>
          <div className={styles.versionLine}>
            <span>Копия</span>
            <i />
            <span>Правка</span>
            <i />
            <span>Проверка</span>
          </div>
          <p className={styles.versionStatus} role="status">
            <LandingIcon name="check" size={18} strokeWidth={2} linecap="round" />
            {reverted ? 'Прежняя цена возвращена' : nbsp('Новая цена на сайте. Прежняя сохранена.')}
          </p>
          <button
            type="button"
            onClick={() => setReverted(!reverted)}
            className={styles.undoButton}
          >
            {/* The sign of the action: a turn back for the undo, an arrow onward for applying
                again. It keeps its place before the label, which must not jump on a press. */}
            <LandingIcon
              name={reverted ? 'arrow-right' : 'undo'}
              size={18}
              strokeWidth={1.7}
              linecap="round"
              linejoin="round"
            />
            {reverted ? 'Применить снова' : 'Отменить правку'}
          </button>
        </div>
        <span className={styles.safetyCaption}>Можно передумать. Это нормально.</span>
      </div>
      {/* After the card in the markup, as a child of the grid of the block: on a phone the note
          joins the caption under the card, on a desktop CSS keeps it under the list. The
          invitation names the button as it reads before a press. After the press only the
          first sentence is left: CSS shows one of the two versions, in the same place. */}
      <p className={styles.safetyNote} data-reverted={reverted}>
        <span>{nbsp(`${SAFETY_NOTE} Попробуйте: нажмите «Отменить правку» на карточке.`)}</span>
        <span>{nbsp(SAFETY_NOTE)}</span>
      </p>
    </>
  )
}
