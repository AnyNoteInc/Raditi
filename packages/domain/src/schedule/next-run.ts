import { badRequest } from '../errors.ts'
import {
  addDays,
  daysInMonth,
  instantOf,
  isoWeekday,
  MINUTE_MS,
  parseCivilDate,
  parseTime,
  wallOf,
  type CivilDate,
} from './calendar.ts'
import type { ScheduleTrigger } from './triggers.ts'

/**
 * The runs of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп13–Зп15): moments, to the
 * minute, of its schedules on the wall clock of its zone. A time the clocks skip when they go
 * forward runs at the first moment after the gap; a time that repeats when they go back runs
 * once, at the earlier moment. «Каждый час» runs every hour of real time at its minute, both
 * hours that repeat included. A monthly day past the end of a shorter month runs on its last
 * day. A single run in the past has no run. No schedule — «Только вручную» — has none either.
 */

type Recurring = Exclude<ScheduleTrigger, { kind: 'once' | 'hourly' }>

/** Whether a recurring schedule runs on a date of its wall clock. */
function runsOn(trigger: Recurring, date: CivilDate): boolean {
  switch (trigger.kind) {
    case 'daily':
      return true
    case 'weekdays':
      return isoWeekday(date) <= 5
    case 'weekly':
      return trigger.days.includes(isoWeekday(date))
    case 'monthly':
      return date.day === Math.min(trigger.day, daysInMonth(date.year, date.month))
  }
}

const momentOn = (date: CivilDate, time: string, timezone: string): number => {
  const minuteOfDay = parseTime(time)
  return instantOf(
    { ...date, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 },
    timezone,
  )
}

/** Days a recurring schedule is looked for: a monthly one runs at least every 31 days. */
const DAYS_LOOKED = 70
/** Tries of the hourly minute: an offset that changes by a part of an hour moves it. */
const HOURLY_TRIES = 4

const floorToMinute = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS

/** The first run of one schedule strictly after a moment; null — none. */
function nextOfTrigger(trigger: ScheduleTrigger, timezone: string, after: number): number | null {
  switch (trigger.kind) {
    case 'once': {
      const at = momentOn(parseCivilDate(trigger.date), trigger.time, timezone)
      return at > after ? at : null
    }
    case 'hourly': {
      let at = floorToMinute(after) + MINUTE_MS
      for (let tries = 0; tries < HOURLY_TRIES; tries += 1) {
        const shift = (trigger.minute - wallOf(at, timezone).minute + 60) % 60
        at += shift * MINUTE_MS
        if (shift === 0) return at
      }
      return null
    }
    default: {
      // A day before the wall date of `after`: a run in a gap may land after midnight.
      const from = addDays(wallOf(after, timezone), -1)
      for (let day = 0; day < DAYS_LOOKED; day += 1) {
        const date = addDays(from, day)
        if (!runsOn(trigger, date)) continue
        const at = momentOn(date, trigger.time, timezone)
        if (at > after) return at
      }
      return null
    }
  }
}

/** The last run of one schedule at or before a moment; null — none. */
function previousOfTrigger(
  trigger: ScheduleTrigger,
  timezone: string,
  atOrBefore: number,
): number | null {
  switch (trigger.kind) {
    case 'once': {
      const at = momentOn(parseCivilDate(trigger.date), trigger.time, timezone)
      return at <= atOrBefore ? at : null
    }
    case 'hourly': {
      let at = floorToMinute(atOrBefore)
      for (let tries = 0; tries < HOURLY_TRIES; tries += 1) {
        const shift = (wallOf(at, timezone).minute - trigger.minute + 60) % 60
        at -= shift * MINUTE_MS
        if (shift === 0) return at
      }
      return null
    }
    default: {
      const from = addDays(wallOf(atOrBefore, timezone), 1)
      for (let day = 0; day < DAYS_LOOKED; day += 1) {
        const date = addDays(from, -day)
        if (!runsOn(trigger, date)) continue
        const at = momentOn(date, trigger.time, timezone)
        if (at <= atOrBefore) return at
      }
      return null
    }
  }
}

function msOf(at: Date): number {
  const ms = at.getTime()
  if (!Number.isFinite(ms)) throw badRequest('Invalid moment of a scheduled task')
  return ms
}

/** The nearest run strictly after `after`; null — the task has no run ahead. */
export function nextRunOf(
  triggers: readonly ScheduleTrigger[],
  timezone: string,
  after: Date,
): Date | null {
  const from = msOf(after)
  let nearest: number | null = null
  for (const trigger of triggers) {
    const at = nextOfTrigger(trigger, timezone, from)
    if (at !== null && (nearest === null || at < nearest)) nearest = at
  }
  return nearest === null ? null : new Date(nearest)
}

/** The last run in `[from, to]`; null — none was due then. */
export function latestDueOf(
  triggers: readonly ScheduleTrigger[],
  timezone: string,
  from: Date,
  to: Date,
): Date | null {
  const low = msOf(from)
  const high = msOf(to)
  if (high < low) return null
  let latest: number | null = null
  for (const trigger of triggers) {
    const at = previousOfTrigger(trigger, timezone, high)
    if (at !== null && at >= low && (latest === null || at > latest)) latest = at
  }
  return latest === null ? null : new Date(latest)
}

/** At most this many runs are counted: an hourly task runs 8 760 times a year. */
export const DUE_COUNT_CAP = 10_000

/**
 * How many runs fall in `[from, to]` — the runs a stopped platform missed (Зп6, Зп14) and the runs
 * of a week the window prices (Зп30). Two schedules at one moment are one run. Counts up to
 * `DUE_COUNT_CAP`.
 */
export function dueCountBetween(
  triggers: readonly ScheduleTrigger[],
  timezone: string,
  from: Date,
  to: Date,
): number {
  const high = msOf(to)
  let count = 0
  let at = nextRunOf(triggers, timezone, new Date(msOf(from) - 1))
  while (at !== null && at.getTime() <= high && count < DUE_COUNT_CAP) {
    count += 1
    at = nextRunOf(triggers, timezone, at)
  }
  return count
}

/** Whether the task runs again after `now`: «Это время уже прошло» when it does not (Зп15). */
export function hasFutureRun(
  triggers: readonly ScheduleTrigger[],
  timezone: string,
  now: Date,
): boolean {
  return nextRunOf(triggers, timezone, now) !== null
}

/**
 * Whether a single run of the schedules is not after `now` (Зп15): such a task is not saved —
 * «Это время уже прошло — выберите другое» — even when another of its schedules runs on.
 */
export function scheduleTriggersInPast(
  triggers: readonly ScheduleTrigger[],
  timezone: string,
  now: Date,
): boolean {
  return triggers.some(
    (trigger) => trigger.kind === 'once' && nextOfTrigger(trigger, timezone, msOf(now)) === null,
  )
}
