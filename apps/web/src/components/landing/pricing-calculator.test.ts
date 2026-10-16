import { averageTaskCredits, typicalTaskCredits } from '@repo/domain/billing/credit-numbers'
import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'

import {
  creditsForTasks,
  packsInWords,
  planInWords,
  pluralCredits,
  pluralTasks,
  recommendPlan,
  tasksAt,
  tasksOf,
  typicalCreditsInWords,
} from './pricing-calculator'
import { pricing } from './testing'

// The slider counts tasks; a tariff is sold in credits. The tariffs of the fixture give 300, 800
// and 2 500 credits a month, the pack 100, and a task is counted at the average charge of 11.
describe('the credits a number of tasks needs', () => {
  it('counts every task at the average charge of the credits model', () => {
    expect(averageTaskCredits).toBe(11)
    expect(creditsForTasks(1)).toBe(averageTaskCredits)
    expect(creditsForTasks(27)).toBe(297)
    expect(creditsForTasks(300)).toBe(3300)
  })
})

describe('landing plan recommendation', () => {
  it('keeps the truly cheapest option when a larger plan costs less than 5% more', () => {
    // 660 credits: «Старт» with four packs is 40 ₽ cheaper than «Бизнес».
    expect(recommendPlan(pricing, 60)).toMatchObject({
      plan: { slug: 'start' },
      packs: 4,
      total: '12860.00',
    })
  })

  it('charges for whole packs and switches to a cheaper quota plan at the boundary', () => {
    // 297 credits fit the 300 of «Старт»; 308 do not.
    expect(recommendPlan(pricing, 27)).toMatchObject({
      plan: { slug: 'start' },
      packs: 0,
      total: '4900.00',
    })
    expect(recommendPlan(pricing, 28)).toMatchObject({
      plan: { slug: 'start' },
      packs: 1,
      total: '6890.00',
    })
    expect(recommendPlan(pricing, 30)).toMatchObject({
      plan: { slug: 'start' },
      packs: 1,
      total: '6890.00',
    })
    expect(recommendPlan(pricing, 45)).toMatchObject({
      plan: { slug: 'start' },
      packs: 2,
      total: '8880.00',
    })
    // 704 credits: a fifth pack would make «Старт» dearer than «Бизнес».
    expect(recommendPlan(pricing, 64)).toMatchObject({
      plan: { slug: 'business' },
      packs: 0,
      total: '12900.00',
    })
    // 792 credits fit the 800 of «Бизнес»; 803 need a pack.
    expect(recommendPlan(pricing, 72)).toMatchObject({
      plan: { slug: 'business' },
      packs: 0,
      total: '12900.00',
    })
    expect(recommendPlan(pricing, 73)).toMatchObject({
      plan: { slug: 'business' },
      packs: 1,
      total: '14890.00',
    })
    // The end of the slider: 3 300 credits.
    expect(recommendPlan(pricing, 300)).toMatchObject({
      plan: { slug: 'agency' },
      packs: 8,
      total: '55820.00',
    })
  })

  it('does not promise free extra credits if packs are unavailable', () => {
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
      plans: [{ ...first, price: '0.10', creditsPerMonth: creditsForTasks(1) }],
      pack: { price: '0.20', credits: creditsForTasks(1) },
    }
    expect(recommendPlan(fractional, 2)).toMatchObject({ packs: 1, total: '0.30' })
    expect(recommendPlan({ plans: [{ ...first, price: '1.01' }], pack: null }, 2)).toMatchObject({
      total: '1.01',
    })
  })

  it('is independent of a changed global Decimal precision', () => {
    const previous = { precision: Decimal.precision, rounding: Decimal.rounding }
    try {
      Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN })
      expect(recommendPlan(pricing, 60)?.total).toBe('12860.00')
    } finally {
      Decimal.set(previous)
    }
  })

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid task count %s',
    (tasks) => {
      expect(recommendPlan(pricing, tasks)).toBeNull()
    },
  )
})

