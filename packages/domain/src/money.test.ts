import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import * as llmMoney from './llm/money.ts'
import { amountRubSchema, balanceRubSchema, decimalStringSchema, Money } from './money.ts'

describe('Money', () => {
  it('rounds HALF_UP with its own precision, whatever the global decimal.js settings are', () => {
    const previous = { precision: Decimal.precision, rounding: Decimal.rounding }
    try {
      Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN })
      expect(new Money('4900.00').div(3).toFixed(2)).toBe('1633.33')
      expect(new Money('0.005').toDecimalPlaces(2).toFixed(2)).toBe('0.01')
      expect(new Money('1234567890.12').plus('0.01').toFixed(2)).toBe('1234567890.13')
    } finally {
      Decimal.set(previous)
    }
  })

  it('is the one constructor and schema factory the llm rules use', () => {
    expect(llmMoney.Money).toBe(Money)
    expect(llmMoney.decimalStringSchema).toBe(decimalStringSchema)
  })
})

describe('decimalStringSchema', () => {
  const schema = decimalStringSchema(8, 6)

  it.each(['0', '7', '175.68', '175.680000', '99999999.999999'])('accepts %s', (value) => {
    expect(schema.safeParse(value).success).toBe(true)
  })

  it.each([
    ['an empty string', ''],
    ['a ninth integer digit', '100000000'],
    ['a seventh decimal', '1.0000001'],
    ['a sign', '-1'],
    ['a plus sign', '+1'],
    ['an exponent', '1e3'],
    ['a comma', '1,5'],
    ['a bare point', '1.'],
    ['a missing integer part', '.5'],
    ['a leading space', ' 1'],
    ['a trailing line break', '1\n'],
  ])('rejects %s', (_name, value) => {
    expect(schema.safeParse(value).success).toBe(false)
  })

  it('rejects values that are not strings', () => {
    expect(schema.safeParse(1).success).toBe(false)
    expect(schema.safeParse(new Money(1)).success).toBe(false)
    expect(schema.safeParse(null).success).toBe(false)
  })
})

describe('customer money strings', () => {
  const schemas = [
    ['amountRubSchema', amountRubSchema, '9999999999.99', '10000000000.00'],
    ['balanceRubSchema', balanceRubSchema, '999999999999.99', '1000000000000.00'],
  ] as const

  describe.each(schemas)('%s', (_name, schema, highest, tooLarge) => {
    it.each(['0.00', '0.01', '1.00', '4900.00', '12900.00', '39900.50', highest])(
      'accepts %s',
      (value) => {
        expect(schema.parse(value)).toBe(value)
      },
    )

    it.each([
      ['no decimals', '4900'],
      ['one decimal', '4900.0'],
      ['three decimals', '4900.000'],
      ['a leading zero', '04900.00'],
      ['two zeros before the point', '00.00'],
      ['a missing integer part', '.50'],
      ['a negative amount', '-1.00'],
      ['a plus sign', '+1.00'],
      ['a comma', '4900,00'],
      ['grouped thousands', '4 900.00'],
      ['an exponent', '1e3'],
      ['a leading space', ' 1.00'],
      ['a trailing space', '1.00 '],
      ['a trailing line break', '1.00\n'],
      ['an empty string', ''],
      ['one integer digit too many', tooLarge],
    ])('rejects %s', (_case, value) => {
      expect(schema.safeParse(value).success).toBe(false)
    })

    it('rejects numbers and Decimal objects: money travels as a string', () => {
      expect(schema.safeParse(4900).success).toBe(false)
      expect(schema.safeParse(new Money('4900.00')).success).toBe(false)
      expect(schema.safeParse(null).success).toBe(false)
    })

    it('accepts what toFixed(2) prints', () => {
      for (const value of ['0', '4900', '12900.5', '0.005', highest]) {
        expect(schema.safeParse(new Money(value).toFixed(2)).success).toBe(true)
      }
    })
  })

  it('keeps Decimal(12,2) amounts narrower than Decimal(14,2) balances', () => {
    expect(amountRubSchema.safeParse('999999999999.99').success).toBe(false)
    expect(balanceRubSchema.safeParse('10000000000.00').success).toBe(true)
  })
})
