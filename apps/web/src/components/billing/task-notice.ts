import { formatCount } from '@/lib/count'
import { formatMoscowDay, nextMoscowMidnight } from '@/lib/moscow-date'
import { plural } from '@/lib/plural'
import { formatRubles } from '@/lib/rubles'

import type { TaskCredits } from './billing-types'
import {
  creditsOf,
  creditsWord,
  giftBelowStart,
  giftIsEnoughFor,
  giftOnHand,
  giftSpent,
  noGiftToSpeakOf,
  type GiftCredits,
} from './plan-format'

// What stands in the way of a new task, as «Тарифы» and «Использование» tell it. The answer
// comes from the server — `newTask` of the read model is what the queue itself would say —, and
// each reason has its sentences: what ran out, what is left, when the next credits come, and
// the way out. They come out with plain spaces: the component that prints one passes it through
// nbsp().

/** The tariff of the customer, as a notice names it. */
export interface NoticeTariff {
  status: 'trial' | 'active' | 'past_due'
  name: string
  periodEnd: Date
  autoRenewal: boolean
  /** The tariff of the next period: the scheduled one, else the current. */
  nextPlan: { name: string; creditsPerMonth: number; creditsPerDay: number | null }
}

export interface TaskNoticeInput {
  /** The answer of the server about a new task, with its numbers. */
  task: TaskCredits
  /** What new tasks may still take of the gift. */
  giftLeft: number
  /** Credits of a pack on the account: they wait for a tariff when there is none. */
  packLeft: number
  /** null: no live tariff. */
  tariff: NoticeTariff | null
  /** The pack the customer may buy now; null when none is on sale or it cannot be bought. */
  pack: { credits: number; price: string } | null
  /** «Включить автопродление» is offered: the shop saves payment methods. */
  canResume: boolean
  /** The moment the page is read at; the clock of the browser unless told. */
  now?: Date
}

/** A way out a notice names: the page offers each one it has a button for. */
export type NoticeAction = 'choose_plan' | 'buy_pack' | 'change_plan' | 'resume_renewal' | 'pay'

export interface TaskNotice {
  /** What ran out, what is left and when the next credits come. */
  state: string
  /**
   * What the customer can do about it now, when it takes a payment: choose or pay for a tariff,
   * buy a pack, switch auto-renewal on. null: nothing to pay for — only to wait, or to write.
   * A page where nothing can be paid for leaves this sentence out.
   */
  way: string | null
  actions: NoticeAction[]
}

/** «Задачи сейчас не принимаются…»: no credit rate is in force — the platform's own pause. */
export const RATE_PAUSE =
  'Задачи сейчас не принимаются: мы обновляем расчёт кредитов. Попробуйте ещё раз немного позже.'

/** Said beside «Сменить тариф» wherever it is offered as a way out: only a pack helps today. */
export const PLAN_CHANGE_STARTS_LATER = 'Новый тариф начнёт действовать со следующего периода.'

/**
 * Read with the ring of the credits while a new task would not be taken (`newTask.allowed`);
 * why — its window says, by the notice.
 */
export const NEW_TASK_CLOSED = 'Сейчас новую задачу начать нельзя'

/** «100 кредитов за 1 990 ₽»: the pack on sale, as a notice offers it. */
const packPrice = (pack: { credits: number; price: string }) =>
  `${formatCount(pack.credits)} ${creditsWord(pack.credits)} за ${formatRubles(pack.price)} ₽`

/** «18 октября начислим 300 кредитов по тарифу «Старт».»: the next grant of a tariff that renews. */
const nextGrant = ({ periodEnd, nextPlan }: NoticeTariff) =>
  `${formatMoscowDay(periodEnd)} начислим ${formatCount(nextPlan.creditsPerMonth)} ${creditsWord(nextPlan.creditsPerMonth)} по тарифу «${nextPlan.name}».`

/** «оставшиеся 15 подарочных кредитов сохранятся»: what a tariff keeps of the gift. */
function giftKept(left: number): string {
  const remaining = plural(left, 'оставшийся', 'оставшиеся', 'оставшиеся')
  const gift = plural(left, 'подарочный кредит', 'подарочных кредита', 'подарочных кредитов')
  const kept = plural(left, 'сохранится', 'сохранятся', 'сохранятся')
  return `${remaining} ${formatCount(left)} ${gift} ${kept}`
}

