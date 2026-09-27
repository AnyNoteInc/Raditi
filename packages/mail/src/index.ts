// Transactional mail: templates (Russian, «вы») and SendSay delivery.
export { createMailer, mailerConfigFromEnv, type Mailer, type MailerConfig } from './mailer.ts'
export { mailDataSchemas, type MailMessage } from './templates/schemas.ts'
export { MailDeliveryError } from './transport.ts'
