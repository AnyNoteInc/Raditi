import { describe, expect, it } from 'vitest'

import type { MethodBinding, PaymentEntry } from './billing-types'
import {
  boundText,
  methodNote,
  noMethodNote,
  notBoundText,
  paidFor,
  paymentDate,
  paymentStatus,
  unlinkedText,
  unlinkWarning,
} from './payment-format'
import { agencyPlan, plain, subscriptionTo } from './testing'

const period = { start: new Date('2026-09-18T09:00:00Z'), end: new Date('2026-10-18T09:00:00Z') }
const outcome = (patch: Partial<PaymentEntry>) => ({
  status: 'paid' as PaymentEntry['status'],
  amount: '1990.00',
  failureText: null,
  refundedAmount: null,
  refundedAt: null,
  ...patch,
})

describe('the date of a payment', () => {
  it('is the day it was paid, by the Moscow calendar', () => {
    const paidAt = new Date('2026-09-29T21:30:00Z')
    // 00:30 on the 30th in Moscow.
    expect(plain(paymentDate({ paidAt, createdAt: new Date('2026-09-29T09:00:00Z') }))).toBe(
      '30 сентября 2026',
    )
  })

  it('is the day the order was made while nothing was paid', () => {
    expect(plain(paymentDate({ paidAt: null, createdAt: new Date('2026-08-18T09:00:00Z') }))).toBe(
      '18 августа 2026',
    )
  })
})

describe('what a payment was for', () => {
  it.each([
    [
      'a tariff with the period it bought',
      { kind: 'subscription', planName: 'Бизнес', period },
      { title: 'Тариф «Бизнес»', period: '18 сентября — 18 октября' },
    ],
    [
      'a tariff that was never paid, so bought no period',
      { kind: 'subscription', planName: 'Старт', period: null },
      { title: 'Тариф «Старт»', period: null },
    ],
    [
      'a tariff whose plan is gone',
      { kind: 'subscription', planName: null, period: null },
      { title: 'Тариф', period: null },
    ],
    [
      'a pack by its own name',
      { kind: 'pack', planName: 'Пакет из 100 кредитов', period: null },
      { title: 'Пакет из 100 кредитов', period: null },
    ],
    [
      'a pack whose plan is gone',
      { kind: 'pack', planName: null, period: null },
      { title: 'Пакет кредитов', period: null },
    ],
    // A period is a thing of a tariff: a pack never shows one.
    [
      'a pack, whatever period its row holds',
      { kind: 'pack', planName: 'Пакет из 100 кредитов', period },
      { title: 'Пакет из 100 кредитов', period: null },
    ],
    [
      'a top-up',
      { kind: 'topup', planName: null, period: null },
      { title: 'Пополнение баланса', period: null },
    ],
  ] as const)('names %s', (_case, payment, expected) => {
    const said = paidFor(payment)
    expect({ title: said.title, period: said.period && plain(said.period) }).toEqual(expected)
  })
})

describe('the status of a payment', () => {
  it.each([
    ['paid', {}, { label: 'Оплачено', icon: 'check', color: 'success', note: null }],
    [
      'failed, with the sentence of the order',
      { status: 'failed', failureText: 'Банк отклонил платёж. Выберите другой способ оплаты.' },
      {
        label: 'Не прошёл',
        icon: 'warning',
        color: 'error',
        note: 'Банк отклонил платёж. Выберите другой способ оплаты.',
      },
    ],
    [
      'failed without a sentence: never an empty line under the chip',
      { status: 'failed' },
      { label: 'Не прошёл', icon: 'warning', color: 'error', note: 'Платёж не прошёл.' },
    ],
    [
      'returned in full, with the day',
      {
        status: 'refunded',
        refundedAmount: '1990.00',
        refundedAt: new Date('2026-08-05T10:00:00Z'),
      },
      { label: 'Возвращено', icon: 'back', color: 'default', note: '5 августа' },
    ],
    [
      'returned in part: the part and the day',
      {
        status: 'refunded',
        refundedAmount: '990.00',
        refundedAt: new Date('2026-08-05T10:00:00Z'),
      },
      { label: 'Возвращено', icon: 'back', color: 'default', note: '990 ₽, 5 августа' },
    ],
    [
      'returned in part with no day recorded',
      { status: 'refunded', refundedAmount: '990.00' },
      { label: 'Возвращено', icon: 'back', color: 'default', note: '990 ₽' },
    ],
    [
      'returned with nothing recorded',
      { status: 'refunded' },
      { label: 'Возвращено', icon: 'back', color: 'default', note: null },
    ],
    [
      'closed by us',
      { status: 'cancelled' },
      { label: 'Отменён', icon: 'close', color: 'default', note: null },
    ],
    [
      'not paid yet',
      { status: 'pending' },
      { label: 'Ожидает оплаты', icon: 'clock', color: 'default', note: null },
    ],
  ] as const)('is told for an order that is %s', (_case, patch, expected) => {
    const status = paymentStatus(outcome(patch))
    expect({ ...status, note: status.note && plain(status.note) }).toEqual(expected)
  })

  it('keeps the sentence of a failure for a failed order only', () => {
    // A reason left in the row of an order that did not fail is not shown as a failure.
    expect(
      paymentStatus(outcome({ status: 'paid', failureText: 'Банк отклонил платёж.' })).note,
    ).toBeNull()
    expect(paymentStatus(outcome({ status: 'cancelled', failureText: 'x' })).note).toBeNull()
  })
})

