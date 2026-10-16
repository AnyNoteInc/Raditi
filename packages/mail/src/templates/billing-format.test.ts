import { minStartCredits } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  formatCount,
  formatMoscowDate,
  formatRubles,
  giftIsEnoughFor,
  giftTakesTasks,
  moscowDaysUntil,
  plansUrl,
  plural,
  tasksWithoutTariff,
} from './billing-format.ts'

describe('formatRubles', () => {
  it.each([
    ['0.00', '0\u00a0₽'],
    ['990.00', '990\u00a0₽'],
    ['1990.00', '1\u00a0990\u00a0₽'],
    ['12900.00', '12\u00a0900\u00a0₽'],
    ['1990.50', '1\u00a0990,50\u00a0₽'],
    ['0.05', '0,05\u00a0₽'],
    ['1234567.89', '1\u00a0234\u00a0567,89\u00a0₽'],
  ])('shows %s as %j', (amount, shown) => {
    expect(formatRubles(amount)).toBe(shown)
  })

  it('shows the widest Decimal(12,2) amount', () => {
    expect(formatRubles('9999999999.99')).toBe('9\u00a0999\u00a0999\u00a0999,99\u00a0₽')
  })

  it('works on the digits and never through a floating point number', () => {
    // 2^53 + 1 with kopecks: Number() would give 9007199254740992.00.
    expect(formatRubles('9007199254740993.01')).toBe(
      '9\u00a0007\u00a0199\u00a0254\u00a0740\u00a0993,01\u00a0₽',
    )
  })
})

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [100, '100'],
    [800, '800'],
    [999, '999'],
    [1000, '1\u00a0000'],
    [2500, '2\u00a0500'],
    [12345, '12\u00a0345'],
    [1234567, '1\u00a0234\u00a0567'],
  ])('shows %i as %j', (count, shown) => {
    expect(formatCount(count)).toBe(shown)
  })
})

describe('formatMoscowDate', () => {
  it.each([
    ['2026-10-18T09:30:00.000Z', '18\u00a0октября 2026'],
    ['2026-05-03T12:00:00+03:00', '3\u00a0мая 2026'],
    ['2027-01-01T00:00:00.000+03:00', '1\u00a0января 2027'],
  ])('shows %s as %j', (iso, shown) => {
    expect(formatMoscowDate(iso)).toBe(shown)
  })

  it('takes the day in Moscow, not in UTC', () => {
    // 00:30 on 1 November in Moscow is still 31 October in UTC.
    expect(formatMoscowDate('2026-10-31T21:30:00.000Z')).toBe('1\u00a0ноября 2026')
    expect(formatMoscowDate('2026-10-31T20:59:59.000Z')).toBe('31\u00a0октября 2026')
  })
})

describe('moscowDaysUntil', () => {
  const chargeAt = '2026-10-18T09:30:00.000Z' // 12:30 in Moscow

  it.each([
    ['three days before, earlier in the day', '2026-10-15T05:00:00.000Z', 3],
    ['three days before, later in the day', '2026-10-15T20:00:00.000Z', 3],
    ['the day before', '2026-10-17T09:30:00.000Z', 1],
    ['the same day', '2026-10-18T05:00:00.000Z', 0],
    ['the day after', '2026-10-19T05:00:00.000Z', -1],
  ])('counts calendar days: %s', (_case, now, days) => {
    expect(moscowDaysUntil(chargeAt, new Date(now))).toBe(days)
  })

  it('changes the day at midnight in Moscow', () => {
    // 23:50 on 14 October and 00:10 on 15 October in Moscow.
    expect(moscowDaysUntil(chargeAt, new Date('2026-10-14T20:50:00.000Z'))).toBe(4)
    expect(moscowDaysUntil(chargeAt, new Date('2026-10-14T21:10:00.000Z'))).toBe(3)
  })

  it('counts across months and years', () => {
    expect(moscowDaysUntil('2027-01-02T09:00:00.000Z', new Date('2026-12-30T09:00:00.000Z'))).toBe(
      3,
    )
    expect(moscowDaysUntil('2028-03-01T09:00:00.000Z', new Date('2028-02-28T09:00:00.000Z'))).toBe(
      2,
    )
  })
})

