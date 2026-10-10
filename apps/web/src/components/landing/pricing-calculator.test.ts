import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'

import { packsInWords, pluralEdits, recommendPlan } from './pricing-calculator'
import { pricing } from './testing'

describe('landing plan recommendation', () => {
  it('keeps the truly cheapest option when a larger plan costs less than 5% more', () => {
    expect(recommendPlan(pricing, 70)).toMatchObject({
      plan: { slug: 'start' },
      packs: 4,
      total: '12860.00',
    })
  })

  it('charges for whole packs and switches to a cheaper quota plan at the boundary', () => {
    expect(recommendPlan(pricing, 30)).toMatchObject({ packs: 0, total: '4900.00' })
    expect(recommendPlan(pricing, 31)).toMatchObject({ packs: 1, total: '6890.00' })
    expect(recommendPlan(pricing, 75)).toMatchObject({
      plan: { slug: 'business' },
      total: '12900.00',
    })
    expect(recommendPlan(pricing, 300)).toMatchObject({
      plan: { slug: 'agency' },
      packs: 5,
      total: '49850.00',
    })
  })

  it('does not promise free extra edits if packs are unavailable', () => {
    const withoutPacks = { ...pricing, pack: null }
    expect(recommendPlan(withoutPacks, 35)).toMatchObject({
      plan: { slug: 'business' },
      packs: 0,
      total: '12900.00',
    })
    expect(recommendPlan(withoutPacks, 300)).toBeNull()
    expect(recommendPlan({ plans: [], pack: null }, 30)).toBeNull()
  })

  it('preserves kopecks with decimal arithmetic', () => {
    const first = pricing.plans[0]!
    const fractional = {
      plans: [{ ...first, price: '0.10', editsPerMonth: 1 }],
      pack: { price: '0.20', edits: 1 },
    }
    expect(recommendPlan(fractional, 2)).toMatchObject({ total: '0.30' })
    expect(recommendPlan({ plans: [{ ...first, price: '1.01' }], pack: null }, 2)).toMatchObject({
      total: '1.01',
    })
  })

  it('is independent of a changed global Decimal precision', () => {
    const previous = { precision: Decimal.precision, rounding: Decimal.rounding }
    try {
      Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN })
      expect(recommendPlan(pricing, 70)?.total).toBe('12860.00')
    } finally {
      Decimal.set(previous)
    }
  })

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid edit count %s',
    (edits) => {
      expect(recommendPlan(pricing, edits)).toBeNull()
    },
  )
})

describe('estimate of one edit', () => {
  /** The estimate for a plan of the given price that covers the edits without a pack. */
  const estimate = (price: string, edits: number) => {
    const plan = { ...pricing.plans[0]!, price, editsPerMonth: edits }
    return recommendPlan({ plans: [plan], pack: null }, edits)
  }

  it('is rounded half up to whole rubles, and the amounts of the calculation stay exact', () => {
    expect(recommendPlan(pricing, 30)).toMatchObject({
      total: '4900.00',
      perEditRounded: '163.00',
    })
    expect(recommendPlan(pricing, 70)).toMatchObject({ perEditRounded: '184.00' })
    expect(estimate('347.00', 2)?.perEditRounded).toBe('174.00')
    expect(estimate('346.98', 2)?.perEditRounded).toBe('173.00')
    expect(estimate('1.00', 2)?.perEditRounded).toBe('1.00')
    expect(estimate('2599.00', 2)?.perEditRounded).toBe('1300.00')
  })

  // 495.495 is 495.50 in kopecks; rounded once more, that would be 496.
  it('is rounded once, from the exact quotient and not from the kopecks', () => {
    expect(estimate('4954.95', 10)).toMatchObject({
      total: '4954.95',
      perEditRounded: '495.00',
    })
    expect(estimate('4954.99', 10)?.perEditRounded).toBe('495.00')
    expect(estimate('4955.00', 10)?.perEditRounded).toBe('496.00')
    // A quotient without an end: a third of a ruble under the half.
    expect(estimate('1486.49', 3)?.perEditRounded).toBe('495.00')
  })

  it('is rounded half up whatever the global Decimal settings are', () => {
    const previous = { precision: Decimal.precision, rounding: Decimal.rounding }
    try {
      Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN })
      expect(estimate('25721.00', 2)?.perEditRounded).toBe('12861.00')
    } finally {
      Decimal.set(previous)
    }
  })
})

describe('words for counts', () => {
  it.each([
    [1, 'правка'],
    [2, 'правки'],
    [5, 'правок'],
    [11, 'правок'],
    [21, 'правка'],
    [30, 'правок'],
    [112, 'правок'],
    [122, 'правки'],
  ])('declines the edits of %i', (count, word) => {
    expect(pluralEdits(count)).toBe(word)
  })

  it.each([
    [1, 10, '1 дополнительный пакет по 10 правок'],
    [2, 10, '2 дополнительных пакета по 10 правок'],
    [4, 10, '4 дополнительных пакета по 10 правок'],
    [5, 10, '5 дополнительных пакетов по 10 правок'],
    [11, 10, '11 дополнительных пакетов по 10 правок'],
    [14, 10, '14 дополнительных пакетов по 10 правок'],
    [21, 10, '21 дополнительный пакет по 10 правок'],
    [22, 10, '22 дополнительных пакета по 10 правок'],
    [27, 10, '27 дополнительных пакетов по 10 правок'],
    [3, 1, '3 дополнительных пакета по 1 правке'],
    [3, 2, '3 дополнительных пакета по 2 правки'],
    [3, 21, '3 дополнительных пакета по 21 правке'],
  ])('names %i packs of %i edits', (packs, packEdits, words) => {
    expect(packsInWords(packs, packEdits)).toBe(words)
  })
})