describe('the note under a saved payment method', () => {
  it('names the day, the amount and the tariff of the next charge', () => {
    expect(plain(methodNote(subscriptionTo(), 'none'))).toBe(
      '18 октября спишем этим способом 12 900 ₽ за тариф «Бизнес». Если его отвязать, автопродление отключится.',
    )
  })

  it('names the tariff and the price that are scheduled for the next period', () => {
    expect(plain(methodNote(subscriptionTo({ nextPlan: agencyPlan }), 'none'))).toBe(
      '18 октября спишем этим способом 39 900 ₽ за тариф «Агентство». Если его отвязать, автопродление отключится.',
    )
  })

  it('promises no charge while auto-renewal is off', () => {
    expect(plain(methodNote(subscriptionTo({ autoRenewal: false }), 'none'))).toBe(
      'Автопродление выключено: списаний не будет. Тариф действует до 18 октября 2026.',
    )
  })

  it('promises no charge for a tariff that is not paid, whatever auto-renewal says', () => {
    for (const autoRenewal of [true, false]) {
      expect(methodNote(subscriptionTo({ status: 'past_due', autoRenewal }), 'none')).toBe(
        'Оплата тарифа не прошла. Автоматических списаний не будет, пока тариф не оплачен.',
      )
    }
  })

  it.each([
    [
      'at_bank',
      'Списание за следующий период уже отправлено в банк. Если способ оплаты отвязать, автопродление отключится, но это списание не отменится.',
    ],
    [
      'unanswered',
      'Списание за следующий период уже отправлялось в банк, ответа пока нет. Если способ оплаты отвязать, автопродление отключится, но это списание не отменится.',
    ],
  ] as const)(
    'names no day to come while the charge of the period is under way (%s)',
    (renewalCharge, note) => {
      const said = plain(methodNote(subscriptionTo(), renewalCharge))
      expect(said).toBe(note)
      // Which method the charge left with is not known here: «этим способом» would be a guess.
      expect(said).not.toMatch(/спишем|этим способом/)
    },
  )

  it.each([
    [
      'at_bank',
      'Автопродление выключено. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Других списаний не будет.',
    ],
    [
      'unanswered',
      'Автопродление выключено. Списание за следующий период уже отправлялось в банк, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их. Других списаний не будет.',
    ],
  ] as const)(
    'does not say «списаний не будет» while a charge that was started is under way (%s)',
    (renewalCharge, note) => {
      const said = plain(methodNote(subscriptionTo({ autoRenewal: false }), renewalCharge))
      expect(said).toBe(note)
      expect(said).not.toContain('списаний не будет. Тариф действует')
    },
  )

  it('tells an unpaid tariff nothing of a charge: its charge has ended', () => {
    for (const renewalCharge of ['at_bank', 'unanswered'] as const) {
      expect(methodNote(subscriptionTo({ status: 'past_due' }), renewalCharge)).toBe(
        'Оплата тарифа не прошла. Автоматических списаний не будет, пока тариф не оплачен.',
      )
    }
  })
})

