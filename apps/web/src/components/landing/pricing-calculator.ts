import {
  averageTaskCount,
  averageTaskCredits,
  type TypicalCredits,
} from '@repo/domain/billing/credit-numbers'

import { formatCount } from '@/lib/count'
import { smallEditRubles } from '@/lib/credit-price'
import { plural } from '@/lib/plural'
import { Money } from '@/lib/rubles'

export interface LandingPlan {
  slug: string
  name: string
  price: string
  creditsPerMonth: number
  /**
   * The tariff credits the plan gives a Moscow day: the daily limit; null — the plan has none,
   * as no plan on sale has since 06.11.2026.
   */
  creditsPerDay: number | null
  /** The windows of the work (plan 70); null — no such limit. */
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

export interface PlanRecommendation {
  plan: LandingPlan
  packs: number
  total: string
  /**
   * The price of one task in whole rubles, for an estimate that is read as «около»: kopecks
   * there look like a price. Rounded half up once, from the exact quotient: 495.495 rounded to
   * kopecks and then to rubles would give 496.
   */
  perTaskRounded: string
  /**
   * What a small edit costs on what is paid, in whole rubles (`smallEditRubles`): the total
   * over the credits the plan and its packs give — the price of a credit of the card when no
   * pack is added, and the blend of the two when packs are. null when the plan gives no
   * credits to count by.
   */
  smallEditRounded: string | null
}

/**
 * The credits a number of tasks a month needs. A visitor thinks in requests, a tariff is sold in
 * credits: each task is counted at the average charge, the constant every promise of a count of
 * tasks divides by.
 */
export function creditsForTasks(tasks: number): number {
  return tasks * averageTaskCredits
}

/**
 * The cheapest tariff with whole packs for a number of tasks a month; without a pack on sale
 * the credits a tariff lacks are never promised for free.
 */
export function recommendPlan(
  { plans, pack }: LandingPricingData,
  tasks: number,
): PlanRecommendation | null {
  if (!Number.isSafeInteger(tasks) || tasks < 1) return null
  const credits = creditsForTasks(tasks)
  let best: PlanRecommendation | null = null

  for (const plan of plans) {
    const extraCredits = Math.max(0, credits - plan.creditsPerMonth)
    if (extraCredits > 0 && (!pack || pack.credits < 1)) continue
    const packs = extraCredits > 0 && pack ? Math.ceil(extraCredits / pack.credits) : 0
    const total = new Money(plan.price).plus(new Money(pack?.price ?? '0').times(packs))
    if (best && !total.lessThan(best.total)) continue
    const bought = plan.creditsPerMonth + packs * (pack?.credits ?? 0)
    best = {
      plan,
      packs,
      total: total.toFixed(2),
      perTaskRounded: total.dividedBy(tasks).toDecimalPlaces(0, Money.ROUND_HALF_UP).toFixed(2),
      smallEditRounded: smallEditRubles(total.toFixed(2), bought),
    }
  }

  return best
}

/** «кредит», «кредита», «кредитов»: the word after a count of credits. */
export function pluralCredits(count: number): string {
  return plural(count, 'кредит', 'кредита', 'кредитов')
}

/** «задача», «задачи», «задач»: the word after a count of tasks. */
export function pluralTasks(count: number): string {
  return plural(count, 'задача', 'задачи', 'задач')
}

/** «кредита», «кредитов» after «до» and a number: «до 50 кредитов», «до 21 кредита». */
export function creditsOf(count: number): string {
  return plural(count, 'кредита', 'кредитов', 'кредитов')
}

/** «задачи», «задач» after «около» and a number: «около 27 задач». */
export function tasksOf(count: number): string {
  return plural(count, 'задачи', 'задач', 'задач')
}

/** «задаче», «задачах» after «при» and a number: «при 45 задачах», «при 21 задаче». */
export function tasksAt(count: number): string {
  return plural(count, 'задаче', 'задачах', 'задачах')
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

/** The extra packs of a recommendation in words: «4 дополнительных пакета по 100 кредитов». */
export function packsInWords(packs: number, packCredits: number): string {
  const packWord = plural(
    packs,
    'дополнительный пакет',
    'дополнительных пакета',
    'дополнительных пакетов',
  )
  // After «по» the count of one takes another case: «по 1 кредиту», but «по 2 кредита».
  const creditWord = plural(packCredits, 'кредиту', 'кредита', 'кредитов')
  return `${packs} ${packWord} по ${formatCount(packCredits)} ${creditWord}`
}
