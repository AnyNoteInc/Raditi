import { minTaskChargeCredits, typicalTaskCredits } from '@repo/domain/billing/credit-numbers'
import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'

import {
  CHARGED_FOR_DONE_WORK,
  smallEditPrice,
  smallEditRubles,
  smallEditSentence,
  TARIFF_CREDITS_CARRY_OVER,
} from './credit-price'

describe('smallEditRubles', () => {
  it('is the charge of a small edit at the price of the credits, half up to a whole ruble', () => {
    // A small edit is usually charged the minimum of a done task.
    expect(minTaskChargeCredits).toBe(5)
    expect(typicalTaskCredits.small).toEqual({
      from: minTaskChargeCredits,
      to: minTaskChargeCredits,
    })
    // The tariffs and the pack of 06.11.2026: 66.33, 58.25, 49.975 and 74.5.
    expect(smallEditRubles('1990.00', 150)).toBe('66.00')
    expect(smallEditRubles('6990.00', 600)).toBe('58.00')
    expect(smallEditRubles('19990.00', 2000)).toBe('50.00')
    expect(smallEditRubles('1490.00', 100)).toBe('75.00')
    // What the calculator of the landing adds up: «Старт» and two packs, 4 970 ₽ for 350.
    expect(smallEditRubles('4970.00', 350)).toBe('71.00')
  })

  it('rounds once, from the exact quotient and not from the kopecks', () => {
    // 5 × 100.99 / 10 = 50.495: 50.50 in kopecks, which rounded again would be 51.
    expect(smallEditRubles('100.99', 10)).toBe('50.00')
    expect(smallEditRubles('101.00', 10)).toBe('51.00')
    // Quotients without an end: a third of a ruble under the half, and two thirds above it.
    expect(smallEditRubles('100.00', 6)).toBe('83.00')
    expect(smallEditRubles('100.00', 3)).toBe('167.00')
  })

  it('reads the price the same whatever the global Decimal settings are', () => {
    const previous = { precision: Decimal.precision, rounding: Decimal.rounding }
    try {
      Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN })
      expect(smallEditRubles('1990.00', 150)).toBe('66.00')
      expect(smallEditRubles('1490.00', 100)).toBe('75.00')
    } finally {
      Decimal.set(previous)
    }
  })

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'promises no price for %s credits',
    (credits) => {
      expect(smallEditRubles('1990.00', credits)).toBeNull()
      expect(smallEditPrice('1990.00', credits)).toBeNull()
    },
  )
})

describe('smallEditPrice', () => {
  it('says the price of a small edit of a tariff and of a pack', () => {
    expect(smallEditPrice('1990.00', 150)).toBe('Небольшая правка — около 66 ₽')
    expect(smallEditPrice('6990.00', 600)).toBe('Небольшая правка — около 58 ₽')
    expect(smallEditPrice('19990.00', 2000)).toBe('Небольшая правка — около 50 ₽')
    expect(smallEditPrice('1490.00', 100, 'из пакета')).toBe(
      'Небольшая правка из пакета — около 75 ₽',
    )
  })

  it('says a price counted elsewhere in the same words', () => {
    expect(smallEditSentence('71.00')).toBe('Небольшая правка — около 71 ₽')
    expect(smallEditSentence('75.00', 'из пакета')).toBe('Небольшая правка из пакета — около 75 ₽')
  })

  it('groups the rubles of a large price with a space that does not break', () => {
    expect(smallEditPrice('300000.00', 1)).toBe('Небольшая правка — около 1 500 000 ₽')
  })
})

describe('CHARGED_FOR_DONE_WORK', () => {
  it('is the rule of the charge, word for word', () => {
    expect(CHARGED_FOR_DONE_WORK).toBe(
      'Списываем только за выполненную работу: если задача не получилась, кредиты возвращаются.',
    )
  })
})

describe('TARIFF_CREDITS_CARRY_OVER', () => {
  it('says the tariff credits live one more month, and only one', () => {
    expect(TARIFF_CREDITS_CARRY_OVER).toBe(
      'Неистраченные кредиты тарифа переходят на следующий месяц, один раз.',
    )
  })
})
