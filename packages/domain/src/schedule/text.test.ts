import { describe, expect, it } from 'vitest'

import { canonicalTimezone } from './triggers.ts'
import {
  runDateText,
  runMomentText,
  scheduleFrequencyHints,
  scheduleFrequencyLabels,
  scheduleText,
  scheduleTimeText,
  scheduleWeekdays,
  timezoneChoiceOf,
  timezoneChoices,
  timezoneLabel,
  timezoneSuffix,
} from './text.ts'

const MOSCOW = 'Europe/Moscow'

describe('scheduleText', () => {
  it('says each frequency as the plan words it', () => {
    expect(scheduleText([{ kind: 'daily', time: '09:00' }], MOSCOW)).toBe('Ежедневно в 9:00')
    expect(scheduleText([{ kind: 'weekdays', time: '08:00' }], MOSCOW)).toBe('По будням в 8:00')
    expect(scheduleText([{ kind: 'weekly', time: '16:00', days: [5] }], MOSCOW)).toBe(
      'Еженедельно: пятница, в 16:00',
    )
    expect(scheduleText([{ kind: 'weekly', time: '09:00', days: [1, 3, 5] }], MOSCOW)).toBe(
      'Еженедельно: пн, ср, пт, в 9:00',
    )
    expect(scheduleText([{ kind: 'monthly', time: '10:00', day: 1 }], MOSCOW)).toBe(
      'Ежемесячно: 1-го числа, в 10:00',
    )
    expect(scheduleText([{ kind: 'monthly', time: '10:00', day: 31 }], MOSCOW)).toBe(
      'Ежемесячно: 31-го числа, в 10:00',
    )
    expect(scheduleText([{ kind: 'hourly', minute: 15 }], MOSCOW)).toBe('Каждый час, в 15 минут')
    expect(scheduleText([{ kind: 'once', date: '2026-11-20', time: '09:00' }], MOSCOW)).toBe(
      'Один раз: 20 ноября 2026, в 9:00',
    )
    expect(scheduleText([], MOSCOW)).toBe('Только вручную')
  })

  it('says the minute of an hourly run in its number', () => {
    expect(scheduleText([{ kind: 'hourly', minute: 1 }], MOSCOW)).toBe('Каждый час, в 1 минуту')
    expect(scheduleText([{ kind: 'hourly', minute: 21 }], MOSCOW)).toBe('Каждый час, в 21 минуту')
    expect(scheduleText([{ kind: 'hourly', minute: 3 }], MOSCOW)).toBe('Каждый час, в 3 минуты')
    expect(scheduleText([{ kind: 'hourly', minute: 11 }], MOSCOW)).toBe('Каждый час, в 11 минут')
    expect(scheduleText([{ kind: 'hourly', minute: 0 }], MOSCOW)).toBe('Каждый час, в начале часа')
  })

  it('joins several schedules with «; » and names a zone other than Moscow once', () => {
    expect(
      scheduleText(
        [
          { kind: 'daily', time: '09:00' },
          { kind: 'weekly', time: '12:00', days: [6] },
        ],
        MOSCOW,
      ),
    ).toBe('Ежедневно в 9:00; Еженедельно: суббота, в 12:00')
    expect(scheduleText([{ kind: 'daily', time: '09:00' }], 'Asia/Novosibirsk')).toBe(
      'Ежедневно в 9:00 (по времени Новосибирска)',
    )
    expect(
      scheduleText(
        [
          { kind: 'weekdays', time: '07:30' },
          { kind: 'monthly', time: '10:00', day: 15 },
        ],
        'Asia/Yekaterinburg',
      ),
    ).toBe('По будням в 7:30; Ежемесячно: 15-го числа, в 10:00 (по времени Екатеринбурга)')
    expect(scheduleText([{ kind: 'daily', time: '09:00' }], 'Europe/Kaliningrad')).toBe(
      'Ежедневно в 9:00 (по времени Калининграда)',
    )
    expect(scheduleText([], 'Asia/Novosibirsk')).toBe('Только вручную')
  })

  it('names a zone outside the list by its id', () => {
    expect(scheduleText([{ kind: 'daily', time: '09:00' }], 'Europe/Berlin')).toBe(
      'Ежедневно в 9:00 (по поясу Europe/Berlin)',
    )
  })
})

