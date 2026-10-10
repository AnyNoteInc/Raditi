import { plural } from '@/lib/plural'
import { Money } from '@/lib/rubles'

export interface LandingPlan {
  slug: string
  name: string
  price: string
  editsPerMonth: number
  editsPerDay: number
  maxSites: number
}

export interface LandingPack {
  price: string
  edits: number
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
   * The price of one edit in whole rubles, for an estimate that is read as «около»: kopecks
   * there look like a price. Rounded half up once, from the exact quotient: 495.495 rounded to
   * kopecks and then to rubles would give 496.
   */
  perEditRounded: string
}

/** Cheapest monthly quota plus whole packs; missing packs never imply free extra edits. */
export function recommendPlan(
  { plans, pack }: LandingPricingData,
  edits: number,
): PlanRecommendation | null {
  if (!Number.isSafeInteger(edits) || edits < 1) return null
  let best: PlanRecommendation | null = null

  for (const plan of plans) {
    const extraEdits = Math.max(0, edits - plan.editsPerMonth)
    if (extraEdits > 0 && (!pack || pack.edits < 1)) continue
    const packs = extraEdits > 0 && pack ? Math.ceil(extraEdits / pack.edits) : 0
    const total = new Money(plan.price).plus(new Money(pack?.price ?? '0').times(packs))
    if (best && !total.lessThan(best.total)) continue
    best = {
      plan,
      packs,
      total: total.toFixed(2),
      perEditRounded: total.dividedBy(edits).toDecimalPlaces(0, Money.ROUND_HALF_UP).toFixed(2),
    }
  }

  return best
}

export function pluralEdits(count: number): string {
  return plural(count, 'правка', 'правки', 'правок')
}

/** The extra packs of a recommendation in words: «4 дополнительных пакета по 10 правок». */
export function packsInWords(packs: number, packEdits: number): string {
  const packWord = plural(
    packs,
    'дополнительный пакет',
    'дополнительных пакета',
    'дополнительных пакетов',
  )
  // After «по» the count of one takes another case: «по 1 правке», but «по 2 правки».
  const editWord = plural(packEdits, 'правке', 'правки', 'правок')
  return `${packs} ${packWord} по ${packEdits} ${editWord}`
}