describe('estimate of one task', () => {
  /** The estimate for a plan of the given price that covers the tasks without a pack. */
  const estimate = (price: string, tasks: number) => {
    const plan = { ...pricing.plans[0]!, price, creditsPerMonth: creditsForTasks(tasks) }
    return recommendPlan({ plans: [plan], pack: null }, tasks)
  }

  it('is rounded half up to whole rubles, and the amounts of the calculation stay exact', () => {
    // The total is divided by the tasks asked for, not by the credits bought.
    expect(recommendPlan(pricing, 27)).toMatchObject({
      total: '4900.00',
      perTaskRounded: '181.00',
    })
    expect(recommendPlan(pricing, 30)).toMatchObject({
      total: '6890.00',
      perTaskRounded: '230.00',
    })
    expect(recommendPlan(pricing, 45)).toMatchObject({
      total: '8880.00',
      perTaskRounded: '197.00',
    })
    expect(recommendPlan(pricing, 72)).toMatchObject({
      total: '12900.00',
      perTaskRounded: '179.00',
    })
    expect(recommendPlan(pricing, 60)).toMatchObject({ perTaskRounded: '214.00' })
    expect(estimate('347.00', 2)?.perTaskRounded).toBe('174.00')
    expect(estimate('346.98', 2)?.perTaskRounded).toBe('173.00')
    expect(estimate('1.00', 2)?.perTaskRounded).toBe('1.00')
    expect(estimate('2599.00', 2)?.perTaskRounded).toBe('1300.00')
  })

  // 495.495 is 495.50 in kopecks; rounded once more, that would be 496.
  it('is rounded once, from the exact quotient and not from the kopecks', () => {
    expect(estimate('4954.95', 10)).toMatchObject({
      total: '4954.95',
      perTaskRounded: '495.00',
    })
    expect(estimate('4954.99', 10)?.perTaskRounded).toBe('495.00')
    expect(estimate('4955.00', 10)?.perTaskRounded).toBe('496.00')
    // A quotient without an end: a third of a ruble under the half.
    expect(estimate('1486.49', 3)?.perTaskRounded).toBe('495.00')
  })

  it('is rounded half up whatever the global Decimal settings are', () => {
    const previous = { precision: Decimal.precision, rounding: Decimal.rounding }
    try {
      Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN })
      expect(estimate('25721.00', 2)?.perTaskRounded).toBe('12861.00')
    } finally {
      Decimal.set(previous)
    }
  })
})