describe('the note of a customer without a saved method', () => {
  const none = { paymentMethod: null, autoRenewal: false }

  it('says how a method gets saved when there is no tariff', () => {
    for (const canBind of [true, false]) {
      expect(noMethodNote(null, canBind, 'none')).toBe(
        'Он сохраняется, когда вы оплачиваете тариф с автопродлением.',
      )
    }
  })

  it('says that binding a card switches nothing on and charges nothing', () => {
    expect(plain(noMethodNote(subscriptionTo(none), true, 'none'))).toBe(
      'Тариф действует до 18 октября 2026. Можно привязать карту: она сохранится для будущих списаний. Автопродление при этом не включится, и денег с карты мы не спишем.',
    )
  })

  it('says only how long the tariff lasts when no card can be bound', () => {
    expect(plain(noMethodNote(subscriptionTo(none), false, 'none'))).toBe(
      'Тариф действует до 18 октября 2026.',
    )
  })

  it.each([
    [
      'at_bank',
      'Тариф действует до 18 октября 2026. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц.',
    ],
    [
      'unanswered',
      'Тариф действует до 18 октября 2026. Списание за следующий период уже отправлялось в банк, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их.',
    ],
  ] as const)(
    'tells of a charge that was started with the method that is gone (%s)',
    (renewalCharge, note) => {
      expect(plain(noMethodNote(subscriptionTo(none), false, renewalCharge))).toBe(note)
      // The offer to bind a card follows it, and still promises no charge from that card.
      expect(plain(noMethodNote(subscriptionTo(none), true, renewalCharge))).toBe(
        `${note} Можно привязать карту: она сохранится для будущих списаний. Автопродление при этом не включится, и денег с карты мы не спишем.`,
      )
    },
  )

  it('says that nothing is saved at a shop that takes one-time payments only', () => {
    const unavailable = 'Автопродление пока недоступно, поэтому способ оплаты не сохраняется.'
    // No way to save a method is named: there is none.
    expect(noMethodNote(null, false, 'none', true)).toBe(unavailable)
    expect(plain(noMethodNote(subscriptionTo(none), false, 'none', true))).toBe(
      `Тариф действует до 18 октября 2026. ${unavailable}`,
    )
    expect(noMethodNote(subscriptionTo({ ...none, status: 'past_due' }), false, 'none', true)).toBe(
      `Оплата тарифа не прошла: тариф ждёт оплаты. ${unavailable}`,
    )
    // A charge that left with the method that is gone is still told of.
    expect(plain(noMethodNote(subscriptionTo(none), false, 'at_bank', true))).toBe(
      `Тариф действует до 18 октября 2026. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. ${unavailable}`,
    )
    for (const subscription of [null, subscriptionTo(none)]) {
      expect(noMethodNote(subscription, false, 'none', true)).not.toMatch(
        /привязать карту|тариф с автопродлением/,
      )
    }
  })

  it('tells of no charge without a tariff or for an unpaid one', () => {
    expect(noMethodNote(null, true, 'at_bank')).toBe(
      'Он сохраняется, когда вы оплачиваете тариф с автопродлением.',
    )
    expect(noMethodNote(subscriptionTo({ ...none, status: 'past_due' }), false, 'at_bank')).toBe(
      'Оплата тарифа не прошла: тариф ждёт оплаты.',
    )
  })

  it('does not call an unpaid tariff valid', () => {
    const unpaid = subscriptionTo({ ...none, status: 'past_due' })
    expect(noMethodNote(unpaid, false, 'none')).toBe('Оплата тарифа не прошла: тариф ждёт оплаты.')
    expect(noMethodNote(unpaid, true, 'none')).toMatch(
      /^Оплата тарифа не прошла: тариф ждёт оплаты\. Можно привязать карту/,
    )
    expect(noMethodNote(unpaid, true, 'none')).not.toContain('действует до')
  })
})

