'use client'

import { averageTaskCredits, typicalTaskCredits } from '@repo/domain/billing/credit-numbers'
import Link from 'next/link'
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'

import { formatCount } from '@/lib/count'
import { nbsp } from '@/lib/nbsp'
import { planDescription } from '@/lib/plan-description'
import { plural } from '@/lib/plural'
import { formatRubles } from '@/lib/rubles'

import { LandingIcon } from './landing-icons'
import { mainAction, mainActionNote } from './main-action'
import {
  packsInWords,
  planInWords,
  pluralCredits,
  pluralTasks,
  recommendPlan,
  tasksAt,
  typicalCreditsInWords,
  type LandingPack,
  type LandingPricingData,
  type PlanRecommendation,
} from './pricing-calculator'
import styles from './pricing.module.css'

/** How long the slider rests before its result is announced: a drag passes many values. */
export const ANNOUNCE_DELAY_MS = 500

/** The ends of the slider, in tasks a month. */
const MIN_TASKS = 10
const MAX_TASKS = 300

const NO_PACK = 'Для такого числа задач пока нет доступного пакета. Выберите меньше задач.'

/**
 * What the slider counts and how its number becomes credits: the average charge the calculator
 * multiplies by and what the two commonest kinds of request cost. Estimates of the credits model,
 * so the sentence says «среднее» and «обычно»; each number is a constant of the domain.
 */
const TASK_HINT = `Задача — одна ваша просьба. В расчёте берём ${averageTaskCredits} ${pluralCredits(averageTaskCredits)} на задачу — это среднее: поменять цену или фото стоит обычно ${typicalCreditsInWords(typicalTaskCredits.small)}, добавить блок или страницу — ${typicalCreditsInWords(typicalTaskCredits.block, false)}.`

/** « и 4 дополнительных пакета по 100 кредитов» after the name of the plan, or nothing. */
function packsPhrase(recommendation: PlanRecommendation, pack: LandingPack | null) {
  return pack && recommendation.packs > 0
    ? ` и ${packsInWords(recommendation.packs, pack.credits)}`
    : ''
}

/** The result as one sentence for a screen reader, built from the strings of the visible one. */
function resultInWords(recommendation: PlanRecommendation | null, pack: LandingPack | null) {
  if (!recommendation) return NO_PACK
  return `Тариф «${recommendation.plan.name}»${packsPhrase(recommendation, pack)}, ${formatRubles(recommendation.total)} ₽ в месяц, в среднем около ${formatRubles(recommendation.perTaskRounded)} ₽ за задачу`
}

