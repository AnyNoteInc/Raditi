import { describe, expect, it } from 'vitest'

import { nextRunOf } from './next-run.ts'
import type { ScheduleTrigger } from './triggers.ts'

/**
 * nextRunOf against an independent calendar: Node 26 ships Temporal, browsers do not, so the
 * product computes with Intl and this test checks it against Temporal on random schedules in
 * zones with clock changes — at 2:00, at midnight (Santiago), by half an hour (Lord Howe) and
 * with odd offsets (Kathmandu, Chatham). A time the clocks skip runs at the transition.
 */

interface ZonedLike {
  epochMilliseconds: number
  hour: number
  minute: number
  getTimeZoneTransition(direction: 'next' | 'previous'): ZonedLike | null
}
interface PlainDateLike {
  year: number
  month: number
  day: number
  dayOfWeek: number
  daysInMonth: number
  add(duration: { days: number }): PlainDateLike
  toZonedDateTime(options: { timeZone: string; plainTime?: string }): ZonedLike
}
interface TemporalLike {
  Instant: {
    fromEpochMilliseconds(ms: number): {
      toZonedDateTimeISO(zone: string): ZonedLike & { toPlainDate(): PlainDateLike }
    }
  }
  ZonedDateTime: {
    from(
      item: {
        timeZone: string
        year: number
        month: number
        day: number
        hour: number
        minute: number
      },
      options: { disambiguation: 'compatible' | 'earlier' | 'later' | 'reject' },
    ): ZonedLike
  }
}

const temporal = (globalThis as { Temporal?: TemporalLike }).Temporal

/** The moment a recurring wall time runs on a date: earlier of two, transition when skipped. */
function oracleMoment(date: PlainDateLike, time: string, zone: string): number {
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  const fields = { timeZone: zone, year: date.year, month: date.month, day: date.day, hour, minute }
  try {
    return temporal!.ZonedDateTime.from(fields, { disambiguation: 'reject' }).epochMilliseconds
  } catch {
    // Ambiguous or skipped: the earlier instant when the time repeats, the transition when skipped.
    const earlier = temporal!.ZonedDateTime.from(fields, { disambiguation: 'earlier' })
    const later = temporal!.ZonedDateTime.from(fields, { disambiguation: 'later' })
    if (earlier.hour === hour && earlier.minute === minute) return earlier.epochMilliseconds
    const start = date.toZonedDateTime({ timeZone: zone })
    const transition = start.getTimeZoneTransition('next')
    return transition ? transition.epochMilliseconds : later.epochMilliseconds
  }
}

function runsOn(trigger: ScheduleTrigger, date: PlainDateLike): boolean {
  switch (trigger.kind) {
    case 'daily':
      return true
    case 'weekdays':
      return date.dayOfWeek <= 5
    case 'weekly':
      return trigger.days.includes(date.dayOfWeek)
    case 'monthly':
      return date.day === Math.min(trigger.day, date.daysInMonth)
    default:
      return false
  }
}

function oracleNext(trigger: ScheduleTrigger, zone: string, after: number): number | null {
  if (trigger.kind === 'once' || trigger.kind === 'hourly') throw new Error('not covered')
  let date = temporal!.Instant.fromEpochMilliseconds(after)
    .toZonedDateTimeISO(zone)
    .toPlainDate()
    .add({ days: -1 })
  for (let i = 0; i < 80; i++, date = date.add({ days: 1 })) {
    if (!runsOn(trigger, date)) continue
    const at = oracleMoment(date, trigger.time, zone)
    if (at > after) return at
  }
  return null
}

/** A small deterministic generator: the same cases on every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const zones = [
  'Europe/Moscow',
  'Europe/Berlin',
  'America/New_York',
  'America/Santiago',
  'Australia/Lord_Howe',
  'Asia/Kathmandu',
  'Pacific/Chatham',
  'Asia/Yekaterinburg',
]

function randomTrigger(next: () => number): ScheduleTrigger {
  const pad = (n: number) => String(n).padStart(2, '0')
  // Clock changes happen around 0:00–3:00: weight those hours.
  const hour = next() < 0.5 ? Math.floor(next() * 4) : Math.floor(next() * 24)
  const minute = [0, 15, 30, 45, 59][Math.floor(next() * 5)]!
  const time = `${pad(hour)}:${pad(minute)}`
  const kind = Math.floor(next() * 4)
  if (kind === 0) return { kind: 'daily', time }
  if (kind === 1) return { kind: 'weekdays', time }
  if (kind === 2) {
    const days = [1, 2, 3, 4, 5, 6, 7].filter(() => next() < 0.4)
    return { kind: 'weekly', time, days: days.length > 0 ? days : [7] }
  }
  return { kind: 'monthly', time, day: 1 + Math.floor(next() * 31) }
}

describe.skipIf(!temporal)('nextRunOf against Temporal', () => {
  it('agrees on 4000 random recurring schedules around clock changes', () => {
    const next = lcg(82)
    const start = Date.UTC(2026, 0, 1)
    const span = 3 * 365 * 24 * 3_600_000
    const mismatches: string[] = []
    let found = 0
    for (let i = 0; i < 4000; i++) {
      const zone = zones[i % zones.length]!
      const trigger = randomTrigger(next)
      const after = start + Math.floor(next() * span)
      const expected = oracleNext(trigger, zone, after)
      const actual = nextRunOf([trigger], zone, new Date(after))?.getTime() ?? null
      if (expected !== null) found++
      if (actual !== expected) {
        mismatches.push(
          `${zone} ${JSON.stringify(trigger)} after ${new Date(after).toISOString()}: ` +
            `${actual === null ? 'null' : new Date(actual).toISOString()} ≠ ` +
            `${expected === null ? 'null' : new Date(expected).toISOString()}`,
        )
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([])
    // Every recurring schedule runs within 80 days: the comparison is of moments, not of nulls.
    expect(found).toBe(4000)
  })

  it('runs a skipped time at the transition and a repeated time once, at the earlier moment', () => {
    // Berlin 29.03.2026: 2:00 → 3:00; 25.10.2026: 3:00 → 2:00.
    const skipped = nextRunOf(
      [{ kind: 'daily', time: '02:30' }],
      'Europe/Berlin',
      new Date('2026-03-28T12:00:00Z'),
    )
    expect(skipped?.toISOString()).toBe('2026-03-29T01:00:00.000Z')
    const repeated = nextRunOf(
      [{ kind: 'daily', time: '02:30' }],
      'Europe/Berlin',
      new Date('2026-10-24T12:00:00Z'),
    )
    expect(repeated?.toISOString()).toBe('2026-10-25T00:30:00.000Z')
    const santiago = nextRunOf(
      [{ kind: 'daily', time: '00:15' }],
      'America/Santiago',
      new Date('2026-09-05T12:00:00Z'),
    )
    expect(santiago).not.toBeNull()
  })
})
