import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'

import { formatRubles } from './rubles'

describe('formatRubles', () => {
  it('groups rubles and preserves kopecks without floating point conversion', () => {
    expect(formatRubles('12900.00')).toBe('12\u00a0900')
    expect(formatRubles('12860.10')).toBe('12\u00a0860,10')
    expect(formatRubles('0.30')).toBe('0,30')
    expect(formatRubles('4900.00')).toBe('4\u00a0900')
    expect(formatRubles('990.00')).toBe('990')
    expect(formatRubles('1234567.00')).toBe('1\u00a0234\u00a0567')
  })

  it('keeps every digit of an amount a binary number cannot hold', () => {
    expect(formatRubles('9007199254740993.07')).toBe(
      '9\u00a0007\u00a0199\u00a0254\u00a0740\u00a0993,07',
    )
  })

  it('reads an amount the same whatever the global Decimal settings are', () => {
    const previous = { precision: Decimal.precision, rounding: Decimal.rounding }
    try {
      Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN })
      expect(formatRubles('12860.50')).toBe('12\u00a0860,50')
    } finally {
      Decimal.set(previous)
    }
  })
})
