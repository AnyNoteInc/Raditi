import { describe, expect, it } from 'vitest'
import { addBillingMonths, billingPeriod, nextBillingPeriod } from './period.ts'

/** An instant given as Moscow wall-clock time, "2026-01-31T12:00:00". */
const msk = (wallClock: string): Date => new Date(`${wallClock}+03:00`)

/** The Moscow wall-clock time of an instant, in the same form. */
function inMoscow(instant: Date): string {
  return new Date(instant.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 19)
}

const boundaries = (anchor: Date, count: number): string[] =>
  Array.from({ length: count }, (_, index) => inMoscow(addBillingMonths(anchor, index)))

const badRequest = expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' })

describe('addBillingMonths', () => {
  it.each([
    // the anchor day exists in every month
    ['2026-01-15T12:00:00', 1, '2026-02-15T12:00:00'],
    ['2026-01-15T12:00:00', 6, '2026-07-15T12:00:00'],
    ['2026-01-01T00:00:00', 1, '2026-02-01T00:00:00'],
    ['2026-01-28T09:05:00', 1, '2026-02-28T09:05:00'],
    // 31 January: the last day of a shorter month, then the 31st again
    ['2026-01-31T12:00:00', 1, '2026-02-28T12:00:00'],
    ['2026-01-31T12:00:00', 2, '2026-03-31T12:00:00'],
    ['2026-01-31T12:00:00', 3, '2026-04-30T12:00:00'],
    ['2028-01-31T12:00:00', 1, '2028-02-29T12:00:00'],
    ['2028-01-31T12:00:00', 2, '2028-03-31T12:00:00'],
    // 30 January: short only in February
    ['2026-01-30T12:00:00', 1, '2026-02-28T12:00:00'],
    ['2026-01-30T12:00:00', 2, '2026-03-30T12:00:00'],
    ['2026-01-30T12:00:00', 3, '2026-04-30T12:00:00'],
    ['2028-01-30T12:00:00', 1, '2028-02-29T12:00:00'],
    // 29 January: short only in a February of a common year
    ['2026-01-29T12:00:00', 1, '2026-02-28T12:00:00'],
    ['2028-01-29T12:00:00', 1, '2028-02-29T12:00:00'],
    // 29 February of a leap year
    ['2028-02-29T12:00:00', 1, '2028-03-29T12:00:00'],
    ['2028-02-29T12:00:00', 12, '2029-02-28T12:00:00'],
    ['2028-02-29T12:00:00', 13, '2029-03-29T12:00:00'],
    ['2028-02-29T12:00:00', 48, '2032-02-29T12:00:00'],
    // 2100 is not a leap year
    ['2096-02-29T12:00:00', 48, '2100-02-28T12:00:00'],
    // December → January
    ['2026-12-15T12:00:00', 1, '2027-01-15T12:00:00'],
    ['2026-12-31T23:59:59', 1, '2027-01-31T23:59:59'],
    ['2026-12-31T23:59:59', 2, '2027-02-28T23:59:59'],
    ['2026-11-30T12:00:00', 3, '2027-02-28T12:00:00'],
    ['2026-10-04T20:36:00', 15, '2028-01-04T20:36:00'],
  ])('%s Moscow time plus %i months is %s', (anchor, months, expected) => {
    expect(inMoscow(addBillingMonths(msk(anchor), months))).toBe(expected)
  })

  it('returns the anchor itself for zero months, as a new object', () => {
    const anchor = msk('2026-01-31T12:00:00')
    const same = addBillingMonths(anchor, 0)
    expect(same).toEqual(anchor)
    expect(same).not.toBe(anchor)
  })

  it('keeps seconds and milliseconds of the anchor', () => {
    const anchor = new Date('2026-01-31T09:15:42.123Z')
    expect(addBillingMonths(anchor, 1).toISOString()).toBe('2026-02-28T09:15:42.123Z')
    expect(addBillingMonths(anchor, 2).toISOString()).toBe('2026-03-31T09:15:42.123Z')
  })

  it('does not change the anchor', () => {
    const anchor = msk('2026-01-31T12:00:00')
    addBillingMonths(anchor, 5)
    expect(anchor).toEqual(msk('2026-01-31T12:00:00'))
  })

  describe('counts the day of month in Moscow, not in UTC', () => {
    it.each([
      // 23:30 Moscow time: the same date in UTC, 20:30
      ['2026-01-31T20:30:00.000Z', '2026-01-31T23:30:00', 1, '2026-02-28T20:30:00.000Z'],
      ['2026-01-31T20:30:00.000Z', '2026-01-31T23:30:00', 2, '2026-03-31T20:30:00.000Z'],
      // 00:30 Moscow time on the 31st is still the 30th in UTC
      ['2026-01-30T21:30:00.000Z', '2026-01-31T00:30:00', 1, '2026-02-27T21:30:00.000Z'],
      ['2026-01-30T21:30:00.000Z', '2026-01-31T00:30:00', 2, '2026-03-30T21:30:00.000Z'],
      ['2026-01-30T21:30:00.000Z', '2026-01-31T00:30:00', 3, '2026-04-29T21:30:00.000Z'],
      // 23:30 UTC on the 30th is already 02:30 on the 31st in Moscow
      ['2026-01-30T23:30:00.000Z', '2026-01-31T02:30:00', 1, '2026-02-27T23:30:00.000Z'],
      ['2026-01-30T23:30:00.000Z', '2026-01-31T02:30:00', 2, '2026-03-30T23:30:00.000Z'],
      // the last millisecond before the Moscow date catches up with UTC
      ['2026-05-30T23:59:59.999Z', '2026-05-31T02:59:59', 1, '2026-06-29T23:59:59.999Z'],
      // 1 March in Moscow while UTC is still in February
      ['2026-02-28T21:30:00.000Z', '2026-03-01T00:30:00', 1, '2026-03-31T21:30:00.000Z'],
      ['2026-02-28T21:30:00.000Z', '2026-03-01T00:30:00', 12, '2027-02-28T21:30:00.000Z'],
      // New Year in Moscow, three hours before UTC
      ['2026-12-31T21:00:00.000Z', '2027-01-01T00:00:00', 1, '2027-01-31T21:00:00.000Z'],
      ['2026-11-30T21:00:00.000Z', '2026-12-01T00:00:00', 1, '2026-12-31T21:00:00.000Z'],
    ])('%s (%s in Moscow) plus %i months is %s', (utc, moscow, months, expected) => {
      const anchor = new Date(utc)
      expect(inMoscow(anchor)).toBe(moscow)
      expect(addBillingMonths(anchor, months).toISOString()).toBe(expected)
    })
  })

  it('does not depend on how the caller wrote the instant', () => {
    const fromUtc = addBillingMonths(new Date('2026-01-30T21:30:00Z'), 1)
    const fromMoscow = addBillingMonths(msk('2026-01-31T00:30:00'), 1)
    const fromVladivostok = addBillingMonths(new Date('2026-01-31T07:30:00+10:00'), 1)
    expect(fromMoscow).toEqual(fromUtc)
    expect(fromVladivostok).toEqual(fromUtc)
  })

  it.each([
    ['a fraction', 1.5],
    ['a negative number', -1],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['more than a century', 1201],
  ])('rejects %s of months', (_name, months) => {
    expect(() => addBillingMonths(msk('2026-01-31T12:00:00'), months)).toThrow(badRequest)
  })

  it('rejects an invalid anchor and a result outside the range of Date', () => {
    expect(() => addBillingMonths(new Date('invalid'), 1)).toThrow(badRequest)
    expect(() => addBillingMonths('2026-01-31' as unknown as Date, 1)).toThrow(badRequest)
    expect(() => addBillingMonths(new Date(8.64e15), 1)).toThrow(badRequest)
  })
})

