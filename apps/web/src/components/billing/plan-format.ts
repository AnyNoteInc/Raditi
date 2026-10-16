import {
  averageTaskCount,
  giftTaskCounts,
  minStartCredits,
  minTaskChargeCredits,
  tasksPerDayWithoutTariff,
  typicalTaskCredits,
  type TypicalCredits,
} from '@repo/domain/billing/credit-numbers'

import { formatCount } from '@/lib/count'
import { formatMoscowDate, formatMoscowDay } from '@/lib/moscow-date'
import { plural } from '@/lib/plural'
import { formatRubles } from '@/lib/rubles'

import type { TaskCredits } from './billing-types'
import { chargeNotStopped, chargeSent, type ChargeUnderWay } from './payment-format'

// The sentences of the tariff pages. They come out with plain spaces: the component that prints
// one passes it through nbsp().

/** The limits of a tariff, as the billing router sends them. */
export interface PlanLimits {
  creditsPerMonth: number
  /** null: the tariff has no daily limit. */
  tasksPerDay: number | null
  maxSites: number
}

/** What new tasks may still take from each account of credits. */
export interface CreditsLeft {
  tariff: number
  /** Gift credits: they stay when the tariff ends, and can be spent without one. */
  gift: number
  pack: number
}

/**
 * The gift account as the billing router sends it. `granted` is false while nothing was granted
 * to it: the credits are then the gift a user without a workspace is promised, or there are none.
 */
export interface GiftCredits {
  /** What new tasks may still take. */
  available: number
  /** Set aside for tasks in work. */
  held: number
  granted: boolean
}

/**
 * «кредит», «кредита», «кредитов»: the word for a count of credits, both as what there is («остался
 * 1 кредит») and as what is added, bought or charged («начислим 2 кредита»).
 */
export function creditsWord(count: number): string {
  return plural(count, 'кредит', 'кредита', 'кредитов')
}

/** «кредита», «кредитов» after «из», «до» and a number: «из 21 кредита», «до 5 кредитов». */
export function creditsOf(count: number): string {
  return plural(count, 'кредита', 'кредитов', 'кредитов')
}

/** «300 кредитов», «2 500 кредитов»: a count of credits with its word. */
const creditsCount = (count: number) => `${formatCount(count)} ${creditsWord(count)}`

/** «подарочный», «подарочных»: the word for gift credits after their count, «35 подарочных». */
function giftWord(count: number): string {
  return plural(count, 'подарочный', 'подарочных', 'подарочных')
}

/** «35 подарочных кредитов», «1 подарочный кредит»: a count of gift credits in full. */
const giftCreditsCount = (count: number) =>
  `${formatCount(count)} ${giftWord(count)} ${creditsWord(count)}`

/** «задачи», «задач» after «до», «около» and a number: «до 1 задачи», «около 27 задач». */
function tasksOf(count: number): string {
  return plural(count, 'задачи', 'задач', 'задач')
}

/** «5 кредитов», «15–25 кредитов»: what a kind of request usually costs. */
function typicalCredits({ from, to }: TypicalCredits, withWord: boolean): string {
  const range = from === to ? String(to) : `${from}–${to}`
  return withWord ? `${range} ${creditsWord(to)}` : range
}

/**
 * What a task costs, under the heading of the tariffs. The numbers are the constants of the
 * credits model: the minimum of a task and the first two rows of the orientation list.
 */
export function taskCostRule(): string {
  const { small, block } = typicalTaskCredits
  return `Задача стоит столько кредитов, сколько работы она потребовала, но не меньше ${minTaskChargeCredits}: небольшая правка текста, цены или фото — обычно ${typicalCredits(small, true)}, добавить блок или страницу — ${typicalCredits(block, false)}. Кредиты списываются только за выполненную задачу. Уточнения и «Изменить» — часть той же задачи: работа над ними добавляется к её стоимости. «Отменить» — бесплатно.`
}

/**
 * «около 27 задач»: how many average tasks a number of credits holds; null when it holds none —
 * a promise of «около 0 задач» is not made.
 */
