import { minTaskChargeCredits } from '@repo/domain/billing/credit-numbers'

import { formatRubles, Money } from './rubles'

// What a credit is worth to the customer in rubles, said beside the credits on «Тарифы» and on
// the landing (docs/plan/63-new-pricing.md, Ц14): the price of a small edit at the price of a
// tariff, of a pack or of what the calculator of the landing adds up — and the two rules the
// landing and the settings both state: only done work is paid for, and the tariff credits live
// one more month (Ц7). Each is written once here.
// The sentences come out with plain spaces: the component that prints one passes it through
// nbsp().

/**
 * What a small edit costs in rubles, «66.00»: the charge of a small edit — the minimum of a done
 * task, `minTaskChargeCredits` — times the price, divided by the credits it buys, rounded half up
 * to a whole ruble once, from the exact quotient. 1 990 ₽ for 150 credits → 66, 6 990 ₽ for 600
 * → 58, 19 990 ₽ for 2 000 → 50, 1 490 ₽ for 100 → 75. null when the credits are not a positive
 * whole number: nothing is bought, and no price is promised.
 */
export function smallEditRubles(price: string, credits: number): string | null {
  if (!Number.isSafeInteger(credits) || credits < 1) return null
  return new Money(price)
    .times(minTaskChargeCredits)
    .dividedBy(credits)
    .toDecimalPlaces(0, Money.ROUND_HALF_UP)
    .toFixed(2)
}

/**
 * «Небольшая правка — около 66 ₽»: a price of `smallEditRubles` in words; with `from`,
 * «Небольшая правка из пакета — около 75 ₽». «около»: a small edit is usually charged the
 * minimum, and some take more.
 */
export function smallEditSentence(rubles: string, from = ''): string {
  const source = from === '' ? '' : ` ${from}`
  return `Небольшая правка${source} — около ${formatRubles(rubles)} ₽`
}

/**
 * The price of a small edit of a tariff or a pack, in words (`smallEditSentence`); null where
 * `smallEditRubles` has no price.
 */
export function smallEditPrice(price: string, credits: number, from = ''): string | null {
  const rubles = smallEditRubles(price, credits)
  return rubles === null ? null : smallEditSentence(rubles, from)
}

/** The rule of the charge, word for word as the report of the prices puts it. */
export const CHARGED_FOR_DONE_WORK =
  'Списываем только за выполненную работу: если задача не получилась, кредиты возвращаются.'

/**
 * What becomes of the tariff credits a period leaves (Ц7, from 06.11.2026): they live one more
 * period, and what is left of them then expires. Said where a page tells the customer what
 * happens to the credits of a period that ends.
 */
export const TARIFF_CREDITS_CARRY_OVER =
  'Неистраченные кредиты тарифа переходят на следующий месяц, один раз.'
