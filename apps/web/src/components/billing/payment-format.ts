import type { AppIconName } from '@/components/application/app-icon'
import { formatMoscowDate, formatMoscowDay } from '@/lib/moscow-date'
import { formatRubles } from '@/lib/rubles'

import type { MethodBinding, PaymentEntry, RenewalCharge, Subscription } from './billing-types'

// The sentences of «Оплата» and of the return page of a binding. They come out with plain
// spaces: the component that prints one passes it through nbsp().

/** The day an order of the history is listed under: when it was paid, else when it was made. */
export function paymentDate({ paidAt, createdAt }: Pick<PaymentEntry, 'paidAt' | 'createdAt'>) {
  return formatMoscowDate(paidAt ?? createdAt)
}

/**
 * What an order paid for: «Тариф «Бизнес»» with the period it bought, «Пакет из 100 кредитов».
 * The period is told only for a tariff: an order that was never paid has none.
 */
export function paidFor({
  kind,
  planName,
  period,
}: Pick<PaymentEntry, 'kind' | 'planName' | 'period'>): {
  title: string
  period: string | null
} {
  if (kind === 'subscription') {
    return {
      title: planName === null ? 'Тариф' : `Тариф «${planName}»`,
      period:
        period === null
          ? null
          : `${formatMoscowDay(period.start)} — ${formatMoscowDay(period.end)}`,
    }
  }
  if (kind === 'pack') return { title: planName ?? 'Пакет кредитов', period: null }
  return { title: 'Пополнение баланса', period: null }
}

export interface PaymentStatus {
  label: string
  icon: AppIconName
  /** The chip is never told apart by colour alone: every status has its words and its icon. */
  color: 'success' | 'error' | 'default'
  /** A line under the chip: why the payment failed, or when and how much was returned. */
  note: string | null
}

type Outcome = Pick<
  PaymentEntry,
  'status' | 'amount' | 'failureText' | 'refundedAmount' | 'refundedAt'
>

/** When the money went back, and how much when it was not the whole amount. */
function refundNote({ amount, refundedAmount, refundedAt }: Outcome): string | null {
  const day = refundedAt === null ? null : formatMoscowDay(refundedAt)
  const part =
    refundedAmount !== null && refundedAmount !== amount
      ? `${formatRubles(refundedAmount)} ₽`
      : null
  return part !== null && day !== null ? `${part}, ${day}` : (part ?? day)
}

/** How an order of the history ended, for its chip and the line under it. */
export function paymentStatus(payment: Outcome): PaymentStatus {
  switch (payment.status) {
    case 'paid':
      return { label: 'Оплачено', icon: 'check', color: 'success', note: null }
    case 'failed':
      return {
        label: 'Не прошёл',
        icon: 'warning',
        color: 'error',
        note: payment.failureText ?? 'Платёж не прошёл.',
      }
    case 'refunded':
      return { label: 'Возвращено', icon: 'back', color: 'default', note: refundNote(payment) }
    case 'cancelled':
      // An order we closed ourselves: the customer chose something else, or never paid.
      return { label: 'Отменён', icon: 'close', color: 'default', note: null }
    case 'pending':
      return { label: 'Ожидает оплаты', icon: 'clock', color: 'default', note: null }
  }
}

/** The tariff of the next period: a scheduled change, else the tariff that renews. */
const renewalPlan = ({ plan, nextPlan }: Subscription) => nextPlan ?? plan

// A renewal charge that was started is not stopped when the method is unlinked or replaced, or
// auto-renewal is switched off: its payment renews the tariff if it succeeds. While one is
// under way nothing on «Оплата» promises a charge to come or says that there will be none.
export type ChargeUnderWay = Exclude<RenewalCharge, 'none'>

/** That the charge of the next period has left for the bank, without a full stop. */
export const chargeSent: Record<ChargeUnderWay, string> = {
  at_bank: 'Списание за следующий период уже отправлено в банк',
  unanswered: 'Списание за следующий период уже отправлялось в банк, ответа пока нет',
}

