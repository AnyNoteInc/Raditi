import { renderResetPassword } from './reset-password.ts'
import { mailDataSchemas, type MailData, type MailKind, type RenderedEmail } from './schemas.ts'
import { renderVerifyEmail } from './verify-email.ts'
import { renderWelcome } from './welcome.ts'

const renderers: { [K in MailKind]: (data: MailData[K]) => RenderedEmail } = {
  'verify-email': renderVerifyEmail,
  'reset-password': renderResetPassword,
  welcome: renderWelcome,
}

/** Validates the data (links must be http(s)) and renders subject, HTML and text. */
export function renderTemplate<K extends MailKind>(kind: K, data: MailData[K]): RenderedEmail {
  const parsed = mailDataSchemas[kind].parse(data) as MailData[K]
  return renderers[kind](parsed)
}
