import { formatCount } from './count'
import { plural } from './plural'

// The windows of a tariff in one line, for the cards of «Тарифы» and of the landing
// (docs/plan/71-usage-limits.md, Л14): imports nothing of the cabinet.

const creditsOf = (count: number) => plural(count, 'кредита', 'кредитов', 'кредитов')

/**
 * «До 20 кредитов за 5 часов и 55 в неделю»; null when the tariff has neither window. One of
 * them alone is said alone.
 */
export function planWindowLimits(
  creditsPer5h: number | null,
  creditsPerWeek: number | null,
): string | null {
  if (creditsPer5h !== null && creditsPerWeek !== null)
    return `До ${formatCount(creditsPer5h)} ${creditsOf(creditsPer5h)} за 5 часов и ${formatCount(creditsPerWeek)} в неделю`
  if (creditsPer5h !== null)
    return `До ${formatCount(creditsPer5h)} ${creditsOf(creditsPer5h)} за 5 часов`
  if (creditsPerWeek !== null)
    return `До ${formatCount(creditsPerWeek)} ${creditsOf(creditsPerWeek)} в неделю`
  return null
}
