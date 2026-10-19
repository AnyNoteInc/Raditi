import { minTaskChargeCredits } from '@repo/domain/billing/credit-numbers'

import { formatCount } from '@/lib/count'
import { formatMoscowDate, formatMoscowDay } from '@/lib/moscow-date'
import { plural } from '@/lib/plural'
import { formatRubles } from '@/lib/rubles'

import type { TariffDay, TaskCredits } from './billing-types'
import {
  creditsOf,
  creditsWord,
  giftOnHand,
  noGiftToSpeakOf,
  type GiftCredits,
} from './plan-format'
import { noticeText, RATE_PAUSE, taskNotice } from './task-notice'

// The sentences of «Использование». They come out with plain spaces: the component that prints
// one passes it through nbsp(); the names of the meters are read by assistive technology as
// they are.

/**
 * What the quota of a period went to, as the billing router sends it: what was granted is what
 * was charged, what is set aside, what expired and what is left. `heldEarlier` stands beside
 * them: credits of the period before, still set aside for a task in work.
 */
export interface TariffCredits {
  granted: number
  charged: number
  held: number
  expired: number
  left: number
  heldEarlier: number
}

/** What the page needs to know about the tariff to say what comes next. */
export interface TariffState {
  status: 'trial' | 'active' | 'past_due'
  periodEnd: Date
  autoRenewal: boolean
  /** The tariff of the next period: the scheduled one, else the current. */
  nextPlan: { name: string; creditsPerMonth: number; creditsPerDay: number | null }
  /** A change of the tariff is scheduled for the next period. */
  changes: boolean
}

const yearOf = (instant: Date) => formatMoscowDate(instant).slice(-4)

/** «Тариф «Бизнес» · 18 сентября — 18 октября 2026»: the tariff and its current period. */
export function usagePeriod(planName: string, period: { start: Date; end: Date }): string {
  // The year is said once unless the period crosses the new year.
  const from =
    yearOf(period.start) === yearOf(period.end)
      ? formatMoscowDay(period.start)
      : formatMoscowDate(period.start)
  return `Тариф «${planName}» · ${from} — ${formatMoscowDate(period.end)}`
}

/** The words after the headline number: «кредитов осталось», «кредит остался». */
export function creditsLeftWords(count: number): string {
  return plural(count, 'кредит остался', 'кредита осталось', 'кредитов осталось')
}

// What the quota still holds is «осталось» while the period runs. The period of a tariff that
// is not paid for is over (`periodOver`): what it did not use is not carried over, so it is
// «не использовано», not something the customer has left.

/**
 * The accessible name of the tariff meter: every number its legend shows, in one sentence.
 * What expired is said only when something did — credits of this period that are gone without
 * a charge, or that an operator took off the account.
 */
export function tariffMeterLabel(
  { granted, charged, held, expired, left }: TariffCredits,
  periodOver: boolean,
): string {
  const rest = periodOver ? 'не использовано' : 'осталось'
  const gone = expired > 0 ? `, ${formatCount(expired)} сгорело` : ''
  return `Из ${formatCount(granted)} ${creditsOf(granted)} по тарифу: ${formatCount(charged)} списано, ${formatCount(held)} отложено под задачи в работе, ${formatCount(left)} ${rest}${gone}`
}

/** «Осталось — 45»: the entry of the tariff legend for what the quota still holds. */
export function tariffRestEntry(left: number, periodOver: boolean): string {
  return `${periodOver ? 'Не использовано' : 'Осталось'} — ${formatCount(left)}`
}

/**
 * Under the meter, while credits are set aside for tasks in work: what becomes of them. The
 * number is the minimum of a done task, a constant of the credits model.
 */
export function heldNote(): string {
  return `Отложенное спишем по факту: сколько уйдёт на работу, но не меньше ${minTaskChargeCredits} ${creditsOf(minTaskChargeCredits)} за выполненную задачу. Остальное вернётся.`
}

/**
 * Beside the meter: credits of the period before, still set aside for a task in work. They are
 * not of the new quota, and what the task does not use is not carried into it.
 */
export function heldEarlierNote(heldEarlier: number): string {
  const setAside = plural(heldEarlier, 'отложен', 'отложено', 'отложено')
  return `Ещё ${formatCount(heldEarlier)} ${creditsWord(heldEarlier)} прошлого периода ${setAside} под задачу в работе. Что не уйдёт на неё, в новый период не перейдёт.`
}

