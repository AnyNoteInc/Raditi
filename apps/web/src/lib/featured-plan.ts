/** The words on the mark of the tariff that stands in the middle of the three. */
export const FEATURED_PLAN_LABEL = 'Для вас'

/**
 * The tariff the landing and the «Тарифы» page mark: the one in the middle of three, in the
 * order the tariffs are sold in. Among two or four there is no middle, so nothing is marked —
 * the mark would say «this one» about a tariff chosen by position alone.
 */
export function featuredPlan<Plan>(plans: readonly Plan[]): Plan | null {
  return plans.length === 3 ? (plans[1] ?? null) : null
}
