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

export function renderVerifyEmail(data: MailData['verify-email']): RenderedEmail {
  const subject = 'Подтвердите адрес почты'
  const intro = 'Чтобы закончить регистрацию в Радити, подтвердите адрес почты.'
  const expires = data.expiresAt
    ? `Ссылка действует до ${formatMoscowDateTime(data.expiresAt)}.`
    : undefined
  const outro = 'Если вы не регистрировались в Радити, просто удалите это письмо.'

  return {
    subject,
    text: textLayout(
      [
        greeting(),
        `Чтобы закончить регистрацию в Радити, подтвердите адрес почты — откройте ссылку:\n${data.url}`,
        expires,
        outro,
      ].filter((line) => line !== undefined),
    ),
    html: layout(
      subject,
      p(greeting()) +
        p(intro) +
        button('Подтвердить адрес', data.url) +
        fallbackLink(data.url) +
        (expires ? p(expires) : '') +
        p(outro),
    ),
  }
}
