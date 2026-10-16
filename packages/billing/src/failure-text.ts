/**
 * Reasons this package writes to orders.failure_reason itself. Every other value there is
 * `cancellation_details.reason` of the payment ЮKassa cancelled.
 */
export const orderFailureReasons = {
  /**
   * The payment succeeded with another amount, currency or order than the order holds, or a
   * part of it had gone back before the order was settled: the money is with us, unapplied.
   */
  amountMismatch: 'amount_mismatch',
  /** The whole payment had gone back to the customer before the order was settled. */
  paymentRefunded: 'payment_refunded',
  /** ЮKassa refused to create the payment (a 4xx answer). */
  checkoutRejected: 'checkout_rejected',
  /** ЮKassa did not answer, twice: nobody was given a page to pay on. */
  checkoutUnavailable: 'checkout_unavailable',
  /**
   * ЮKassa refused the first request of a renewal charge itself (a 4xx answer about the
   * request, not about our access): it made no payment, and the same request is not repeated.
   */
  chargeRejected: 'charge_rejected',
  /**
   * A renewal charge never got an answer while a repeat was still safe: whether the money was
   * taken is not known, and an operator looks it up.
   */
  unknownResult: 'unknown_result',
} as const

// What the customer can do about it, on «вы» and without codes. The bank's own reasons first,
// then ours.
const texts: ReadonlyMap<string, string> = new Map([
  ['insufficient_funds', 'Недостаточно средств. Пополните счёт или выберите другой способ оплаты.'],
  ['card_expired', 'Срок действия карты истёк. Оплатите другой картой.'],
  ['3d_secure_failed', 'Банк не подтвердил платёж. Попробуйте ещё раз.'],
  ['expired_on_confirmation', 'Время на оплату истекло. Оформите оплату заново.'],
  [
    'permission_revoked',
    'Разрешение на списания отозвано. Оплатите заново или выберите другой способ оплаты.',
  ],
  ['general_decline', 'Банк отклонил платёж. Выберите другой способ оплаты или обратитесь в банк.'],
  [
    orderFailureReasons.amountMismatch,
    'Платёж не удалось зачислить. Напишите нам — мы разберёмся.',
  ],
  [orderFailureReasons.paymentRefunded, 'Платёж возвращён. Оформите оплату заново.'],
  [orderFailureReasons.checkoutRejected, 'Не удалось начать оплату. Попробуйте ещё раз позже.'],
  [orderFailureReasons.checkoutUnavailable, 'Не удалось начать оплату. Попробуйте ещё раз позже.'],
  [orderFailureReasons.chargeRejected, 'Не получилось списать оплату. Оплатите тариф.'],
  [
    orderFailureReasons.unknownResult,
    'Не удалось подтвердить списание. Если деньги списаны, напишите нам — мы разберёмся.',
  ],
])

const UNKNOWN_REASON = 'Платёж не прошёл. Попробуйте ещё раз или выберите другой способ оплаты.'

/**
 * Why a payment did not go through, as one sentence for the customer. `reason` is
 * orders.failure_reason; a reason without a sentence of its own, and a missing one, get a
 * neutral sentence, never the code.
 */
export function paymentFailureText(reason: string | null): string {
  return (reason === null ? undefined : texts.get(reason)) ?? UNKNOWN_REASON
}