/**
 * The daily limit «завтра» may promise: what the tariff gives when the next Moscow day starts,
 * or null when it will give nothing then and no promise is made. A tariff that is paid and whose
 * period runs past that midnight gives its own `limit` — while the period still has a free
 * tariff credit (`monthSpent` false: tomorrow's day takes only what the month has). A tariff
 * that renews before it starts the next period by then: fresh credits, on the plan of that
 * period, whose day it is.
 */
export function dayLimitTomorrow(
  tariff: Pick<NoticeTariff, 'status' | 'periodEnd' | 'autoRenewal' | 'nextPlan'>,
  limit: number,
  monthSpent: boolean,
  now: Date = new Date(),
): number | null {
  if (tariff.status !== 'active') return null
  if (tariff.periodEnd.getTime() > nextMoscowMidnight(now).getTime()) {
    return monthSpent ? null : limit
  }
  return tariff.autoRenewal ? tariff.nextPlan.creditsPerDay : null
}

/** «до 50 кредитов», «до 21 кредита»: what a day of the tariff gives. */
const upTo = (limit: number) => `до ${formatCount(limit)} ${creditsOf(limit)}`

/**
 * The tariff credits of the Moscow day are taken, or what is left of them with the gift and the
 * pack cannot start a task, while the accounts could (spec §17, «Дневной лимит — в кредитах
 * тарифа»). A pack bought today lifts it; the next day does too while the tariff still takes
 * tasks then (`dayLimitTomorrow`; the refusal of the day implies a free tariff credit, so the
 * month is not spent). Continuations are under the day as well, so nothing is promised of the
 * tasks in work. «Попробовать ещё» is not (the owner, 19.10.2026): its reserve can take the day
 * past the limit, and what it does not use comes back to the day all the same.
 */
function dayTaken(input: TaskNoticeInput): TaskNotice {
  const { task, tariff, pack } = input
  const today = task.today
  const limit = today?.limit ?? null
  const next =
    limit === null || tariff === null ? null : dayLimitTomorrow(tariff, limit, false, input.now)
  const tomorrow = next === null ? null : `завтра снова можно будет потратить ${upTo(next)}`
  const nextDay =
    tomorrow === null ? '' : ` ${tomorrow.charAt(0).toLocaleUpperCase('ru')}${tomorrow.slice(1)}.`
  let state: string
  if (
    today !== null &&
    limit !== null &&
    today.room === 0 &&
    today.held > 0 &&
    today.charged < limit
  ) {
    // The day is set aside for tasks in work: what they do not use comes back to it, and gives
    // the day back while the charges have not taken all of it. The reserve of a retry, which the
    // day does not bound, can hold more than the limit.
    const charged = today.charged > 0 ? `списано ${formatCount(today.charged)} и ` : ''
    const of =
      today.used <= limit ? `из ${formatCount(limit)}` : `при дневном лимите ${formatCount(limit)}`
    const back = 'Неиспользованные кредиты вернутся, когда задачи закончатся'
    state = `Кредиты по тарифу на сегодня заняты: ${of} ${charged}отложено под задачи в работе ${formatCount(today.held)}. ${tomorrow === null ? `${back}.` : `${back}, а ${tomorrow}.`}`
  } else if (today !== null && today.room !== null && today.room > 0) {
    // Something is left of the day, fewer than a new task needs with the gift and the pack.
    const now = task.spendableNow
    state = `Сегодня можно потратить ещё ${formatCount(now)} ${creditsWord(now)}, а на новую задачу нужно не меньше ${task.minToStart}.${nextDay}`
  } else {
    // The charges took the whole day. They can have taken more than the limit of now after a
    // renewal onto a smaller plan, or after a retry, which the day does not bound.
    const spent =
      today === null || limit === null
        ? ''
        : today.used <= limit
          ? `: потрачено ${formatCount(today.used)} из ${formatCount(limit)}`
          : `: дневной лимит — ${formatCount(limit)}`
    state = `Кредиты по тарифу на сегодня закончились${spent}.${nextDay}`
  }
  return {
    state,
    way:
      pack === null
        ? null
        : `Чтобы продолжить сегодня, купите пакет — ${packPrice(pack)}. Кредиты из пакета не сгорают и дневным лимитом не ограничены.`,
    actions: pack === null ? [] : ['buy_pack'],
  }
}

