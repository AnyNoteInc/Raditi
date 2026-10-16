import { giftTaskCounts, minStartCredits } from '@repo/domain'

const NBSP = '\u00a0'
const DAY_MS = 86_400_000

/**
 * "12 900 ₽", "1 990,50 ₽": an amount as amountRubSchema prints it ("12900.00"), for reading.
 * Mirrors formatRubles of the landing and works on the digits themselves, so money never
 * becomes a binary floating point number. The spaces do not break.
 */
export function formatRubles(amount: string): string {
  const [rubles = '0', kopecks = '00'] = amount.split('.')
  const grouped = rubles.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
  return `${grouped}${kopecks === '00' ? '' : `,${kopecks}`}${NBSP}₽`
}

/**
 * "300", "2 500": a count of credits for reading, its digits in groups of three as an amount is
 * grouped. The spaces do not break.
 */
export function formatCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
}

function partsOf(format: Intl.DateTimeFormat, instant: Date): Map<string, string> {
  return new Map(format.formatToParts(instant).map(({ type, value }) => [type, value]))
}

const moscowDate = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Moscow',
})

/** "18 октября 2026": the Moscow calendar day of an instant, without the «г.» of the locale. */
export function formatMoscowDate(iso: string): string {
  const parts = partsOf(moscowDate, new Date(iso))
  return `${parts.get('day') ?? ''}${NBSP}${parts.get('month') ?? ''} ${parts.get('year') ?? ''}`
}

const moscowDayNumbers = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  timeZone: 'Europe/Moscow',
})

/** The Moscow calendar day of an instant as a count of days, so two of them can be subtracted. */
function moscowDayNumber(instant: Date): number {
  const parts = partsOf(moscowDayNumbers, instant)
  const year = Number(parts.get('year'))
  const month = Number(parts.get('month'))
  return Date.UTC(year, month - 1, Number(parts.get('day'))) / DAY_MS
}

/**
 * Calendar days in Moscow from `now` to the instant: 0 the same day, 1 tomorrow, negative when
 * the day has passed. Not a count of 24-hour spans: 23:50 to 00:10 is one day.
 */
export function moscowDaysUntil(iso: string, now: Date): number {
  return moscowDayNumber(new Date(iso)) - moscowDayNumber(now)
}

/** The form of a Russian noun that goes with the number: 1 день, 2 дня, 5 дней. */
export function plural(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100
  if (lastTwo >= 11 && lastTwo <= 14) return many
  if (count % 10 === 1) return one
  if (count % 10 >= 2 && count % 10 <= 4) return few
  return many
}

const FEMININE_COUNTS = [
  'одну',
  'две',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
  'десять',
]

/** «семь», «две»: how many of a feminine thing after «на» — a word up to ten, digits above. */
const countWord = (count: number) => FEMININE_COUNTS[count - 1] ?? String(count)

/**
 * «на семь небольших правок или на две-три задачи побольше»: what a number of gift credits is
 * enough for, by the counts of the domain (`giftTaskCounts`). Without the larger tasks when the
 * credits hold none; null when they are not enough for one small edit. Mirrors `giftIsEnoughFor`
 * of the settings pages, so the letter and the page promise the same.
 */
export function giftIsEnoughFor(credits: number): string | null {
  const { small, larger } = giftTaskCounts(credits)
  if (small === 0) return null
  const edits = `на ${countWord(small)} ${plural(small, 'небольшую правку', 'небольшие правки', 'небольших правок')}`
  if (larger.from === 0) return edits
  const range =
    larger.from === larger.to
      ? countWord(larger.to)
      : `${countWord(larger.from)}-${countWord(larger.to)}`
  return `${edits} или на ${range} ${plural(larger.to, 'задачу', 'задачи', 'задач')} побольше`
}

/**
 * The gift credits that are left can start a task: new tasks are taken without a paid tariff.
 * Mirrors `giftTakesTasks` of the settings pages, so a letter about a tariff that is not paid
 * for or has ended says of new tasks what the page it leads to says.
 */
export function giftTakesTasks(giftCredits: number): boolean {
  return giftCredits >= minStartCredits
}

/**
 * What a letter says of new tasks while no tariff is paid for, after «новые задачи»: `refused`,
 * unless the gift credits that are left can start a task.
 */
export function tasksWithoutTariff(giftCredits: number, refused: string): string {
  return giftTakesTasks(giftCredits) ? 'принимаются, только пока есть подарочные кредиты' : refused
}

/** The «Тарифы» page of the app: every billing letter sends the reader there. */
export function plansUrl(appUrl: string): string {
  return new URL('/settings/plans', appUrl).href
}
