import {
  formatCount,
  formatMoscowDate,
  giftTakesTasks,
  plansUrl,
  tasksWithoutTariff,
} from './billing-format.ts'
import { button, fallbackLink, greeting, layout, p, textLayout } from './layout.ts'
import type { MailData, RenderedEmail } from './schemas.ts'

/**
 * What the customer keeps after the tariff. Pack and gift credits never expire: the letter
 * names those the customer has and none it has not, and counts the pack — its credits wait for
 * a tariff.
 */
function keptText(pack: number, gift: number): string {
  let kept = 'Сайты'
  if (pack > 0 && gift > 0) kept = 'Кредиты из пакета и подарочные, сайты'
  else if (pack > 0) kept = 'Кредиты из пакета, сайты'
  else if (gift > 0) kept = 'Подарочные кредиты, сайты'
  const counted = pack > 0 ? ` Кредитов из пакета осталось: ${formatCount(pack)}.` : ''
  return `${kept} и история правок сохраняются.${counted}`
}

export function renderSubscriptionEnded(data: MailData['subscription-ended']): RenderedEmail {
  const subject = 'Тариф закончился'
  const url = plansUrl(data.appUrl)
  const gift = data.giftCreditsLeft
  // Gift credits are spent without a tariff as well: while those that are left can start a
  // task, the letter says of new tasks what «Тарифы» says, and names the tariff as what comes
  // after the gift, not as the way to set tasks «again».
  const ended =
    `Тариф «${data.planName}» закончился ${formatMoscowDate(data.endedAt)}. ` +
    `Новые задачи ${tasksWithoutTariff(gift, 'сейчас не принимаются')}.`
  const kept = keptText(data.packCreditsLeft, gift)
  const action = giftTakesTasks(gift)
    ? 'Когда подарочные кредиты закончатся, понадобится тариф: выбрать его можно на странице «Тарифы».'
    : 'Чтобы снова ставить задачи, выберите тариф на странице «Тарифы».'

  return {
    subject,
    text: textLayout([greeting(), ended, kept, `${action}\n${url}`]),
    html: layout(
      subject,
      p(greeting()) +
        p(ended) +
        p(kept) +
        p(action) +
        button('Выбрать тариф', url) +
        fallbackLink(url),
    ),
  }
}
