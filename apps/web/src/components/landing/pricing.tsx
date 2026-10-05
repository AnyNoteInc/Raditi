'use client'

import Link from 'next/link'
import { useId, useState, type CSSProperties } from 'react'

import {
  formatRubles,
  pluralEdits,
  recommendPlan,
  type LandingPricingData,
} from './pricing-calculator'
import styles from './pricing.module.css'

const descriptions: Record<string, string> = {
  start: 'Для своего дела',
  business: 'Когда задач становится больше',
  agency: 'Для сайтов ваших клиентов',
}

function Arrow() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

export function Pricing({
  plans,
  pack,
  actionHref = '/sign-up',
  actionLabel = 'Создать аккаунт',
}: LandingPricingData & { actionHref?: '/sign-up' | '/projects'; actionLabel?: string }) {
  const [edits, setEdits] = useState(30)
  const rangeId = useId()
  const recommendation = recommendPlan({ plans, pack }, edits)

  if (plans.length === 0) {
    return (
      <div className={`${styles.pricing} ${styles.unavailable}`}>
        <p>Сейчас не удалось загрузить тарифы.</p>
        <p>
          Обновите страницу чуть позже.{' '}
          {actionHref === '/sign-up'
            ? 'Создать аккаунт можно уже сейчас.'
            : 'Перейти к проектам можно по ссылке ниже.'}
        </p>
        <Link className={styles.action} href={actionHref}>
          {actionLabel} <Arrow />
        </Link>
      </div>
    )
  }

  return (
    <div className={styles.pricing}>
      <div className={styles.calculator}>
        <div className={styles.input}>
          <label htmlFor={rangeId}>Сколько правок нужно в месяц?</label>
          <div className={styles.editCount}>
            <output htmlFor={rangeId}>{edits}</output>
            <span>{pluralEdits(edits)}</span>
          </div>
          <input
            className={styles.range}
            id={rangeId}
            type="range"
            min={10}
            max={300}
            step={5}
            value={edits}
            aria-valuetext={`${edits} ${pluralEdits(edits)} в месяц`}
            style={{ '--range-progress': `${((edits - 10) / 290) * 100}%` } as CSSProperties}
            onChange={(event) => setEdits(Number(event.target.value))}
          />
          <div className={styles.scale} aria-hidden="true">
            <span>10</span>
            <span>300</span>
          </div>
        </div>
        <div className={styles.result} aria-live="polite" aria-atomic="true">
          {recommendation ? (
            <>
              <span className={styles.resultLabel}>Самый выгодный вариант по числу правок</span>
              <p className={styles.resultPlan}>
                «{recommendation.plan.name}»
                {recommendation.packs > 0 && (
                  <span>
                    {' '}
                    + {recommendation.packs} × {pack?.edits} {pluralEdits(pack?.edits ?? 0)}
                  </span>
                )}
              </p>
              <p className={styles.resultPrice}>
                <strong>{formatRubles(recommendation.total)} ₽</strong>
                <span>/ месяц</span>
              </p>
              <p className={styles.perEdit}>
                Около {formatRubles(recommendation.perEdit)} ₽ за правку
              </p>
            </>
          ) : (
            <p className={styles.resultPlan}>
              Для такого числа правок пока нет доступного пакета. Выберите меньше правок.
            </p>
          )}
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
              <p className={styles.description}>
                {descriptions[plan.slug] ?? 'Для регулярных задач на сайте'}
              </p>
              <p className={styles.price}>
                <strong>{formatRubles(plan.price)} ₽</strong>
                <span>/ месяц</span>
              </p>
              <ul className={styles.features}>
                <li>
                  <strong>{plan.editsPerMonth}</strong> {pluralEdits(plan.editsPerMonth)} в месяц
                </li>
                <li>
                  {plan.maxSites === 1 ? 'Один сайт' : `До ${plan.maxSites} сайтов`} на WordPress
                </li>
                <li>До {plan.editsPerDay} правок в день</li>
                <li>Тексты, фото и изменения на сайте</li>
              </ul>
              <Link
                className={styles.action}
                href={actionHref}
                aria-label={`${actionLabel} — ${plan.name}`}
              >
                {actionLabel} <Arrow />
              </Link>
            </article>
          )
        })}
      </div>
      <div className={styles.notes}>
        <p>
          {pack
            ? `Нужно больше? Ещё ${pack.edits} ${pluralEdits(pack.edits)} — ${formatRubles(pack.price)} ₽. `
            : ''}
          Калькулятор учитывает полные пакеты. Число сайтов и дневной лимит — по выбранному тарифу.
        </p>
        <p>Тарифы на запуске. Оплата появится после открытия сервиса. Цены в рублях, с НДС.</p>
      </div>
    </div>
  )
}
