export interface MailSender {
  email: string
  name: string
}

export interface OutgoingEmail {
  from: MailSender
  to: string
  subject: string
  html: string
  text: string
}

export interface MailTransport {
  /** Throws MailDeliveryError when the provider rejects or does not answer, so the job is retried. */
  send(email: OutgoingEmail): Promise<void>
}

export interface MailLogger {
  info(message: string): void
}

export class MailDeliveryError extends Error {
  /** Provider error id, e.g. "error/email/invalid", or "timeout". */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'MailDeliveryError'
    this.code = code
  }
}

const LINK = /https?:\/\/[^\s<>"']+/g

/** Local development without SENDSAY_API_KEY: nothing is sent, links are printed to open by hand. */
export function createLogTransport(logger: MailLogger = console): MailTransport {
  return {
    send(email) {
      const links = [...new Set(email.text.match(LINK) ?? [])]
      logger.info(
        [
          `[mail] not sent (SENDSAY_API_KEY is empty): "${email.subject}" to ${email.to}`,
          ...links.map((link) => `  ${link}`),
        ].join('\n'),
      )
      return Promise.resolve()
    },
  }
}