/** What happens to the tariff credits when the period ends. */
export function tariffNote({
  status,
  periodEnd,
  autoRenewal,
  nextPlan,
  changes,
}: TariffState): string {
  const day = formatMoscowDay(periodEnd)
  const quota = nextPlan.creditsPerMonth
  if (status === 'past_due') {
    return `Период тарифа закончился ${day}. Новые кредиты начислим после оплаты, остаток прошлого периода не переносится.`
  }
  if (!autoRenewal) {
    return `Тариф действует до ${day} и не продлится. Остаток по тарифу после этого сгорит.`
  }
  const grant = changes
    ? `${day} начислим ${formatCount(quota)} ${creditsWord(quota)} по тарифу «${nextPlan.name}».`
    : `${day} начислим новые ${formatCount(quota)}.`
  return `${grant} Остаток по тарифу на новый период не переносится.`
}

/** « Ещё 5 отложено под задачи в работе.»: credits of an account that tasks have set aside. */
const inWork = (held: number) =>
  held > 0 ? ` Ещё ${formatCount(held)} отложено под задачи в работе.` : ''

/**
 * What the customer should know about the gift credits: they do not expire, and where they
 * stand in the order the credits are spent in.
 */
export function giftNote(gift: { held: number }): string {
  return `Не сгорают. Тратятся после кредитов по тарифу и раньше кредитов из пакета.${inWork(gift.held)}`
}

/**
 * What the customer should know about the credits of their packs: they are spent last, after
 * the credits of the tariff and the gift ones. `takesTasks` is false while the tariff is not
 * paid for: no task spends a pack credit then, whatever is left on the account.
 */
export function packNote(
  pack: { left: number; held: number },
  before: { tariff: number; gift: number },
  takesTasks: boolean,
): string {
  if (pack.left === 0) {
    return `Кредиты из пакета не сгорают и тратятся последними — после кредитов по тарифу и подарочных.${inWork(pack.held)}`
  }
  const when = !takesTasks
    ? 'Станут доступны после оплаты тарифа.'
    : before.tariff > 0
      ? before.gift > 0
        ? 'Начнут тратиться, когда закончатся кредиты по тарифу и подарочные.'
        : 'Начнут тратиться, когда закончатся кредиты по тарифу.'
      : before.gift > 0
        ? 'Начнут тратиться, когда закончатся подарочные кредиты.'
        : 'Сейчас задачи тратят их: кредиты по тарифу закончились.'
  return `Кредиты из пакета не сгорают. ${when}${inWork(pack.held)}`
}

/**
 * What is said of a tariff that is not paid for while new tasks are still taken — on the gift
 * credits, by the answer of the server. When they are not, the notice of the refusal says why.
 */
export function unpaidWhileTasksTaken(): string {
  return 'Оплата тарифа не прошла. Пока она не пройдёт, новые задачи принимаются, только пока есть подарочные кредиты.'
}

/**
 * «Купить ещё 100 кредитов — 1 990 ₽»: the label of the button that offers the pack. `price` is
 * the amount as the server sends it; `more` is false when no credit is left at all. The name of
 * a button keeps plain spaces, the amount included: the button itself does not wrap.
 */
export function buyPackLabel(credits: number, price: string, more: boolean): string {
  const amount = formatRubles(price).replaceAll(String.fromCharCode(0xa0), ' ')
  return `Купить ${more ? 'ещё ' : ''}${formatCount(credits)} ${creditsWord(credits)} — ${amount} ₽`
}

// The day counts the tariff credits taken since midnight in Moscow: what reserves placed that
// day set aside, what they paid once their tasks were charged, and what a charge took of free
// tariff credits in place of a gift or pack reserve. Gift and pack credits are outside it.

/** «из 100 кредитов»: the daily limit after the tariff credits the day has taken. */
export function ofDailyLimit(limit: number): string {
  return `из ${formatCount(limit)} ${creditsOf(limit)}`
}

/**
 * «Сегодня из 100 кредитов: 5 списано, 45 отложено под задачи в работе, 50 осталось»: the
 * accessible name of the meter of the day, in the order of its parts. What is left is `left`:
 * what the tariff can still give today — less than the room of the day when the month has less.
 */
