import { describe, expect, it } from 'vitest'

import { orderFailureReasons, paymentFailureText } from './failure-text.ts'

const bankReasons = [
  'insufficient_funds',
  'card_expired',
  '3d_secure_failed',
  'expired_on_confirmation',
  'permission_revoked',
  'general_decline',
]

describe('paymentFailureText', () => {
  it('has a sentence of its own for every reason the customer can act on', () => {
    const sentences = bankReasons.map(paymentFailureText)
    expect(new Set(sentences).size).toBe(bankReasons.length)
    expect(paymentFailureText('insufficient_funds')).toBe(
      'Недостаточно средств. Пополните счёт или выберите другой способ оплаты.',
    )
    expect(paymentFailureText('general_decline')).toBe(
      'Банк отклонил платёж. Выберите другой способ оплаты или обратитесь в банк.',
    )
  })

  it('answers a reason it does not know, and none at all, with one neutral sentence', () => {
    const neutral = 'Платёж не прошёл. Попробуйте ещё раз или выберите другой способ оплаты.'
    for (const reason of ['fraud_suspected', 'canceled', 'call_issuer', '', 'toString', null]) {
      expect(paymentFailureText(reason)).toBe(neutral)
    }
    expect(bankReasons.map(paymentFailureText)).not.toContain(neutral)
  })

  it('does not blame the bank for a failure of ours', () => {
    const ours = Object.values(orderFailureReasons).map(paymentFailureText)
    for (const sentence of ours) expect(sentence).not.toMatch(/[Бб]анк/)
    // The money of a mismatched payment was taken: the customer is told to write, not to retry.
    expect(paymentFailureText(orderFailureReasons.amountMismatch)).toMatch(/Напишите нам/)
    // The money of a returned payment is back with the customer: paying again is what is left.
    expect(paymentFailureText(orderFailureReasons.paymentRefunded)).toBe(
      'Платёж возвращён. Оформите оплату заново.',
    )
    // A renewal charge the shop refused took no money: the customer pays by hand. Replacing the
    // payment method is not offered: it settles no failed charge, and a shop without autopayments
    // cannot do it at all.
    expect(paymentFailureText(orderFailureReasons.chargeRejected)).toBe(
      'Не получилось списать оплату. Оплатите тариф.',
    )
    // Nobody knows whether a renewal charge without an answer took the money: the sentence
    // neither says it failed nor tells the customer to pay again.
    expect(paymentFailureText(orderFailureReasons.unknownResult)).toBe(
      'Не удалось подтвердить списание. Если деньги списаны, напишите нам — мы разберёмся.',
    )
  })

  it('speaks Russian to the customer: no codes, no Latin, nothing the seller cannot promise', () => {
    const reasons = [...bankReasons, ...Object.values(orderFailureReasons), 'unknown', null]
    for (const reason of reasons) {
      const sentence = paymentFailureText(reason)
      expect(sentence).toMatch(/^[А-ЯЁ][А-Яа-яЁё ,.—-]+\.$/)
      expect(sentence).not.toMatch(/чек|НДС|ЮKassa/i)
      if (reason) expect(sentence).not.toContain(reason)
      expect(sentence.length).toBeLessThanOrEqual(100)
    }
  })

  it('names the reasons this package writes itself', () => {
    expect(orderFailureReasons).toEqual({
      amountMismatch: 'amount_mismatch',
      paymentRefunded: 'payment_refunded',
      checkoutRejected: 'checkout_rejected',
      checkoutUnavailable: 'checkout_unavailable',
      chargeRejected: 'charge_rejected',
      unknownResult: 'unknown_result',
    })
    // orders.failure_reason is varchar(64).
    for (const reason of Object.values(orderFailureReasons)) {
      expect(reason.length).toBeLessThanOrEqual(64)
    }
  })
})
