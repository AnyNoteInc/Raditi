import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatMoscowDate, formatMoscowDay, nextMoscowMidnight } from './moscow-date'

const NBSP = String.fromCharCode(0xa0)

/* eslint-disable turbo/no-undeclared-env-vars -- TZ is the time zone switch of Node itself, not a setting of the app. */
const machineZone = process.env.TZ

function setZone(zone: string | undefined) {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
}
/* eslint-enable turbo/no-undeclared-env-vars */

afterEach(() => {
  setZone(machineZone)
  vi.resetModules()
})

describe('Moscow dates', () => {
  it('prints the day in the Russian long form, without the «г.» of the locale', () => {
    const instant = new Date('2026-10-18T09:00:00Z')

    expect(formatMoscowDate(instant)).toBe(`18${NBSP}октября 2026`)
    expect(formatMoscowDay(instant)).toBe(`18${NBSP}октября`)
  })

  it('takes the calendar day of Moscow, where midnight is 21:00 UTC', () => {
    expect(formatMoscowDate(new Date('2026-12-31T20:59:59Z'))).toBe(`31${NBSP}декабря 2026`)
    expect(formatMoscowDate(new Date('2026-12-31T21:00:00Z'))).toBe(`1${NBSP}января 2027`)
    expect(formatMoscowDay(new Date('2026-03-01T00:30:00+03:00'))).toBe(`1${NBSP}марта`)
  })

  it('finds the midnight in Moscow that starts the next day', () => {
    const midnight = new Date('2026-10-04T21:00:00Z')
    expect(nextMoscowMidnight(new Date('2026-10-04T09:00:00Z'))).toEqual(midnight)
    expect(nextMoscowMidnight(new Date('2026-10-03T21:00:00Z'))).toEqual(midnight)
    expect(nextMoscowMidnight(new Date('2026-10-04T20:59:59.999Z'))).toEqual(midnight)
    // midnight itself starts a day: the next one is a day later
    expect(nextMoscowMidnight(midnight)).toEqual(new Date('2026-10-05T21:00:00Z'))
  })

  it.each(['America/Los_Angeles', 'Asia/Vladivostok', 'UTC'])(
    'prints the same day on a server and in a browser that live in %s',
    async (zone) => {
      // The module is loaded anew under the zone: a formatter keeps the zone it was made in.
      setZone(zone)
      vi.resetModules()
      const dates = await import('./moscow-date')

      // The zone did change: the machine's own clock reads the instant differently.
      expect(new Date('2026-10-04T21:30:00Z').getHours()).not.toBe(0)
      expect(dates.formatMoscowDate(new Date('2026-10-04T21:30:00Z'))).toBe(`5${NBSP}октября 2026`)
      expect(dates.formatMoscowDay(new Date('2026-10-04T20:30:00Z'))).toBe(`4${NBSP}октября`)
    },
  )
})
