import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'

import { formatRubles, recommendPlan, type LandingPricingData } from './pricing-calculator'

const pricing: LandingPricingData = {
  plans: [
    {
      slug: 'start',
      name: 'Старт',
      price: '4900.00',
      editsPerMonth: 30,
      editsPerDay: 5,
      maxSites: 1,
    },
    {
      slug: 'business',
      name: 'Бизнес',
      price: '12900.00',
      editsPerMonth: 80,
      editsPerDay: 10,
      maxSites: 3,
    },
    {
      slug: 'agency',
      name: 'Агентство',
      price: '39900.00',
      editsPerMonth: 250,
      editsPerDay: 30,
      maxSites: 15,
    },
  ],
  pack: { price: '1990.00', edits: 10 },
}

describe('landing plan recommendation', () => {
  it('keeps the truly cheapest option when a larger plan costs less than 5% more', () => {
    expect(recommendPlan(pricing, 70)).toMatchObject({
      plan: { slug: 'start' },
      packs: 4,
      total: '12860.00',
      perEdit: '183.71',
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

  it('preserves kopecks with decimal arithmetic and rounds the per-edit estimate half up', () => {
    const first = pricing.plans[0]!
    const fractional = {
      plans: [{ ...first, price: '0.10', editsPerMonth: 1 }],
      pack: { price: '0.20', edits: 1 },
    }
    expect(recommendPlan(fractional, 2)).toMatchObject({ total: '0.30', perEdit: '0.15' })
    expect(recommendPlan({ plans: [{ ...first, price: '1.01' }], pack: null }, 2)).toMatchObject({
      perEdit: '0.51',
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

describe('monetary display', () => {
  it('groups rubles and preserves kopecks without floating point conversion', () => {
    expect(formatRubles('12900.00')).toBe('12\u00a0900')
    expect(formatRubles('12860.10')).toBe('12\u00a0860,10')
    expect(formatRubles('0.30')).toBe('0,30')
  })
})
