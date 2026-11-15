import { typicalTaskCredits } from '@repo/domain/billing/credit-numbers'
import { describe, expect, it } from 'vitest'

import {
  creditsOf,
  planInWords,
  pluralCredits,
  tasksOf,
  typicalCreditsInWords,
} from './pricing-data'

// The words the plan cards of the landing say: credits, the tasks they are about enough for, a
// day's limit where a plan sets one, what a kind of request usually costs.
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

  // The plan card says «около 27 задач», «около 21 задачи».
  it.each([
    [1, 'задачи'],
    [2, 'задач'],
    [4, 'задач'],
    [5, 'задач'],
    [11, 'задач'],
    [21, 'задачи'],
    [22, 'задач'],
    [27, 'задач'],
    [101, 'задачи'],
    [112, 'задач'],
  ])('declines the tasks of %i after «около»', (count, word) => {
    expect(tasksOf(count)).toBe(word)
  })

  it.each([
    // The tariffs of 13.11.2026: no daily limit.
    [200, null, 'кредитов в месяц — в среднем около 18 задач'],
    [1000, null, 'кредитов в месяц — в среднем около 91 задачи'],
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
