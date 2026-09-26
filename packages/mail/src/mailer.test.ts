import { describe, expect, it, vi } from 'vitest'

import { createMailer, mailerConfigFromEnv } from './mailer.ts'
import type { MailTransport, OutgoingEmail } from './transport.ts'

function fakeTransport() {
  const sent: OutgoingEmail[] = []
  const transport: MailTransport = {
    send: (email) => {
      sent.push(email)
      return Promise.resolve()
    },
  }
  return { transport, sent }
}

const verifyEmail = {
  kind: 'verify-email',
  to: 'owner@example.ru',
  data: { url: 'https://raditi.ru/api/auth/verify-email?token=abc' },
} as const

describe('createMailer', () => {
  it('renders the letter and sends it from noreply@raditi.ru by default', async () => {
    const { transport, sent } = fakeTransport()

    await createMailer({ transport }).sendMail(verifyEmail)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      from: { email: 'noreply@raditi.ru', name: 'Радити' },
      to: 'owner@example.ru',
      subject: 'Подтвердите адрес почты',
    })
    expect(sent[0]?.html).toContain('href="https://raditi.ru/api/auth/verify-email?token=abc"')
  })

  it('takes the sender from config', async () => {
    const { transport, sent } = fakeTransport()

    await createMailer({ transport, from: { name: 'Радити, поддержка' } }).sendMail(verifyEmail)

    expect(sent[0]?.from).toEqual({ email: 'noreply@raditi.ru', name: 'Радити, поддержка' })
  })

  it('rejects an invalid recipient before sending', async () => {
    const { transport, sent } = fakeTransport()

    await expect(
      createMailer({ transport }).sendMail({ ...verifyEmail, to: 'not-an-email' }),
    ).rejects.toThrow()
    expect(sent).toHaveLength(0)
  })

  it('propagates delivery failures so the job is retried', async () => {
    const transport: MailTransport = { send: () => Promise.reject(new Error('down')) }

    await expect(createMailer({ transport }).sendMail(verifyEmail)).rejects.toThrow('down')
  })

  it('logs the subject and the links instead of sending without an API key', async () => {
    const logger = { info: vi.fn() }

    await createMailer({ logger }).sendMail(verifyEmail)

    expect(logger.info).toHaveBeenCalledOnce()
    const line = String(logger.info.mock.calls[0]?.[0])
    expect(line).toContain('Подтвердите адрес почты')
    expect(line).toContain('https://raditi.ru/api/auth/verify-email?token=abc')
  })
})

describe('mailerConfigFromEnv', () => {
  it('passes the SendSay key through', () => {
    expect(mailerConfigFromEnv({ APP_ENV: 'production', SENDSAY_API_KEY: 'key' })).toEqual({
      sendsayApiKey: 'key',
    })
  })

  it.each([
    ['missing', undefined],
    ['blank', ''],
    ['misspelt', 'prod'],
  ])('refuses a %s APP_ENV instead of assuming development', (_case, APP_ENV) => {
    expect(() => mailerConfigFromEnv({ APP_ENV, SENDSAY_API_KEY: 'key' })).toThrow(/APP_ENV/)
  })

  it('treats an empty key as absent in development', () => {
    expect(mailerConfigFromEnv({ APP_ENV: 'development', SENDSAY_API_KEY: '' })).toEqual({
      sendsayApiKey: undefined,
    })
  })

  it('requires the key in production', () => {
    expect(() => mailerConfigFromEnv({ APP_ENV: 'production', SENDSAY_API_KEY: '' })).toThrow(
      'SENDSAY_API_KEY',
    )
  })
})
