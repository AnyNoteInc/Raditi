import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { scheduleErrorOfIssues, scheduleTooOften } from './errors.ts'
import {
  canonicalTimezone,
  DEFAULT_SCHEDULE_TIMEZONE,
  isScheduleTooOftenIssue,
  SCHEDULE_TOO_OFTEN,
  SCHEDULE_TOO_OFTEN_TEXT,
  scheduleDateSchema,
  scheduleRunsTooOften,
  scheduleTimeSchema,
  scheduleTimezoneSchema,
  scheduleTriggerListSchema,
  scheduleTriggerSchema,
  scheduleTriggersSchema,
  type ScheduleTrigger,
} from './triggers.ts'

const ok = (triggers: unknown) => scheduleTriggersSchema.safeParse(triggers).success
const tooOften = (triggers: ScheduleTrigger[]) => {
  const parsed = scheduleTriggersSchema.safeParse(triggers)
  return !parsed.success && parsed.error.issues.some(isScheduleTooOftenIssue)
}

describe('a schedule', () => {
  it('takes each frequency of the window', () => {
    for (const trigger of [
      { kind: 'once', date: '2026-11-20', time: '09:00' },
      { kind: 'hourly', minute: 0 },
      { kind: 'hourly', minute: 59 },
      { kind: 'daily', time: '00:00' },
      { kind: 'weekdays', time: '23:59' },
      { kind: 'weekly', time: '16:00', days: [5] },
      { kind: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5, 6, 7] },
      { kind: 'monthly', time: '10:00', day: 1 },
      { kind: 'monthly', time: '10:00', day: 31 },
    ])
      expect(scheduleTriggerSchema.safeParse(trigger).success, JSON.stringify(trigger)).toBe(true)
  })

  it('refuses what the window cannot say', () => {
    for (const trigger of [
      { kind: 'once', date: '2026-02-29', time: '09:00' },
      { kind: 'once', date: '2026-13-01', time: '09:00' },
      { kind: 'once', date: '1999-12-31', time: '09:00' },
      { kind: 'once', date: '2026-11-20', time: '9:00' },
      { kind: 'once', date: '2026-11-20', time: '24:00' },
      { kind: 'once', date: '2026-11-20', time: '09:60' },
      { kind: 'hourly', minute: 60 },
      { kind: 'hourly', minute: 1.5 },
      { kind: 'daily', time: '09:00', days: [1] },
      { kind: 'weekly', time: '09:00', days: [] },
      { kind: 'weekly', time: '09:00', days: [3, 1] },
      { kind: 'weekly', time: '09:00', days: [1, 1] },
      { kind: 'weekly', time: '09:00', days: [0] },
      { kind: 'weekly', time: '09:00', days: [8] },
      { kind: 'monthly', time: '10:00', day: 0 },
      { kind: 'monthly', time: '10:00', day: 32 },
      { kind: 'yearly', time: '10:00' },
      { kind: 'cron', expression: '* * * * *' },
    ])
      expect(scheduleTriggerSchema.safeParse(trigger).success, JSON.stringify(trigger)).toBe(false)
  })

  it('takes dates of leap Februaries and times as HH:MM', () => {
    expect(scheduleDateSchema.safeParse('2028-02-29').success).toBe(true)
    expect(scheduleDateSchema.safeParse('2027-02-29').success).toBe(false)
    expect(scheduleDateSchema.safeParse('2026-04-31').success).toBe(false)
    expect(scheduleTimeSchema.safeParse('00:00').success).toBe(true)
    expect(scheduleTimeSchema.safeParse('23:59').success).toBe(true)
    expect(scheduleTimeSchema.safeParse('7:05').success).toBe(false)
  })
})

