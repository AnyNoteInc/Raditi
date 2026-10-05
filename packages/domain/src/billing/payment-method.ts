/**
 * The saved payment method of a subscription as ЮKassa described it: the columns
 * payment_method_type, payment_method_card_type and payment_method_last4.
 */
export interface StoredPaymentMethod {
  /** payment_method.type: `bank_card`, `sbp`, `sberbank`, … */
  type: string | null
  /** payment_method.card.card_type: `Mir`, `Visa`, `MasterCard`, … */
  cardType: string | null
  last4: string | null
}

// A Russian name goes in quotation marks, a Latin one does not.
const cardBrands: ReadonlyMap<string, string> = new Map([
  ['Mir', '«Мир»'],
  ['Visa', 'Visa'],
  ['MasterCard', 'Mastercard'],
])

const methodNames: ReadonlyMap<string, string> = new Map([
  ['sbp', 'СБП'],
  ['sberbank', 'SberPay'],
  ['tinkoff_bank', 'T-Pay'],
  ['yoo_money', 'ЮMoney'],
])

const NBSP = '\u00a0'

/**
 * The customer's name for a saved payment method, in Russian: «Карта «Мир» •• 4444»,
 * «Банковская карта •• 4444» for a brand we do not name, «СБП», «SberPay», «T-Pay», «ЮMoney»,
 * and «Сохранённый способ оплаты» for anything else. The last four digits never wrap away
 * from the dots; without four digits a card is named without them.
 */
export function paymentMethodLabel(method: StoredPaymentMethod): string {
  if (method.type === 'bank_card') {
    const brand = method.cardType === null ? undefined : cardBrands.get(method.cardType)
    const card = brand === undefined ? 'Банковская карта' : `Карта ${brand}`
    const { last4 } = method
    return last4 !== null && /^\d{4}$/.test(last4) ? `${card} ••${NBSP}${last4}` : card
  }
  const name = method.type === null ? undefined : methodNames.get(method.type)
  return name ?? 'Сохранённый способ оплаты'
}