describe('billingPeriod', () => {
  it('starts period 0 at the anchor and ends it a month later', () => {
    const anchor = msk('2026-10-04T20:36:00')
    expect(billingPeriod(anchor, 0)).toEqual({ start: anchor, end: msk('2026-11-04T20:36:00') })
  })

  it.each([
    ['2026-01-31T12:00:00', 0, '2026-01-31T12:00:00', '2026-02-28T12:00:00'],
    ['2026-01-31T12:00:00', 1, '2026-02-28T12:00:00', '2026-03-31T12:00:00'],
    ['2026-01-31T12:00:00', 2, '2026-03-31T12:00:00', '2026-04-30T12:00:00'],
    ['2026-01-30T12:00:00', 1, '2026-02-28T12:00:00', '2026-03-30T12:00:00'],
    ['2028-02-29T12:00:00', 11, '2029-01-29T12:00:00', '2029-02-28T12:00:00'],
    ['2028-02-29T12:00:00', 12, '2029-02-28T12:00:00', '2029-03-29T12:00:00'],
    ['2026-12-31T23:30:00', 0, '2026-12-31T23:30:00', '2027-01-31T23:30:00'],
    ['2026-12-31T23:30:00', 1, '2027-01-31T23:30:00', '2027-02-28T23:30:00'],
  ])('period %#: anchor %s, index %i runs from %s to %s', (anchor, index, start, end) => {
    const period = billingPeriod(msk(anchor), index)
    expect(inMoscow(period.start)).toBe(start)
    expect(inMoscow(period.end)).toBe(end)
  })

  it('returns to the 31st over twelve consecutive periods', () => {
    const anchor = msk('2026-01-31T12:00:00')
    expect(boundaries(anchor, 13)).toEqual([
      '2026-01-31T12:00:00',
      '2026-02-28T12:00:00',
      '2026-03-31T12:00:00',
      '2026-04-30T12:00:00',
      '2026-05-31T12:00:00',
      '2026-06-30T12:00:00',
      '2026-07-31T12:00:00',
      '2026-08-31T12:00:00',
      '2026-09-30T12:00:00',
      '2026-10-31T12:00:00',
      '2026-11-30T12:00:00',
      '2026-12-31T12:00:00',
      '2027-01-31T12:00:00',
    ])
  })

  it('returns to the 30th over twelve consecutive periods through a leap February', () => {
    expect(boundaries(msk('2027-08-30T23:30:00'), 13)).toEqual([
      '2027-08-30T23:30:00',
      '2027-09-30T23:30:00',
      '2027-10-30T23:30:00',
      '2027-11-30T23:30:00',
      '2027-12-30T23:30:00',
      '2028-01-30T23:30:00',
      '2028-02-29T23:30:00',
      '2028-03-30T23:30:00',
      '2028-04-30T23:30:00',
      '2028-05-30T23:30:00',
      '2028-06-30T23:30:00',
      '2028-07-30T23:30:00',
      '2028-08-30T23:30:00',
    ])
  })

  it.each([
    ['2026-01-31T12:00:00'],
    ['2026-01-31T00:30:00'],
    ['2028-02-29T23:30:00'],
    ['2026-12-15T02:59:59'],
  ])('leaves no gap and no overlap between periods of anchor %s', (anchor) => {
    for (let index = 0; index < 36; index++) {
      const current = billingPeriod(msk(anchor), index)
      const next = billingPeriod(msk(anchor), index + 1)
      expect(next.start).toEqual(current.end)
      expect(current.end.getTime()).toBeGreaterThan(current.start.getTime())
      const days = (current.end.getTime() - current.start.getTime()) / 86_400_000
      expect([28, 29, 30, 31]).toContain(days)
    }
  })

  it('rejects a negative, fractional or too distant index', () => {
    const anchor = msk('2026-01-31T12:00:00')
    expect(() => billingPeriod(anchor, -1)).toThrow(badRequest)
    expect(() => billingPeriod(anchor, 0.5)).toThrow(badRequest)
    expect(() => billingPeriod(anchor, 1200)).toThrow(badRequest)
  })
})