export function todayMeterLabel({ limit, charged, held, left }: TariffDay & { limit: number }) {
  return `Сегодня ${ofDailyLimit(limit)}: ${formatCount(charged)} списано, ${formatCount(held)} отложено под задачи в работе, ${formatCount(left)} осталось`
}

/**
 * «Сегодня потрачено 50 кредитов из 100: 5 списано и 45 отложено под задачи в работе.»: what the
 * day has taken; null while it has taken nothing or the tariff has no daily limit.
 */
export function todaySpent({ limit, charged, held, used }: TariffDay): string | null {
  if (limit === null || used === 0) return null
  const spent = `Сегодня ${plural(used, 'потрачен', 'потрачено', 'потрачено')} ${formatCount(used)} ${creditsWord(used)} из ${formatCount(limit)}`
  if (held === 0) return `${spent}.`
  const paid = charged === 0 ? '' : `${formatCount(charged)} списано и `
  return `${spent}: ${paid}${formatCount(held)} отложено под задачи в работе.`
}

/** Said of every tariff with a daily limit: the day caps tariff credits only. */
export const OUTSIDE_THE_DAY =
  'Подарочные кредиты и кредиты из пакета дневным лимитом не ограничены.'

/**
 * What the day of the tariff still gives. `today` null: the tariff is not paid; `paid` is false
 * then, and tasks are taken only on gift credits — while the gift still carries them
 * (`tasksTaken`, `giftCarriesTasks`: one would be taken now, or what refuses it is of the moment
 * and the notice of the page names the next one). `tomorrow`: the daily limit the tariff gives
 * when the next Moscow day starts (`dayLimitTomorrow`); null when it will give nothing then.
 *
 * The number is `today.left`: what is left of the day, or what the tariff has free when that is
 * less. When the month itself is spent nothing is said of the day: the credits say «Лимиты
 * закончились»; and once the day is spent too, nothing is promised of tomorrow (`tomorrow` null).
 */
export function todayNote(input: {
  today: TariffDay | null
  paid: boolean
  tasksTaken: boolean
  tomorrow: number | null
}): string {
  const { today, paid, tasksTaken, tomorrow } = input
  if (!paid || today === null) {
    return tasksTaken
      ? 'Пока тариф не оплачен, новые задачи принимаются, только пока есть подарочные кредиты.'
      : 'Новые задачи не принимаются, пока не оплачен тариф.'
  }
  const { limit, room, left } = today
  if (limit === null || room === null) return 'Дневного лимита на вашем тарифе нет.'
  let day: string | null = null
  if (room === 0) {
    day =
      tomorrow !== null
        ? `Кредиты по тарифу на сегодня закончились — завтра снова можно будет потратить до ${formatCount(tomorrow)}.`
        : 'Кредиты по тарифу на сегодня закончились.'
  } else if (left > 0) {
    const more = `Сегодня можно потратить ещё ${formatCount(left)} ${creditsWord(left)}`
    // Tasks in work hold tariff credits that come back when they end: «свободно», not «осталось».
    day = left < room ? `${more} по тарифу — столько их сейчас свободно.` : `${more}.`
  }
  return day === null ? OUTSIDE_THE_DAY : `${day} ${OUTSIDE_THE_DAY}`
}

const sitesWord = (count: number) => plural(count, 'сайт', 'сайта', 'сайтов')

/** «из 3 сайтов»: the site limit after the number of sites. */
export function ofSiteLimit(max: number): string {
  return `из ${max} ${plural(max, 'сайта', 'сайтов', 'сайтов')}`
}

/** «Добавлено 2 сайта из 3»: the accessible name of the meter of sites. */
export function sitesMeterLabel(count: number, max: number): string {
  return `${plural(count, 'Добавлен', 'Добавлено', 'Добавлено')} ${count} ${sitesWord(count)} из ${max}`
}

/** How many more sites the tariff takes. */
export function sitesNote(count: number, max: number): string {
  if (count > max) return 'Сайтов больше, чем входит в тариф: новый добавить нельзя.'
  if (count === max) return 'Больше сайтов на этом тарифе добавить нельзя.'
  const room = max - count
  return `Можно добавить ещё ${room === 1 ? 'один сайт' : `${room} ${sitesWord(room)}`}.`
}