describe('the schedules of a task', () => {
  it('takes none («Только вручную») up to five', () => {
    expect(ok([])).toBe(true)
    const five = [0, 3, 6, 9, 12].map((hour) => ({
      kind: 'daily',
      time: `${String(hour).padStart(2, '0')}:00`,
    }))
    expect(ok(five)).toBe(true)
    expect(ok([...five, { kind: 'daily', time: '20:00' }])).toBe(false)
    expect(scheduleTriggerListSchema.safeParse([...five, ...five]).success).toBe(false)
  })

  it('refuses two daily runs half an hour apart', () => {
    expect(
      tooOften([
        { kind: 'daily', time: '09:00' },
        { kind: 'daily', time: '09:30' },
      ]),
    ).toBe(true)
  })

  it('takes a daily run at 9:00 with a weekly one on Saturday at 12:00', () => {
    expect(
      ok([
        { kind: 'daily', time: '09:00' },
        { kind: 'weekly', time: '12:00', days: [6] },
      ]),
    ).toBe(true)
  })

  it('refuses two hourly schedules, and an hourly one beside any other', () => {
    expect(
      tooOften([
        { kind: 'hourly', minute: 0 },
        { kind: 'hourly', minute: 30 },
      ]),
    ).toBe(true)
    expect(
      tooOften([
        { kind: 'hourly', minute: 0 },
        { kind: 'weekly', time: '03:30', days: [7] },
      ]),
    ).toBe(true)
    expect(ok([{ kind: 'hourly', minute: 0 }])).toBe(true)
  })

  it('takes runs exactly an hour apart, refuses 59 minutes', () => {
    expect(
      ok([
        { kind: 'daily', time: '09:00' },
        { kind: 'daily', time: '10:00' },
      ]),
    ).toBe(true)
    expect(
      tooOften([
        { kind: 'daily', time: '09:00' },
        { kind: 'daily', time: '09:59' },
      ]),
    ).toBe(true)
  })

  it('refuses the same schedule twice', () => {
    expect(
      tooOften([
        { kind: 'weekdays', time: '08:00' },
        { kind: 'weekdays', time: '08:00' },
      ]),
    ).toBe(true)
  })

  it('measures round midnight and round the week', () => {
    expect(
      tooOften([
        { kind: 'daily', time: '23:30' },
        { kind: 'daily', time: '00:10' },
      ]),
    ).toBe(true)
    // Sunday 23:30 and Monday 0:10 come 40 minutes apart.
    expect(
      tooOften([
        { kind: 'weekly', time: '23:30', days: [7] },
        { kind: 'weekly', time: '00:10', days: [1] },
      ]),
    ).toBe(true)
    // Friday 23:30 and Monday 0:10 never meet.
    expect(
      ok([
        { kind: 'weekly', time: '23:30', days: [5] },
        { kind: 'weekly', time: '00:10', days: [1] },
      ]),
    ).toBe(true)
    // Weekdays at 8:00 and Saturdays at 8:30 are a day apart.
    expect(
      ok([
        { kind: 'weekdays', time: '08:00' },
        { kind: 'weekly', time: '08:30', days: [6, 7] },
      ]),
    ).toBe(true)
    expect(
      tooOften([
        { kind: 'weekdays', time: '08:00' },
        { kind: 'weekly', time: '08:30', days: [5] },
      ]),
    ).toBe(true)
  })

  it('brings a monthly run to every day of the week', () => {
    // The 1st falls on a Monday some month: 10:00 against Mondays at 10:30.
    expect(
      tooOften([
        { kind: 'monthly', time: '10:00', day: 1 },
        { kind: 'weekly', time: '10:30', days: [1] },
      ]),
    ).toBe(true)
    expect(
      ok([
        { kind: 'monthly', time: '10:00', day: 1 },
        { kind: 'weekly', time: '12:00', days: [1] },
      ]),
    ).toBe(true)
  })

  it('lays two monthly schedules out over the months', () => {
    // The 30th and the 31st meet on the 30th of April.
    expect(
      tooOften([
        { kind: 'monthly', time: '10:00', day: 30 },
        { kind: 'monthly', time: '10:30', day: 31 },
      ]),
    ).toBe(true)
    // The 31st at 23:30 comes forty minutes before the 1st at 0:10.
    expect(
      tooOften([
        { kind: 'monthly', time: '23:30', day: 31 },
        { kind: 'monthly', time: '00:10', day: 1 },
      ]),
    ).toBe(true)
    // The 28th at 23:30 and the 1st at 0:10: a common February.
    expect(
      tooOften([
        { kind: 'monthly', time: '23:30', day: 28 },
        { kind: 'monthly', time: '00:10', day: 1 },
      ]),
    ).toBe(true)
    expect(
      ok([
        { kind: 'monthly', time: '10:00', day: 1 },
        { kind: 'monthly', time: '10:30', day: 15 },
      ]),
    ).toBe(true)
  })

  it('compares a single run with the runs around its own date', () => {
    // Friday 20 November 2026.
    expect(
      tooOften([
        { kind: 'once', date: '2026-11-20', time: '09:30' },
        { kind: 'weekdays', time: '09:00' },
      ]),
    ).toBe(true)
    expect(
      ok([
        { kind: 'once', date: '2026-11-21', time: '09:30' },
        { kind: 'weekdays', time: '09:00' },
      ]),
    ).toBe(true)
    expect(
      tooOften([
        { kind: 'once', date: '2026-11-30', time: '23:30' },
        { kind: 'monthly', time: '00:10', day: 1 },
      ]),
    ).toBe(true)
    expect(
      ok([
        { kind: 'once', date: '2026-11-15', time: '23:30' },
        { kind: 'monthly', time: '00:10', day: 1 },
      ]),
    ).toBe(true)
    expect(
      tooOften([
        { kind: 'once', date: '2026-11-20', time: '09:00' },
        { kind: 'once', date: '2026-11-20', time: '09:45' },
      ]),
    ).toBe(true)
    expect(
      ok([
        { kind: 'once', date: '2026-11-20', time: '09:00' },
        { kind: 'once', date: '2026-11-21', time: '09:00' },
      ]),
    ).toBe(true)
  })

  it('carries the code of the domain error and its words', () => {
    const parsed = scheduleTriggersSchema.safeParse([
      { kind: 'daily', time: '09:00' },
      { kind: 'daily', time: '09:30' },
    ])
    expect(parsed.success).toBe(false)
    const issue = parsed.error?.issues[0]
    expect(issue?.message).toBe('Запуски одной задачи — не чаще раза в час')
    expect(issue?.message).toBe(SCHEDULE_TOO_OFTEN_TEXT)
    const error = scheduleErrorOfIssues(parsed.error?.issues ?? [])
    expect(error?.code).toBe(SCHEDULE_TOO_OFTEN)
    expect(error?.httpStatus).toBe(400)
    expect(error?.message).toBe(scheduleTooOften().message)
    // A schedule refused for another reason is not «too often».
    const other = scheduleTriggersSchema.safeParse([{ kind: 'daily', time: '9:00' }])
    expect(scheduleErrorOfIssues(other.error?.issues ?? [])).toBeNull()
  })

  it('answers the same without the schema', () => {
    expect(scheduleRunsTooOften([])).toBe(false)
    expect(scheduleRunsTooOften([{ kind: 'hourly', minute: 5 }])).toBe(false)
    expect(
      scheduleRunsTooOften([
        { kind: 'daily', time: '09:00' },
        { kind: 'daily', time: '09:30' },
      ]),
    ).toBe(true)
  })

  it('is written as closed objects: an unknown key is a refusal', () => {
    const schema = JSON.stringify(z.toJSONSchema(scheduleTriggersSchema, { io: 'input' }))
    const objects = schema.match(/"type":"object"/g)?.length ?? 0
    expect(objects).toBe(6)
    expect(schema.match(/"additionalProperties":false/g)?.length).toBe(objects)
  })
})

describe('the time zone of a task', () => {
  it('takes a zone Intl knows and stores the name Intl gives it', () => {
    expect(scheduleTimezoneSchema.parse('Europe/Moscow')).toBe('Europe/Moscow')
    expect(scheduleTimezoneSchema.parse('europe/moscow')).toBe('Europe/Moscow')
    expect(scheduleTimezoneSchema.parse('Asia/Novosibirsk')).toBe('Asia/Novosibirsk')
    expect(scheduleTimezoneSchema.parse('UTC')).toBe(canonicalTimezone('UTC'))
  })

  it('refuses a zone Intl does not know, an offset and a name too long', () => {
    for (const timezone of [
      'Mars/Olympus',
      '+03:00',
      'UTC+3',
      '',
      'A'.repeat(65),
      'Europe/ Moscow',
    ])
      expect(scheduleTimezoneSchema.safeParse(timezone).success, timezone).toBe(false)
  })

  it('defaults to Moscow', () => {
    expect(DEFAULT_SCHEDULE_TIMEZONE).toBe('Europe/Moscow')
    expect(canonicalTimezone('Nowhere/Land')).toBeNull()
  })
})