describe('nextBillingPeriod', () => {
  it.each([
    // 28 February is followed by a period that ends on the anchor day again
    ['2026-01-31T12:00:00', '2026-02-28T12:00:00', '2026-03-31T12:00:00'],
    ['2026-01-31T12:00:00', '2026-03-31T12:00:00', '2026-04-30T12:00:00'],
    ['2026-01-30T12:00:00', '2026-02-28T12:00:00', '2026-03-30T12:00:00'],
    ['2026-01-29T12:00:00', '2026-02-28T12:00:00', '2026-03-29T12:00:00'],
    ['2026-01-28T12:00:00', '2026-02-28T12:00:00', '2026-03-28T12:00:00'],
    ['2028-01-31T12:00:00', '2028-02-29T12:00:00', '2028-03-31T12:00:00'],
    ['2028-02-29T12:00:00', '2029-02-28T12:00:00', '2029-03-29T12:00:00'],
    ['2026-11-30T12:00:00', '2026-12-30T12:00:00', '2027-01-30T12:00:00'],
    ['2026-12-31T23:30:00', '2027-01-31T23:30:00', '2027-02-28T23:30:00'],
    ['2026-01-31T00:30:00', '2026-02-28T00:30:00', '2026-03-31T00:30:00'],
  ])('anchor %s: the period after %s ends at %s', (anchor, periodEnd, nextEnd) => {
    const period = nextBillingPeriod(msk(anchor), msk(periodEnd))
    expect(period.start).toEqual(msk(periodEnd))
    expect(inMoscow(period.end)).toBe(nextEnd)
  })

  it.each([
    ['2026-01-31T12:00:00'],
    ['2026-01-30T21:30:00'],
    ['2028-02-29T00:00:00'],
    ['2026-12-31T23:59:59'],
  ])('walks the same periods as billingPeriod for anchor %s', (wallClock) => {
    const anchor = msk(wallClock)
    let period = billingPeriod(anchor, 0)
    for (let index = 1; index <= 48; index++) {
      period = nextBillingPeriod(anchor, period.end)
      expect(period).toEqual(billingPeriod(anchor, index))
    }
  })

  it.each([
    ['the anchor itself', '2026-01-31T12:00:00'],
    ['an instant before the anchor', '2025-12-31T12:00:00'],
    ['a boundary counted from the previous end, not from the anchor', '2026-03-28T12:00:00'],
    ['another time of day', '2026-02-28T12:00:01'],
    ['another day of the month', '2026-03-30T12:00:00'],
    ['a moment inside a period', '2026-02-10T12:00:00'],
    ['a moment later in the anchor month', '2026-01-31T18:00:00'],
  ])('rejects %s as a period end', (_name, periodEnd) => {
    expect(() => nextBillingPeriod(msk('2026-01-31T12:00:00'), msk(periodEnd))).toThrow(badRequest)
  })

  it('continues a past_due subscription paid late from that payment, not from the first one', () => {
    // First payment on 31 January, the renewal of 28 February is declined, paid on 3 March.
    const firstPayment = msk('2026-01-31T12:00:00')
    const latePayment = msk('2026-03-03T15:00:00')
    const restarted = billingPeriod(latePayment, 0)
    expect(inMoscow(restarted.end)).toBe('2026-04-03T15:00:00')
    // The first payment's boundaries are 31 March and 30 April at 12:00: with it as the anchor
    // the renewal of 3 April is refused, so the late payment must become the stored anchor.
    expect(() => nextBillingPeriod(firstPayment, restarted.end)).toThrow(badRequest)
    const renewed = nextBillingPeriod(latePayment, restarted.end)
    expect(renewed).toEqual(billingPeriod(latePayment, 1))
    expect(inMoscow(renewed.start)).toBe('2026-04-03T15:00:00')
    expect(inMoscow(renewed.end)).toBe('2026-05-03T15:00:00')
  })

  it('rejects a period end counted on the UTC calendar', () => {
    const anchor = new Date('2026-01-30T21:30:00Z')
    expect(inMoscow(anchor)).toBe('2026-01-31T00:30:00')
    expect(() => nextBillingPeriod(anchor, new Date('2026-02-28T21:30:00Z'))).toThrow(badRequest)
    expect(nextBillingPeriod(anchor, new Date('2026-02-27T21:30:00Z')).end).toEqual(
      new Date('2026-03-30T21:30:00Z'),
    )
  })

  it('rejects invalid dates and a period end beyond a century', () => {
    const anchor = msk('2026-01-31T12:00:00')
    expect(() => nextBillingPeriod(new Date('invalid'), anchor)).toThrow(badRequest)
    expect(() => nextBillingPeriod(anchor, new Date('invalid'))).toThrow(badRequest)
    expect(() => nextBillingPeriod(anchor, msk('2126-01-31T12:00:00'))).toThrow(badRequest)
    expect(nextBillingPeriod(anchor, msk('2125-12-31T12:00:00')).end).toEqual(
      msk('2126-01-31T12:00:00'),
    )
  })
})