describe('plural', () => {
  it.each([
    [1, 'день'],
    [2, 'дня'],
    [4, 'дня'],
    [5, 'дней'],
    [11, 'дней'],
    [14, 'дней'],
    [21, 'день'],
    [22, 'дня'],
    [100, 'дней'],
    [111, 'дней'],
  ])('picks the form for %i', (count, form) => {
    expect(plural(count, 'день', 'дня', 'дней')).toBe(form)
  })
})

describe('plansUrl', () => {
  it.each([
    ['https://raditi.ru', 'https://raditi.ru/settings/plans'],
    ['https://raditi.ru/', 'https://raditi.ru/settings/plans'],
    ['http://localhost:3000', 'http://localhost:3000/settings/plans'],
  ])('puts the page under %s', (appUrl, url) => {
    expect(plansUrl(appUrl)).toBe(url)
  })

  it('keeps only the origin of the app address', () => {
    expect(plansUrl('https://raditi.ru/app?from=mail#top')).toBe('https://raditi.ru/settings/plans')
  })
})

describe('giftIsEnoughFor', () => {
  it('says what the gift of the registration is enough for', () => {
    expect(giftIsEnoughFor(35)).toBe('на семь небольших правок или на две-три задачи побольше')
  })

  it.each([
    // Not enough for one small edit: nothing is promised.
    [0, null],
    [4, null],
    // Small edits only, while the credits hold no block.
    [5, 'на одну небольшую правку'],
    [10, 'на две небольшие правки'],
    [14, 'на две небольшие правки'],
    // One number when the two counts of larger tasks agree, a range when they differ.
    [15, 'на три небольшие правки или на одну задачу побольше'],
    [20, 'на четыре небольшие правки или на одну-две задачи побольше'],
    [25, 'на пять небольших правок или на одну-две задачи побольше'],
    [30, 'на шесть небольших правок или на две-три задачи побольше'],
    [50, 'на десять небольших правок или на три-пять задач побольше'],
    // Above ten the count is written in digits, and the noun still agrees with it.
    [55, 'на 11 небольших правок или на три-пять задач побольше'],
    [105, 'на 21 небольшую правку или на семь-десять задач побольше'],
    [300, 'на 60 небольших правок или на 20-27 задач побольше'],
  ])('says for %i credits: %s', (credits, text) => {
    expect(giftIsEnoughFor(credits)).toBe(text)
  })
})

describe('giftTakesTasks', () => {
  it('follows the number of credits a new task needs to start', () => {
    expect(minStartCredits).toBe(5)
    expect(giftTakesTasks(minStartCredits)).toBe(true)
    expect(giftTakesTasks(minStartCredits - 1)).toBe(false)
  })

  it.each([
    [0, false],
    [1, false],
    [4, false],
    [5, true],
    [35, true],
    [300, true],
  ])('says of %i gift credits: %s', (credits, takes) => {
    expect(giftTakesTasks(credits)).toBe(takes)
  })
})

describe('tasksWithoutTariff', () => {
  it.each([5, 35])('says that tasks are taken on the gift while %i credits are left', (credits) => {
    expect(tasksWithoutTariff(credits, 'не принимаются')).toBe(
      'принимаются, только пока есть подарочные кредиты',
    )
  })

  it.each([0, 4])('keeps the refusal of the letter while %i credits are left', (credits) => {
    expect(tasksWithoutTariff(credits, 'не принимаются')).toBe('не принимаются')
    expect(tasksWithoutTariff(credits, 'сейчас не принимаются')).toBe('сейчас не принимаются')
  })
})
