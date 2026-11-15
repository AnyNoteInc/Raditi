import Link from 'next/link'

import { formatCount } from '@/lib/count'
import { CHARGED_FOR_DONE_WORK, smallEditPrice } from '@/lib/credit-price'
import { FEATURED_PLAN_LABEL, featuredPlan } from '@/lib/featured-plan'
import { nbsp } from '@/lib/nbsp'
import { planDescription } from '@/lib/plan-description'
import { planWindowLimits } from '@/lib/plan-windows'
import { plural } from '@/lib/plural'
import { formatRubles } from '@/lib/rubles'

import { LandingIcon } from './landing-icons'
import { mainAction, mainActionNote } from './main-action'
import {
  planInWords,
  pluralCredits,
  type LandingPack,
  type LandingPricingData,
} from './pricing-data'
import styles from './pricing.module.css'

/**
 * The note of the pack under the tariffs: what it gives and costs, what a small edit costs out
 * of it, and that its credits stay. «Дневным лимитом не ограничены» only while a tariff on sale
 * has a daily limit to be free of.
 */
function packNote(pack: LandingPack, plans: LandingPricingData['plans']): string {
  const smallEdit = smallEditPrice(pack.price, pack.credits, 'из пакета')
  const edit = smallEdit === null ? '' : ` ${smallEdit}.`
  const day = plans.some((plan) => plan.creditsPerDay !== null)
    ? ' и дневным лимитом не ограничены'
    : ''
  return `Кредитов не хватит? Можно будет докупить пакет — ${formatCount(pack.credits)} ${pluralCredits(pack.credits)} за ${formatRubles(pack.price)} ₽.${edit} Кредиты из пакета не сгорают${day}.`
}

export function Pricing({
  plans,
  pack,
  isGuest = true,
}: LandingPricingData & { isGuest?: boolean }) {
  const action = mainAction(isGuest)
  // No calculator: the three plans are shown as they are, and the one in the middle is marked.
  const featured = featuredPlan(plans)

  if (plans.length === 0) {
    return (
      <div className={`${styles.pricing} ${styles.unavailable}`}>
        <p>Сейчас не удалось загрузить тарифы.</p>
        <p>
          Обновите страницу чуть позже.{' '}
          {nbsp(
            isGuest
              ? 'Оставить заявку на подключение можно уже сейчас.'
              : 'Перейти к чатам можно по ссылке ниже.',
          )}
        </p>
        <Link className={styles.action} href={action.href}>
          {action.label} <LandingIcon name="arrow-right-pricing" size={20} strokeWidth={1.6} />
        </Link>
      </div>
    )
  }

  return (
    <div className={styles.pricing}>
      <div className={styles.plans}>
        {plans.map((plan) => {
          const marked = plan === featured
          const smallEdit = smallEditPrice(plan.price, plan.creditsPerMonth)
          return (
            <article className={`${styles.plan} ${marked ? styles.featured : ''}`} key={plan.slug}>
              <div className={styles.planHeading}>
                <h3>{plan.name}</h3>
                {marked && (
                  <span className={styles.featuredLabel}>{nbsp(FEATURED_PLAN_LABEL)}</span>
                )}
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
                  {nbsp(`\u00a0${planInWords(plan.creditsPerMonth, plan.creditsPerDay)}`)}
                </li>
                {smallEdit && <li>{nbsp(smallEdit)}</li>}
                {planWindowLimits(plan.creditsPer5h, plan.creditsPerWeek) && (
                  <li>{nbsp(planWindowLimits(plan.creditsPer5h, plan.creditsPerWeek)!)}</li>
                )}
                <li>
                  {plan.maxSites === 1
                    ? 'Один сайт'
                    : nbsp(
                        `До ${plan.maxSites} ${plural(plan.maxSites, 'сайта', 'сайтов', 'сайтов')}`,
                      )}
                </li>
                {/* Sites of pages beside the credits (docs/plan/73-pages-sites.md, Дер37). */}
                {plan.pageSites != null && plan.pageSites > 0 && (
                  <li>
                    {nbsp(
                      plan.pageSites === 1
                        ? 'Один сайт из страниц'
                        : `До ${plan.pageSites} ${plural(plan.pageSites, 'сайта', 'сайтов', 'сайтов')} из страниц`,
                    )}
                  </li>
                )}
                {plan.pageCustomNames && <li>{nbsp('Своё имя сайта страниц')}</li>}
              </ul>
            </article>
          )
        })}
      </div>
      {/* One action for all plans: the plan is chosen when the payment opens, not here. */}
      <div className={styles.signup}>
        <p className={styles.included}>
          {nbsp(
            'В каждый тариф войдут правки текстов, цен, фото, акций и страниц сайта, копия перед правкой и отмена.',
          )}
        </p>
        <div className={styles.signupAction}>
          <Link className={`${styles.action} ${styles.primary}`} href={action.href}>
            {action.label} <LandingIcon name="arrow-right-pricing" size={20} strokeWidth={1.6} />
          </Link>
          <p>{nbsp(mainActionNote(isGuest))}</p>
        </div>
      </div>
      {/* One row under the three plans: the rule of the charge, the pack, the currency. */}
      <div className={styles.notes}>
        <p>{nbsp(CHARGED_FOR_DONE_WORK)}</p>
        {pack && <p>{nbsp(packNote(pack, plans))}</p>}
        <p>Цены в&nbsp;рублях.</p>
      </div>
    </div>
  )
}
