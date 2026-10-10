'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'

import { nbsp } from '@/lib/nbsp'
import { planDescription } from '@/lib/plan-description'
import { plural } from '@/lib/plural'
import { formatRubles } from '@/lib/rubles'

import { LandingIcon } from './landing-icons'
import { mainAction } from './main-action'
import {
  packsInWords,
  pluralEdits,
  recommendPlan,
  type LandingPack,
  type LandingPricingData,
  type PlanRecommendation,
} from './pricing-calculator'
import styles from './pricing.module.css'

/** How long the slider rests before its result is announced: a drag passes many values. */
export const ANNOUNCE_DELAY_MS = 500

/** The ends of the slider, in edits a month. */
const MIN_EDITS = 10
const MAX_EDITS = 300

const NO_PACK = 'Для такого числа правок пока нет доступного пакета. Выберите меньше правок.'

/** « и 4 дополнительных пакета по 10 правок» after the name of the plan, or nothing. */
function packsPhrase(recommendation: PlanRecommendation, pack: LandingPack | null) {
  return pack && recommendation.packs > 0
    ? ` и ${packsInWords(recommendation.packs, pack.edits)}`
    : ''
}

/** The result as one sentence for a screen reader, built from the strings of the visible one. */
function resultInWords(recommendation: PlanRecommendation | null, pack: LandingPack | null) {
  if (!recommendation) return NO_PACK
  return `Тариф «${recommendation.plan.name}»${packsPhrase(recommendation, pack)}, ${formatRubles(recommendation.total)} ₽ в месяц, около ${formatRubles(recommendation.perEditRounded)} ₽ за правку`
}

export function Pricing({
  plans,
  pack,
  isGuest = true,
}: LandingPricingData & { isGuest?: boolean }) {
  const action = mainAction(isGuest)
  const [edits, setEdits] = useState(30)
  // The value on which the slider came to rest; nothing is announced until the visitor moves it.
  const [announcedEdits, setAnnouncedEdits] = useState<number | null>(null)
  const moved = useRef(false)
  const rangeId = useId()
  const hintId = useId()
  const recommendation = recommendPlan({ plans, pack }, edits)
  const packsText = recommendation ? packsPhrase(recommendation, pack) : ''
  const announcement =
    announcedEdits === null
      ? ''
      : resultInWords(recommendPlan({ plans, pack }, announcedEdits), pack)

  useEffect(() => {
    if (!moved.current) return
    const timer = window.setTimeout(() => setAnnouncedEdits(edits), ANNOUNCE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [edits])

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
          <label htmlFor={rangeId}>Сколько правок нужно в месяц?</label>
          <p className={styles.hint} id={hintId}>
            {nbsp('Правка — одна ваша просьба: поменять цены, заменить фото, добавить акцию.')}
          </p>
          {/* For the eye only: the slider names its value itself, and an `output` is a live
              region that would say it a second time. */}
          <div className={styles.editCount} aria-hidden="true">
            <output htmlFor={rangeId}>{edits}</output>
            <span>{pluralEdits(edits)}</span>
          </div>
          <input
            className={styles.range}
            id={rangeId}
            type="range"
            min={MIN_EDITS}
            max={MAX_EDITS}
            step={5}
            value={edits}
            aria-valuetext={`${edits} ${pluralEdits(edits)} в месяц`}
            aria-describedby={hintId}
            style={
              {
                '--range-progress': `${((edits - MIN_EDITS) / (MAX_EDITS - MIN_EDITS)) * 100}%`,
              } as CSSProperties
            }
            onChange={(event) => {
              moved.current = true
              setEdits(Number(event.target.value))
            }}
          />
          <div className={styles.scale} aria-hidden="true">
            <span>{MIN_EDITS}</span>
            <span>{MAX_EDITS}</span>
          </div>
        </div>
        <div className={styles.result}>
          {recommendation ? (
            <>
              <span className={styles.resultLabel}>
                Самый выгодный вариант по&nbsp;числу правок
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
              <p className={styles.perEdit}>
                Около {formatRubles(recommendation.perEditRounded)}&nbsp;₽ за&nbsp;правку, если
                использовать все&nbsp;{edits}
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
                  <strong>{plan.editsPerMonth}</strong>
                  {nbsp(
                    `\u00a0${pluralEdits(plan.editsPerMonth)} в месяц, не больше\u00a0${plan.editsPerDay} в день`,
                  )}
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
          <p>Тариф выберете позже, когда откроется оплата</p>
        </div>
      </div>
      <div className={styles.notes}>
        {pack && (
          <p>
            {nbsp(
              `Правок не хватит? Можно будет докупить пакет — ${pack.edits} ${pluralEdits(pack.edits)} за ${formatRubles(pack.price)} ₽. Пакеты будут продаваться целиком.`,
            )}
          </p>
        )}
        <p>Цены в&nbsp;рублях.</p>
      </div>
    </div>
  )
}
