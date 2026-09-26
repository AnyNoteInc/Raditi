import { button, greeting, layout, p, textLayout } from './layout.ts'
import type { MailData, RenderedEmail } from './schemas.ts'

export function renderWelcome(data: MailData['welcome']): RenderedEmail {
  const subject = 'Добро пожаловать в Радити'
  const intro = 'Спасибо, что выбрали Радити.'
  const howItWorks =
    'Подключите свой сайт и напишите в чате, что на нём поменять. Мы внесём правку и покажем результат.'

  return {
    subject,
    text: textLayout([greeting(data.name), intro, howItWorks, `Личный кабинет: ${data.appUrl}`]),
    html: layout(
      subject,
      p(greeting(data.name)) +
        p(intro) +
        p(howItWorks) +
        button('Открыть личный кабинет', data.appUrl),
    ),
  }
}