describe('runMomentText', () => {
  // Sunday 15 November 2026, 13:00 in Moscow.
  const now = new Date('2026-11-15T10:00:00Z')

  it('says today, tomorrow and yesterday in words', () => {
    expect(runMomentText(new Date('2026-11-15T13:00:00Z'), MOSCOW, now)).toBe('сегодня в 16:00')
    expect(runMomentText(new Date('2026-11-16T06:00:00Z'), MOSCOW, now)).toBe('завтра в 9:00')
    expect(runMomentText(new Date('2026-11-14T06:05:00Z'), MOSCOW, now)).toBe('вчера в 9:05')
  })

  it('says another day with its weekday and date, and the year when it is not this one', () => {
    expect(runMomentText(new Date('2026-11-20T13:00:00Z'), MOSCOW, now)).toBe(
      'пятница, 20 ноября, в 16:00',
    )
    expect(runMomentText(new Date('2027-01-01T06:00:00Z'), MOSCOW, now)).toBe(
      'пятница, 1 января 2027, в 9:00',
    )
  })

  it('reads the day on the wall clock of the zone', () => {
    // 22:30 UTC on the 15th is the 16th in Novosibirsk.
    expect(runMomentText(new Date('2026-11-15T22:30:00Z'), 'Asia/Novosibirsk', now)).toBe(
      'завтра в 5:30',
    )
    expect(runMomentText(new Date('2026-11-15T20:30:00Z'), MOSCOW, now)).toBe('сегодня в 23:30')
  })

  it('says the date of a finished task', () => {
    expect(runDateText(new Date('2026-11-20T13:00:00Z'), MOSCOW, now)).toBe('20 ноября')
    expect(runDateText(new Date('2025-12-31T13:00:00Z'), MOSCOW, now)).toBe('31 декабря 2025')
  })
})

describe('the words of the window', () => {
  it('formats a time as the client reads it', () => {
    expect(scheduleTimeText('09:00')).toBe('9:00')
    expect(scheduleTimeText('16:30')).toBe('16:30')
    expect(scheduleTimeText('00:05')).toBe('0:05')
  })

  it('names the frequencies and the days of the week', () => {
    expect(Object.values(scheduleFrequencyLabels)).toEqual([
      'Один раз',
      'Каждый час',
      'Ежедневно',
      'По будням',
      'Еженедельно',
      'Ежемесячно',
      'Только вручную',
    ])
    expect(scheduleFrequencyHints.weekdays).toBe('пн–пт, праздники не учитываются')
    expect(scheduleFrequencyHints.monthly).toBe('в коротком месяце — последний день')
    expect(scheduleWeekdays.map((day) => day.day)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(scheduleWeekdays[0]?.name).toBe('понедельник')
    expect(scheduleWeekdays[6]?.short).toBe('вс')
  })
})

describe('the zones of Russia and the CIS', () => {
  it('are zones Intl knows, by the names it gives them, each once', () => {
    for (const choice of timezoneChoices)
      expect(canonicalTimezone(choice.id), choice.id).toBe(choice.id)
    expect(new Set(timezoneChoices.map((choice) => choice.id)).size).toBe(timezoneChoices.length)
    expect(timezoneChoices.some((choice) => choice.id === MOSCOW)).toBe(true)
  })

  it('name their cities, in the list and after «по времени»', () => {
    expect(timezoneLabel('Asia/Novosibirsk')).toBe('Новосибирск')
    expect(timezoneChoiceOf('asia/novosibirsk')?.genitive).toBe('Новосибирска')
    expect(timezoneLabel('Europe/Berlin')).toBe('Europe/Berlin')
    expect(timezoneSuffix(MOSCOW)).toBe('')
    expect(timezoneSuffix('Asia/Vladivostok')).toBe(' (по времени Владивостока)')
    expect(timezoneSuffix('Asia/Almaty')).toBe(' (по времени Алматы)')
  })
})
