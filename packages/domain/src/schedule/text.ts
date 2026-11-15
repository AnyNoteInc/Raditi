import { pluralRu } from '../plural.ts'
import {
  addDays,
  canonicalTimezone,
  isoWeekday,
  parseCivilDate,
  sameDate,
  wallOf,
} from './calendar.ts'
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  type ScheduleTrigger,
  type ScheduleTriggerKind,
} from './triggers.ts'

/**
 * What the cabinet, the feed and the agent say of a schedule (docs/plan/82-scheduled-tasks.md,
 * §4.1, Зп5–Зп8, Зп12): in Russian, on «вы», times as 9:00. The names of days and months are
 * written here, not asked of `Intl`: every browser says them alike.
 */

/** The days of the week for the window's buttons (Зп8): ISO number, full name, short name. */
export const scheduleWeekdays = Object.freeze([
  { day: 1, name: 'понедельник', short: 'пн' },
  { day: 2, name: 'вторник', short: 'вт' },
  { day: 3, name: 'среда', short: 'ср' },
  { day: 4, name: 'четверг', short: 'чт' },
  { day: 5, name: 'пятница', short: 'пт' },
  { day: 6, name: 'суббота', short: 'сб' },
  { day: 7, name: 'воскресенье', short: 'вс' },
] as const)

const monthsOf = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const

const weekdayName = (day: number): string => scheduleWeekdays[day - 1]?.name ?? ''
const weekdayShort = (day: number): string => scheduleWeekdays[day - 1]?.short ?? ''
const monthOf = (month: number): string => monthsOf[month - 1] ?? ''

/** The frequencies of the window (Зп8), «Только вручную» — no schedule at all. */
export const scheduleFrequencyLabels: Readonly<Record<ScheduleTriggerKind | 'manual', string>> =
  Object.freeze({
    once: 'Один раз',
    hourly: 'Каждый час',
    daily: 'Ежедневно',
    weekdays: 'По будням',
    weekly: 'Еженедельно',
    monthly: 'Ежемесячно',
    manual: 'Только вручную',
  })

/** The hints under a frequency (Зп8). */
export const scheduleFrequencyHints: Readonly<Partial<Record<ScheduleTriggerKind, string>>> =
  Object.freeze({
    weekdays: 'пн–пт, праздники не учитываются',
    monthly: 'в коротком месяце — последний день',
  })

/** A time `HH:MM` as the client reads it: 9:00, 16:30, 0:05. */
export function scheduleTimeText(time: string): string {
  const [hour = '0', minute = '00'] = time.split(':')
  return `${Number(hour)}:${minute}`
}

const clock = (hour: number, minute: number): string => `${hour}:${String(minute).padStart(2, '0')}`

function triggerText(trigger: ScheduleTrigger): string {
  switch (trigger.kind) {
    case 'once': {
      const date = parseCivilDate(trigger.date)
      return `Один раз: ${date.day} ${monthOf(date.month)} ${date.year}, в ${scheduleTimeText(trigger.time)}`
    }
    case 'hourly':
      return trigger.minute === 0
        ? 'Каждый час, в начале часа'
        : `Каждый час, в ${trigger.minute} ${pluralRu(trigger.minute, 'минуту', 'минуты', 'минут')}`
    case 'daily':
      return `Ежедневно в ${scheduleTimeText(trigger.time)}`
    case 'weekdays':
      return `По будням в ${scheduleTimeText(trigger.time)}`
    case 'weekly': {
      const days =
        trigger.days.length === 1
          ? weekdayName(trigger.days[0] ?? 1)
          : trigger.days.map(weekdayShort).join(', ')
      return `Еженедельно: ${days}, в ${scheduleTimeText(trigger.time)}`
    }
    case 'monthly':
      return `Ежемесячно: ${trigger.day}-го числа, в ${scheduleTimeText(trigger.time)}`
  }
}

/**
 * The schedules in words: «Ежедневно в 9:00», «По будням в 8:00», «Еженедельно: пятница, в
 * 16:00», «Еженедельно: пн, ср, пт, в 9:00», «Ежемесячно: 1-го числа, в 10:00», «Каждый час, в 15
 * минут», «Один раз: 20 ноября 2026, в 9:00», «Только вручную»; several — through «; »; a zone
 * other than Moscow is named after them: « (по времени Новосибирска)».
 */
export function scheduleText(triggers: readonly ScheduleTrigger[], timezone: string): string {
  if (triggers.length === 0) return scheduleFrequencyLabels.manual
  return `${triggers.map(triggerText).join('; ')}${timezoneSuffix(timezone)}`
}

/**
 * A run on the wall clock of the task's zone, as near to `now` as it is: «сегодня в 9:00»,
 * «завтра в 9:00», «вчера в 9:00», «пятница, 20 ноября, в 16:00» — and the year when it is not
 * this one. The zone is not named: the schedule names it.
 */
