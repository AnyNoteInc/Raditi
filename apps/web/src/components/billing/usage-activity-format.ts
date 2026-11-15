import { formatCount } from '@/lib/count'
import { plural } from '@/lib/plural'

import type { UsageActivityDay } from './billing-types'
import { creditsWord } from './plan-format'

// The words and the numbers of the charts of «Использование»: actions and charged credits day by day.

/** The spans the page offers, in days. */
export const ACTIVITY_SPANS = [7, 30] as const
export type ActivitySpan = (typeof ACTIVITY_SPANS)[number]

/** The accounts a day's credits came from, bottom up, in the order credits are spent. */
export const CREDIT_PARTS = ['tariff', 'gift', 'pack'] as const
export type CreditPart = (typeof CREDIT_PARTS)[number]

export const creditPartLabel: Record<CreditPart, string> = {
  tariff: 'По тарифу',
  gift: 'Подарочные',
  pack: 'Из пакета',
}

/** «7 дней», «30 дней»: the name of a span on its button. */
export const spanLabel = (days: number) => `${days} ${plural(days, 'день', 'дня', 'дней')}`

export const actionsWord = (count: number) => plural(count, 'действие', 'действия', 'действий')

const dayFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

const longDayFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  weekday: 'short',
  timeZone: 'UTC',
})

/** «9 нояб.»: a day of Moscow, `YYYY-MM-DD`, short. */
export const dayLabel = (date: string) => dayFormat.format(new Date(`${date}T00:00:00.000Z`))

/**
 * The labels under the columns: the number of the day, with its month at the first label and
 * wherever the month changes — «9 нояб.», «10», «11»; an empty string under a day without one.
 */
export function dayTicks(dates: readonly string[]): string[] {
  let month: string | null = null
  return dates.map((date, index) => {
    if (!labelledDay(index, dates.length)) return ''
    const current = date.slice(0, 7)
    const label = current === month ? String(Number(date.slice(8))) : dayLabel(date)
    month = current
    return label
  })
}

/** «пн, 9 ноября»: the day a hint is about. */
export const longDayLabel = (date: string) =>
  longDayFormat.format(new Date(`${date}T00:00:00.000Z`))

/** «12 кредитов»: a count of credits with its word. */
export const creditsCount = (count: number) => `${formatCount(count)} ${creditsWord(count)}`

export const dayCredits = (day: UsageActivityDay) =>
  day.credits.tariff + day.credits.gift + day.credits.pack

export const totalActions = (days: readonly UsageActivityDay[]) =>
  days.reduce((sum, day) => sum + day.actions, 0)

export const totalCredits = (days: readonly UsageActivityDay[]) =>
  days.reduce((sum, day) => sum + dayCredits(day), 0)

/**
 * The lines of the scale: 0 and up to three steps of 1, 2 or 5 times a power of ten, the top
 * one at or above the largest value. A chart of zeros still has a scale: 0 and 1.
 */
export function scaleTicks(max: number): number[] {
  if (max <= 0) return [0, 1]
  const raw = max / 3
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power
  // A step below 1 is not a count of anything: actions and credits are whole.
  const whole = Math.max(step, 1)
  const top = Math.ceil(max / whole) * whole
  return Array.from({ length: top / whole + 1 }, (_, index) => index * whole)
}

/**
 * Which days are labelled under the chart: every one of a week, every seventh of a month —
 * counted back from today, so that today always has its label.
 */
export const labelledDay = (index: number, count: number) =>
  count <= 7 || (count - 1 - index) % 7 === 0

/** What the chart of actions says in words, for assistive technology. */
export function actionsSummary(days: readonly UsageActivityDay[]): string {
  const total = totalActions(days)
  const busiest = days.reduce<UsageActivityDay | null>(
    (best, day) => (day.actions > (best?.actions ?? 0) ? day : best),
    null,
  )
  const head = `За ${spanLabel(days.length)} — ${formatCount(total)} ${actionsWord(total)}`
  return busiest === null
    ? `${head}.`
    : `${head}, больше всего ${longDayLabel(busiest.date)}: ${formatCount(busiest.actions)}.`
}

/** What the chart of credits says in words, for assistive technology. */
export function creditsSummary(days: readonly UsageActivityDay[]): string {
  const sum = (part: CreditPart) => days.reduce((total, day) => total + day.credits[part], 0)
  const parts = CREDIT_PARTS.map(
    (part) => `${creditPartLabel[part].toLowerCase()} — ${formatCount(sum(part))}`,
  ).join(', ')
  return `За ${spanLabel(days.length)} списано ${creditsCount(totalCredits(days))}: ${parts}.`
}

/** A year of days, as the grid of actions reads it. */
export const ACTIONS_YEAR = 365

/** The rows of the grid: Monday on top, as a Russian calendar has it. */
export const WEEKDAY_LABELS = ['пн', '', 'ср', '', 'пт', '', ''] as const

/** 0 — Monday … 6 — Sunday, of a day of Moscow `YYYY-MM-DD`. */
const weekdayOf = (date: string) => (new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7

/**
 * The days in weeks, oldest first: each week is seven cells, Monday first; a cell before the
 * first day or after the last one is null.
 */
export function weeksOf(days: readonly UsageActivityDay[]): (UsageActivityDay | null)[][] {
  const first = days[0]
  if (first === undefined) return []
  const cells: (UsageActivityDay | null)[] = [
    ...Array.from({ length: weekdayOf(first.date) }, () => null),
    ...days,
  ]
  while (cells.length % 7 !== 0) cells.push(null)
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7))
}

/** 0 — nothing that day; 1 to 4 — up to a quarter, a half, three quarters, all of the busiest. */
export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((4 * value) / max))) as 1 | 2 | 3 | 4
}

const monthFormat = new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone: 'UTC' })

/**
 * The months under the grid: a month is named under the week its first day falls in; a month
 * whose first day is not in the grid is not named.
 */
export function monthTicks(
  weeks: readonly (UsageActivityDay | null)[][],
): { week: number; label: string }[] {
  return weeks.flatMap((week, index) => {
    const first = week.find((day) => day?.date.endsWith('-01'))
    return first
      ? [{ week: index, label: monthFormat.format(new Date(`${first.date}T00:00:00.000Z`)) }]
      : []
  })
}
