import { formatRubles, plansUrl, tasksWithoutTariff } from './billing-format.ts'
import { button, fallbackLink, greeting, layout, p, textLayout } from './layout.ts'
import type { MailData, RenderedEmail } from './schemas.ts'

export function renderPaymentFailed(data: MailData['payment-failed']): RenderedEmail {
  const subject = 'Оплата не прошла'
  const url = plansUrl(data.appUrl)
  const failed = `Не получилось списать ${formatRubles(data.amount)} за тариф «${data.planName}».`
  const method = `Способ оплаты: ${data.paymentMethod}.`
  // Gift credits are spent without a paid tariff as well: while those that are left can start
  // a task, the letter does not say that tasks are not taken — as the alert of «Тарифы» does not.
  const consequence = `Пока оплата не пройдёт, новые задачи ${tasksWithoutTariff(data.giftCreditsLeft, 'не принимаются')}.`
  // Only the payment the customer makes by hand settles a charge that failed: nothing is
  // charged again by itself, whatever card is saved. And the letter goes out at any shop —
  // one that takes one-time payments only replaces no payment method —, so it offers no
  // replacement: the sentence is true wherever it is read.
  const action = 'Оплатить тариф можно на странице «Тарифы».'

  return {
    subject,
    text: textLayout([greeting(), failed, method, consequence, `${action}\n${url}`]),
    html: layout(
      subject,
      p(greeting()) +
        p(failed) +
        p(method) +
        p(consequence) +
        p(action) +
        button('Открыть «Тарифы»', url) +
        fallbackLink(url),
    ),
  }
}