export function runMomentText(at: Date, timezone: string, now: Date): string {
  const wall = wallOf(at, timezone)
  const today = wallOf(now, timezone)
  const time = clock(wall.hour, wall.minute)
  if (sameDate(wall, today)) return `сегодня в ${time}`
  if (sameDate(wall, addDays(today, 1))) return `завтра в ${time}`
  if (sameDate(wall, addDays(today, -1))) return `вчера в ${time}`
  return `${weekdayName(isoWeekday(wall))}, ${runDateText(at, timezone, now)}, в ${time}`
}

/** The date of a run: «20 ноября», and the year when it is not this one — «Завершена 20 ноября». */
export function runDateText(at: Date, timezone: string, now: Date): string {
  const wall = wallOf(at, timezone)
  const year = wall.year === wallOf(now, timezone).year ? '' : ` ${wall.year}`
  return `${wall.day} ${monthOf(wall.month)}${year}`
}

export interface TimezoneChoice {
  /** The zone as `Intl` names it in V8: the choices are stored as they are. */
  readonly id: string
  /** The city of the list: «Новосибирск». */
  readonly label: string
  /** The city after «по времени»: «Новосибирска». */
  readonly genitive: string
}

/**
 * The zones of Russia and the CIS offered in «Дополнительные настройки» (Зп12), west to east; a
 * zone of the task or the browser outside them is offered with them by its id.
 */
export const timezoneChoices: readonly TimezoneChoice[] = Object.freeze([
  { id: 'Europe/Kaliningrad', label: 'Калининград', genitive: 'Калининграда' },
  { id: 'Europe/Moscow', label: 'Москва', genitive: 'Москвы' },
  { id: 'Europe/Samara', label: 'Самара', genitive: 'Самары' },
  { id: 'Asia/Yekaterinburg', label: 'Екатеринбург', genitive: 'Екатеринбурга' },
  { id: 'Asia/Omsk', label: 'Омск', genitive: 'Омска' },
  { id: 'Asia/Novosibirsk', label: 'Новосибирск', genitive: 'Новосибирска' },
  { id: 'Asia/Krasnoyarsk', label: 'Красноярск', genitive: 'Красноярска' },
  { id: 'Asia/Irkutsk', label: 'Иркутск', genitive: 'Иркутска' },
  { id: 'Asia/Yakutsk', label: 'Якутск', genitive: 'Якутска' },
  { id: 'Asia/Vladivostok', label: 'Владивосток', genitive: 'Владивостока' },
  { id: 'Asia/Magadan', label: 'Магадан', genitive: 'Магадана' },
  {
    id: 'Asia/Kamchatka',
    label: 'Петропавловск-Камчатский',
    genitive: 'Петропавловска-Камчатского',
  },
  { id: 'Europe/Minsk', label: 'Минск', genitive: 'Минска' },
  { id: 'Europe/Chisinau', label: 'Кишинёв', genitive: 'Кишинёва' },
  { id: 'Asia/Yerevan', label: 'Ереван', genitive: 'Еревана' },
  { id: 'Asia/Baku', label: 'Баку', genitive: 'Баку' },
  { id: 'Asia/Ashgabat', label: 'Ашхабад', genitive: 'Ашхабада' },
  { id: 'Asia/Tashkent', label: 'Ташкент', genitive: 'Ташкента' },
  { id: 'Asia/Dushanbe', label: 'Душанбе', genitive: 'Душанбе' },
  { id: 'Asia/Almaty', label: 'Алматы', genitive: 'Алматы' },
  { id: 'Asia/Bishkek', label: 'Бишкек', genitive: 'Бишкека' },
])

/** The choice of a zone, by the name `Intl` gives it; undefined — a zone outside the list. */
export function timezoneChoiceOf(timezone: string): TimezoneChoice | undefined {
  const id = canonicalTimezone(timezone) ?? timezone
  return timezoneChoices.find((choice) => choice.id === id || canonicalTimezone(choice.id) === id)
}

/** A zone in the list of the window: its city, or its id when it is not one of ours. */
export const timezoneLabel = (timezone: string): string =>
  timezoneChoiceOf(timezone)?.label ?? timezone

/**
 * What follows a time of a zone other than Moscow (Зп12): « (по времени Новосибирска)», for a zone
 * outside the list « (по поясу Europe/Berlin)»; Moscow — nothing.
 */
export function timezoneSuffix(timezone: string): string {
  const id = canonicalTimezone(timezone) ?? timezone
  if (id === DEFAULT_SCHEDULE_TIMEZONE) return ''
  const choice = timezoneChoiceOf(id)
  return choice ? ` (по времени ${choice.genitive})` : ` (по поясу ${id})`
}
