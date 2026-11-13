import { typicalTaskCredits } from '@repo/domain/billing/credit-numbers'

import { formatRubles, Money } from './rubles'

// What a credit is worth to the customer in rubles, said beside the credits on «Тарифы» and on
// the landing (docs/plan/63-new-pricing.md, Ц14): the price of a small edit at the price of a
// tariff, of a pack or of what the calculator of the landing adds up — and the two rules the
// landing and the settings both state: only done work is paid for, and the tariff credits live
// one more month (Ц7). Each is written once here.
// The sentences come out with plain spaces: the component that prints one passes it through
// nbsp().

/**
 * What a small edit costs in rubles, «66.00»: the credits a small edit usually takes — the
 * lower end of `typicalTaskCredits.small`, the number «небольшая правка — обычно …» says, so the
 * rubles and the credits never part (the minimum of a done task today) — times the price, divided
 * by the credits it buys, rounded half up to a whole ruble once, from the exact quotient. 1 990 ₽
 * for 200 credits → 50, 9 990 ₽ for 1 000 → 50, 19 990 ₽ for 2 000 → 50, 1 490 ₽ for 100 → 75
 * (the tariffs of 13.11.2026, docs/plan/72-pricing-api-margin.md).
 * null when the credits are not a positive whole number: nothing is bought, and no price is
 * promised.
 */
export function smallEditRubles(price: string, credits: number): string | null {
  if (!Number.isSafeInteger(credits) || credits < 1) return null
  return new Money(price)
    .times(typicalTaskCredits.small.from)
    .dividedBy(credits)
    .toDecimalPlaces(0, Money.ROUND_HALF_UP)
    .toFixed(2)
}

/**
 * «Небольшая правка — около 50 ₽»: a price of `smallEditRubles` in words; with `from`,
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

/**
 * The rule of the charge (Ц14), in words that hold while a chat is charged pass by pass (spec
 * §17, how a chat is paid for): a pass that broke off on a failure is not charged — its turn is
 * rejected and its model calls stay out of the charge —, while passes that ended stay charged
 * even when the chat is dropped later or its release is rolled back. So the sentence promises
 * no return of credits for a task that «не получилась».
 */
export const CHARGED_FOR_DONE_WORK =
  'Списываем только за выполненную работу: попытка, которая оборвалась из-за сбоя, ничего не стоит.'

/**
 * What becomes of the tariff credits a period leaves (Ц7, from 06.11.2026): they live one more
 * period, and what is left of them then expires. Said where a page tells the customer what
 * happens to the credits of a period that ends.
 */
export const TARIFF_CREDITS_CARRY_OVER =
  'Неистраченные кредиты тарифа переходят на следующий месяц, один раз.'
