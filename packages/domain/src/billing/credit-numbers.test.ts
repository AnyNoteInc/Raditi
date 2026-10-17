import { describe, expect, it } from 'vitest'
import * as domain from '../index.ts'
import { modelClasses, quotaAttemptCeilingsRub } from '../llm/model-class.ts'
import { Money } from '../money.ts'
import * as numbers from './credit-numbers.ts'
import {
  attemptStepCredits,
  averageTaskCount,
  averageTaskCredits,
  giftTaskCounts,
  minStartCredits,
  minTaskChargeCredits,
  signupGiftCredits,
  typicalTaskCredits,
} from './credit-numbers.ts'

const badRequest = expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' })

describe('the numbers of the credits model', () => {
  it('are the defaults of the design, each written once', () => {
    expect(minTaskChargeCredits).toBe(5)
    expect(averageTaskCredits).toBe(11)
    expect(typicalTaskCredits).toEqual({
      small: { from: 5, to: 5 },
      block: { from: 15, to: 25 },
      large: { from: 25, to: 40 },
    })
    expect(attemptStepCredits).toEqual({ light: 20, standard: 45, heavy: 120 })
    expect(signupGiftCredits).toBe(35)
    expect(minStartCredits).toBe(5)
  })

  // 17.10.2026 the daily limit became one of tariff credits: without a tariff there is no day,
  // and the gift is the bound.
  it('have no count of tasks a day, with or without a tariff', () => {
    expect(Object.keys(numbers).filter((name) => /PerDay|Day/i.test(name))).toEqual([])
  })

  it('cannot be changed by a page that prints them', () => {
    expect(Object.isFrozen(typicalTaskCredits)).toBe(true)
    for (const range of Object.values(typicalTaskCredits)) expect(Object.isFrozen(range)).toBe(true)
    expect(Object.isFrozen(attemptStepCredits)).toBe(true)
  })

  it('reach the rest of the code through the package, under the same names', () => {
    for (const [name, value] of Object.entries(numbers)) {
      expect(Reflect.get(domain, name), name).toBe(value)
    }
  })

  it('agree with each other', () => {
    // A small edit costs the minimum: its tokens are worth less.
    expect(typicalTaskCredits.small.from).toBe(minTaskChargeCredits)
    // The list goes from the smallest request to the largest, each as a range of whole credits.
    const ranges = [typicalTaskCredits.small, typicalTaskCredits.block, typicalTaskCredits.large]
    for (const [index, range] of ranges.entries()) {
      expect(Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to)).toBe(true)
      expect(range.from).toBeLessThanOrEqual(range.to)
      const previous = ranges[index - 1]
      if (previous) expect(range.from).toBeGreaterThanOrEqual(previous.to)
    }
    // No kind of task costs the average: it lies between a small edit and a block.
    expect(averageTaskCredits).toBeGreaterThan(typicalTaskCredits.small.to)
    expect(averageTaskCredits).toBeLessThan(typicalTaskCredits.block.from)
    // One attempt of a new task — the standard class — holds every task of the list.
    expect(attemptStepCredits.standard).toBeGreaterThanOrEqual(typicalTaskCredits.large.to)
    // A step is never below what a task must have to be charged at all.
    for (const modelClass of modelClasses) {
      expect(attemptStepCredits[modelClass]).toBeGreaterThanOrEqual(minTaskChargeCredits)
    }
    expect(Object.keys(attemptStepCredits)).toEqual([...modelClasses])
    expect(attemptStepCredits.light).toBeLessThan(attemptStepCredits.standard)
    expect(attemptStepCredits.standard).toBeLessThan(attemptStepCredits.heavy)
    // The gift is a whole number of credits that holds about three average tasks and every
    // task of the list at least once; one attempt of a new task sets the whole of it aside.
    expect(Number.isSafeInteger(signupGiftCredits)).toBe(true)
    expect(averageTaskCount(signupGiftCredits)).toBe(3)
    expect(signupGiftCredits).toBeGreaterThanOrEqual(typicalTaskCredits.large.from)
    expect(signupGiftCredits).toBeLessThan(attemptStepCredits.standard)
    // A task starts on what a done task is charged at least: it can always be charged.
    expect(minStartCredits).toBe(minTaskChargeCredits)
    // The gift starts a task.
    expect(signupGiftCredits).toBeGreaterThanOrEqual(minStartCredits)
  })

  // 6.00 RUB of accounting cost in a credit is the provisional rate of the design; the table of
  // rates arrives later. The steps were chosen to stay inside the ceilings of an attempt at it.
  it('keeps every step inside the rouble ceiling of an attempt at the provisional rate', () => {
    for (const modelClass of modelClasses) {
      const stepRub = new Money(attemptStepCredits[modelClass]).times('6.00')
      expect(stepRub.lte(quotaAttemptCeilingsRub[modelClass]), modelClass).toBe(true)
    }
    expect(new Money(attemptStepCredits.standard).times('6.00').toFixed(2)).toBe('270.00')
  })
})

