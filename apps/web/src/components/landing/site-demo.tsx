'use client'

import { BrandSymbol } from '@repo/ui/brand-symbol'
import { useEffect, useReducer } from 'react'
import styles from './site-demo.module.css'

type ScenarioId = 'price' | 'hours' | 'promotion'
type Phase = 'preparing' | 'review' | 'applying' | 'applied' | 'undone'

const scenarios = {
  price: {
    label: 'Цена',
    request: 'Поменяй цену капучино на 290 ₽',
    field: 'Капучино, 250 мл',
    before: '250 ₽',
    after: '290 ₽',
    result: 'Готово. В меню уже новая цена.',
  },
  hours: {
    label: 'График',
    request: 'По субботам открываемся в 8:00. Обнови сайт',
    field: 'Часы работы в субботу',
    before: '09:00–21:00',
    after: '08:00–21:00',
    result: 'Готово. По субботам — с восьми утра.',
  },
  promotion: {
    label: 'Акция',
    request: 'Добавь акцию: второй кофе за полцены',
    field: 'Плашка над меню',
    before: 'Без акции',
    after: 'Второй кофе −50%',
    result: 'Готово. Акция появилась на сайте.',
  },
} as const

const scenarioIds: ScenarioId[] = ['price', 'hours', 'promotion']

type DemoState = { scenario: ScenarioId; phase: Phase; revision: number }
type DemoAction =
  | { type: 'choose'; scenario: ScenarioId }
  | { type: 'apply' }
  | { type: 'undo' }
  | { type: 'finish'; revision: number; phase: Phase }