function aboutTasks(credits: number): string | null {
  const tasks = averageTaskCount(credits)
  return tasks === 0 ? null : `около ${formatCount(tasks)} ${tasksOf(tasks)}`
}

/** «В среднем около 27 задач»: the line of a tariff card under its credits; null for none. */
export function planAverageTasks(creditsPerMonth: number): string | null {
  const about = aboutTasks(creditsPerMonth)
  return about === null ? null : `В среднем ${about}`
}

/** «Один сайт на WordPress», «До 3 сайтов на WordPress». */
export function planSites(maxSites: number): string {
  if (maxSites === 1) return 'Один сайт на WordPress'
  return `До ${maxSites} ${plural(maxSites, 'сайта', 'сайтов', 'сайтов')} на WordPress`
}

/** «До 5 задач в день»; null for a tariff without a daily limit. */
export function planDailyLimit(tasksPerDay: number | null): string | null {
  if (tasksPerDay === null) return null
  return `До ${tasksPerDay} ${tasksOf(tasksPerDay)} в день`
}

/**
 * A tariff in one line: «800 кредитов в месяц, до 10 задач в день · до 3 сайтов на WordPress».
 */
export function planLimits({ creditsPerMonth, tasksPerDay, maxSites }: PlanLimits): string {
  const perDay = tasksPerDay === null ? '' : `, до ${tasksPerDay} ${tasksOf(tasksPerDay)} в день`
  const sites = planSites(maxSites)
  return `${creditsCount(creditsPerMonth)} в месяц${perDay} · ${sites.charAt(0).toLocaleLowerCase('ru')}${sites.slice(1)}`
}

const SMALL_NUMBERS = ['один', 'два', 'три', 'четыре']

/** A count as a sentence reads it: a word up to four, digits after that. */
const inWords = (count: number) => SMALL_NUMBERS[count - 1] ?? String(count)

/** Why a tariff cannot be chosen: «Не подойдёт: у вас два сайта, а тариф рассчитан на один.» */
export function planTooSmall(siteCount: number, maxSites: number): string {
  const sites = `${inWords(siteCount)} ${plural(siteCount, 'сайт', 'сайта', 'сайтов')}`
  return `Не подойдёт: у вас ${sites}, а тариф рассчитан на ${inWords(maxSites)}.`
}

/** «45 по тарифу, 4 подарочных и 10 из пакета»: the parts of a list, the last one after «и». */
function listed(parts: readonly string[]): string {
  const last = parts.at(-1) ?? ''
  return parts.length < 2 ? last : `${parts.slice(0, -1).join(', ')} и ${last}`
}

/**
 * The «Кредиты» row: «Осталось 590: 450 по тарифу, 40 подарочных и 100 из пакета». The accounts
 * go in the order their credits are spent in, and an account with nothing left is not named;
 * one account alone is named without a total. «Закончились» when a new task cannot start on
 * what is left and nothing is set aside for tasks in work: fewer credits can be spent than a
 * task needs (`task`, the answer of the server; without it — when no account has a credit).
 * When no account has a free credit and some are set aside, they are not gone: «Отложено под
 * задачи в работе: 45».
 */
export function creditsLeft(
  { tariff, gift, pack }: CreditsLeft,
  task?: Pick<TaskCredits, 'spendable' | 'setAside' | 'minToStart'>,
): string {
  if (task !== undefined && task.spendable < task.minToStart && task.setAside === 0) {
    return 'Закончились'
  }
  const parts = [
    tariff > 0 ? `${formatCount(tariff)} по тарифу` : null,
    gift > 0 ? `${formatCount(gift)} ${giftWord(gift)}` : null,
    pack > 0 ? `${formatCount(pack)} из пакета` : null,
  ].filter((part) => part !== null)
  const [only, ...others] = parts
  if (only === undefined) {
    return task !== undefined && task.setAside > 0
      ? `Отложено под задачи в работе: ${formatCount(task.setAside)}`
      : 'Закончились'
  }
  if (others.length > 0) return `Осталось ${formatCount(tariff + gift + pack)}: ${listed(parts)}`
  // «Остался 1 подарочный»: alone, the gift is the subject of the sentence.
  const left =
    tariff === 0 && pack === 0 ? plural(gift, 'Остался', 'Осталось', 'Осталось') : 'Осталось'
  return `${left} ${only}`
}