describe('words for counts', () => {
  it.each([
    [1, 'кредит'],
    [2, 'кредита'],
    [5, 'кредитов'],
    [11, 'кредитов'],
    [21, 'кредит'],
    [22, 'кредита'],
    [25, 'кредитов'],
    [30, 'кредитов'],
    [101, 'кредит'],
    [112, 'кредитов'],
    [122, 'кредита'],
  ])('declines the credits of %i', (count, word) => {
    expect(pluralCredits(count)).toBe(word)
  })

  // The slider says «30 задач в месяц»; the plan card «около 27 задач», «не больше 5 задач»; the
  // estimate «при 45 задачах».
  it.each([
    [1, 'задача', 'задачи', 'задаче'],
    [2, 'задачи', 'задач', 'задачах'],
    [4, 'задачи', 'задач', 'задачах'],
    [5, 'задач', 'задач', 'задачах'],
    [10, 'задач', 'задач', 'задачах'],
    [11, 'задач', 'задач', 'задачах'],
    [14, 'задач', 'задач', 'задачах'],
    [21, 'задача', 'задачи', 'задаче'],
    [22, 'задачи', 'задач', 'задачах'],
    [27, 'задач', 'задач', 'задачах'],
    [30, 'задач', 'задач', 'задачах'],
    [101, 'задача', 'задачи', 'задаче'],
    [112, 'задач', 'задач', 'задачах'],
    [300, 'задач', 'задач', 'задачах'],
  ])('declines the tasks of %i', (count, counted, after, at) => {
    expect(pluralTasks(count)).toBe(counted)
    expect(tasksOf(count)).toBe(after)
    expect(tasksAt(count)).toBe(at)
  })

  it.each([
    [300, 5, 'кредитов в месяц — в среднем около 27 задач, не больше 5 задач в день'],
    [800, 10, 'кредитов в месяц — в среднем около 73 задач, не больше 10 задач в день'],
    [2500, 30, 'кредитов в месяц — в среднем около 230 задач, не больше 30 задач в день'],
    [231, 1, 'кредит в месяц — в среднем около 21 задачи, не больше 1 задачи в день'],
    [22000, 21, 'кредитов в месяц — в среднем около 2 000 задач, не больше 21 задачи в день'],
    // Credits that hold no average task promise none.
    [5, 2, 'кредитов в месяц, не больше 2 задач в день'],
  ])('says what a tariff of %i credits and %i tasks a day gives', (credits, perDay, words) => {
    expect(planInWords(credits, perDay)).toBe(words)
  })

  it.each([
    [1, 100, '1 дополнительный пакет по 100 кредитов'],
    [2, 100, '2 дополнительных пакета по 100 кредитов'],
    [4, 100, '4 дополнительных пакета по 100 кредитов'],
    [5, 100, '5 дополнительных пакетов по 100 кредитов'],
    [11, 100, '11 дополнительных пакетов по 100 кредитов'],
    [14, 100, '14 дополнительных пакетов по 100 кредитов'],
    [21, 100, '21 дополнительный пакет по 100 кредитов'],
    [22, 100, '22 дополнительных пакета по 100 кредитов'],
    [27, 100, '27 дополнительных пакетов по 100 кредитов'],
    [3, 10, '3 дополнительных пакета по 10 кредитов'],
    // A count of four digits is grouped, with a plain space.
    [2, 1000, '2 дополнительных пакета по 1 000 кредитов'],
    // After «по» the count of one takes the dative: «по 1 кредиту», «по 21 кредиту».
    [3, 1, '3 дополнительных пакета по 1 кредиту'],
    [3, 2, '3 дополнительных пакета по 2 кредита'],
    [3, 5, '3 дополнительных пакета по 5 кредитов'],
    [3, 11, '3 дополнительных пакета по 11 кредитов'],
    [3, 21, '3 дополнительных пакета по 21 кредиту'],
    [3, 22, '3 дополнительных пакета по 22 кредита'],
    [3, 25, '3 дополнительных пакета по 25 кредитов'],
    [3, 101, '3 дополнительных пакета по 101 кредиту'],
  ])('names %i packs of %i credits', (packs, packCredits, words) => {
    expect(packsInWords(packs, packCredits)).toBe(words)
  })

  it('says what a kind of request usually costs: one figure or a range, with the word or without', () => {
    // The two rows of the orientation list that the landing names.
    expect(typicalCreditsInWords(typicalTaskCredits.small)).toBe('5 кредитов')
    expect(typicalCreditsInWords(typicalTaskCredits.block)).toBe('15–25 кредитов')
    expect(typicalCreditsInWords(typicalTaskCredits.block, false)).toBe('15–25')
    expect(typicalCreditsInWords(typicalTaskCredits.small, false)).toBe('5')
    // The word follows the last figure of a range, not the first.
    expect(typicalCreditsInWords({ from: 1, to: 1 })).toBe('1 кредит')
    expect(typicalCreditsInWords({ from: 1, to: 5 })).toBe('1–5 кредитов')
    expect(typicalCreditsInWords({ from: 2, to: 4 })).toBe('2–4 кредита')
    expect(typicalCreditsInWords({ from: 5, to: 8 })).toBe('5–8 кредитов')
  })
})
