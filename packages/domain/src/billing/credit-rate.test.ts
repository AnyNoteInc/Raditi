import { describe, expect, it } from 'vitest'
import { Money } from '../money.ts'
import {
  creditRateCoversPrice,
  creditRateSchema,
  creditRateVerdict,
  rubPerCreditSchema,
  type UsableCreditRateInput,
} from './credit-rate.ts'

const badRequest = expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' })

const approved = new Date('2026-10-01T00:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const at = (days: number, ms = 0) => new Date(approved.getTime() + days * DAY_MS + ms)

describe('rubPerCreditSchema', () => {
  it.each(['6', '6.00', '6.000000', '5.98', '7.50', '0.000001', '99999999.999999'])(
    'accepts %s',
    (value) => {
      expect(rubPerCreditSchema.parse(value)).toBe(value)
    },
  )

  it.each<[string, unknown]>([
    ['zero', '0'],
    ['zero with decimals', '0.000000'],
    ['a negative rate', '-6.00'],
    ['a seventh decimal', '6.0000001'],
    ['a ninth integer digit', '100000000'],
    ['an exponent', '6e0'],
    ['a comma', '6,00'],
    ['a bare point', '6.'],
    ['a space', ' 6.00'],
    ['an empty string', ''],
    ['a number', 6],
    ['a Decimal', new Money('6.00')],
    ['null', null],
  ])('refuses %s', (_name, value) => {
    expect(rubPerCreditSchema.safeParse(value).success).toBe(false)
  })
})

describe('creditRateSchema', () => {
  const row = {
    effectiveFrom: approved,
    rubPerCredit: '6.000000',
    basis: 'The basket of done work on GPT-6 Sol at 4.65 RUB: 59.83 RUB, a tenth of it',
  }

  it('reads a row of credit_rates', () => {
    expect(creditRateSchema.parse(row)).toEqual(row)
  })

  it('takes a basis of 1024 characters and no longer', () => {
    expect(creditRateSchema.safeParse({ ...row, basis: 'б'.repeat(1024) }).success).toBe(true)
    expect(creditRateSchema.safeParse({ ...row, basis: 'б'.repeat(1025) }).success).toBe(false)
  })

  it.each<[string, Record<string, unknown>]>([
    ['a rate of zero', { rubPerCredit: '0.000000' }],
    ['a rate as a number', { rubPerCredit: 6 }],
    ['an empty basis', { basis: '' }],
    ['a basis of spaces', { basis: '   ' }],
    ['a start that is not a moment', { effectiveFrom: new Date(Number.NaN) }],
    ['a start as text', { effectiveFrom: '2026-10-01' }],
    ['an unknown column', { approvedBy: 'owner' }],
  ])('refuses %s', (_name, change) => {
    expect(creditRateSchema.safeParse({ ...row, ...change }).success).toBe(false)
  })

  it('refuses a row without one of its columns', () => {
    for (const column of ['effectiveFrom', 'rubPerCredit', 'basis'] as const) {
      const { [column]: _dropped, ...rest } = row
      expect(creditRateSchema.safeParse(rest).success).toBe(false)
    }
  })
})

describe('creditRateCoversPrice', () => {
  it.each([
    ['approved in one act with the price', at(0), at(0), true],
    ['a rate newer than the price: a change of the rate alone', at(30), at(0), true],
    ['a rate a millisecond after the price', at(0, 1), at(0), true],
    ['a price a millisecond after the rate', at(0), at(0, 1), false],
    ['a price of a later quarter', at(0), at(90), false],
  ])('%s → %s', (_name, rate, price, expected) => {
    expect(creditRateCoversPrice(rate, price)).toBe(expected)
  })

  it('compares instants, not the objects that carry them', () => {
    expect(creditRateCoversPrice(new Date(approved), new Date(approved))).toBe(true)
  })

  it('refuses a start that is not a moment', () => {
    const never = new Date(Number.NaN)
    expect(() => creditRateCoversPrice(never, approved)).toThrow(badRequest)
    expect(() => creditRateCoversPrice(approved, never)).toThrow(badRequest)
    expect(() => creditRateCoversPrice('2026-10-01' as unknown as Date, approved)).toThrow(
      badRequest,
    )
    expect(() => creditRateCoversPrice(approved, null as unknown as Date)).toThrow(badRequest)
  })
})

describe('creditRateVerdict', () => {
  const now = at(10)
  const rate = (days: number, ms = 0) => ({ effectiveFrom: at(days, ms) })
  const check = (change: Partial<UsableCreditRateInput> = {}) =>
    creditRateVerdict({ now, rate: rate(0), prices: [rate(0)], ...change })

  it('is usable when the rate and the prices were approved in one act', () => {
    expect(check()).toBe('usable')
    expect(check({ prices: [rate(0), rate(0), rate(0)] })).toBe('usable')
  })

  it('is usable when the rate is newer than every price in force', () => {
    expect(check({ rate: rate(5), prices: [rate(0), rate(-90)] })).toBe('usable')
    expect(check({ rate: rate(10), prices: [rate(0)] })).toBe('usable')
  })

  it('is missing when no rate has ever been approved', () => {
    expect(check({ rate: null })).toBe('missing')
    expect(check({ rate: null, prices: [] })).toBe('missing')
  })

  it('is missing while the only rate has not started yet', () => {
    expect(check({ rate: rate(10, 1) })).toBe('missing')
    expect(check({ rate: rate(40), prices: [rate(40)] })).toBe('missing')
    // the instant it starts, it is in force
    expect(check({ rate: rate(10), prices: [rate(10)] })).toBe('usable')
  })

  it('is stale when a price in force of an enabled model started after the rate', () => {
    expect(check({ prices: [rate(0, 1)] })).toBe('stale')
    expect(check({ prices: [rate(0), rate(5)] })).toBe('stale')
    expect(check({ prices: [rate(5), rate(0)] })).toBe('stale')
    // a price that starts at this very instant is in force
    expect(check({ prices: [rate(10)] })).toBe('stale')
  })

  it('passes over a price that is not in force yet', () => {
    expect(check({ prices: [rate(0), rate(10, 1)] })).toBe('usable')
    expect(check({ prices: [rate(40)] })).toBe('usable')
  })

  it('is usable with no price at all: the rate itself is not what is missing then', () => {
    expect(check({ prices: [] })).toBe('usable')
  })

  it('reports a missing rate before it looks at the prices', () => {
    expect(check({ rate: null, prices: [rate(5)] })).toBe('missing')
    expect(check({ rate: rate(20), prices: [rate(5)] })).toBe('missing')
  })

  it('does not change its input', () => {
    const input = { now: new Date(now), rate: rate(0), prices: [rate(0), rate(5)] }
    creditRateVerdict(input)
    expect(input).toEqual({ now, rate: rate(0), prices: [rate(0), rate(5)] })
  })

  it.each<[string, unknown]>([
    ['a moment that is not one', { now: new Date(Number.NaN), rate: rate(0), prices: [] }],
    ['a rate without its start', { now, rate: {}, prices: [] }],
    ['a rate whose start is not a moment', { now, rate: rate(Number.NaN), prices: [] }],
    ['a whole row in place of its start', { now, rate: { ...rate(0), basis: 'x' }, prices: [] }],
    ['a price whose start is not a moment', { now, rate: rate(0), prices: [rate(Number.NaN)] }],
    ['prices that are not a list', { now, rate: rate(0), prices: rate(0) }],
    ['no prices', { now, rate: rate(0) }],
    ['an unknown field', { now, rate: rate(0), prices: [], models: [] }],
    ['null', null],
  ])('refuses %s', (_name, input) => {
    expect(() => creditRateVerdict(input as UsableCreditRateInput)).toThrow(badRequest)
  })
})
