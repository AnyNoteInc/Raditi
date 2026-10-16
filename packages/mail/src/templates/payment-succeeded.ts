import { formatCount, formatMoscowDate, formatRubles, plansUrl, plural } from './billing-format.ts'
import { button, fallbackLink, greeting, layout, p, textLayout } from './layout.ts'
import type { MailData, RenderedEmail } from './schemas.ts'

export function renderPaymentSucceeded(data: MailData['payment-succeeded']): RenderedEmail {
  const subject = 'Оплата прошла'
  const url = plansUrl(data.appUrl)
  const amount = formatRubles(data.amount)
  const lines =
    data.item === 'plan'
      ? [
          `Оплата прошла: тариф «${data.planName}» — ${amount}.`,
          // What the payment gave: the period, and the credits granted for it.
          `Тариф действует до ${formatMoscowDate(data.periodEnd)}. Начислили ${formatCount(data.credits)} ${plural(data.credits, 'кредит', 'кредита', 'кредитов')} на этот период.`,
        ]
      : [
          // After «из» the count of one takes another form: «из 1 кредита», but «из 100 кредитов».
          `Оплата прошла: пакет из ${formatCount(data.packCredits)} ${plural(data.packCredits, 'кредита', 'кредитов', 'кредитов')} — ${amount}.`,
          'Кредиты из пакета уже добавлены и не сгорают в конце периода.',
        ]
  const details = 'Подробности — на странице «Тарифы».'

  return {
    subject,
    text: textLayout([greeting(), ...lines, `${details}\n${url}`]),
    html: layout(
      subject,
      p(greeting()) +
        lines.map((line) => p(line)).join('') +
        p(details) +
        button('Открыть «Тарифы»', url) +
        fallbackLink(url),
    ),
  }
}
