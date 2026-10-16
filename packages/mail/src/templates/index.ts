import { renderPaymentFailed } from './payment-failed.ts'
import { renderPaymentSucceeded } from './payment-succeeded.ts'
import { renderRenewalNotice } from './renewal-notice.ts'
import { renderResetPassword } from './reset-password.ts'
import { mailDataSchemas, type MailData, type MailKind, type RenderedEmail } from './schemas.ts'
import { renderSubscriptionEnded } from './subscription-ended.ts'
import { renderVerifyEmail } from './verify-email.ts'
import { renderWelcome } from './welcome.ts'

const renderers: { [K in MailKind]: (data: MailData[K], now: Date) => RenderedEmail } = {
  'verify-email': renderVerifyEmail,
  'reset-password': renderResetPassword,
  welcome: renderWelcome,
  'payment-succeeded': renderPaymentSucceeded,
  'renewal-notice': renderRenewalNotice,
  'payment-failed': renderPaymentFailed,
  'subscription-ended': renderSubscriptionEnded,
}

/**
 * Validates the data (links must be http(s)) and renders subject, HTML and text. `now` is the
 * moment of sending: the renewal notice counts the days to the charge from it.
 */
export function renderTemplate<K extends MailKind>(
  kind: K,
  data: MailData[K],
  now: Date = new Date(),
): RenderedEmail {
  const parsed = mailDataSchemas[kind].parse(data) as MailData[K]
  return renderers[kind](parsed, now)
}