describe('the warning of the unlink dialog', () => {
  it('says that auto-renewal stops and how long the tariff works', () => {
    expect(plain(unlinkWarning(subscriptionTo(), 'none'))).toBe(
      'Автопродление отключится. Тариф «Бизнес» будет работать до 18 октября 2026; после этого новые задачи не принимаются, пока вы снова не оплатите тариф.',
    )
  })

  it('says that tasks are taken after the tariff while the gift credits can start one', () => {
    const onGift = plain(unlinkWarning(subscriptionTo(), 'none', false, true))
    expect(onGift).toBe(
      'Автопродление отключится. Тариф «Бизнес» будет работать до 18 октября 2026; после этого новые задачи принимаются, только пока есть подарочные кредиты.',
    )
    // At a shop that takes one-time payments only the last sentence still follows.
    expect(plain(unlinkWarning(subscriptionTo(), 'none', true, true))).toBe(
      `${onGift} Привязать карту снова пока будет нельзя: автопродление недоступно.`,
    )
    // Where the warning names no day after which the tariff is over, the gift changes nothing.
    for (const [patch, renewalCharge] of [
      [{ autoRenewal: false }, 'none'],
      [{ status: 'past_due' }, 'none'],
      [{}, 'at_bank'],
      [{ autoRenewal: false }, 'unanswered'],
    ] as const) {
      const subscription = subscriptionTo(patch)
      expect(unlinkWarning(subscription, renewalCharge, false, true)).toBe(
        unlinkWarning(subscription, renewalCharge),
      )
    }
  })

  it('does not say «отключится» of auto-renewal that is off already', () => {
    expect(plain(unlinkWarning(subscriptionTo({ autoRenewal: false }), 'none'))).toBe(
      'Автопродление уже выключено. Тариф «Бизнес» работает до 18 октября 2026, как и раньше.',
    )
  })

  it('promises an unpaid tariff no working days', () => {
    const warning = unlinkWarning(subscriptionTo({ status: 'past_due' }), 'none')
    expect(warning).toBe(
      'Автоматических списаний не будет. Тариф «Бизнес» по-прежнему ждёт оплаты.',
    )
    expect(warning).not.toMatch(/работа/)
  })

  it.each([
    [
      'at_bank',
      true,
      'Автопродление отключится. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Отвязка это списание не отменит; других списаний не будет.',
    ],
    [
      'unanswered',
      true,
      'Автопродление отключится. Списание за следующий период уже отправлялось в банк, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их. Отвязка это списание не отменит; других списаний не будет.',
    ],
    [
      'at_bank',
      false,
      'Автопродление уже выключено. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Отвязка это списание не отменит; других списаний не будет.',
    ],
  ] as const)(
    'names no last day while a charge is under way, and says that unlinking does not stop it (%s, auto-renewal %s)',
    (renewalCharge, autoRenewal, warning) => {
      const said = plain(unlinkWarning(subscriptionTo({ autoRenewal }), renewalCharge))
      expect(said).toBe(warning)
      expect(said).not.toMatch(/работа(ет|ть) до/)
    },
  )

  it('tells an unpaid tariff nothing of a charge', () => {
    expect(unlinkWarning(subscriptionTo({ status: 'past_due' }), 'at_bank')).toBe(
      'Автоматических списаний не будет. Тариф «Бизнес» по-прежнему ждёт оплаты.',
    )
  })

  it('names the tariff the customer has, not the one scheduled after it', () => {
    expect(unlinkWarning(subscriptionTo({ nextPlan: agencyPlan }), 'none')).toContain(
      'Тариф «Бизнес»',
    )
  })

  it('says before the step that a card cannot be bound again at a shop that takes one-time payments only', () => {
    const noWayBack = 'Привязать карту снова пока будет нельзя: автопродление недоступно.'
    expect(plain(unlinkWarning(subscriptionTo(), 'none', true))).toBe(
      `Автопродление отключится. Тариф «Бизнес» будет работать до 18 октября 2026; после этого новые задачи не принимаются, пока вы снова не оплатите тариф. ${noWayBack}`,
    )
    // In every state of the tariff: «Оплата» offers no «Привязать карту» after any of them.
    for (const [patch, renewalCharge] of [
      [{}, 'none'],
      [{ autoRenewal: false }, 'none'],
      [{ status: 'past_due' }, 'none'],
      [{}, 'at_bank'],
      [{ autoRenewal: false }, 'unanswered'],
    ] as const) {
      const subscription = subscriptionTo(patch)
      const anywhere = unlinkWarning(subscription, renewalCharge)
      expect(unlinkWarning(subscription, renewalCharge, true)).toBe(`${anywhere} ${noWayBack}`)
      // Where a card can be bound again, nothing is said of it.
      expect(unlinkWarning(subscription, renewalCharge, false)).toBe(anywhere)
      expect(anywhere).not.toContain('Привязать карту')
    }
  })
})

