import { z } from 'zod'

import {
  addMonths,
  canonicalTimezone,
  DAY_MINUTES,
  daysInMonth,
  isKnownTimezone,
  isoWeekday,
  naiveMinutes,
  parseCivilDate,
  parseTime,
  WEEK_MINUTES,
  type CivilDate,
} from './calendar.ts'
import { SCHEDULE_MIN_GAP_MINUTES, scheduleLimits } from './limits.ts'

/**
 * When a scheduled task runs (docs/plan/82-scheduled-tasks.md, Зп8, Зп11): up to five schedules,
 * each a frequency with a time on the wall clock of the task's zone. No RRULE or cron of the
 * client's own: the frequencies of the window, and nothing else.
 */

export { canonicalTimezone }

/** A time of the day, `HH:MM` from 00:00 to 23:59. */
export const scheduleTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'a time as HH:MM')

/** A date of the calendar, `YYYY-MM-DD`, this millennium. */
export const scheduleDateSchema = z
  .string()
  .regex(/^2\d{3}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/, 'a date as YYYY-MM-DD')
  .refine((text) => {
    const date = parseCivilDate(text)
    return date.day <= daysInMonth(date.year, date.month)
  }, 'a date of the calendar')

/** ISO weekday: 1 — Monday … 7 — Sunday. */
export const scheduleWeekdaySchema = z.number().int().min(1).max(7)

export const scheduleTriggerKinds = [
  'once',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
] as const
export type ScheduleTriggerKind = (typeof scheduleTriggerKinds)[number]

const time = scheduleTimeSchema

export const scheduleOnceTriggerSchema = z.strictObject({
  kind: z.literal('once'),
  date: scheduleDateSchema,
  time,
})

/** One schedule of a task. «По будням» — Monday to Friday, holidays are not known (Зп8). */
export const scheduleTriggerSchema = z.discriminatedUnion('kind', [
  scheduleOnceTriggerSchema,
  z.strictObject({ kind: z.literal('hourly'), minute: z.number().int().min(0).max(59) }),
  z.strictObject({ kind: z.literal('daily'), time }),
  z.strictObject({ kind: z.literal('weekdays'), time }),
  z.strictObject({
    kind: z.literal('weekly'),
    time,
    // Different days in their order: the schedule is stored as the window shows it.
    days: z
      .array(scheduleWeekdaySchema)
      .min(1)
      .max(7)
      .refine(
        (days) => days.every((day, index) => index === 0 || day > (days[index - 1] ?? 0)),
        'different days in ascending order',
      ),
  }),
  // In a shorter month the day is its last one (Зп8): the 31st runs on the 30th of April.
  z.strictObject({ kind: z.literal('monthly'), time, day: z.number().int().min(1).max(31) }),
])
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>

/** The issue `scheduleTriggersSchema` raises for runs closer than an hour: its domain code. */
export const SCHEDULE_TOO_OFTEN = 'SCHEDULE_TOO_OFTEN'
export const SCHEDULE_TOO_OFTEN_TEXT = 'Запуски одной задачи — не чаще раза в час'

/** Whether an issue of a schema is the one of runs closer than an hour. */
export const isScheduleTooOftenIssue = (issue: {
  code: string
  params?: Record<string, unknown> | undefined
}): boolean => issue.code === 'custom' && issue.params?.code === SCHEDULE_TOO_OFTEN

/** The schedules as stored, without the rule of an hour: a reader of an old row needs no more. */
export const scheduleTriggerListSchema = z
  .array(scheduleTriggerSchema)
  .max(scheduleLimits.triggersPerTask)

/**
 * The schedules of a task: none («Только вручную») to five. «Каждый час» only alone, and no two
 * runs closer than an hour (Зп11) — the issue carries `params.code = SCHEDULE_TOO_OFTEN`.
 */
export const scheduleTriggersSchema = scheduleTriggerListSchema.superRefine((triggers, ctx) => {
  if (scheduleRunsTooOften(triggers))
    ctx.addIssue({
      code: 'custom',
      message: SCHEDULE_TOO_OFTEN_TEXT,
      params: { code: SCHEDULE_TOO_OFTEN },
    })
})

/**
 * A zone of the IANA database, as `new Intl.DateTimeFormat('en-US', { timeZone })` takes it; the
 * value is replaced by the name `resolvedOptions().timeZone` gives (Зп12). No offsets as `+03:00`.
 */
export const scheduleTimezoneSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/, 'a time zone of the IANA database')
  .refine(isKnownTimezone, { message: 'an unknown time zone', abort: true })
  .overwrite((timezone) => canonicalTimezone(timezone) ?? timezone)

/** The zone of a task when the client has none remembered (Зп12). */
export const DEFAULT_SCHEDULE_TIMEZONE = 'Europe/Moscow'

// ---------------------------------------------------------------------------------------------
// Not more often than once an hour
// ---------------------------------------------------------------------------------------------

