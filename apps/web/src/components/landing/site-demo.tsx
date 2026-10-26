'use client'

import { AnimatedBrandSymbol } from '@repo/ui/animated-brand-symbol'
import { useEffect, useId, useReducer, type CSSProperties } from 'react'

import { nbsp } from '@/lib/nbsp'

import { LandingIcon } from './landing-icons'
import { cafe, scenarioIds, scenarios, type ScenarioId } from './landing-story'
import { PHASE_MS } from './motion'
import styles from './site-demo.module.css'

type Phase = 'preparing' | 'review' | 'applying' | 'applied' | 'undone'

export type DemoState = { scenario: ScenarioId; phase: Phase; revision: number }
export type DemoAction =
  | { type: 'choose'; scenario: ScenarioId }
  | { type: 'apply' }
  | { type: 'undo' }
  | { type: 'finish'; revision: number; phase: Phase }

export const initialDemoState: DemoState = { scenario: 'price', phase: 'review', revision: 0 }

export function reducer(state: DemoState, action: DemoAction): DemoState {
  if (action.type === 'choose') {
    // Choosing the current scenario again must not drop an applied change.
    if (action.scenario === state.scenario) return state
    return { scenario: action.scenario, phase: 'preparing', revision: state.revision + 1 }
  }
  if (action.type === 'apply' && (state.phase === 'review' || state.phase === 'undone')) {
    return { ...state, phase: 'applying' }
  }
  if (action.type === 'undo' && state.phase === 'applied') {
    return { ...state, phase: 'undone' }
  }
  if (
    action.type === 'finish' &&
    action.revision === state.revision &&
    action.phase === state.phase
  ) {
    if (state.phase === 'preparing') return { ...state, phase: 'review' }
    if (state.phase === 'applying') return { ...state, phase: 'applied' }
  }
  return state
}

type PhaseView = {
  /** The status of the chat; the applied phase tells the result of the scenario instead. */
  status?: string
  /** The sign before the status: Радити is working, the change is on the site, it is taken back. */
  sign?: 'activity' | 'check' | 'undo'
  /** The label of the site window. */
  site: string
  /** The label of the action. */
  action: string
  /** A busy phase ends by a timer after this pause, and the action waits for it. */
  pause?: number
}

/** What each phase shows, in one place: the markup below asks this table, not the phase. */
const phases: Record<Phase, PhaseView> = {
  preparing: {
    status: nbsp('Нахожу нужное место на странице…'),
    sign: 'activity',
    site: nbsp('До правки'),
    action: 'Готовлю правку…',
    pause: PHASE_MS.preparing,
  },
  review: {
    status: 'Подготовил правку. Посмотрите:',
    site: nbsp('До правки'),
    action: 'Применить правку',
  },
  applying: {
    status: nbsp('Сохраняю копию и применяю правку…'),
    sign: 'activity',
    site: nbsp('До правки'),
    action: 'Применяю…',
    pause: PHASE_MS.applying,
  },
  applied: { sign: 'check', site: 'Изменено', action: 'Отменить правку' },
  undone: {
    status: nbsp('Вернул как было. Всё под контролем.'),
    sign: 'undo',
    site: 'Возвращено',
    action: 'Применить снова',
  },
}