describe('the notice of an unlink', () => {
  it('says that the method is unlinked and auto-renewal is off', () => {
    expect(unlinkedText('none')).toBe('Способ оплаты отвязан, автопродление выключено.')
  })

  it('tells at once of a charge that is at the bank: it may still renew the tariff', () => {
    expect(plain(unlinkedText('at_bank'))).toBe(
      'Способ оплаты отвязан, автопродление выключено. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Больше списаний не будет.',
    )
  })

  it('tells at once of a charge without an answer: we look it up, and renew or return', () => {
    expect(plain(unlinkedText('unanswered'))).toBe(
      'Способ оплаты отвязан, автопродление выключено. Списание за следующий период уже отправлялось в банк, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их. Больше списаний не будет.',
    )
  })

  it('keeps to «вы» and names no receipt, tax or code', () => {
    for (const renewalCharge of ['none', 'at_bank', 'unanswered'] as const) {
      expect(unlinkedText(renewalCharge)).not.toMatch(/чек|НДС|unknown|pending|[a-z]{4,}/i)
    }
  })
})

describe('the return page of a binding', () => {
  const binding = (patch: Partial<MethodBinding> = {}): MethodBinding => ({
    state: 'active',
    renewalCharge: 'none',
    subscription: subscriptionTo(),
    ...patch,
  })

  it('names the bound card and what happens to it next', () => {
    expect(boundText(binding()).map(plain)).toEqual([
      'Способ оплаты — Карта «Мир» •• 4444.',
      '18 октября спишем этим способом 12 900 ₽ за тариф «Бизнес». Если его отвязать, автопродление отключится.',
    ])
  })

  it('says that a card bound to a tariff that does not renew is not charged', () => {
    const [, note] = boundText(binding({ subscription: subscriptionTo({ autoRenewal: false }) }))
    expect(plain(note)).toBe(
      'Автопродление выключено: списаний не будет. Тариф действует до 18 октября 2026.',
    )
  })

  it.each([
    [
      'is at the bank',
      'at_bank',
      true,
      'Списание за следующий период уже отправлено в банк с прежнего способа оплаты; следующие пойдут с новой карты.',
    ],
    [
      'is at the bank and auto-renewal is off',
      'at_bank',
      false,
      'Списание за следующий период уже отправлено в банк с прежнего способа оплаты: если оно пройдёт, тариф продлится ещё на месяц. Автопродление выключено: других списаний не будет.',
    ],
    [
      'has no answer',
      'unanswered',
      true,
      'Списание за следующий период уже отправлялось в банк с прежнего способа оплаты, ответа пока нет: деньги могут быть списаны с него. Следующие списания пойдут с новой карты.',
    ],
    [
      'has no answer and auto-renewal is off',
      'unanswered',
      false,
      'Списание за следующий период уже отправлялось в банк с прежнего способа оплаты, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их. Автопродление выключено: других списаний не будет.',
    ],
  ] as const)(
    'does not promise the new card for a charge that left with the method before it and %s',
    (_case, renewalCharge, autoRenewal, note) => {
      const said = boundText(
        binding({ renewalCharge, subscription: subscriptionTo({ autoRenewal }) }),
      ).map(plain)
      expect(said).toEqual(['Способ оплаты — Карта «Мир» •• 4444.', note])
      expect(said.join(' ')).not.toMatch(/спишем этим способом/)
    },
  )

  it('says nothing of a charge to a tariff that is not paid: that charge has ended', () => {
    const [, note] = boundText(
      binding({ renewalCharge: 'at_bank', subscription: subscriptionTo({ status: 'past_due' }) }),
    )
    expect(note).toBe(
      'Оплата тарифа не прошла. Автоматических списаний не будет, пока тариф не оплачен.',
    )
  })

  it('has one plain sentence when the answer names no tariff or no card', () => {
    expect(boundText(binding({ subscription: null }))).toEqual(['Способ оплаты сохранён.'])
    expect(boundText(binding({ subscription: subscriptionTo({ paymentMethod: null }) }))[0]).toBe(
      'Способ оплаты сохранён.',
    )
  })

  it('says that nothing was charged and which method stays when the card was not bound', () => {
    expect(notBoundText(binding({ state: 'inactive' })).map(plain)).toEqual([
      'ЮKassa не сохранила карту: привязка отменена или время на неё истекло. Денег с карты не списано.',
      'Способ оплаты прежний — Карта «Мир» •• 4444.',
    ])
    for (const subscription of [null, subscriptionTo({ paymentMethod: null })]) {
      expect(notBoundText(binding({ state: 'inactive', subscription }))[1]).toBe(
        'Способ оплаты по-прежнему не сохранён.',
      )
    }
  })
})