export function Pricing({
  plans,
  pack,
  isGuest = true,
}: LandingPricingData & { isGuest?: boolean }) {
  const action = mainAction(isGuest)
  const [tasks, setTasks] = useState(30)
  // The value on which the slider came to rest; nothing is announced until the visitor moves it.
  const [announcedTasks, setAnnouncedTasks] = useState<number | null>(null)
  const moved = useRef(false)
  const rangeId = useId()
  const hintId = useId()
  const recommendation = recommendPlan({ plans, pack }, tasks)
  const packsText = recommendation ? packsPhrase(recommendation, pack) : ''
  const announcement =
    announcedTasks === null
      ? ''
      : resultInWords(recommendPlan({ plans, pack }, announcedTasks), pack)

  useEffect(() => {
    if (!moved.current) return
    const timer = window.setTimeout(() => setAnnouncedTasks(tasks), ANNOUNCE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [tasks])

  if (plans.length === 0) {
    return (
      <div className={`${styles.pricing} ${styles.unavailable}`}>
        <p>Сейчас не удалось загрузить тарифы.</p>
        <p>
          Обновите страницу чуть позже.{' '}
          {isGuest
            ? 'Зарегистрироваться можно уже сейчас.'
            : nbsp('Перейти к проектам можно по ссылке ниже.')}
        </p>
        <Link className={styles.action} href={action.href}>
          {action.label} <LandingIcon name="arrow-right-pricing" size={20} strokeWidth={1.6} />
        </Link>
      </div>
    )
  }

  return (
    <div className={styles.pricing}>
      <div className={styles.calculator}>
        <div className={styles.input}>
          <label htmlFor={rangeId}>Сколько задач в месяц вы планируете?</label>
          <p className={styles.hint} id={hintId}>
            {nbsp(TASK_HINT)}
          </p>
          {/* For the eye only: the slider names its value itself, and an `output` is a live
              region that would say it a second time. */}
          <div className={styles.taskCount} aria-hidden="true">
            <output htmlFor={rangeId}>{tasks}</output>
            <span>{pluralTasks(tasks)}</span>
          </div>
          <input
            className={styles.range}
            id={rangeId}
            type="range"
            min={MIN_TASKS}
            max={MAX_TASKS}
            step={5}
            value={tasks}
            aria-valuetext={`${tasks} ${pluralTasks(tasks)} в месяц`}
            aria-describedby={hintId}
            style={
              {
                '--range-progress': `${((tasks - MIN_TASKS) / (MAX_TASKS - MIN_TASKS)) * 100}%`,
              } as CSSProperties
            }
            onChange={(event) => {
              moved.current = true
              setTasks(Number(event.target.value))
            }}
          />
          <div className={styles.scale} aria-hidden="true">
            <span>{MIN_TASKS}</span>
            <span>{MAX_TASKS}</span>
          </div>
        </div>
        <div className={styles.result}>
          {recommendation ? (
            <>
              <span className={styles.resultLabel}>
                {nbsp('Самый выгодный вариант для такого числа задач')}
              </span>
              <p className={styles.resultPlan}>
                {/* Keyed by the plan: the name is drawn anew, and rises, when the plan changes
                    and not when a pack is added. The sums are never animated. */}
                <span key={recommendation.plan.slug} className={styles.resultName}>
                  Тариф «{recommendation.plan.name}»
                </span>
                {packsText && <span className={styles.resultPacks}>{nbsp(packsText)}</span>}
              </p>
              {pack && packsText && (
                <p className={styles.resultSum}>
                  {formatRubles(recommendation.plan.price)}&nbsp;₽ + {recommendation.packs} ×{' '}
                  {formatRubles(pack.price)}&nbsp;₽
                </p>
              )}
              <p className={styles.resultPrice}>
                <strong>
                  {formatRubles(recommendation.total)}
                  <small>&nbsp;₽</small>
                </strong>
                <span>/ месяц</span>
              </p>
              <p className={styles.perTask}>
                {nbsp(
                  `В среднем около ${formatRubles(recommendation.perTaskRounded)} ₽ за задачу при ${tasks} ${tasksAt(tasks)} в месяц`,
                )}
              </p>
            </>
          ) : (
            <p className={styles.resultPlan}>{nbsp(NO_PACK)}</p>
          )}
          <p className={styles.sitesHint}>
            {nbsp('Если сайтов больше одного — смотрите число сайтов в тарифе.')}
          </p>
          {/* The one announcement of a step, heard and not seen, once the slider rests. The visible
              result is not a live region: with the value of the slider and its `output` it was
              read three times on each of 58 steps. */}
          <p data-sr-only aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
        </div>
      </div>

      <div className={styles.plans}>
        {plans.map((plan) => {
          const recommended = recommendation?.plan.slug === plan.slug
          return (
            <article
              className={`${styles.plan} ${recommended ? styles.recommended : ''}`}
              key={plan.slug}
            >
              <div className={styles.planHeading}>
                <h3>{plan.name}</h3>
                {recommended && <span className={styles.recommendedLabel}>Ваш вариант</span>}
              </div>
              <p className={styles.description}>{nbsp(planDescription(plan.slug))}</p>
              <p className={styles.price}>
                <strong>
                  {formatRubles(plan.price)}
                  <small>&nbsp;₽</small>
                </strong>
                <span>/ месяц</span>
              </p>
              <ul className={styles.features}>
                <li>
                  <strong>{nbsp(formatCount(plan.creditsPerMonth))}</strong>
                  {nbsp(`\u00a0${planInWords(plan.creditsPerMonth, plan.tasksPerDay)}`)}
                </li>
                <li>
                  {plan.maxSites === 1
                    ? 'Один сайт'
                    : nbsp(
                        `До ${plan.maxSites} ${plural(plan.maxSites, 'сайта', 'сайтов', 'сайтов')}`,
                      )}
                </li>
              </ul>
            </article>
          )
        })}
      </div>
      {/* One action for all plans: the plan is chosen when the payment opens, not here. */}
      <div className={styles.signup}>
        <p className={styles.included}>
          {nbsp(
            'В каждый тариф войдут правки текстов, цен, фото, акций и страниц на сайтах WordPress, копия перед правкой и отмена.',
          )}
        </p>
        <div className={styles.signupAction}>
          <Link className={`${styles.action} ${styles.primary}`} href={action.href}>
            {action.label} <LandingIcon name="arrow-right-pricing" size={20} strokeWidth={1.6} />
          </Link>
          <p>{nbsp(mainActionNote(isGuest))}</p>
        </div>
      </div>
      <div className={styles.notes}>
        {pack && (
          <p>
            {nbsp(
              `Кредитов не хватит? Можно будет докупить пакет — ${formatCount(pack.credits)} ${pluralCredits(pack.credits)} за ${formatRubles(pack.price)} ₽. Кредиты из пакета не сгорают.`,
            )}
          </p>
        )}
        <p>Цены в&nbsp;рублях.</p>
      </div>
    </div>
  )
}
