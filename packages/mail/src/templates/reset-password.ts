import {
  button,
  fallbackLink,
  formatMoscowDateTime,
  greeting,
  layout,
  p,
  textLayout,
} from './layout.ts'
import type { MailData, RenderedEmail } from './schemas.ts'

export function renderResetPassword(data: MailData['reset-password']): RenderedEmail {
  const subject = 'Восстановление пароля'
  const intro = 'Вы запросили восстановление пароля в Радити.'
  const expires = data.expiresAt
    ? `Ссылка действует до ${formatMoscowDateTime(data.expiresAt)}.`
    : undefined
  const outro =
    'Если вы не запрашивали восстановление, ничего делать не нужно: пароль останется прежним.'

  return {
    subject,
    text: textLayout(
      [
        greeting(),
        `${intro} Задать новый пароль можно по ссылке:\n${data.url}`,
        expires,
        outro,
      ].filter((line) => line !== undefined),
    ),
    html: layout(
      subject,
      p(greeting()) +
        p(intro) +
        button('Задать новый пароль', data.url) +
        fallbackLink(data.url) +
        (expires ? p(expires) : '') +
        p(outro),
    ),
  }
}
