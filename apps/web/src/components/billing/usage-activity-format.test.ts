import { describe, expect, it } from 'vitest'

import type { UsageActivityDay } from './billing-types'
import {
  actionsSummary,
  creditsCount,
  creditsSummary,
  dayLabel,
  dayTicks,
  labelledDay,
  longDayLabel,
  scaleTicks,
  spanLabel,
} from './usage-activity-format'

const day = (
  date: string,
  actions: number,
  credits = { tariff: 0, gift: 0, pack: 0 },
): UsageActivityDay => ({ date, actions, credits })

describe('usage activity words', () => {
  it('names a day of Moscow by its date, whatever the zone of the browser', () => {
    expect(dayLabel('2026-11-09')).toBe('9 нояб.')
    expect(longDayLabel('2026-11-09')).toBe('пн, 9 ноября')
  })

  it('gives counts of credits and spans their words', () => {
    expect(creditsCount(1)).toBe('1 кредит')
    expect(creditsCount(3)).toBe('3 кредита')
    expect(creditsCount(1250)).toBe('1 250 кредитов')
    expect(spanLabel(7)).toBe('7 дней')
    expect(spanLabel(30)).toBe('30 дней')
  })

  it('draws a scale of round steps up to the largest value', () => {
    expect(scaleTicks(0)).toEqual([0, 1])
    expect(scaleTicks(2)).toEqual([0, 1, 2])
    expect(scaleTicks(14)).toEqual([0, 5, 10, 15])
    expect(scaleTicks(30)).toEqual([0, 10, 20, 30])
    expect(scaleTicks(170)).toEqual([0, 100, 200])
  })

  it('labels every day of a week and every seventh of a month, today always', () => {
    expect([0, 1, 6].map((index) => labelledDay(index, 7))).toEqual([true, true, true])
    expect(labelledDay(29, 30)).toBe(true)
    expect(labelledDay(22, 30)).toBe(true)
    expect(labelledDay(28, 30)).toBe(false)
  })

  it('names the month at the first label and where it changes', () => {
    expect(dayTicks(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])).toEqual([
      '30 окт.',
      '31',
      '1 нояб.',
      '2',
    ])
    const month = Array.from({ length: 30 }, (_, index) =>
      new Date(Date.UTC(2026, 9, 17 + index)).toISOString().slice(0, 10),
    )
    expect(dayTicks(month).filter(Boolean)).toEqual(['18 окт.', '25', '1 нояб.', '8', '15'])
  })

  it('says the charts in words', () => {
    const days = [day('2026-11-09', 2, { tariff: 9, gift: 3, pack: 1 }), day('2026-11-10', 5)]
    expect(actionsSummary(days)).toBe('За 2 дня — 7 действий, больше всего вт, 10 ноября: 5.')
    expect(actionsSummary([day('2026-11-09', 0)])).toBe('За 1 день — 0 действий.')
    expect(creditsSummary(days)).toBe(
      'За 2 дня списано 13 кредитов: по тарифу — 9, подарочные — 3, из пакета — 1.',
    )
  })
})
