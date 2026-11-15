import { badRequest } from '../errors.ts'

/**
 * The calendar of the scheduled tasks (docs/plan/82-scheduled-tasks.md, §4.1): dates and times
 * on the wall clock of a time zone, and the moments they are. The domain is built for the browser
 * too, where there is no `Temporal`: the wall clock of a zone is read by `Intl`, as `isPlanPeak`
 * does, and a wall clock becomes a moment by trying the offsets around it. Internal to the
 * schedule: the module exports nothing of the package.
 */

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS
/** Minutes of a day and of a week. */
export const DAY_MINUTES = 24 * 60
export const WEEK_MINUTES = 7 * DAY_MINUTES

/** A date of the calendar, without a zone: month 1–12, day 1–31. */
export interface CivilDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** A date and a time on a wall clock, to the minute. */
export interface WallClock extends CivilDate {
  readonly hour: number
  readonly minute: number
}

/** The days of the month: `Date.UTC` with day 0 is the last day of the month before. */
export const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate()

/** ISO weekday of a date: 1 — Monday … 7 — Sunday. */
export function isoWeekday(date: CivilDate): number {
  const sunday0 = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
  return sunday0 === 0 ? 7 : sunday0
}

/** The date `days` after (or before, when negative) a date. */
export function addDays(date: CivilDate, days: number): CivilDate {
  const at = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() }
}

/** A month after (or before) the month of a date, on its first day. */
export function addMonths(date: Pick<CivilDate, 'year' | 'month'>, months: number): CivilDate {
  const at = new Date(Date.UTC(date.year, date.month - 1 + months, 1))
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: 1 }
}

export const sameDate = (a: CivilDate, b: CivilDate): boolean =>
  a.year === b.year && a.month === b.month && a.day === b.day

/** `YYYY-MM-DD` → its date; the schemas have checked the form. */
export function parseCivilDate(text: string): CivilDate {
  const [year, month, day] = text.split('-').map(Number)
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 }
}

/** `HH:MM` → minutes since midnight; the schemas have checked the form. */
export function parseTime(text: string): number {
  const [hour, minute] = text.split(':').map(Number)
  return (hour ?? 0) * 60 + (minute ?? 0)
}

/** Minutes of a naive wall clock since 1970, as if it were UTC: the arithmetic of the wall. */
export const naiveMinutes = (date: CivilDate, minuteOfDay: number): number =>
  Date.UTC(date.year, date.month - 1, date.day) / MINUTE_MS + minuteOfDay

const formatters = new Map<string, Intl.DateTimeFormat>()

/** One formatter per zone: `Intl.DateTimeFormat` is costly to build. */
function formatterOf(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone)
  if (cached) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
  } catch {
    throw badRequest('Unknown time zone of a scheduled task')
  }
  formatters.set(timezone, formatter)
  return formatter
}

function finiteMs(at: Date | number): number {
  const ms = typeof at === 'number' ? at : at.getTime()
  if (!Number.isFinite(ms)) throw badRequest('Invalid moment of a scheduled task')
  return ms
}

/** The wall clock of a moment in a zone, with its seconds. */
function wallWithSeconds(ms: number, timezone: string): WallClock & { second: number } {
  const fields: Record<string, number> = {}
  for (const part of formatterOf(timezone).formatToParts(ms))
    if (part.type !== 'literal') fields[part.type] = Number(part.value)
  const { year, month, day, hour, minute, second } = fields
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  )
    throw badRequest('Invalid moment of a scheduled task')
  // Some engines still print midnight as 24 with h23.
  return { year, month, day, hour: hour % 24, minute, second }
}

/** The wall clock of a moment in a zone, to the minute. */
export function wallOf(at: Date | number, timezone: string): WallClock {
  const { second: _second, ...wall } = wallWithSeconds(finiteMs(at), timezone)
  return wall
}

/** How far the zone's wall clock is ahead of UTC at a moment, in ms. */
function offsetAt(ms: number, timezone: string): number {
  const whole = Math.floor(ms / 1000) * 1000
  const w = wallWithSeconds(whole, timezone)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - whole
}

/**
 * The moment a wall clock is in a zone. The offsets a day before and a day after are tried: one
 * that brings the moment back to the same wall clock is the answer. Two of them — the hour that
 * repeats when the clocks go back — give the earlier moment. None — the hour skipped when the
 * clocks go forward — gives the first moment after the gap, the transition itself, found to the
 * minute between the two tries.
 */
export function instantOf(wall: WallClock, timezone: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  const offsetBefore = offsetAt(naive - DAY_MS, timezone)
  const offsetAfter = offsetAt(naive + DAY_MS, timezone)
  const tries = [naive - offsetBefore, naive - offsetAfter]
  const fitting = tries.filter((ms) => ms + offsetAt(ms, timezone) === naive)
  if (fitting.length > 0) return Math.min(...fitting)
  // The gap: the offset grows at the transition, somewhere between the two tries.
  let low = Math.min(...tries)
  let high = Math.max(...tries)
  if (offsetAt(high, timezone) !== offsetAfter) return high
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS
    if (middle <= low) break
    if (offsetAt(middle, timezone) === offsetAfter) high = middle
    else low = middle
  }
  return high
}

/** Whether a zone is one `Intl` knows. */
export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** The zone as `Intl` names it (`resolvedOptions().timeZone`); null — a zone it does not know. */
export function canonicalTimezone(timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone
  } catch {
    return null
  }
}