/**
 * What a customer who expects no more charges is told of one that was started before: what
 * becomes of the tariff and of the money. A charge without an answer is looked up by us: an
 * operator returns the money when it was taken and the tariff was not renewed.
 */
export const chargeNotStopped: Record<ChargeUnderWay, string> = {
  at_bank: `${chargeSent.at_bank}: если оно пройдёт, тариф продлится ещё на месяц.`,
  unanswered: `${chargeSent.unanswered}. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их.`,
}

/**
 * What stands under the saved payment method: when it is charged next and for what, or why it
 * is not charged at all. `renewalCharge`: the charge of the period that is under way now,
 * whichever method it left with — the note then tells of that charge instead of a day to come.
 */
export function methodNote(subscription: Subscription, renewalCharge: RenewalCharge): string {
  if (subscription.status === 'past_due') {
    return 'Оплата тарифа не прошла. Автоматических списаний не будет, пока тариф не оплачен.'
  }
  const { period } = subscription
  if (!subscription.autoRenewal) {
    return renewalCharge === 'none'
      ? `Автопродление выключено: списаний не будет. Тариф действует до ${formatMoscowDate(period.end)}.`
      : `Автопродление выключено. ${chargeNotStopped[renewalCharge]} Других списаний не будет.`
  }
  if (renewalCharge !== 'none') {
    return `${chargeSent[renewalCharge]}. Если способ оплаты отвязать, автопродление отключится, но это списание не отменится.`
  }
  const { name, price } = renewalPlan(subscription)
  return `${formatMoscowDay(period.end)} спишем этим способом ${formatRubles(price)} ₽ за тариф «${name}». Если его отвязать, автопродление отключится.`
}

/**
 * What a customer without a saved method is told under «не сохранён». `canBind`: the page
 * offers to bind a card, which saves it and switches nothing on. `renewalCharge`: a charge that
 * was started with the method that is gone and still has no outcome. `oneTimeOnly`: the shop
 * takes one-time payments only — nothing is saved or bound, and the note says so instead of
 * naming a way to save a method that is not there.
 */
export function noMethodNote(
  subscription: Subscription | null,
  canBind: boolean,
  renewalCharge: RenewalCharge,
  oneTimeOnly = false,
): string {
  const unavailable = 'Автопродление пока недоступно, поэтому способ оплаты не сохраняется.'
  if (subscription === null) {
    return oneTimeOnly
      ? unavailable
      : 'Он сохраняется, когда вы оплачиваете тариф с автопродлением.'
  }
  const overdue = subscription.status === 'past_due'
  const tariff = overdue
    ? 'Оплата тарифа не прошла: тариф ждёт оплаты.'
    : `Тариф действует до ${formatMoscowDate(subscription.period.end)}.`
  const said =
    overdue || renewalCharge === 'none' ? tariff : `${tariff} ${chargeNotStopped[renewalCharge]}`
  if (!canBind) return oneTimeOnly ? `${said} ${unavailable}` : said
  return `${said} Можно привязать карту: она сохранится для будущих списаний. Автопродление при этом не включится, и денег с карты мы не спишем.`
}

/**
 * What the page says once the method is unlinked. `renewalCharge`: the charge that had been
 * started before, as the unlink itself found it — the customer learns of it at once.
 */
export function unlinkedText(renewalCharge: RenewalCharge): string {
  const unlinked = 'Способ оплаты отвязан, автопродление выключено.'
  return renewalCharge === 'none'
    ? unlinked
    : `${unlinked} ${chargeNotStopped[renewalCharge]} Больше списаний не будет.`
}

/**
 * What the customer confirms when unlinking: what happens to auto-renewal and to the tariff.
 * `renewalCharge`: a charge the page already knows to be under way — unlinking does not stop
 * it, so the warning does not name a last day the charge may move. `oneTimeOnly`: the shop
 * takes one-time payments only — «Оплата» binds no card there, so the step cannot be taken
 * back, and the warning says so before it is taken. `tasksOnGift`: the gift credits of the
 * customer can start a task (`giftTakesTasks`) — new tasks are then taken after the tariff ends
 * as well, while those credits last.
 */
