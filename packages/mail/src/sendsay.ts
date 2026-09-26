// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- sendsay-api has no types; the shim must follow this file into every program that compiles it
/// <reference path="./sendsay-api.d.ts" />
import Sendsay from 'sendsay-api'

import { MailDeliveryError, type MailTransport } from './transport.ts'

export const SENDSAY_API_URL = 'https://api.sendsay.ru'

export interface SendsayClient {
  request(payload: Record<string, unknown>): Promise<unknown>
}

export interface SendsayTransportOptions {
  apiKey: string
  apiUrl?: string
  /** sendsay-api has no request timeout; a hung call would hold the queue worker forever. */
  timeoutMs?: number
}

/**
 * Transactional mail through SendSay (issue.send). Every failure is thrown as
 * MailDeliveryError: the notifications queue retries the job, nothing is swallowed.
 */
export function createSendsayTransport(
  options: SendsayTransportOptions,
  client: SendsayClient = new Sendsay({
    apiKey: options.apiKey,
    apiUrl: options.apiUrl ?? SENDSAY_API_URL,
  }),
): MailTransport {
  const timeoutMs = options.timeoutMs ?? 20_000

  return {
    async send(email) {
      const request = client.request({
        action: 'issue.send',
        sendwhen: 'now',
        letter: {
          subject: email.subject,
          'from.name': email.from.name,
          'from.email': email.from.email,
          message: { html: email.html, text: email.text },
        },
        'users.list': email.to,
        // "personal" is SendSay's preset group for transactional issues.
        group: 'personal',
      })

      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new MailDeliveryError('timeout', `SendSay did not answer in ${timeoutMs} ms`)),
          timeoutMs,
        )
      })

      let response: unknown
      try {
        response = await Promise.race([request, timeout])
      } catch (error) {
        throw toDeliveryError(error)
      } finally {
        clearTimeout(timer)
      }

      const errors = (response as { errors?: unknown[] } | null)?.errors
      if (errors?.length) throw toDeliveryError(errors[0])
    },
  }
}

/**
 * sendsay-api rejects with the raw error object ({ id, explain, request }), not an Error.
 * The request carries the recipient and the letter, so it never goes into the message.
 */
function toDeliveryError(error: unknown): MailDeliveryError {
  if (error instanceof MailDeliveryError) return error
  if (error instanceof Error)
    return new MailDeliveryError('network', `SendSay request failed: ${error.message}`)
  if (error && typeof error === 'object') {
    const { id, explain } = error as { id?: unknown; explain?: unknown }
    const code = typeof id === 'string' ? id : 'unknown'
    const detail = typeof explain === 'string' ? `: ${explain}` : ''
    return new MailDeliveryError(code, `SendSay rejected the letter (${code})${detail}`)
  }
  return new MailDeliveryError('unknown', 'SendSay request failed')
}