/**
 * «У вас 100 кредитов из пакета. Они не сгорают и снова будут доступны, когда вы выберете тариф.»:
 * the pack credits of a customer without a tariff.
 */
export function packCredits(count: number): string {
  const kept = plural(
    count,
    'Он не сгорает и снова будет доступен',
    'Они не сгорают и снова будут доступны',
    'Они не сгорают и снова будут доступны',
  )
  return `У вас ${formatCount(count)} ${creditsWord(count)} из пакета. ${kept}, когда вы выберете тариф.`
}

/**
 * The block «Тариф не выбран» of «Использование». While a task would be taken: the gift
 * credits a customer without a tariff can spend — they are the bound, there is no day without a
 * tariff. Otherwise what stands in the way of a new task, by the answer of the server
 * (`taskNotice`) — or, with no gift to speak of, that credits come with a tariff. `packLeft`:
 * credits of a pack that wait for one.
 */
export function usageWithoutTariff(gift: GiftCredits, task: TaskCredits, packLeft: number): string {
  if (task.newTask.allowed) {
    const kept = plural(gift.available, 'Он не сгорает', 'Они не сгорают', 'Они не сгорают')
    return `${giftOnHand(gift.available)}. ${kept}, а задачи принимаются, пока подарочные кредиты не закончатся. Здесь видно, сколько кредитов осталось и на что они ушли.`
  }
  if (noGiftToSpeakOf(gift, task)) {
    return 'Кредиты входят в тариф. Выберите тариф, чтобы ставить задачи: здесь появится, сколько кредитов осталось и на что они ушли.'
  }
  const notice = taskNotice({
    task,
    giftLeft: gift.available,
    packLeft,
    tariff: null,
    pack: null,
    canResume: false,
  })
  if (notice === null) return ''
  // The pause is the platform's: what the customer has is said before it.
  const pause = task.newTask.reason === 'rate_missing' && gift.available > 0
  return pause ? `${giftOnHand(gift.available)}. ${RATE_PAUSE}` : noticeText(notice)
}

export type UsageOutcome = 'charged' | 'held' | 'unpaid' | 'free'

/** Credits by the account they are of, in the order credits are spent. */
export interface CreditsByAccount {
  tariff: number
  gift: number
  pack: number
}

/** «5 по тарифу и 12 из пакета»: which accounts paid, when more than one did; null for one. */
function paidFrom({ tariff, gift, pack }: CreditsByAccount): string | null {
  const parts = [
    tariff > 0 ? `${formatCount(tariff)} по тарифу` : null,
    gift > 0
      ? `${formatCount(gift)} ${plural(gift, 'подарочный', 'подарочных', 'подарочных')}`
      : null,
    pack > 0 ? `${formatCount(pack)} из пакета` : null,
  ].filter((part) => part !== null)
  if (parts.length < 2) return null
  return `${parts.slice(0, -1).join(', ')} и ${parts.at(-1) ?? ''}`
}

/**
 * What a line of the history says in its last column, and the smaller line under it: what a
 * done task was charged — and from which accounts, when from more than one —, what is set aside
 * for a task in work, that nothing was charged for a task that ended without a result, and that
 * an undo is free.
 */
export function outcomeText(entry: {
  outcome: UsageOutcome
  credits: number | null
  from: CreditsByAccount | null
}): { text: string; note: string | null } {
  const { outcome, credits, from } = entry
  switch (outcome) {
    case 'charged':
      return {
        text: credits === null ? 'Списано' : `${formatCount(credits)} ${creditsWord(credits)}`,
        note: from === null ? null : paidFrom(from),
      }
    case 'held':
      return {
        text: 'В работе',
        note:
          credits === null
            ? null
            : `Отложено до ${formatCount(credits)} ${creditsOf(credits)} — спишем по факту`,
      }
    case 'unpaid':
      return { text: 'Не списано', note: null }
    case 'free':
      return { text: 'Бесплатно', note: null }
  }
}

/** The smaller line under the task of a history line; null when the outcome says it all. */
export function taskNote(outcome: UsageOutcome, status: string): string | null {
  if (outcome === 'free') return 'Отмена правки'
  if (outcome !== 'unpaid') return null
  if (status === 'failed') return 'Не получилось'
  if (status === 'cancelled') return 'Задача отменена'
  if (status === 'rolled_back') return 'Вернули сайт как было'
  return null
}
