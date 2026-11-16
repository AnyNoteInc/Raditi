import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import {
  DUE_COUNT_CAP,
  dueCountBetween,
  hasFutureRun,
  latestDueOf,
  nextRunOf,
  scheduleTriggersInPast,
} from './next-run.ts'
import type { ScheduleTrigger } from './triggers.ts'

const at = (iso: string) => new Date(iso)
const next = (triggers: ScheduleTrigger[], timezone: string, after: string) =>
  nextRunOf(triggers, timezone, at(after))?.toISOString() ?? null

/** The runs after a moment, one after another. */
function runs(triggers: ScheduleTrigger[], timezone: string, after: string, count: number) {
  const found: string[] = []
  let from = at(after)
  for (let index = 0; index < count; index += 1) {
    const run = nextRunOf(triggers, timezone, from)
    if (run === null) break
    found.push(run.toISOString())
    from = run
  }
  return found
}

const MOSCOW = 'Europe/Moscow'
const BERLIN = 'Europe/Berlin'
const NEW_YORK = 'America/New_York'

describe('nextRunOf in Moscow (no change of the clocks)', () => {
  it('runs daily at the time of the wall clock, the next day once today has passed', () => {
    const daily: ScheduleTrigger[] = [{ kind: 'daily', time: '09:00' }]
    expect(next(daily, MOSCOW, '2026-11-15T05:00:00Z')).toBe('2026-11-15T06:00:00.000Z')
    expect(next(daily, MOSCOW, '2026-11-15T06:00:00Z')).toBe('2026-11-16T06:00:00.000Z')
    expect(next(daily, MOSCOW, '2026-11-15T06:00:00.001Z')).toBe('2026-11-16T06:00:00.000Z')
  })

  it('runs strictly after the moment given, to the minute, with no seconds', () => {
    const run = nextRunOf(
      [{ kind: 'daily', time: '23:59' }],
      MOSCOW,
      at('2026-11-15T10:11:12.345Z'),
    )
    expect(run?.toISOString()).toBe('2026-11-15T20:59:00.000Z')
    expect(run?.getUTCSeconds()).toBe(0)
    expect(run?.getUTCMilliseconds()).toBe(0)
  })

  it('takes midnight as the first minute of the day', () => {
    expect(next([{ kind: 'daily', time: '00:00' }], MOSCOW, '2026-11-15T10:00:00Z')).toBe(
      '2026-11-15T21:00:00.000Z',
    )
  })

  it('runs on weekdays from Monday to Friday, over a weekend to Monday', () => {
    const weekdays: ScheduleTrigger[] = [{ kind: 'weekdays', time: '09:00' }]
    // Friday 13 November 2026, 10:00 in Moscow: the next is Monday.
    expect(next(weekdays, MOSCOW, '2026-11-13T07:00:00Z')).toBe('2026-11-16T06:00:00.000Z')
    // Saturday and Sunday lead to Monday too.
    expect(next(weekdays, MOSCOW, '2026-11-14T03:00:00Z')).toBe('2026-11-16T06:00:00.000Z')
    expect(next(weekdays, MOSCOW, '2026-11-15T20:00:00Z')).toBe('2026-11-16T06:00:00.000Z')
    expect(runs(weekdays, MOSCOW, '2026-11-15T00:00:00Z', 6)).toEqual([
      '2026-11-16T06:00:00.000Z',
      '2026-11-17T06:00:00.000Z',
      '2026-11-18T06:00:00.000Z',
      '2026-11-19T06:00:00.000Z',
      '2026-11-20T06:00:00.000Z',
      '2026-11-23T06:00:00.000Z',
    ])
  })

  it('runs weekly on each of its days', () => {
    // Monday, Wednesday and Friday at 9:00.
    const weekly: ScheduleTrigger[] = [{ kind: 'weekly', time: '09:00', days: [1, 3, 5] }]
    expect(runs(weekly, MOSCOW, '2026-11-15T00:00:00Z', 4)).toEqual([
      '2026-11-16T06:00:00.000Z',
      '2026-11-18T06:00:00.000Z',
      '2026-11-20T06:00:00.000Z',
      '2026-11-23T06:00:00.000Z',
    ])
    // Sunday alone: a week from Sunday.
    expect(
      runs([{ kind: 'weekly', time: '18:30', days: [7] }], MOSCOW, '2026-11-15T16:00:00Z', 2),
    ).toEqual(['2026-11-22T15:30:00.000Z', '2026-11-29T15:30:00.000Z'])
  })

  it('runs monthly on its day, on the last day of a shorter month', () => {
    const thirtyFirst: ScheduleTrigger[] = [{ kind: 'monthly', time: '10:00', day: 31 }]
    expect(runs(thirtyFirst, MOSCOW, '2026-01-01T00:00:00Z', 5)).toEqual([
      '2026-01-31T07:00:00.000Z',
      '2026-02-28T07:00:00.000Z',
      '2026-03-31T07:00:00.000Z',
      '2026-04-30T07:00:00.000Z',
      '2026-05-31T07:00:00.000Z',
    ])
    // A leap February has its 29th.
    expect(
      next([{ kind: 'monthly', time: '10:00', day: 30 }], MOSCOW, '2028-02-01T00:00:00Z'),
    ).toBe('2028-02-29T07:00:00.000Z')
    expect(
      next([{ kind: 'monthly', time: '10:00', day: 29 }], MOSCOW, '2027-02-01T00:00:00Z'),
    ).toBe('2027-02-28T07:00:00.000Z')
    expect(
      runs([{ kind: 'monthly', time: '10:00', day: 1 }], MOSCOW, '2026-11-15T00:00:00Z', 2),
    ).toEqual(['2026-12-01T07:00:00.000Z', '2027-01-01T07:00:00.000Z'])
  })

  it('runs hourly at its minute of every hour', () => {
    const hourly: ScheduleTrigger[] = [{ kind: 'hourly', minute: 15 }]
    expect(runs(hourly, MOSCOW, '2026-11-15T06:15:00Z', 3)).toEqual([
      '2026-11-15T07:15:00.000Z',
      '2026-11-15T08:15:00.000Z',
      '2026-11-15T09:15:00.000Z',
    ])
    expect(next(hourly, MOSCOW, '2026-11-15T06:14:30Z')).toBe('2026-11-15T06:15:00.000Z')
    expect(next([{ kind: 'hourly', minute: 0 }], MOSCOW, '2026-11-15T06:59:59Z')).toBe(
      '2026-11-15T07:00:00.000Z',
    )
  })

  it('runs hourly at the minute of a zone half an hour off UTC', () => {
    // India is UTC+5:30: 15 minutes past the hour there is 45 past in UTC.
    expect(next([{ kind: 'hourly', minute: 15 }], 'Asia/Kolkata', '2026-11-15T06:00:00Z')).toBe(
      '2026-11-15T06:45:00.000Z',
    )
  })

  it('runs once in the future, never in the past', () => {
    const once: ScheduleTrigger[] = [{ kind: 'once', date: '2026-11-20', time: '09:00' }]
    expect(next(once, MOSCOW, '2026-11-15T10:00:00Z')).toBe('2026-11-20T06:00:00.000Z')
    expect(next(once, MOSCOW, '2026-11-20T06:00:00Z')).toBeNull()
    expect(next(once, MOSCOW, '2026-11-21T00:00:00Z')).toBeNull()
  })

  it('has no run without a schedule («Только вручную»)', () => {
    expect(next([], MOSCOW, '2026-11-15T10:00:00Z')).toBeNull()
    expect(hasFutureRun([], MOSCOW, at('2026-11-15T10:00:00Z'))).toBe(false)
    expect(
      latestDueOf([], MOSCOW, at('2026-11-01T00:00:00Z'), at('2026-11-15T00:00:00Z')),
    ).toBeNull()
    expect(
      dueCountBetween([], MOSCOW, at('2026-11-01T00:00:00Z'), at('2026-11-15T00:00:00Z')),
    ).toBe(0)
  })

  it('takes the nearest run of several schedules', () => {
    const triggers: ScheduleTrigger[] = [
      { kind: 'weekly', time: '12:00', days: [6] },
      { kind: 'daily', time: '09:00' },
    ]
    // Saturday 21 November, 10:00: the weekly noon comes before the next morning.
    expect(next(triggers, MOSCOW, '2026-11-21T07:00:00Z')).toBe('2026-11-21T09:00:00.000Z')
    expect(next(triggers, MOSCOW, '2026-11-21T09:00:00Z')).toBe('2026-11-22T06:00:00.000Z')
  })

  it('refuses a moment that is not one and a zone it does not know', () => {
    const daily: ScheduleTrigger[] = [{ kind: 'daily', time: '09:00' }]
    const invalid = () => nextRunOf(daily, MOSCOW, new Date(Number.NaN))
    expect(invalid).toThrow()
    try {
      invalid()
    } catch (error) {
      expect(isDomainError(error)).toBe(true)
    }
    expect(() => nextRunOf(daily, 'Mars/Olympus', at('2026-11-15T00:00:00Z'))).toThrow(
      'Unknown time zone of a scheduled task',
    )
  })
})

