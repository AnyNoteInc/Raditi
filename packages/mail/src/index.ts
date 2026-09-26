// Transactional mail: templates (Russian, «вы») and SendSay delivery.
export {
  createMailer,
  DEFAULT_SENDER,
  mailerConfigFromEnv,
  type Mailer,
  type MailerConfig,
} from './mailer.ts'
export {
  createSendsayTransport,
  SENDSAY_API_URL,
  type SendsayClient,
  type SendsayTransportOptions,
} from './sendsay.ts'
export { renderTemplate } from './templates/index.ts'
export {
  mailDataSchemas,
  mailKinds,
  type MailData,
  type MailKind,
  type MailMessage,
  type RenderedEmail,
} from './templates/schemas.ts'
export {
  createLogTransport,
  MailDeliveryError,
  type MailLogger,
  type MailSender,
  type MailTransport,
  type OutgoingEmail,
} from './transport.ts'
