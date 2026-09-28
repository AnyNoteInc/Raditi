import { isDomainError } from '@repo/domain'
import type { Mailer, MailMessage } from '@repo/mail'
import { describe, expect, it, vi } from 'vitest'

import { deliverNotification } from './deliver.ts'

function fakeMailer() {
  const sendMail = vi.fn((_message: MailMessage) => Promise.resolve())
  const mailer: Mailer = { sendMail }
  return { mailer, sendMail }
}

describe('deliverNotification', () => {
  it('sends the verification letter', async () => {
    const { mailer, sendMail } = fakeMailer()

    await deliverNotification(
      {
        type: 'auth.verify_email',
        payload: {
          to: 'owner@example.ru',
          url: 'https://raditi.ru/api/auth/verify-email?token=abc',
          expiresAt: '2026-09-26T18:00:00.000Z',
        },
      },
      { mailer },
    )

    expect(sendMail).toHaveBeenCalledExactlyOnceWith({
      kind: 'verify-email',
      to: 'owner@example.ru',
      data: {
        url: 'https://raditi.ru/api/auth/verify-email?token=abc',
        expiresAt: '2026-09-26T18:00:00.000Z',
      },
    })
  })

  it('drops the name from a verification job queued before names were removed', async () => {
    const { mailer, sendMail } = fakeMailer()

    await deliverNotification(
      {
        type: 'auth.verify_email',
        payload: { to: 'owner@example.ru', name: 'Анна', url: 'https://raditi.ru/verify?t=1' },
      },
      { mailer },
    )

    expect(sendMail.mock.calls[0]?.[0].data).toEqual({ url: 'https://raditi.ru/verify?t=1' })
  })

  it('maps every auth event to its letter', async () => {
    const { mailer, sendMail } = fakeMailer()

    await deliverNotification(
      {
        type: 'auth.reset_password',
        payload: { to: 'owner@example.ru', url: 'https://raditi.ru/reset?token=1' },
      },
      { mailer },
    )
    await deliverNotification(
      {
        type: 'auth.welcome',
        payload: { to: 'owner@example.ru', name: 'Анна', appUrl: 'https://raditi.ru/app' },
      },
      { mailer },
    )

    expect(sendMail.mock.calls.map(([message]) => message.kind)).toEqual([
      'reset-password',
      'welcome',
    ])
  })

  it('drops fields the letter does not use', async () => {
    const { mailer, sendMail } = fakeMailer()

    await deliverNotification(
      {
        type: 'auth.welcome',
        payload: {
          to: 'owner@example.ru',
          name: 'Анна',
          appUrl: 'https://raditi.ru/app',
          extra: 1,
        },
      },
      { mailer },
    )

    expect(sendMail.mock.calls[0]?.[0].data).toEqual({
      name: 'Анна',
      appUrl: 'https://raditi.ru/app',
    })
  })

  it('rejects an unknown type as a non-retryable domain error', async () => {
    const { mailer, sendMail } = fakeMailer()

    const error = await deliverNotification(
      { type: 'auth.unknown', payload: {} },
      { mailer },
    ).catch((e: unknown) => e)

    expect(isDomainError(error)).toBe(true)
    expect(error).toMatchObject({ code: 'BAD_REQUEST' })
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('rejects an invalid payload and names only the fields', async () => {
    const { mailer, sendMail } = fakeMailer()

    const error = await deliverNotification(
      {
        type: 'auth.verify_email',
        payload: { to: 'secret@example.ru', url: 'javascript:alert(1)' },
      },
      { mailer },
    ).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'BAD_REQUEST', details: { fields: ['url'] } })
    expect(JSON.stringify(error)).not.toContain('secret@example.ru')
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('rethrows delivery failures so the job is retried', async () => {
    const mailer: Mailer = { sendMail: () => Promise.reject(new Error('SendSay is down')) }

    await expect(
      deliverNotification(
        {
          type: 'auth.welcome',
          payload: { to: 'owner@example.ru', name: 'Анна', appUrl: 'https://raditi.ru/app' },
        },
        { mailer },
      ),
    ).rejects.toThrow('SendSay is down')
  })
})