/*
 * «Сроки всех расписаний за ближайшие 7 дней — не ближе 60 минут друг к другу» (Зп11), answered
 * without a «now», so that a schedule valid today is valid tomorrow: on the wall clock of the
 * task's zone, every pair of schedules is brought to the closest its runs ever come.
 *
 * - Daily, weekday and weekly schedules repeat every week: their runs are minutes of a week, and
 *   the distance of two of them is taken round the week.
 * - A monthly run falls on every day of the week over the years: against a weekly pattern it is
 *   tried on each of the seven days.
 * - Two monthly schedules are laid out over 2024–2028 — leap and common Februaries, every month
 *   into the next —, so «31-го» and «30-го» meet on the 30th of April and «31-го в 23:30» comes
 *   forty minutes before «1-го в 0:10».
 * - A single run is compared with the weeks, months and single runs around its own date.
 *
 * The wall clock, not the moments: a change of the clocks can bring two runs closer once or
 * twice a year, which the rule lets be. «Каждый час» runs an hour apart by itself, so it stands
 * alone.
 */

type Shape =
  | { kind: 'week'; minutes: readonly number[] }
  | { kind: 'month'; day: number; time: number }
  | { kind: 'once'; at: number; weekMinute: number; date: CivilDate }

const DAILY = [1, 2, 3, 4, 5, 6, 7] as const
const WEEKDAYS = [1, 2, 3, 4, 5] as const

function shapeOf(trigger: Exclude<ScheduleTrigger, { kind: 'hourly' }>): Shape {
  const minute = parseTime(trigger.time)
  switch (trigger.kind) {
    case 'daily':
    case 'weekdays':
    case 'weekly': {
      const days =
        trigger.kind === 'daily' ? DAILY : trigger.kind === 'weekdays' ? WEEKDAYS : trigger.days
      return { kind: 'week', minutes: days.map((day) => (day - 1) * DAY_MINUTES + minute) }
    }
    case 'monthly':
      return { kind: 'month', day: trigger.day, time: minute }
    case 'once': {
      const date = parseCivilDate(trigger.date)
      return {
        kind: 'once',
        at: naiveMinutes(date, minute),
        weekMinute: (isoWeekday(date) - 1) * DAY_MINUTES + minute,
        date,
      }
    }
  }
}

const aroundTheWeek = (a: number, b: number): number => {
  const distance = Math.abs(a - b) % WEEK_MINUTES
  return Math.min(distance, WEEK_MINUTES - distance)
}

const closestInWeek = (minute: number, minutes: readonly number[]): number =>
  Math.min(...minutes.map((other) => aroundTheWeek(minute, other)))

/** The run of a monthly schedule in a month, as naive minutes. */
function monthlyRun(shape: { day: number; time: number }, month: CivilDate): number {
  const day = Math.min(shape.day, daysInMonth(month.year, month.month))
  return naiveMinutes({ ...month, day }, shape.time)
}

const FIRST_MONTH: CivilDate = { year: 2024, month: 1, day: 1 }
const MONTHS_LAID_OUT = 60

function monthlyRuns(shape: { day: number; time: number }): number[] {
  return Array.from({ length: MONTHS_LAID_OUT }, (_, index) =>
    monthlyRun(shape, addMonths(FIRST_MONTH, index)),
  )
}

function closestOf(a: readonly number[], b: readonly number[]): number {
  let closest = Number.POSITIVE_INFINITY
  for (const x of a) for (const y of b) closest = Math.min(closest, Math.abs(x - y))
  return closest
}

/** The closest two schedules' runs come, in minutes of the wall clock. */
function closest(a: Shape, b: Shape): number {
  if (a.kind === 'week' && b.kind === 'week')
    return Math.min(...a.minutes.map((minute) => closestInWeek(minute, b.minutes)))
  if (a.kind === 'once' && b.kind === 'once') return Math.abs(a.at - b.at)
  if (a.kind === 'once' && b.kind === 'week') return closestInWeek(a.weekMinute, b.minutes)
  if (a.kind === 'week' && b.kind === 'once') return closest(b, a)
  if (a.kind === 'month' && b.kind === 'week')
    return Math.min(
      ...DAILY.map((day) => closestInWeek((day - 1) * DAY_MINUTES + a.time, b.minutes)),
    )
  if (a.kind === 'week' && b.kind === 'month') return closest(b, a)
  if (a.kind === 'month' && b.kind === 'month') return closestOf(monthlyRuns(a), monthlyRuns(b))
  // A single run and a monthly schedule: the months around the single run's date.
  const once = a.kind === 'once' ? a : (b as Extract<Shape, { kind: 'once' }>)
  const month = (a.kind === 'month' ? a : b) as Extract<Shape, { kind: 'month' }>
  return closestOf(
    [once.at],
    [-1, 0, 1].map((shift) => monthlyRun(month, addMonths(once.date, shift))),
  )
}

/**
 * Whether the schedules would run a task more often than once an hour (Зп11): «Каждый час» with
 * any other schedule, or two schedules whose runs ever come closer than 60 minutes.
 */
export function scheduleRunsTooOften(triggers: readonly ScheduleTrigger[]): boolean {
  if (triggers.some((trigger) => trigger.kind === 'hourly')) return triggers.length > 1
  const shapes = triggers.map((trigger) =>
    shapeOf(trigger as Exclude<ScheduleTrigger, { kind: 'hourly' }>),
  )
  for (let i = 0; i < shapes.length; i += 1)
    for (let j = i + 1; j < shapes.length; j += 1) {
      const a = shapes[i]
      const b = shapes[j]
      if (a && b && closest(a, b) < SCHEDULE_MIN_GAP_MINUTES) return true
    }
  return false
}