describe('nextRunOf across a change of the clocks', () => {
  it('runs a time the clocks skip in Berlin at the first moment after the gap', () => {
    // 29 March 2026: 2:00 CET becomes 3:00 CEST at 01:00 UTC; 2:30 does not exist.
    const daily: ScheduleTrigger[] = [{ kind: 'daily', time: '02:30' }]
    expect(runs(daily, BERLIN, '2026-03-27T12:00:00Z', 3)).toEqual([
      '2026-03-28T01:30:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-30T00:30:00.000Z',
    ])
    // 2:00 itself is skipped too; 3:00 is the first minute of the day after the gap.
    expect(next([{ kind: 'daily', time: '02:00' }], BERLIN, '2026-03-28T12:00:00Z')).toBe(
      '2026-03-29T01:00:00.000Z',
    )
    expect(next([{ kind: 'daily', time: '03:00' }], BERLIN, '2026-03-28T12:00:00Z')).toBe(
      '2026-03-29T01:00:00.000Z',
    )
  })

  it('runs a time the clocks repeat in Berlin once, at the earlier moment', () => {
    // 25 October 2026: 3:00 CEST becomes 2:00 CET at 01:00 UTC; 2:30 happens twice.
    const daily: ScheduleTrigger[] = [{ kind: 'daily', time: '02:30' }]
    expect(runs(daily, BERLIN, '2026-10-24T12:00:00Z', 2)).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
    ])
  })

  it('does the same in New York', () => {
    // 8 March 2026: 2:00 EST becomes 3:00 EDT at 07:00 UTC.
    expect(next([{ kind: 'daily', time: '02:15' }], NEW_YORK, '2026-03-07T12:00:00Z')).toBe(
      '2026-03-08T07:00:00.000Z',
    )
    // 1 November 2026: 2:00 EDT becomes 1:00 EST at 06:00 UTC; 1:30 happens twice.
    expect(runs([{ kind: 'daily', time: '01:30' }], NEW_YORK, '2026-10-31T12:00:00Z', 2)).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
    ])
  })

  it('keeps a weekly run at its wall time on both sides of a change', () => {
    // Sundays at 10:00 in Berlin: +1 after 25 October, +2 before.
    expect(
      runs([{ kind: 'weekly', time: '10:00', days: [7] }], BERLIN, '2026-10-17T12:00:00Z', 2),
    ).toEqual(['2026-10-18T08:00:00.000Z', '2026-10-25T09:00:00.000Z'])
  })

  it('runs hourly every hour of real time, the hour that repeats twice and the skipped one not at all', () => {
    const hourly: ScheduleTrigger[] = [{ kind: 'hourly', minute: 30 }]
    expect(runs(hourly, NEW_YORK, '2026-11-01T04:45:00Z', 3)).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
      '2026-11-01T07:30:00.000Z',
    ])
    expect(runs(hourly, NEW_YORK, '2026-03-08T05:45:00Z', 3)).toEqual([
      '2026-03-08T06:30:00.000Z',
      '2026-03-08T07:30:00.000Z',
      '2026-03-08T08:30:00.000Z',
    ])
    expect(
      dueCountBetween(hourly, NEW_YORK, at('2026-11-01T00:00:00Z'), at('2026-11-02T00:00:00Z')),
    ).toBe(24)
  })

  it('runs a single run in the gap at the first moment after it', () => {
    expect(
      next([{ kind: 'once', date: '2026-03-29', time: '02:30' }], BERLIN, '2026-03-28T00:00:00Z'),
    ).toBe('2026-03-29T01:00:00.000Z')
  })
})