export function SiteDemo() {
  const [state, dispatch] = useReducer(reducer, initialDemoState)
  const hintId = useId()
  const scenario = scenarios[state.scenario]
  const view = phases[state.phase]
  const isApplied = state.phase === 'applied'
  // The field of the site that shows its new value: the one of the request, once it is applied.
  const changed = isApplied ? state.scenario : null
  const isBusy = view.pause !== undefined

  useEffect(() => {
    if (view.pause === undefined) return
    // The pause stays under reduced motion: it gives the status time to be read and keeps a
    // double click from applying and undoing the change at once.
    const timer = window.setTimeout(
      () => dispatch({ type: 'finish', revision: state.revision, phase: state.phase }),
      view.pause,
    )
    return () => window.clearTimeout(timer)
  }, [view.pause, state.phase, state.revision])

  return (
    <figure
      id="site-demo"
      tabIndex={-1}
      className={styles.demo}
      aria-label="Интерактивная демонстрация работы Радити"
    >
      <figcaption className={styles.caption}>
        <span>
          <span className={styles.liveDot} />
          Интерактивное демо
        </span>
      </figcaption>

      {/* The hint stands at the buttons and names their group: it is what the buttons answer. */}
      <div className={styles.scenarios} role="group" aria-labelledby={hintId}>
        <span className={styles.scenariosHint} id={hintId}>
          Выберите, что попросить:
        </span>
        <div className={styles.scenarioList}>
          {scenarioIds.map((id) => (
            <button
              key={id}
              type="button"
              className={styles.scenario}
              aria-pressed={state.scenario === id}
              onClick={() => dispatch({ type: 'choose', scenario: id })}
            >
              {/* Every button has the mark, CSS shows it in the chosen one: `aria-pressed`
                  tells the choice to a screen reader, the mark tells it without colour. */}
              <LandingIcon name="check" size={11} />
              {scenarios[id].label}
            </button>
          ))}
        </div>
      </div>

      {/* The animations of a busy phase take its length from the same number as the timer. */}
      <div
        className={styles.stage}
        data-phase={state.phase}
        style={isBusy ? ({ '--demo-phase': `${view.pause}ms` } as CSSProperties) : undefined}
      >
        <div className={styles.browser} role="group" aria-label="Пример сайта кофейни">
          <div className={styles.browserBar}>
            <div className={styles.windowDots} aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <span className={styles.address}>
              <svg width="10" height="12" viewBox="0 0 12 14" fill="none" aria-hidden="true">
                <rect x="2" y="6" width="8" height="6" rx="1" />
                <path d="M4 6V4a2 2 0 0 1 4 0v2" />
              </svg>
              {cafe.address}
            </span>
            <span className={styles.browserLabel}>{view.site}</span>
          </div>

          <div className={styles.cafe}>
            <div className={styles.cafeTopline}>
              <span>КОФЕ&nbsp;· ВЫПЕЧКА&nbsp;· СОСЕДИ</span>
              <span>С&nbsp;2019</span>
            </div>
            <div className={styles.cafeIdentity}>
              <span className={styles.cafeName}>{cafe.name}</span>
              <svg className={styles.sun} viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <circle cx="32" cy="32" r="12" fill="currentColor" stroke="none" />
                <path d="M32 3v9m0 40v9M3 32h9m40 0h9M11.5 11.5l6.4 6.4m28.2 28.2 6.4 6.4m0-41-6.4 6.4M17.9 46.1l-6.4 6.4" />
              </svg>
            </div>
            <p className={styles.cafeTagline}>Большие планы начинаются с&nbsp;маленького кофе.</p>

            <div
              className={styles.promotion}
              data-selected={state.scenario === 'promotion'}
              data-changed={changed === 'promotion'}
            >
              {changed === 'promotion' ? cafe.banner.after : cafe.banner.before}
            </div>

            <div className={styles.cafeDetails}>
              <div
                className={styles.cafeRow}
                data-selected={state.scenario === 'price'}
                data-changed={changed === 'price'}
              >
                <span>
                  {cafe.item} <small>{cafe.volume}</small>
                </span>
                <strong key={`price-${changed === 'price'}`}>
                  {scenarios.price[changed === 'price' ? 'after' : 'before']}
                </strong>
              </div>
              <div
                className={styles.cafeRow}
                data-selected={state.scenario === 'hours'}
                data-changed={changed === 'hours'}
              >
                <span>В&nbsp;субботу</span>
                <strong key={`hours-${changed === 'hours'}`}>
                  {scenarios.hours[changed === 'hours' ? 'after' : 'before']}
                </strong>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.connection} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <div className={styles.chat} role="group" aria-label="Демонстрационный чат">
          <div className={styles.chatHeader}>
            <AnimatedBrandSymbol size={30} />
            <div className={styles.agentTitle}>
              <strong>Радити</strong>
              <span>{nbsp('ИИ-помощник для вашего сайта')}</span>
            </div>
            <span className={styles.chatStatus} aria-hidden="true" />
          </div>

          <div className={styles.chatBody}>
            <span className={styles.requestAuthor}>Вы</span>
            <div className={styles.request} key={state.scenario}>
              {scenario.request}
            </div>
            <div className={styles.reply}>
              <p className={styles.replyStatus} aria-live="polite" aria-atomic="true">
                {view.sign === 'activity' && (
                  <span className={styles.activity} aria-hidden="true" />
                )}
                {view.sign === 'check' && <LandingIcon name="check" size={16} />}
                {view.sign === 'undo' && <LandingIcon name="undo-demo" size={16} />}
                {view.status ?? scenario.result}
                {/* The region is atomic: after «Готово» the offer would contradict the status,
                    so the change is told in words only while it waits for the decision. */}
                {state.phase === 'review' && (
                  <span data-sr-only>
                    {` ${scenario.field}: было ${scenario.before}, станет ${scenario.after}.`}
                  </span>
                )}
              </p>
              <div className={styles.diff}>
                <span className={styles.diffLabel}>{scenario.field}</span>
                <div className={styles.diffValues}>
                  <span className={styles.before}>
                    <span data-sr-only>Было: </span>
                    {scenario.before}
                  </span>
                  <span className={styles.becomes}>
                    <LandingIcon name="arrow-right" size={18} />
                    <span className={styles.after}>
                      <span data-sr-only>Станет: </span>
                      {scenario.after}
                    </span>
                  </span>
                </div>
              </div>
              {/* The reducer drops an action that does not fit the phase, so the busy button
                  needs no `disabled`, which would take the focus of the keyboard away. */}
              <button
                className={styles.action}
                type="button"
                aria-disabled={isBusy}
                data-undo={isApplied}
                onClick={() => dispatch({ type: isApplied ? 'undo' : 'apply' })}
              >
                <span>{view.action}</span>
                <LandingIcon name={isApplied ? 'undo-demo' : 'arrow-right'} size={18} />
              </button>
            </div>
          </div>
          <div className={styles.chatFooter}>
            <LandingIcon name="check" size={16} />
            Сначала копия. Потом изменения.
          </div>
        </div>
      </div>

      <p className={styles.disclaimer}>
        {nbsp(
          'Это вымышленная кофейня, просьбы готовые. Попробуйте применить правку и отменить её — ваш сайт не изменится.',
        )}
      </p>
    </figure>
  )
}
