import { Decimal } from 'decimal.js'

/** Display amounts and estimates, independent of global Decimal settings used by other features. */
export const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

/**
 * «12 900», «1 990,50»: an amount as the server sends it («12900.00») for reading, without the
 * ruble sign. Money is never converted to a binary floating point number; the spaces between
 * the groups do not break.
 */
export function formatRubles(value: string): string {
  const [rubles = '0', kopecks = '00'] = new Money(value).toFixed(2).split('.')
  const grouped = rubles.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
  return `${grouped}${kopecks === '00' ? '' : `,${kopecks}`}`
}