describe('averageTaskCount', () => {
  it.each([
    // The tariffs, the pack and the gift of the design.
    [300, 27],
    [800, 73],
    [2500, 230],
    [100, 9],
    [35, 3],
    // Half a task rounds up; just under a half does not.
    [0, 0],
    [5, 0],
    [6, 1],
    [11, 1],
    [16, 1],
    [17, 2],
    [1083, 98],
    // 99.5 tasks are a hundred, and from a hundred up the count is a round ten.
    [1094, 99],
    [1095, 100],
    [1100, 100],
    [1154, 100],
    // 105 tasks exactly: half a ten rounds up.
    [1155, 110],
    // 104.6 tasks are «около 100», not 105 rounded once more to 110.
    [1151, 100],
    [2475, 230],
    [2585, 240],
    [11000, 1000],
  ])('finds in %i credits about %i average tasks', (credits, tasks) => {
    expect(averageTaskCount(credits)).toBe(tasks)
  })

  it('never promises more tasks for fewer credits', () => {
    let previous = 0
    for (let credits = 0; credits <= 5000; credits++) {
      const tasks = averageTaskCount(credits)
      expect(tasks).toBeGreaterThanOrEqual(previous)
      previous = tasks
    }
  })

  it.each([-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses %s as a count of credits',
    (credits) => {
      expect(() => averageTaskCount(credits)).toThrow(badRequest)
    },
  )
})

describe('giftTaskCounts', () => {
  it('finds in the gift of the registration seven small edits or two to three larger tasks', () => {
    expect(giftTaskCounts(signupGiftCredits)).toEqual({ small: 7, larger: { from: 2, to: 3 } })
  })

  it.each([
    // Nothing starts below the charge of a small edit.
    [0, 0, 0, 0],
    [4, 0, 0, 0],
    [5, 1, 0, 0],
    // Six credits round to one average task, and hold no block.
    [6, 1, 0, 1],
    [14, 2, 0, 1],
    // A block at the bottom of its range.
    [15, 3, 1, 1],
    [17, 3, 1, 2],
    [29, 5, 1, 3],
    [30, 6, 2, 3],
    [34, 6, 2, 3],
    [45, 9, 3, 4],
    [100, 20, 6, 9],
  ])('finds in %i credits %i small edits and %i to %i larger tasks', (credits, small, from, to) => {
    expect(giftTaskCounts(credits)).toEqual({ small, larger: { from, to } })
  })

  it('counts by the numbers of the orientation list and of the average task', () => {
    for (let credits = 0; credits <= 3000; credits++) {
      const { small, larger } = giftTaskCounts(credits)
      expect(small).toBe(Math.floor(credits / typicalTaskCredits.small.to))
      expect(larger.from).toBe(Math.floor(credits / typicalTaskCredits.block.from))
      expect(larger.to).toBe(averageTaskCount(credits))
      // Never fewer average tasks than blocks, never more larger tasks than small edits.
      expect(larger.from).toBeLessThanOrEqual(larger.to)
      expect(larger.to).toBeLessThanOrEqual(Math.max(small, 1))
    }
  })

  it.each([-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses %s as a count of credits',
    (credits) => {
      expect(() => giftTaskCounts(credits)).toThrow(badRequest)
    },
  )
})