/** The credits of a paid tariff ran out, or too few are left to start a task. */
function outOfCredits(input: TaskNoticeInput, tariff: NoticeTariff): TaskNotice {
  const { task, pack, canResume } = input
  const day = formatMoscowDay(tariff.periodEnd)
  if (!tariff.autoRenewal) {
    // The tariff ends with its period: no grant is coming unless auto-renewal is switched on.
    const quota = tariff.nextPlan.creditsPerMonth
    const renew = `включите автопродление: тогда ${day} начислим ${formatCount(quota)} ${creditsWord(quota)}.`
    const buy = pack === null ? null : `Купите пакет — ${packPrice(pack)}, они не сгорают`
    const way =
      buy === null
        ? canResume
          ? `${renew.charAt(0).toLocaleUpperCase('ru')}${renew.slice(1)}`
          : null
        : canResume
          ? `${buy}, — или ${renew}`
          : `${buy}.`
    return {
      state: `Лимиты закончились, а тариф «${tariff.name}» действует до ${day} и не продлится.`,
      way,
      actions: [
        ...(pack ? (['buy_pack'] as const) : []),
        ...(canResume ? (['resume_renewal'] as const) : []),
      ],
    }
  }
  const actions: NoticeAction[] = [...(pack ? (['buy_pack'] as const) : []), 'change_plan']
  if (task.spendable === 0) {
    return {
      state: `Лимиты закончились: кредиты по тарифу и из пакета израсходованы. ${nextGrant(tariff)}`,
      way:
        pack === null
          ? null
          : `Чтобы продолжить сейчас, купите пакет — ${packPrice(pack)}. Кредиты из пакета не сгорают.`,
      actions,
    }
  }
  const left = plural(task.spendable, 'остался', 'осталось', 'осталось')
  return {
    state: `Лимиты закончились: ${left} ${formatCount(task.spendable)} ${creditsWord(task.spendable)}, а на новую задачу нужно не меньше ${task.minToStart}. ${nextGrant(tariff)}`,
    way: pack === null ? null : `Чтобы продолжить сейчас, купите пакет — ${packPrice(pack)}.`,
    actions,
  }
}

/**
 * What stands in the way of a new task; null while one would be taken. The reason is the
 * server's; the numbers and the names come from what the page has read beside it.
 *
 * A workspace whose tariff is overdue takes tasks on its gift credits, like one without a
 * tariff, so the same reasons reach it: where the way out of a customer without a tariff is to
 * choose one, theirs is to pay for the one they have.
 */
export function taskNotice(input: TaskNoticeInput): TaskNotice | null {
  const { task, tariff, pack } = input
  const reason = task.newTask.reason
  if (reason === null) return null
  const overdue = tariff?.status === 'past_due'
  /** The way to a paid tariff: choosing one, or paying for the one that waits. */
  const toTariff: NoticeAction[] = [overdue ? 'pay' : 'choose_plan']

  switch (reason) {
    case 'rate_missing':
      return { state: RATE_PAUSE, way: null, actions: [] }
    case 'gift_spent':
      return {
        state: giftSpent,
        way: 'Чтобы ставить новые задачи, выберите тариф.',
        actions: toTariff,
      }
    case 'gift_below_start':
      return {
        state: giftBelowStart(task.spendable, task.minToStart),
        way: 'Выберите тариф — подарочные кредиты сохранятся и прибавятся к кредитам тарифа.',
        actions: toTariff,
      }
    case 'trial_unpaid_limit':
      return {
        state:
          'Пробные задачи закончились: несколько задач остановились без результата, и без тарифа мы больше не можем их принимать.',
        way: `${overdue ? 'Оплатите' : 'Выберите'} тариф, чтобы продолжить; ${giftKept(input.giftLeft)}.`,
        actions: toTariff,
      }
    case 'empty':
    case 'below_start':
      // Both are of a paid tariff: the read model names them for nobody else.
      return tariff === null ? null : outOfCredits(input, tariff)
    case 'held':
      if (tariff?.status === 'active') {
        return {
          state: `Кредиты заняты задачами в работе: под них отложено ${formatCount(task.setAside)}. Когда задачи закончатся, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить новую.`,
          way: pack === null ? null : `Чтобы не ждать, купите пакет — ${packPrice(pack)}.`,
          actions: pack ? ['buy_pack'] : [],
        }
      }
      return {
        state: `Подарочные кредиты заняты задачей в работе: под неё отложено ${formatCount(task.setAside)}. Когда она закончится, спишем только то, что ушло на работу, остальное вернётся — и можно будет поставить следующую.`,
        way: null,
        actions: toTariff,
      }
    case 'daily_limit':
      return dayTaken(input)
    case 'past_due':
      return {
        state: `Тариф «${tariff?.name ?? ''}» не оплачен, поэтому новые задачи не принимаются.`,
        way: 'Оплатите тариф — кредиты нового периода начислим сразу.',
        actions: ['pay'],
      }
    case 'ended': {
      const { packLeft } = input
      const kept = plural(
        packLeft,
        'он не сгорает и снова будет доступен',
        'они не сгорают и снова будут доступны',
        'они не сгорают и снова будут доступны',
      )
      return {
        state: `Тариф закончился. У вас ${formatCount(packLeft)} ${creditsWord(packLeft)} из пакета: ${kept}, когда вы выберете тариф.`,
        way: null,
        actions: ['choose_plan'],
      }
    }
    case 'unpaid_limit':
      return {
        state:
          'В этом периоде слишком много задач остановилось без результата, поэтому новые задачи временно не принимаются. Кредиты за них не списаны. Напишите нам — разберёмся, в чём дело.',
        way: null,
        actions: [],
      }
    case 'gift_site_used':
      // Known only where the site is: in the chat of that site, not on a page of the account.
      return null
  }
}

