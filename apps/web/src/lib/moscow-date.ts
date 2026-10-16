const NBSP = '\u00a0'

// The time zone is named, so the server and every browser print the same day.
const moscowDay = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Moscow',
})

function partsOf(instant: Date): Map<string, string> {
  return new Map(moscowDay.formatToParts(instant).map(({ type, value }) => [type, value]))
}

/** «18 октября»: the Moscow calendar day of an instant. The number stays with the month. */
export function formatMoscowDay(instant: Date): string {
  const parts = partsOf(instant)
  return `${parts.get('day') ?? ''}${NBSP}${parts.get('month') ?? ''}`
}

const moscowTime = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Moscow',
})

/** «18 октября 2026, 12:40»: an instant by the Moscow clock. */
export function formatMoscowMoment(instant: Date): string {
  const time = new Map(moscowTime.formatToParts(instant).map(({ type, value }) => [type, value]))
  return `${formatMoscowDate(instant)}, ${time.get('hour') ?? ''}:${time.get('minute') ?? ''}`
}

/** «18 октября 2026»: the same day with its year, without the «г.» of the locale. */
export function formatMoscowDate(instant: Date): string {
  return `${formatMoscowDay(instant)} ${partsOf(instant).get('year') ?? ''}`
}