function reducer(state: DemoState, action: DemoAction): DemoState {
  if (action.type === 'choose') {
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

function Arrow({ undo = false }: { undo?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {undo ? (
        <>
          <path d="m9 5-5 5 5 5" />
          <path d="M4 10h10a5 5 0 0 1 0 10h-3" />
        </>
      ) : (
        <>
          <path d="M4 12h15" />
          <path d="m13 6 6 6-6 6" />
        </>
      )}
    </svg>
  )
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}

export function SiteDemo() {
  const [state, dispatch] = useReducer(reducer, {
    scenario: 'price',
    phase: 'review',
    revision: 0,
  })
  const scenario = scenarios[state.scenario]
  const isApplied = state.phase === 'applied'
  const isBusy = state.phase === 'preparing' || state.phase === 'applying'

  useEffect(() => {
    if (state.phase !== 'preparing' && state.phase !== 'applying') return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(
      () => dispatch({ type: 'finish', revision: state.revision, phase: state.phase }),
      reducedMotion ? 0 : state.phase === 'preparing' ? 650 : 700,
    )
    return () => window.clearTimeout(timer)
  }, [state.phase, state.revision])

  const status =
    state.phase === 'preparing'
      ? 'Нахожу нужное место на странице…'
      : state.phase === 'applying'
        ? 'Сохраняю копию и применяю правку…'
        : state.phase === 'applied'
          ? scenario.result
          : state.phase === 'undone'
            ? 'Вернул как было. Всё под контролем.'
            : 'Подготовил правку. Посмотрите:'

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
        <span className={styles.captionHint}>Выберите задачу</span>
      </figcaption>

      <div className={styles.scenarios} role="group" aria-label="Выберите пример правки">
        {scenarioIds.map((id) => (
          <button
            key={id}
            type="button"
            className={styles.scenario}
            aria-pressed={state.scenario === id}
            onClick={() => dispatch({ type: 'choose', scenario: id })}
          >
            {scenarios[id].label}
          </button>
        ))}
      </div>

      <div className={styles.stage} data-phase={state.phase}>
        <div className={styles.browser}>
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
              kroshka.example
            </span>
            <span className={styles.browserLabel}>
              {isApplied ? 'Изменено' : state.phase === 'undone' ? 'Возвращено' : 'До правки'}
            </span>
          </div>

          <div className={styles.cafe}>
            <div className={styles.cafeTopline}>
              <span>КОФЕ · ВЫПЕЧКА · СОСЕДИ</span>
              <span>С 2019</span>
            </div>
            <div className={styles.cafeIdentity}>
              <span className={styles.cafeName}>КРОШКА</span>
              <svg className={styles.sun} viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <circle cx="32" cy="32" r="12" fill="currentColor" stroke="none" />
                <path d="M32 3v9m0 40v9M3 32h9m40 0h9M11.5 11.5l6.4 6.4m28.2 28.2 6.4 6.4m0-41-6.4 6.4M17.9 46.1l-6.4 6.4" />
              </svg>
            </div>
            <p className={styles.cafeTagline}>Большие планы начинаются с маленького кофе.</p>

            <div
              className={styles.promotion}
              data-selected={state.scenario === 'promotion'}
              data-changed={isApplied && state.scenario === 'promotion'}
            >
              {isApplied && state.scenario === 'promotion'
                ? 'ВТОРОЙ КОФЕ −50% · БЕРИТЕ ДРУГА'
                : 'ХОРОШИЙ ДЕНЬ. ХОРОШИЙ КОФЕ.'}
            </div>

            <div className={styles.cafeDetails}>
              <div
                className={styles.cafeRow}
                data-selected={state.scenario === 'price'}
                data-changed={isApplied && state.scenario === 'price'}
              >
                <span>
                  Капучино <small>250 мл</small>
                </span>
                <strong key={`price-${isApplied && state.scenario === 'price'}`}>
                  {isApplied && state.scenario === 'price' ? '290 ₽' : '250 ₽'}
                </strong>
              </div>
              <div
                className={styles.cafeRow}
                data-selected={state.scenario === 'hours'}
                data-changed={isApplied && state.scenario === 'hours'}
              >
                <span>В субботу</span>
                <strong key={`hours-${isApplied && state.scenario === 'hours'}`}>
                  {isApplied && state.scenario === 'hours' ? '08:00–21:00' : '09:00–21:00'}
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

        <div className={styles.chat}>
          <div className={styles.chatHeader}>
            <BrandSymbol size={30} />
            <div className={styles.agentTitle}>
              <strong>Радити</strong>
              <span>Заботится о вашем сайте</span>
            </div>
            <span className={styles.chatStatus} aria-label="Демонстрационный чат" />
          </div>

          <div className={styles.chatBody}>
            <div className={styles.request} key={state.scenario}>
              {scenario.request}
            </div>
            <div className={styles.reply}>
              <p className={styles.replyStatus} aria-live="polite" aria-atomic="true">
                {isBusy && <span className={styles.activity} aria-hidden="true" />}
                {isApplied && <Check />}
                {status}
              </p>
              <div className={styles.diff}>
                <span className={styles.diffLabel}>{scenario.field}</span>
                <div className={styles.diffValues}>
                  <span className={styles.before}>{scenario.before}</span>
                  <Arrow />
                  <span className={styles.after}>{scenario.after}</span>
                </div>
              </div>
              <button
                className={styles.action}
                type="button"
                disabled={isBusy}
                data-undo={isApplied}
                onClick={() => dispatch({ type: isApplied ? 'undo' : 'apply' })}
              >
                <span>
                  {state.phase === 'preparing'
                    ? 'Готовлю правку…'
                    : state.phase === 'applying'
                      ? 'Применяю…'
                      : isApplied
                        ? 'Отменить правку'
                        : state.phase === 'undone'
                          ? 'Применить снова'
                          : 'Применить правку'}
                </span>
                <Arrow undo={isApplied} />
              </button>
            </div>
          </div>
          <div className={styles.chatFooter}>
            <Check />
            Сначала копия. Потом изменения.
          </div>
        </div>
      </div>

      <p className={styles.disclaimer}>
        Это вымышленная кофейня. Попробуйте правку и отмену — ваш сайт не изменится.
      </p>
    </figure>
  )
}