// ─── Without a paid tariff ────────────────────────────────────────────────────
//
// Gift credits are spent without a tariff as well. Whether a new task is taken now is the
// answer of the server (`credits.newTask`), which knows the credits, the limit of the day and
// the bound on work that ended without a charge: a sentence about the present follows it. Of
// a tariff that waits for its payment the sentence is about the time until the payment, so a
// refusal of the moment does not turn it into «не принимаются» (`giftCarriesTasks`). A
// sentence about what comes after the tariff ends — in a dialog that switches auto-renewal off
// — has no such answer yet, and goes by the credits alone (`giftTakesTasks`).

/**
 * The gift is enough to start a task: what a sentence about the days after the tariff says of
 * new tasks. The limit of that day and its unpaid work are not known in advance.
 */
export function giftTakesTasks(gift: number): boolean {
  return gift >= minStartCredits
}

/** What is said of new tasks while no tariff is paid for, after «новые задачи». */
function tasksOnGift(taken: boolean, refused: string, accepted: string): string {
  return taken ? `${accepted}, только пока есть подарочные кредиты` : refused
}

/**
 * A workspace that has no gift to speak of: none was granted to it and none is promised — the
 * server answers «used up» for it as for a gift that is spent, and the account tells them apart.
 */
export function noGiftToSpeakOf(gift: GiftCredits, task: TaskCredits): boolean {
  return task.newTask.reason === 'gift_spent' && !gift.granted
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
 * credits hold none; null when they are not enough for one small edit. The welcome letter says
 * the same with a copy of this function (`packages/mail/src/templates/billing-format.ts`).
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

/** «У вас 35 подарочных кредитов»: how the gift is named to a customer who can spend it. */
export function giftOnHand(available: number): string {
  return `У вас ${giftCreditsCount(available)}`
}

/** «Без тарифа можно поставить до 3 задач в день.» */
export function tasksPerDayOnGift(): string {
  return `Без тарифа можно поставить до ${tasksPerDayWithoutTariff} ${tasksOf(tasksPerDayWithoutTariff)} в день.`
}

/** The gift is left, and it is less than the `needed` credits a new task takes to start. */
export function giftBelowStart(available: number, needed: number = minStartCredits): string {
  return `${plural(available, 'Остался', 'Осталось', 'Осталось')} ${giftCreditsCount(available)}, а на новую задачу нужно не меньше ${needed}.`
}

/** The gift was granted and nothing is left of it. */
export const giftSpent = 'Подарочные кредиты закончились.'

/** «18 октября 2026 — 12 900 ₽»: when the saved payment method is charged next, and how much. */
export function nextCharge(periodEnd: Date, price: string): string {
  return `${formatMoscowDate(periodEnd)} — ${formatRubles(price)} ₽`
}

/** What a customer keeps and loses when the tariff ends with its period. */
export function endsWithPeriod(periodEnd: Date, left: CreditsLeft): string {
  const until = formatMoscowDate(periodEnd)
  const tariff =
    left.tariff > 0
      ? `Тариф и ${creditsCount(left.tariff)} по тарифу доступны до ${until}.`
      : `Тариф действует до ${until}.`
  const kept = left.pack > 0 ? `${creditsCount(left.pack)} из пакета, сайты` : 'Сайты'
  const after = tasksOnGift(
    giftTakesTasks(left.gift),
    'не принимаются, пока вы снова не выберете тариф',
    'принимаются',
  )
  return `Автопродление отключено. ${tariff} После этого новые задачи ${after}. ${kept} и история правок сохранятся.`
}

/** What happens at the end of the period while auto-renewal is on. */
export function renewsWithPeriod(input: {
  periodEnd: Date
  /** The tariff of the next period: the scheduled one, else the current. */
  plan: { name: string; price: string; creditsPerMonth: number }
  /** A change of the tariff is scheduled for the next period. */
  changes: boolean
  email: string
}): string {
  const { periodEnd, plan, changes, email } = input
  const day = formatMoscowDay(periodEnd)
  const charge = `спишем ${formatRubles(plan.price)} ₽ сохранённым способом оплаты и начислим ${creditsCount(plan.creditsPerMonth)} на новый период`
  const what = changes ? `С ${day} — тариф «${plan.name}»: ${charge}` : `${day} ${charge}`
  return `Включено. ${what}. Перед списанием пришлём письмо на ${email}.`
}

/**
 * The note in the card of the customer's tariff: «Продлится 18 октября.» when this tariff is
 * the one that renews, «Действует до 18 октября.» when it ends or gives way to another.
 */
export function currentPlanNote(periodEnd: Date, renews: boolean): string {
  const day = formatMoscowDay(periodEnd)
  return renews ? `Продлится ${day}.` : `Действует до ${day}.`
}

/** What a pack gives and when: the promise under its name on «Тарифы» and in its dialog. */
export function packPromise(credits: number): string {
  return `Добавим ${creditsCount(credits)} сразу после оплаты. Кредиты из пакета не сгорают в конце периода.`
}

/**
 * The pack on «Тарифы»: when it is of use, how many average tasks it holds, and its promise.
 */
export function packOffer(credits: number): string {
  const about = aboutTasks(credits)
  const holds = about === null ? '' : `: это в среднем ${about}`
  return `Пригодится, если кредиты по тарифу закончатся до конца периода${holds}. ${packPromise(credits)}`
}

/** A paid pack on the page of its order. `credits`: the size of the pack, null when unknown. */
export function packAdded(credits: number | null): string {
  if (credits === null) return 'Кредиты из пакета уже добавлены и не сгорают в конце периода.'
  return `Добавили ${creditsCount(credits)}. Кредиты из пакета не сгорают в конце периода.`
}

// ─── Managing the tariff ──────────────────────────────────────────────────────
//
// A renewal charge that was started is not stopped by anything the customer does on the page.
// While one is under way (`charge` is not 'none') no sentence here names a day of a charge to
// come or says that there will be none.

/** The charge of the period that is under way, as the billing router tells it. */
type Charge = ChargeUnderWay | 'none'

/** A tariff as a sentence names it: what it is called, what it costs and what it gives. */
interface NamedPlan extends PlanLimits {
  name: string
  price: string
}

/** The value of «Следующее списание» while the charge of the period is at the bank. */
export function chargeUnderWayValue(charge: ChargeUnderWay): string {
  return charge === 'at_bank'
    ? 'Уже отправлено в банк, ждём ответа'
    : 'Уже отправлялось в банк, ответа пока нет'
}

/** What auto-renewal does while the charge of the period is under way; it is on. */
export function renewsWithChargeUnderWay(charge: ChargeUnderWay, email: string): string {
  return charge === 'at_bank'
    ? `Включено. ${chargeSent.at_bank}: когда оно пройдёт, тариф продлится ещё на месяц. Перед каждым следующим списанием пришлём письмо на ${email}.`
    : `Включено. ${chargeSent.unanswered}. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их. Перед каждым следующим списанием пришлём письмо на ${email}.`
}

/** A tariff whose auto-renewal is off while a charge that was started before is under way. */
export function endsUnlessCharged(charge: ChargeUnderWay): string {
  return `Автопродление отключено. ${chargeNotStopped[charge]} Других списаний не будет.`
}

/**
 * What stands under «Включить автопродление»: what the customer agrees to. `methodLabel`: the
 * saved payment method, null when a card has to be bound first. `changes`: another tariff is
 * scheduled for the next period.
 */
export function resumeTerms(input: {
  periodEnd: Date
  plan: { name: string; price: string }
  changes: boolean
  methodLabel: string | null
  charge: Charge
}): string {
  const { periodEnd, plan, changes, methodLabel, charge } = input
  const day = formatMoscowDay(periodEnd)
  const amount = `${formatRubles(plan.price)} ₽`
  const letter = 'Перед списанием пришлём письмо.'
  // The charge of this period has left already: what is switched on is every charge after it.
  const when =
    charge !== 'none'
      ? `каждый месяц будем списывать ${amount}`
      : changes
        ? `${day} тариф сменится на «${plan.name}»: в этот день и дальше каждый месяц будем списывать ${amount}`
        : `${day} и дальше каждый месяц будем списывать ${amount}`
  if (methodLabel === null) {
    return `Сначала привяжем карту на странице ЮKassa: деньги при этом не спишутся. Когда карта сохранится, автопродление включится: ${when} с этой карты. ${letter}`
  }
  return `Если включите, ${when} сохранённым способом оплаты — ${methodLabel}. ${letter}`
}

/**
 * What stands in place of «Включить автопродление» and its terms while the shop takes one-time
 * payments only: nothing can be switched on, and nothing is promised.
 */
export function renewalUnavailable(): string {
  return 'Автопродление пока недоступно: когда тариф закончится, его можно оформить снова.'
}

/**
 * What the last step before the payment page of a tariff says in place of the consent to
 * auto-renewal while the shop takes one-time payments only.
 */
export function checkoutWithoutRenewal(): string {
  return 'Автопродление пока недоступно: тариф будет действовать месяц, потом его можно оформить снова.'
}

/** What the page says once auto-renewal is switched on with the saved payment method. */
export function resumedText(charge: Charge): string {
  return charge === 'none'
    ? 'Автопродление включено. Перед списанием пришлём письмо.'
    : `Автопродление включено. ${chargeSent[charge]}; перед каждым следующим пришлём письмо.`
}

/** Said before auto-renewal is switched off where the pages offer no way to switch it back on. */
const renewalStaysOff = 'Включить автопродление снова пока будет нельзя.'

/** What `cancelRenewalWarning` is told of the tariff and of the shop. */
interface RenewalCancel {
  planName: string
  periodEnd: Date
  left: CreditsLeft
  /** The tariff waits for a payment made by hand: nothing is charged by itself anyway. */
  pastDue: boolean
  /** The tariff scheduled for the next period, if any: it starts only with a renewal. */
  nextPlanName: string | null
  charge: Charge
  /**
   * The shop takes one-time payments only: the page offers no «Включить автопродление» there,
   * so the step cannot be taken back.
   */
  oneTimeOnly: boolean
}

/**
 * What the customer confirms when switching auto-renewal off: until when the tariff works, what
 * is kept after it, and what becomes of a charge the page already knows to be under way. Where
 * auto-renewal cannot be switched back on, the last paragraph says so before the step is taken.
 */
export function cancelRenewalWarning(input: RenewalCancel): string[] {
  const warning = renewalCancelOutcome(input)
  return input.oneTimeOnly ? [...warning, renewalStaysOff] : warning
}

/** What switching auto-renewal off does to the tariff, at any shop. */
function renewalCancelOutcome(input: RenewalCancel): string[] {
  const { planName, periodEnd, left, pastDue, nextPlanName, charge } = input
  if (pastDue) {
    return [
      `Тариф «${planName}» по-прежнему ждёт оплаты. После оплаты он будет действовать месяц и сам не продлится.`,
      'Способ оплаты, которым вы заплатите, мы не сохраним.',
    ]
  }
  const kept = left.pack > 0 ? `${creditsCount(left.pack)} из пакета, сайты` : 'Сайты'
  const after = `${kept} и история правок сохранятся.`
  const tasks = tasksOnGift(
    giftTakesTasks(left.gift),
    'не будут приниматься, пока вы снова не выберете тариф',
    'будут приниматься',
  )
  if (charge !== 'none') {
    return [
      `Автопродление отключится. ${chargeNotStopped[charge]} Отключение это списание не отменит; других списаний не будет.`,
      `Когда тариф закончится, новые задачи ${tasks}. ${after}`,
    ]
  }
  const day = formatMoscowDay(periodEnd)
  const until = `Тариф «${planName}» будет действовать до ${formatMoscowDate(periodEnd)}.`
  const credits =
    left.tariff > 0
      ? ` ${creditsCount(left.tariff)} по тарифу можно использовать до этого дня.`
      : ''
  const change =
    nextPlanName === null
      ? ''
      : ` Переход на тариф «${nextPlanName}» не состоится, пока автопродление отключено.`
  return [`${until}${credits}${change}`, `С ${day} новые задачи ${tasks}. ${after}`]
}

/** What the customer confirms when choosing another tariff for the next period. */
export function planChangeTerms(input: {
  currentName: string
  periodEnd: Date
  /** A tariff chosen before, which this choice replaces. */
  replacedName: string | null
}): string {
  const { currentName, periodEnd, replacedName } = input
  const day = formatMoscowDay(periodEnd)
  const replaced =
    replacedName === null ? '' : ` Переход на «${replacedName}», выбранный раньше, отменится.`
  return `Тариф изменится ${formatMoscowDate(periodEnd)} — с началом нового периода. До этого дня действует «${currentName}». Кредиты по тарифу можно использовать до ${day}, на новый период они не переносятся. Кредиты из пакета остаются.${replaced}`
}

/** The row of the change dialog that tells how the new tariff is paid for: label and value. */
export function planChangeCharge(input: {
  periodEnd: Date
  price: string
  autoRenewal: boolean
  methodLabel: string | null
}): { label: string; value: string } {
  const { periodEnd, price, autoRenewal, methodLabel } = input
  const day = formatMoscowDay(periodEnd)
  const amount = `${formatRubles(price)} ₽`
  if (!autoRenewal) {
    return {
      label: 'Оплата',
      value: `Автопродление отключено: тариф сменится, только если его продлить. Включите автопродление на этой странице, и ${day} мы спишем ${amount}.`,
    }
  }
  return {
    label: `Спишем ${day}`,
    value:
      methodLabel === null
        ? `${amount} сохранённым способом оплаты`
        : `${amount} сохранённым способом оплаты — ${methodLabel}`,
  }
}

/**
 * The block of a scheduled change: what is coming, when, and how it is paid for. `canResume` is
 * false while auto-renewal cannot be switched on (the shop takes one-time payments only, or
 * payments are off): a tariff that does not renew is then not told to switch it on.
 */
export function scheduledChange(input: {
  next: NamedPlan
  periodEnd: Date
  autoRenewal: boolean
  pastDue: boolean
  charge: Charge
  canResume: boolean
}): { title: string; text: string } {
  const { next, periodEnd, autoRenewal, pastDue, charge, canResume } = input
  const day = formatMoscowDay(periodEnd)
  const amount = `${formatRubles(next.price)} ₽`
  const limits = `${planLimits(next)}.`
  if (pastDue) {
    return {
      title: `После оплаты — тариф «${next.name}»`,
      text: `${limits} К оплате — ${amount}: тариф сменится, как только оплата пройдёт.`,
    }
  }
  if (charge !== 'none') {
    return {
      title: `С ${day} — тариф «${next.name}»`,
      text: `${limits} ${chargeSent[charge]}. Отменить переход можно будет после него.`,
    }
  }
  if (!autoRenewal) {
    const ends = `${limits} Автопродление отключено, поэтому ${day} тариф закончится и переход не состоится.`
    return {
      title: `Выбран тариф «${next.name}»`,
      text: canResume
        ? `${ends} Чтобы перейти, включите автопродление: ${day} спишем ${amount}.`
        : ends,
    }
  }
  return {
    title: `С ${day} — тариф «${next.name}»`,
    text: `${limits} ${day} спишем ${amount} сохранённым способом оплаты.`,
  }
}

/** What the page says once a change of tariff is scheduled, and once it is taken back. */
export function changeScheduledText(nextName: string, periodEnd: Date, renews: boolean): string {
  return renews
    ? `Готово: с ${formatMoscowDay(periodEnd)} — тариф «${nextName}».`
    : `Тариф «${nextName}» выбран. Он начнёт действовать, если включить автопродление.`
}
export function changeCancelledText(currentName: string): string {
  return `Переход отменён: остаётся тариф «${currentName}».`
}

/** The note in the card of the tariff that is scheduled for the next period. */
export function scheduledPlanNote(periodEnd: Date, renews: boolean): string {
  return renews
    ? `Начнёт действовать ${formatMoscowDay(periodEnd)}.`
    : 'Выбран на следующий период.'
}

/**
 * Under «Не получилось списать»: what to do, and when the tariff ends if nothing is done. Only
 * the payment the customer makes by hand settles the failed charge: nothing is charged again by
 * itself, whatever card is saved (default «е» of docs/plan/37-billing-plan.md). So replacing the
 * card is never offered as a way out — it is named as what it is, a matter of the charges after
 * this payment.
 */
export function pastDueText(input: {
  canPay: boolean
  /** Auto-renewal is on: the saved card is the one the coming periods are charged to. */
  autoRenewal: boolean
  /** When the grace runs out; null when nobody is ended (payments are off). */
  endsAt: Date | null
  /** «Оплата» offers to replace the card: the shop binds payment methods. */
  canReplaceCard: boolean
  /**
   * Tasks are taken without the payment, on gift credits: one would be taken now, or what
   * refuses it is of the moment and its notice names the next one (`giftCarriesTasks`).
   */
  tasksTaken: boolean
}): string {
  const { canPay, autoRenewal, endsAt, canReplaceCard, tasksTaken } = input
  const blocked = `пока оплата не пройдёт, новые задачи ${tasksOnGift(tasksTaken, 'не принимаются', 'принимаются')}.`
  const action = canPay ? `Оплатите тариф: ${blocked}` : `Оплата сейчас недоступна: ${blocked}`
  const deadline =
    endsAt === null
      ? ''
      : ` ${formatMoscowDate(endsAt)} тариф закончится, если оплата не пройдёт раньше.`
  const card =
    canPay && autoRenewal && canReplaceCard ? ' Карту для следующих списаний можно заменить.' : ''
  return `${action}${deadline}${card}`
}

/**
 * The «Кредиты» row of a tariff that is not paid for: what its period did not use is not
 * carried over, and the purchased credits wait for the payment with the tariff. Gift credits
 * wait for nothing: what is left of them is named first. When none of them is free and the task
 * in work has some set aside (`giftSetAside`, what the gift account holds), they are not gone
 * either: «Отложено под задачу в работе: 35 подарочных» — the row then agrees with the notice
 * that says the rest will come back. «Недоступны…» is for a gift with nothing free and nothing
 * set aside.
 */
export function creditsWhileOverdue(
  { gift, pack }: Pick<CreditsLeft, 'gift' | 'pack'>,
  giftSetAside: number,
): string {
  const afterPayment =
    pack === 0 ? null : `После оплаты — новые кредиты по тарифу и ${formatCount(pack)} из пакета`
  const onGift =
    gift > 0
      ? `${plural(gift, 'Остался', 'Осталось', 'Осталось')} ${formatCount(gift)} ${giftWord(gift)}`
      : giftSetAside > 0
        ? `Отложено под задачу в работе: ${formatCount(giftSetAside)} ${giftWord(giftSetAside)}`
        : null
  if (onGift !== null) {
    return `${onGift}. ${afterPayment ?? 'Кредиты по тарифу начислим после оплаты'}`
  }
  const blocked = 'Недоступны, пока тариф не оплачен'
  return afterPayment === null ? blocked : `${blocked}. ${afterPayment}`
}

/**
 * What the dialog of «Оплатить сейчас» says about the payment method of the payment.
 * `savesMethod` is false while the shop takes one-time payments only: the payment then saves
 * nothing, and a tariff that renews goes on renewing with the method saved before.
 */
export function pastDuePaymentTerms(
  autoRenewal: boolean,
  price: string,
  savesMethod: boolean,
): string {
  if (!autoRenewal) {
    return 'Автопродление отключено: способ оплаты мы не сохраним, тариф будет действовать месяц и сам не продлится.'
  }
  const amount = `${formatRubles(price)} ₽`
  const rest = 'Перед списанием пришлём письмо. Отключить можно в настройках в любой день.'
  return savesMethod
    ? `Автопродление включено: сохраним способ оплаты, которым вы заплатите сейчас, и каждый месяц будем списывать ${amount} тем же способом. ${rest}`
    : `Способ оплаты, которым вы заплатите сейчас, мы не сохраним. Автопродление включено: каждый месяц будем списывать ${amount} способом оплаты, сохранённым раньше. ${rest}`
}

/** What the page says once auto-renewal is switched off for a tariff that waits for its payment. */
export function renewalOffWhileOverdue(): string {
  return 'Автопродление отключено: способ оплаты, которым вы оплатите тариф, мы не сохраним.'
}

/**
 * What auto-renewal means for a tariff that waits for a payment made by hand. `savesMethod` is
 * false while the shop takes one-time payments only: that payment saves nothing.
 */
export function renewalWhileOverdue(autoRenewal: boolean, savesMethod: boolean): string {
  if (!autoRenewal) {
    return 'Отключено. После оплаты тариф будет действовать месяц и сам не продлится.'
  }
  return savesMethod
    ? 'Включено. Способ оплаты, которым вы оплатите тариф, сохранится, и дальше тариф будет продлеваться сам. Перед каждым списанием пришлём письмо.'
    : 'Включено. Способ оплаты, которым вы оплатите тариф, не сохранится: дальше тариф будет продлеваться со способа оплаты, сохранённого раньше. Перед каждым списанием пришлём письмо.'
}

/**
 * Why the last tariff is over, and what the customer still has. What to do next is said once by
 * the line under the page's heading and by the button under this text, not here again.
 */
export function endedText(input: {
  reason: 'not_renewed' | 'not_paid' | 'refunded'
  packCredits: number
  /** A new task is taken without a tariff: on gift credits, by the answer of the server. */
  tasksTaken: boolean
}): string {
  const { reason, packCredits, tasksTaken } = input
  const why = {
    not_renewed: '',
    not_paid: 'Оплата за следующий период не прошла, и тариф закончился. ',
    refunded: 'Мы вернули оплату за этот тариф, и он закончился. ',
  }[reason]
  const kept = packCredits > 0 ? `${creditsCount(packCredits)} из пакета, сайты` : 'Сайты'
  const tasks = tasksOnGift(tasksTaken, 'сейчас не принимаются', 'принимаются')
  return `${why}Новые задачи ${tasks}. ${kept} и история правок на месте.`
}

/** The coming charge of a tariff that renews, as `billing.autoRenewal` tells it. */
interface ComingCharge {
  planName: string
  nextPlanName: string | null
  amount: string
  chargeAt: Date
  renewalCharge: Charge
  /**
   * The shop takes one-time payments only: no page offers «Включить автопродление» there, so
   * switching it off cannot be taken back.
   */
  oneTimeOnly: boolean
}

/**
 * The coming charge on the page that asks for the consent to the documents. The button under it
 * switches auto-renewal off in one press, with no confirmation: where it cannot be switched back
 * on, the last sentence says so before the step is taken.
 */
export function consentRenewalNotice(renewal: ComingCharge): string {
  const notice = comingCharge(renewal)
  return renewal.oneTimeOnly ? `${notice} ${renewalStaysOff}` : notice
}

/** What is charged and when, and that stopping it needs no consent, at any shop. */
function comingCharge(renewal: ComingCharge): string {
  const { planName, nextPlanName, chargeAt, renewalCharge } = renewal
  const amount = `${formatRubles(renewal.amount)} ₽`
  const day = formatMoscowDay(chargeAt)
  if (renewalCharge !== 'none') {
    return `У вас включено автопродление тарифа «${planName}». ${chargeSent[renewalCharge]}. Отключить автопродление можно, не принимая документы: это списание не отменится, других не будет.`
  }
  const charge =
    nextPlanName === null
      ? `У вас включено автопродление тарифа «${planName}»: ${day} спишем ${amount}.`
      : `У вас включено автопродление: ${day} тариф «${planName}» сменится на «${nextPlanName}», спишем ${amount}.`
  return `${charge} Отключить его можно, не принимая документы.`
}

/** The same block once auto-renewal is switched off there. */
export function consentRenewalOff(planName: string, periodEnd: Date, charge: Charge): string {
  return charge === 'none'
    ? `Автопродление отключено. Тариф «${planName}» действует до ${formatMoscowDate(periodEnd)}.`
    : `Автопродление отключено. ${chargeNotStopped[charge]} Больше списаний не будет.`
}
