import { averageTaskCredits, typicalTaskCredits } from '@repo/domain/billing/credit-numbers'
import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'

import {
  creditsForTasks,
  creditsOf,
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

// The slider counts tasks; a tariff is sold in credits. The tariffs of the fixture — the terms
// of 06.11.2026 — give 150, 600 and 2 000 credits a month for 1 990, 6 990 and 19 990 ₽, the pack
// 100 for 1 490 ₽, and a task is counted at the average charge of 11.
describe('the credits a number of tasks needs', () => {
  it('counts every task at the average charge of the credits model', () => {
    expect(averageTaskCredits).toBe(11)
    expect(creditsForTasks(1)).toBe(averageTaskCredits)
    expect(creditsForTasks(27)).toBe(297)
    expect(creditsForTasks(300)).toBe(3300)
  })
})

describe('landing plan recommendation', () => {
  it('keeps the truly cheapest option when a larger plan costs only a little more', () => {
    // 440 credits: «Старт» with three packs is 530 ₽ cheaper than «Бизнес».
    expect(recommendPlan(pricing, 40)).toMatchObject({
      plan: { slug: 'start' },
      packs: 3,
      total: '6460.00',
    })
    // 1 397 credits: «Бизнес» with eight packs is 1 080 ₽ cheaper than «Агентство».
    expect(recommendPlan(pricing, 127)).toMatchObject({
      plan: { slug: 'business' },
      packs: 8,
      total: '18910.00',
    })
  })

  it('charges for whole packs and switches to a cheaper quota plan at the boundary', () => {
    // 143 credits fit the 150 of «Старт»; 154 do not.
    expect(recommendPlan(pricing, 13)).toMatchObject({
      plan: { slug: 'start' },
      packs: 0,
      total: '1990.00',
    })
    expect(recommendPlan(pricing, 14)).toMatchObject({
      plan: { slug: 'start' },
      packs: 1,
      total: '3480.00',
    })
    // Where the slider starts.
    expect(recommendPlan(pricing, 30)).toMatchObject({
      plan: { slug: 'start' },
      packs: 2,
      total: '4970.00',
    })
    // 451 credits: a fourth pack would make «Старт» dearer than «Бизнес».
    expect(recommendPlan(pricing, 41)).toMatchObject({
      plan: { slug: 'business' },
      packs: 0,
      total: '6990.00',
    })
    // 594 credits fit the 600 of «Бизнес»; 605 need a pack.
    expect(recommendPlan(pricing, 54)).toMatchObject({
      plan: { slug: 'business' },
      packs: 0,
      total: '6990.00',
    })
    expect(recommendPlan(pricing, 55)).toMatchObject({
      plan: { slug: 'business' },
      packs: 1,
      total: '8480.00',
    })
    // 1 408 credits: a ninth pack would make «Бизнес» dearer than «Агентство».
    expect(recommendPlan(pricing, 128)).toMatchObject({
      plan: { slug: 'agency' },
      packs: 0,
      total: '19990.00',
    })
    // 1 991 credits fit the 2 000 of «Агентство»; 2 002 need a pack.
    expect(recommendPlan(pricing, 181)).toMatchObject({
      plan: { slug: 'agency' },
      packs: 0,
      total: '19990.00',
    })
    expect(recommendPlan(pricing, 182)).toMatchObject({
      plan: { slug: 'agency' },
      packs: 1,
      total: '21480.00',
    })
    // The end of the slider: 3 300 credits.
    expect(recommendPlan(pricing, 300)).toMatchObject({
      plan: { slug: 'agency' },
      packs: 13,
      total: '39360.00',
    })
  })

  it('does not promise free extra credits if packs are unavailable', () => {
    const withoutPacks = { ...pricing, pack: null }
    expect(recommendPlan(withoutPacks, 35)).toMatchObject({
      plan: { slug: 'business' },
      packs: 0,
      total: '6990.00',
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
      expect(recommendPlan(pricing, 40)?.total).toBe('6460.00')
      expect(recommendPlan(pricing, 40)?.smallEditRounded).toBe('72.00')
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
    expect(recommendPlan(pricing, 13)).toMatchObject({
      total: '1990.00',
      perTaskRounded: '153.00',
    })
    expect(recommendPlan(pricing, 30)).toMatchObject({
      total: '4970.00',
      perTaskRounded: '166.00',
    })
    expect(recommendPlan(pricing, 40)).toMatchObject({
      total: '6460.00',
      perTaskRounded: '162.00',
    })
    expect(recommendPlan(pricing, 54)).toMatchObject({
      total: '6990.00',
      perTaskRounded: '129.00',
    })
    expect(recommendPlan(pricing, 127)).toMatchObject({ perTaskRounded: '149.00' })
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

describe('the price of a small edit in the result', () => {
  it('is that of the card while the plan alone covers the tasks', () => {
    // 1 990 ₽ for 150 credits, 6 990 ₽ for 600, 19 990 ₽ for 2 000: 66.33, 58.25, 49.975.
    expect(recommendPlan(pricing, 13)?.smallEditRounded).toBe('66.00')
    expect(recommendPlan(pricing, 54)?.smallEditRounded).toBe('58.00')
    expect(recommendPlan(pricing, 181)?.smallEditRounded).toBe('50.00')
  })

  it('counts the packs in: what is paid over the credits the plan and its packs give', () => {
    // 4 970 ₽ for 350 credits, 8 480 ₽ for 700, 39 360 ₽ for 3 300.
    expect(recommendPlan(pricing, 30)?.smallEditRounded).toBe('71.00')
    expect(recommendPlan(pricing, 55)?.smallEditRounded).toBe('61.00')
    expect(recommendPlan(pricing, 300)?.smallEditRounded).toBe('60.00')
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
    // The tariffs of 06.11.2026: no daily limit.
    [150, null, 'кредитов в месяц — в среднем около 14 задач'],
    [600, null, 'кредитов в месяц — в среднем около 55 задач'],
    [2000, null, 'кредитов в месяц — в среднем около 180 задач'],
    [5, null, 'кредитов в месяц'],
    // A tariff that sets a daily limit says it.
    [300, 50, 'кредитов в месяц — в среднем около 27 задач, до 50 кредитов в день'],
    [800, 100, 'кредитов в месяц — в среднем около 73 задач, до 100 кредитов в день'],
    [2500, 300, 'кредитов в месяц — в среднем около 230 задач, до 300 кредитов в день'],
    [231, 1, 'кредит в месяц — в среднем около 21 задачи, до 1 кредита в день'],
    [22000, 21, 'кредитов в месяц — в среднем около 2 000 задач, до 21 кредита в день'],
    [22000, 2500, 'кредитов в месяц — в среднем около 2 000 задач, до 2 500 кредитов в день'],
    // Credits that hold no average task promise none.
    [5, 2, 'кредитов в месяц, до 2 кредитов в день'],
  ])('says what a tariff of %i credits and %s credits a day gives', (credits, perDay, words) => {
    expect(planInWords(credits, perDay)).toBe(words)
  })

  it.each([
    [1, 'кредита'],
    [2, 'кредитов'],
    [5, 'кредитов'],
    [11, 'кредитов'],
    [21, 'кредита'],
    [50, 'кредитов'],
    [101, 'кредита'],
  ])('declines the credits of %i after «до»', (count, word) => {
    expect(creditsOf(count)).toBe(word)
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