describe('latestDueOf', () => {
  const daily: ScheduleTrigger[] = [{ kind: 'daily', time: '09:00' }]

  it('takes the last run in the span, its ends included', () => {
    expect(
      latestDueOf(
        daily,
        MOSCOW,
        at('2026-11-10T00:00:00Z'),
        at('2026-11-15T07:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-11-15T06:00:00.000Z')
    expect(
      latestDueOf(
        daily,
        MOSCOW,
        at('2026-11-15T06:00:00Z'),
        at('2026-11-15T06:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-11-15T06:00:00.000Z')
    expect(
      latestDueOf(
        daily,
        MOSCOW,
        at('2026-11-10T00:00:00Z'),
        at('2026-11-15T05:59:59Z'),
      )?.toISOString(),
    ).toBe('2026-11-14T06:00:00.000Z')
  })

  it('has none when nothing was due in the span, or the span is turned round', () => {
    expect(
      latestDueOf(daily, MOSCOW, at('2026-11-15T06:01:00Z'), at('2026-11-15T20:00:00Z')),
    ).toBeNull()
    expect(
      latestDueOf(daily, MOSCOW, at('2026-11-16T00:00:00Z'), at('2026-11-15T00:00:00Z')),
    ).toBeNull()
  })

  it('takes the latest of several schedules, hourly and monthly too', () => {
    expect(
      latestDueOf(
        [{ kind: 'hourly', minute: 0 }],
        MOSCOW,
        at('2026-11-15T00:00:00Z'),
        at('2026-11-15T05:30:00Z'),
      )?.toISOString(),
    ).toBe('2026-11-15T05:00:00.000Z')
    expect(
      latestDueOf(
        [
          { kind: 'monthly', time: '10:00', day: 31 },
          { kind: 'weekly', time: '09:00', days: [1] },
        ],
        MOSCOW,
        at('2026-04-01T00:00:00Z'),
        at('2026-05-01T00:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-04-30T07:00:00.000Z')
  })

  it('takes a single run in the span and none past it', () => {
    const once: ScheduleTrigger[] = [{ kind: 'once', date: '2026-11-20', time: '09:00' }]
    expect(
      latestDueOf(
        once,
        MOSCOW,
        at('2026-11-20T00:00:00Z'),
        at('2026-11-20T10:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-11-20T06:00:00.000Z')
    expect(
      latestDueOf(once, MOSCOW, at('2026-11-20T00:00:00Z'), at('2026-11-20T05:59:00Z')),
    ).toBeNull()
  })

  it('takes the earlier of the repeated hour when the span ends between the two', () => {
    expect(
      latestDueOf(
        [{ kind: 'daily', time: '02:30' }],
        BERLIN,
        at('2026-10-24T12:00:00Z'),
        at('2026-10-25T01:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z')
  })
})

describe('dueCountBetween', () => {
  it('counts the runs of a span, both ends included', () => {
    expect(
      dueCountBetween(
        [{ kind: 'hourly', minute: 0 }],
        MOSCOW,
        at('2026-11-15T00:00:00Z'),
        at('2026-11-15T05:30:00Z'),
      ),
    ).toBe(6)
    expect(
      dueCountBetween(
        [{ kind: 'daily', time: '09:00' }],
        MOSCOW,
        at('2026-11-15T06:00:00Z'),
        at('2026-11-17T06:00:00Z'),
      ),
    ).toBe(3)
  })

  it('counts the runs of a week the window prices (Зп30)', () => {
    const from = at('2026-11-15T10:00:00Z')
    const to = new Date(from.getTime() + 7 * 24 * 3_600_000)
    expect(dueCountBetween([{ kind: 'weekdays', time: '09:00' }], MOSCOW, from, to)).toBe(5)
    expect(dueCountBetween([{ kind: 'hourly', minute: 5 }], MOSCOW, from, to)).toBe(168)
    expect(
      dueCountBetween(
        [
          { kind: 'daily', time: '09:00' },
          { kind: 'weekly', time: '12:00', days: [6] },
        ],
        MOSCOW,
        from,
        to,
      ),
    ).toBe(8)
  })

  it('counts nothing in a turned-round span and stops at its cap', () => {
    expect(
      dueCountBetween(
        [{ kind: 'daily', time: '09:00' }],
        MOSCOW,
        at('2026-11-17T00:00:00Z'),
        at('2026-11-15T00:00:00Z'),
      ),
    ).toBe(0)
    expect(
      dueCountBetween(
        [{ kind: 'hourly', minute: 0 }],
        MOSCOW,
        at('2026-01-01T00:00:00Z'),
        at('2028-01-01T00:00:00Z'),
      ),
    ).toBe(DUE_COUNT_CAP)
  })
})

describe('hasFutureRun and scheduleTriggersInPast', () => {
  const now = at('2026-11-15T10:00:00Z')

  it('answers whether the task runs again', () => {
    expect(hasFutureRun([{ kind: 'daily', time: '09:00' }], MOSCOW, now)).toBe(true)
    // 10:00 UTC is 13:00 in Moscow: a run at that very minute is not after it.
    expect(hasFutureRun([{ kind: 'once', date: '2026-11-15', time: '13:00' }], MOSCOW, now)).toBe(
      false,
    )
    expect(hasFutureRun([{ kind: 'once', date: '2026-11-15', time: '13:01' }], MOSCOW, now)).toBe(
      true,
    )
  })

  it('finds a single run in the past even beside a schedule that runs on (Зп15)', () => {
    expect(
      scheduleTriggersInPast(
        [
          { kind: 'daily', time: '09:00' },
          { kind: 'once', date: '2026-11-14', time: '09:00' },
        ],
        MOSCOW,
        now,
      ),
    ).toBe(true)
    expect(scheduleTriggersInPast([{ kind: 'daily', time: '09:00' }], MOSCOW, now)).toBe(false)
    expect(scheduleTriggersInPast([], MOSCOW, now)).toBe(false)
    expect(
      scheduleTriggersInPast([{ kind: 'once', date: '2026-11-16', time: '09:00' }], MOSCOW, now),
    ).toBe(false)
  })
})