export function unlinkWarning(
  subscription: Subscription,
  renewalCharge: RenewalCharge,
  oneTimeOnly = false,
  tasksOnGift = false,
): string {
  const warning = unlinkOutcome(subscription, renewalCharge, tasksOnGift)
  return oneTimeOnly
    ? `${warning} Привязать карту снова пока будет нельзя: автопродление недоступно.`
    : warning
}

/** What unlinking does to auto-renewal and to the tariff, at any shop. */
function unlinkOutcome(
  subscription: Subscription,
  renewalCharge: RenewalCharge,
  tasksOnGift: boolean,
): string {
  const { plan, period } = subscription
  if (subscription.status === 'past_due') {
    return `Автоматических списаний не будет. Тариф «${plan.name}» по-прежнему ждёт оплаты.`
  }
  const until = formatMoscowDate(period.end)
  if (renewalCharge !== 'none') {
    const renewal = subscription.autoRenewal
      ? 'Автопродление отключится.'
      : 'Автопродление уже выключено.'
    return `${renewal} ${chargeNotStopped[renewalCharge]} Отвязка это списание не отменит; других списаний не будет.`
  }
  if (!subscription.autoRenewal) {
    return `Автопродление уже выключено. Тариф «${plan.name}» работает до ${until}, как и раньше.`
  }
  const after = tasksOnGift
    ? 'принимаются, только пока есть подарочные кредиты'
    : 'не принимаются, пока вы снова не оплатите тариф'
  return `Автопродление отключится. Тариф «${plan.name}» будет работать до ${until}; после этого новые задачи ${after}.`
}

/** The saved method of the subscription a binding answers with; null when there is none. */
const savedLabel = (binding: MethodBinding) => binding.subscription?.paymentMethod?.label ?? null

/**
 * What the return page says of a renewal charge the bound card came too late for: it left with
 * the method saved before. With auto-renewal on the charges after it go to the new card; a
 * charge without an answer may be repeated, and then with the new card as well. With
 * auto-renewal off nothing follows it.
 */
function formerMethodCharged(renewalCharge: ChargeUnderWay, autoRenewal: boolean): string {
  const sent = {
    at_bank: 'Списание за следующий период уже отправлено в банк с прежнего способа оплаты',
    unanswered:
      'Списание за следующий период уже отправлялось в банк с прежнего способа оплаты, ответа пока нет',
  }[renewalCharge]
  if (autoRenewal) {
    return renewalCharge === 'at_bank'
      ? `${sent}; следующие пойдут с новой карты.`
      : `${sent}: деньги могут быть списаны с него. Следующие списания пойдут с новой карты.`
  }
  const outcome =
    renewalCharge === 'at_bank'
      ? ': если оно пройдёт, тариф продлится ещё на месяц.'
      : '. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их.'
  return `${sent}${outcome} Автопродление выключено: других списаний не будет.`
}

/**
 * What the return page of a binding says once the card is bound. While the charge of the period
 * that was started with the method before it is under way, the page does not promise the new
 * card for it.
 */
export function boundText(binding: MethodBinding): string[] {
  const label = savedLabel(binding)
  const saved = label === null ? 'Способ оплаты сохранён.' : `Способ оплаты — ${label}.`
  const { subscription, renewalCharge } = binding
  if (subscription === null) return [saved]
  if (renewalCharge === 'none' || subscription.status === 'past_due') {
    return [saved, methodNote(subscription, 'none')]
  }
  return [saved, formerMethodCharged(renewalCharge, subscription.autoRenewal)]
}

/** What the return page of a binding says when the card was not bound. */
export function notBoundText(binding: MethodBinding): string[] {
  const label = savedLabel(binding)
  return [
    'ЮKassa не сохранила карту: привязка отменена или время на неё истекло. Денег с карты не списано.',
    label === null ? 'Способ оплаты по-прежнему не сохранён.' : `Способ оплаты прежний — ${label}.`,
  ]
}
