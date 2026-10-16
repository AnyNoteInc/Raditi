import {
  formatMoscowDate,
  formatRubles,
  moscowDaysUntil,
  plansUrl,
  plural,
} from './billing-format.ts'
import { button, fallbackLink, greeting, layout, p, textLayout } from './layout.ts'
import type { MailData, RenderedEmail } from './schemas.ts'

/**
 * «Через 3 дня, 18 октября 2026,» — the days are counted from the moment of sending, so a
 * letter that waited in the queue still tells the truth. Only for a charge that is still ahead.
 */
function chargeDay(chargeAt: string, now: Date): string {
  const date = formatMoscowDate(chargeAt)
  const days = moscowDaysUntil(chargeAt, now)
  if (days > 1) return `Через ${days} ${plural(days, 'день', 'дня', 'дней')}, ${date},`
  if (days === 1) return `Завтра, ${date},`
  return `Сегодня, ${date},`
}

/**
 * The notice the offer promises before every automatic charge: the amount, the day, the
 * payment method and how to switch auto-renewal off.
 *
 * The charge waits for the notice to be queued, not for it to be delivered: a customer who
 * switches auto-renewal on in the last minutes of a period is charged while the letter is
 * still on its way. So a letter sent at or after the moment of the charge promises nothing
 * about the future: it names the charge and its day, which is true whether or not the money
 * has already been taken.
 */
export function renderRenewalNotice(data: MailData['renewal-notice'], now: Date): RenderedEmail {
  const amount = formatRubles(data.amount)
  const plan = `тариф «${data.planName}»`
  const ahead = new Date(data.chargeAt).getTime() > now.getTime()
  const subject = ahead ? `Скоро спишем ${amount} за ${plan}` : `Списание ${amount} за ${plan}`
  const url = plansUrl(data.appUrl)
  const charge = ahead
    ? `${chargeDay(data.chargeAt, now)} спишем ${amount} за ${plan}: у вас включено автопродление.`
    : `Списание ${amount} за ${plan} назначено на ${formatMoscowDate(data.chargeAt)}: у вас включено автопродление.`
  const method = `Способ оплаты: ${data.paymentMethod}.`
  const optOut = ahead
    ? 'Чтобы тариф не продлевался, отключите автопродление на странице «Тарифы» до списания.'
    : 'Чтобы тариф больше не продлевался, отключите автопродление на странице «Тарифы».'

  return {
    subject,
    text: textLayout([greeting(), charge, method, `${optOut}\n${url}`]),
    html: layout(
      subject,
      p(greeting()) +
        p(charge) +
        p(method) +
        p(optOut) +
        button('Открыть «Тарифы»', url) +
        fallbackLink(url),
    ),
  }
}
