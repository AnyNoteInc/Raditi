import { describe, expect, it } from 'vitest'
import * as domain from '../index.ts'
import * as numbers from './credit-numbers.ts'
import {
  attemptReserveCredits,
  averageTaskCount,
  averageTaskCredits,
  giftTaskCounts,
  minStartCredits,
  signupGiftCredits,
  typicalTaskCredits,
} from './credit-numbers.ts'

const badRequest = expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' })

describe('the numbers of the credits model', () => {
  it('are the defaults of the design, each written once', () => {
    expect(averageTaskCredits).toBe(11)
    expect(typicalTaskCredits).toEqual({
      small: { from: 5, to: 5 },
      block: { from: 15, to: 25 },
      large: { from: 25, to: 40 },
    })
    // Only credits bound a task (owner's decision of 10.11.2026, КР5–КР8): one credit starts it
    // and is its reserve.
    expect(attemptReserveCredits).toBe(1)
    expect(signupGiftCredits).toBe(50)
    expect(minStartCredits).toBe(1)
  })

  // 17.10.2026 the daily limit became one of tariff credits: without a tariff there is no day,
  // and the gift is the bound.
  it('have no count of tasks a day, with or without a tariff', () => {
    expect(Object.keys(numbers).filter((name) => /PerDay|Day/i.test(name))).toEqual([])
  })

  it('cannot be changed by a page that prints them', () => {
    expect(Object.isFrozen(typicalTaskCredits)).toBe(true)
    for (const range of Object.values(typicalTaskCredits)) expect(Object.isFrozen(range)).toBe(true)
  })

  it('reach the rest of the code through the package, under the same names', () => {
    for (const [name, value] of Object.entries(numbers)) {
      expect(Reflect.get(domain, name), name).toBe(value)
    }
  })

  it('agree with each other', () => {
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
    // The gift is a whole number of credits that holds about five average tasks and every task
    // of the list at least once (plan 63, Ц5).
    expect(Number.isSafeInteger(signupGiftCredits)).toBe(true)
    expect(averageTaskCount(signupGiftCredits)).toBe(5)
    expect(signupGiftCredits).toBeGreaterThanOrEqual(typicalTaskCredits.large.to)
    // A reserve is what a task needs to start: no more.
    expect(attemptReserveCredits).toBe(minStartCredits)
    // The gift starts a task.
    expect(signupGiftCredits).toBeGreaterThanOrEqual(minStartCredits)
  })
})

describe('averageTaskCount', () => {
  it.each([
    // The tariffs, the pack and the gift of 06.11.2026 (plan 63).
    [150, 14],
    [600, 55],
    [2000, 180],
    [100, 9],
    [50, 5],
    // The tariffs and the gift before them.
    [300, 27],
    [800, 73],
    [2500, 230],
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
  it('finds in the gift of the registration ten small edits or three to five larger tasks', () => {
    expect(giftTaskCounts(signupGiftCredits)).toEqual({ small: 10, larger: { from: 3, to: 5 } })
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
    [50, 10, 3, 5],
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