/**
 * A tariff that is not paid for still takes tasks on gift credits: one would be taken now, or
 * what refuses is of the moment — the gift is set aside for the task in work (`held`). A
 * sentence that stands beside the notice of such a refusal says «принимаются, только пока есть
 * подарочные кредиты», not that no task is taken until the payment: the notice itself names
 * the next one.
 */
export function giftCarriesTasks({ newTask }: Pick<TaskCredits, 'newTask'>): boolean {
  return newTask.allowed || newTask.reason === 'held'
}

/** The whole notice in one paragraph; `payable` false leaves out what takes a payment. */
export function noticeText(notice: TaskNotice, payable = true): string {
  return payable && notice.way !== null ? `${notice.state} ${notice.way}` : notice.state
}

/**
 * The line under the heading of «Тарифы» for a customer without a tariff. While a task would
 * be taken: what the gift of the registration is enough for, and that a tariff is needed after
 * it. Otherwise what stands in the way of a new task, by the answer of the server
 * (`taskNotice`) — or, with no gift to speak of, only the way on. `hadTariff`: a tariff has
 * ended. `canChoose` is false while payments are off: no tariff can be chosen then, and the
 * line says so instead of sending the customer to choose one.
 */
export function plansWithoutTariff(input: {
  gift: GiftCredits
  task: TaskCredits
  /** Credits of a pack that wait for a tariff. */
  packLeft: number
  hadTariff: boolean
  canChoose: boolean
}): string {
  const { gift, task, packLeft, hadTariff, canChoose } = input
  const unavailable = 'Оплата пока недоступна.'
  if (task.newTask.allowed) {
    const enough = giftIsEnoughFor(gift.available)
    const holds =
      enough === null ? '' : ` — ${plural(gift.available, 'его', 'их', 'их')} хватит ${enough}`
    const text = `${giftOnHand(gift.available)}${holds}. Когда кредиты закончатся, понадобится тариф.`
    return canChoose ? text : `${text} ${unavailable}`
  }
  // That a tariff has ended, and what it left, is told by the block of that tariff below.
  const toldBelow = hadTariff && task.newTask.reason === 'ended'
  const notice =
    noGiftToSpeakOf(gift, task) || toldBelow
      ? null
      : taskNotice({
          task,
          giftLeft: gift.available,
          packLeft,
          tariff: null,
          pack: null,
          canResume: false,
        })
  if (notice === null) {
    if (!canChoose) return unavailable
    return hadTariff
      ? 'Выберите тариф, чтобы снова ставить задачи.'
      : 'Выберите тариф, чтобы начать ставить задачи.'
  }
  // The pause is the platform's: what the customer has is said before it.
  if (task.newTask.reason === 'rate_missing' && gift.available > 0) {
    return `${giftOnHand(gift.available)}. ${RATE_PAUSE}`
  }
  if (canChoose) return noticeText(notice)
  // The way on is a tariff, and none can be chosen: said in place of the invitation.
  return notice.actions.includes('choose_plan') ? `${notice.state} ${unavailable}` : notice.state
}
