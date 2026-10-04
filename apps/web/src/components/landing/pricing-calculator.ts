import { Decimal } from 'decimal.js'

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
  perEdit: string
}

// Keep display estimates independent of global Decimal settings used by other features.
const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

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
      perEdit: total.dividedBy(edits).toFixed(2),
    }
  }

  return best
}

/** Format monetary strings without converting money to a binary floating point number. */
export function formatRubles(value: string): string {
  const [rubles = '0', kopecks = '00'] = new Money(value).toFixed(2).split('.')
  const grouped = rubles.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
  return `${grouped}${kopecks === '00' ? '' : `,${kopecks}`}`
}

export function pluralEdits(count: number): string {
  const lastTwo = count % 100
  if (lastTwo >= 11 && lastTwo <= 14) return 'правок'
  if (count % 10 === 1) return 'правка'
  if (count % 10 >= 2 && count % 10 <= 4) return 'правки'
  return 'правок'
}
