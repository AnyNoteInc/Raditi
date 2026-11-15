import { averageTaskCount, type TypicalCredits } from '@repo/domain/billing/credit-numbers'

import { formatCount } from '@/lib/count'
import { plural } from '@/lib/plural'

export interface LandingPlan {
  slug: string
  name: string
  /** Sites of pages (docs/plan/73-pages-sites.md, Дер37): beside the credits; null — none. */
  pageSites?: number | null
  /** The own name of a site of pages (Дер32). */
  pageCustomNames?: boolean
  price: string
  creditsPerMonth: number
  /**
   * The tariff credits the plan gives a Moscow day: the daily limit; null — the plan has none,
   * as no plan on sale has since 06.11.2026.
   */
  creditsPerDay: number | null
  /** The windows of the work (plan 71); null — no such limit. */
  creditsPer5h: number | null
  creditsPerWeek: number | null
  maxSites: number
}

export interface LandingPack {
  price: string
  credits: number
}

export interface LandingPricingData {
  plans: LandingPlan[]
  pack: LandingPack | null
}

/** «кредит», «кредита», «кредитов»: the word after a count of credits. */
export function pluralCredits(count: number): string {
  return plural(count, 'кредит', 'кредита', 'кредитов')
}

/** «кредита», «кредитов» after «до» and a number: «до 50 кредитов», «до 21 кредита». */
export function creditsOf(count: number): string {
  return plural(count, 'кредита', 'кредитов', 'кредитов')
}

/** «задачи», «задач» after «около» and a number: «около 27 задач». */
export function tasksOf(count: number): string {
  return plural(count, 'задачи', 'задач', 'задач')
}

/**
 * «5 кредитов», «15–25»: what a kind of request usually costs, as a sentence of the landing says
 * it — one figure or a range, with the word of the unit or, after an example that has named it,
 * without.
 */
export function typicalCreditsInWords({ from, to }: TypicalCredits, withWord = true): string {
  const range = from === to ? String(to) : `${from}–${to}`
  return withWord ? `${range} ${pluralCredits(to)}` : range
}

/**
 * What a tariff gives, after the count of its credits: «кредитов в месяц — в среднем около 14
 * задач», and for a tariff with a daily limit «…, до 50 кредитов в день». The average tasks are
 * left out where the credits hold none; the day caps only the tariff credits, the month stays
 * their quota.
 */
export function planInWords(creditsPerMonth: number, creditsPerDay: number | null): string {
  const tasks = averageTaskCount(creditsPerMonth)
  const average = tasks === 0 ? '' : ` — в среднем около ${formatCount(tasks)} ${tasksOf(tasks)}`
  const day =
    creditsPerDay === null
      ? ''
      : `, до ${formatCount(creditsPerDay)} ${creditsOf(creditsPerDay)} в день`
  return `${pluralCredits(creditsPerMonth)} в месяц${average}${day}`
}
