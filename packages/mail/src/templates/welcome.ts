import { signupGiftCredits } from '@repo/domain'

import { formatCount, giftIsEnoughFor, plural } from './billing-format.ts'
import { button, greeting, layout, p, textLayout } from './layout.ts'
import type { MailData, RenderedEmail } from './schemas.ts'

/**
 * «Мы дарим вам 35 кредитов, чтобы попробовать: их хватит на семь небольших правок или на
 * две-три задачи побольше.» The gift of the registration, by the constant of the domain: it is
 * granted with the personal workspace, which the first site makes.
 */
export function signupGiftLine(credits: number = signupGiftCredits): string {
  const gift = `Мы дарим вам ${formatCount(credits)} ${plural(credits, 'кредит', 'кредита', 'кредитов')}, чтобы попробовать`
  const enough = giftIsEnoughFor(credits)
  return enough === null
    ? `${gift}.`
    : `${gift}: ${plural(credits, 'его', 'их', 'их')} хватит ${enough}.`
}

export function renderWelcome(data: MailData['welcome']): RenderedEmail {
  const subject = 'Добро пожаловать в Радити'
  const intro = 'Спасибо, что выбрали Радити.'
  const howItWorks =
    'Подключите свой сайт и напишите в чате, что на нём поменять. Мы внесём правку и покажем результат.'
  const gift = signupGiftLine()

  return {
    subject,
    text: textLayout([
      greeting(data.name),
      intro,
      howItWorks,
      gift,
      `Личный кабинет: ${data.appUrl}`,
    ]),
    html: layout(
      subject,
      p(greeting(data.name)) +
        p(intro) +
        p(howItWorks) +
        p(gift) +
        button('Открыть личный кабинет', data.appUrl),
    ),
  }
}
