import type { Mailer } from '@repo/mail'
import { MailDeliveryError } from '@repo/mail'
import { UnrecoverableError, type Job } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'

import { NotificationsProcessor } from './notifications.processor.ts'

const job = (name: string, data: unknown) => ({ name, data, id: 'job-1' }) as unknown as Job

function setup(sendMail: Mailer['sendMail'] = vi.fn().mockResolvedValue(undefined)) {
  const mailer = { sendMail: vi.fn(sendMail) }
  return { processor: new NotificationsProcessor(mailer), mailer }
}

describe('NotificationsProcessor', () => {
  it('delivers a notification by job name and data', async () => {
    const { processor, mailer } = setup()

    await processor.process(
      job('auth.verify_email', {
        to: 'owner@example.ru',
        url: 'https://raditi.ru/verify?token=t1',
      }),
    )

    expect(mailer.sendMail).toHaveBeenCalledOnce()
    expect(mailer.sendMail.mock.calls[0]?.[0]).toEqual({
      kind: 'verify-email',
      to: 'owner@example.ru',
      data: { url: 'https://raditi.ru/verify?token=t1' },
    })
  })

  it('does not retry an unknown notification type', async () => {
    const { processor, mailer } = setup()

    await expect(processor.process(job('auth.unknown', {}))).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    expect(mailer.sendMail).not.toHaveBeenCalled()
  })

  it('does not retry an invalid payload', async () => {
    const { processor } = setup()

    await expect(
      processor.process(job('auth.welcome', { to: 'not-an-email' })),
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('rethrows delivery failures so BullMQ retries them', async () => {
    const failure = new MailDeliveryError('timeout', 'SendSay did not answer')
    const { processor } = setup(vi.fn().mockRejectedValue(failure))

    await expect(
      processor.process(
        job('auth.welcome', { to: 'owner@example.ru', name: 'Ольга', appUrl: 'https://raditi.ru' }),
      ),
    ).rejects.toBe(failure)
  })
})
