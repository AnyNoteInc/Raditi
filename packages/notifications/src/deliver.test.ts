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

  describe('billing events', () => {
    const to = 'owner@example.ru'
    const appUrl = 'https://raditi.ru'
    const paymentMethod = 'Карта «Мир» •• 4444'
    const periodEnd = '2026-10-18T09:30:00.000Z'

    const paidPlan = {
      item: 'plan',
      planName: 'Бизнес',
      amount: '12900.00',
      periodEnd,
      credits: 800,
      appUrl,
    }
    const paidPack = { item: 'pack', packCredits: 100, amount: '1990.00', appUrl }
    const renewalNotice = {
      planName: 'Бизнес',
      amount: '12900.00',
      chargeAt: periodEnd,
      paymentMethod,
      appUrl,
    }
    const paymentFailed = {
      planName: 'Бизнес',
      amount: '12900.00',
      paymentMethod,
      giftCreditsLeft: 35,
      appUrl,
    }
    const subscriptionEnded = {
      planName: 'Бизнес',
      endedAt: periodEnd,
      packCreditsLeft: 0,
      giftCreditsLeft: 35,
      appUrl,
    }

    it.each([
      ['billing.payment_succeeded', 'payment-succeeded', paidPlan],
      ['billing.payment_succeeded', 'payment-succeeded', paidPack],
      ['billing.renewal_notice', 'renewal-notice', renewalNotice],
      ['billing.payment_failed', 'payment-failed', paymentFailed],
      ['billing.subscription_ended', 'subscription-ended', subscriptionEnded],
    ])('maps %s to the %s letter', async (type, kind, data) => {
      const { mailer, sendMail } = fakeMailer()

      await deliverNotification({ type, payload: { to, ...data } }, { mailer })

      expect(sendMail).toHaveBeenCalledExactlyOnceWith({ kind, to, data })
    })

    it('drops fields the letter does not use, for a tariff and for a pack', async () => {
      const { mailer, sendMail } = fakeMailer()

      for (const paid of [paidPlan, paidPack]) {
        await deliverNotification(
          {
            type: 'billing.payment_succeeded',
            payload: { to, ...paid, userId: 'user-1', orderId: 'order-1' },
          },
          { mailer },
        )
      }

      expect(sendMail.mock.calls.map(([message]) => message.data)).toEqual([paidPlan, paidPack])
    })

    it.each([
      ['an amount that is not a decimal string', { amount: '12900' }, ['amount']],
      ['an amount as a number', { amount: 12900 }, ['amount']],
      ['a date that is not ISO', { periodEnd: '18.10.2026' }, ['periodEnd']],
      ['a link that is not http(s)', { appUrl: 'javascript:alert(1)' }, ['appUrl']],
      ['an unknown paid item', { item: 'topup' }, ['item']],
      ['credits of the tariff that are not a whole number', { credits: 799.5 }, ['credits']],
      ['credits of the tariff as a string', { credits: '800' }, ['credits']],
      ['a recipient that is not an address', { to: 'secret-recipient' }, ['to']],
    ])('rejects %s and names only the field', async (_case, change, fields) => {
      const { mailer, sendMail } = fakeMailer()

      const error = await deliverNotification(
        {
          type: 'billing.payment_succeeded',
          payload: { to: 'secret@example.ru', ...paidPlan, ...change },
        },
        { mailer },
      ).catch((e: unknown) => e)

      expect(error).toMatchObject({ code: 'BAD_REQUEST', details: { fields } })
      expect(JSON.stringify(error)).not.toMatch(/secret|Бизнес|12900/)
      expect(sendMail).not.toHaveBeenCalled()
    })

    it('rejects a tariff payment without the end of its period', async () => {
      const { mailer, sendMail } = fakeMailer()
      const { periodEnd: _periodEnd, ...withoutPeriod } = paidPlan

      const error = await deliverNotification(
        { type: 'billing.payment_succeeded', payload: { to, ...withoutPeriod } },
        { mailer },
      ).catch((e: unknown) => e)

      expect(error).toMatchObject({ code: 'BAD_REQUEST', details: { fields: ['periodEnd'] } })
      expect(sendMail).not.toHaveBeenCalled()
    })

    it.each([
      ['billing.renewal_notice', 'paymentMethod', renewalNotice],
      ['billing.renewal_notice', 'chargeAt', renewalNotice],
      ['billing.payment_failed', 'amount', paymentFailed],
      // Without the gift credits the letter cannot tell whether new tasks are taken.
      ['billing.payment_failed', 'giftCreditsLeft', paymentFailed],
      ['billing.subscription_ended', 'packCreditsLeft', subscriptionEnded],
      ['billing.subscription_ended', 'giftCreditsLeft', subscriptionEnded],
    ])('rejects %s without %s', async (type, field, data) => {
      const { mailer, sendMail } = fakeMailer()

      const error = await deliverNotification(
        { type, payload: { to, ...data, [field]: undefined } },
        { mailer },
      ).catch((e: unknown) => e)

      expect(error).toMatchObject({ code: 'BAD_REQUEST', details: { fields: [field] } })
      expect(sendMail).not.toHaveBeenCalled()
    })
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
