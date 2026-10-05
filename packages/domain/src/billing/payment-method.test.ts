import { describe, expect, it } from 'vitest'
import { paymentMethodLabel, type StoredPaymentMethod } from './payment-method.ts'

const card = (cardType: string | null, last4: string | null = '4444'): StoredPaymentMethod => ({
  type: 'bank_card',
  cardType,
  last4,
})
const method = (type: string | null): StoredPaymentMethod => ({ type, cardType: null, last4: null })

describe('paymentMethodLabel', () => {
  it.each([
    ['Mir', 'Карта «Мир» ••\u00a04444'],
    ['Visa', 'Карта Visa ••\u00a04444'],
    ['MasterCard', 'Карта Mastercard ••\u00a04444'],
  ])('names a %s card by its brand', (cardType, label) => {
    expect(paymentMethodLabel(card(cardType))).toBe(label)
  })

  it.each([
    'UnionPay',
    'JCB',
    'AmericanExpress',
    'DinersClub',
    'DiscoverCard',
    'InstaPayment',
    'InstaPaymentTM',
    'Laser',
    'Dankort',
    'Solo',
    'Switch',
    'Unknown',
    // ЮKassa spells the brands exactly; another spelling is another brand
    'mir',
    'MIR',
    'VISA',
    'Mastercard',
    ' Mir',
    '',
    // names of inherited object members are not brands
    'toString',
    'constructor',
    '__proto__',
    null,
  ])('names a card of brand %j a bank card', (cardType) => {
    expect(paymentMethodLabel(card(cardType))).toBe('Банковская карта ••\u00a04444')
  })

  it.each([
    ['sbp', 'СБП'],
    ['sberbank', 'SberPay'],
    ['tinkoff_bank', 'T-Pay'],
    ['yoo_money', 'ЮMoney'],
  ])('names %s %s', (type, label) => {
    expect(paymentMethodLabel(method(type))).toBe(label)
  })

  it.each([
    'alfa_pay',
    'alfabank',
    'apple_pay',
    'google_pay',
    'sber_loan',
    'sber_bnpl',
    'b2b_sberbank',
    'mobile_balance',
    'cash',
    'installments',
    'electronic_certificate',
    'qiwi',
    'webmoney',
    'wechat',
    // exact spelling only
    'SBP',
    'bank card',
    'Bank_Card',
    '',
    'toString',
    'constructor',
    '__proto__',
    null,
  ])('falls back to a neutral name for type %j', (type) => {
    expect(paymentMethodLabel(method(type))).toBe('Сохранённый способ оплаты')
    // Card details of an unknown type are not shown either.
    expect(paymentMethodLabel({ type, cardType: 'Mir', last4: '4444' })).toBe(
      'Сохранённый способ оплаты',
    )
  })

  it('keeps the name of a wallet whatever card stands behind it', () => {
    expect(paymentMethodLabel({ type: 'sberbank', cardType: 'Mir', last4: '4444' })).toBe('SberPay')
    expect(paymentMethodLabel({ type: 'tinkoff_bank', cardType: 'Visa', last4: '1111' })).toBe(
      'T-Pay',
    )
  })

  it('puts a non-breaking space before the last four digits and a plain one elsewhere', () => {
    const label = paymentMethodLabel(card('Mir', '0042'))
    expect(label).toBe('Карта «Мир» ••\u00a00042')
    expect(label.split('\u00a0')).toEqual(['Карта «Мир» ••', '0042'])
    expect(label.split(' ')).toEqual(['Карта', '«Мир»', '••\u00a00042'])
    expect([...label].filter((char) => char === '•')).toHaveLength(2)
  })

  it.each([
    ['missing', null],
    ['empty', ''],
    ['three digits', '444'],
    ['five digits', '44444'],
    ['letters', '44a4'],
    ['a masked number', '*444'],
    ['digits with a space', '44 4'],
    ['digits with a line break', '4444\n'],
    ['digits of another script', '٤٤٤٤'],
  ])('names a card without its digits when they are %s', (_name, last4) => {
    expect(paymentMethodLabel(card('Mir', last4))).toBe('Карта «Мир»')
    expect(paymentMethodLabel(card('Visa', last4))).toBe('Карта Visa')
    expect(paymentMethodLabel(card('MasterCard', last4))).toBe('Карта Mastercard')
    expect(paymentMethodLabel(card('UnionPay', last4))).toBe('Банковская карта')
    expect(paymentMethodLabel(card(null, last4))).toBe('Банковская карта')
  })

  it('uses the exact characters of the brand names', () => {
    // Code points and script ranges, not typed letters: a look-alike of another script (a
    // Cyrillic «Т» or a dash in T-Pay, a Latin «C» in СБП) fails here even when the source and
    // the tables above were retyped the same way.
    const latin = /^[\x21-\x7e]+$/
    const cyrillic = /^[А-я]+$/
    const tPay = paymentMethodLabel(method('tinkoff_bank'))
    const yooMoney = paymentMethodLabel(method('yoo_money'))
    // Latin "T" and hyphen-minus
    expect(tPay).toBe('T-Pay')
    expect(tPay).toMatch(latin)
    // Cyrillic "Ю" before Latin "Money"
    expect(yooMoney).toBe('ЮMoney')
    expect(yooMoney.slice(1)).toMatch(latin)
    expect(paymentMethodLabel(method('sberbank'))).toMatch(latin)
    expect(paymentMethodLabel(method('sbp'))).toBe('СБП')

    const [word, mir, ...rest] = paymentMethodLabel(card('Mir', null)).split(' ')
    expect(word).toMatch(cyrillic)
    expect(mir).toBe('«Мир»')
    expect(rest).toEqual([])
    for (const cardType of ['Visa', 'MasterCard']) {
      const [cardWord, brand] = paymentMethodLabel(card(cardType, null)).split(' ')
      expect(cardWord).toBe(word)
      expect(brand).toMatch(latin)
    }
    for (const part of paymentMethodLabel(card(null, null)).split(' ')) {
      expect(part).toMatch(cyrillic)
    }
  })
})
