import type { OutboxWriter } from '@repo/db'
import { describe, expect, it, vi } from 'vitest'

import { enqueueNotification, notify } from './enqueue.ts'

function fakeDb(count = 1) {
  const createMany = vi.fn().mockResolvedValue({ count })
  const db = { outboxEvent: { createMany } } as unknown as OutboxWriter
  const rows = () => createMany.mock.calls.map(([args]) => args.data[0])
  return { db, createMany, rows }
}

const verify = {
  to: 'owner@example.ru',
  url: 'https://raditi.ru/api/auth/verify-email?token=abc',
  expiresAt: '2026-09-26T18:00:00.000Z',
}

describe('notify', () => {
  it('writes the verification letter to the notifications topic of the outbox', async () => {
    const { db, createMany, rows } = fakeDb()

    const enqueued = await notify.verifyEmail(verify, { db })

    expect(enqueued).toBe(true)
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }))
    expect(rows()[0]).toMatchObject({
      topic: 'notifications',
      type: 'auth.verify_email',
      payload: verify,
    })
  })

  it('keys a link by its hash, never by the token itself', async () => {
    const { db, rows } = fakeDb()

    await notify.verifyEmail(verify, { db })
    await notify.verifyEmail(verify, { db })
    await notify.verifyEmail(
      { ...verify, url: 'https://raditi.ru/api/auth/verify-email?token=def' },
      { db },
    )

    const [first, repeated, other] = rows().map((row) => row.dedupeKey as string)
    expect(first).toMatch(/^auth\.verify_email:[0-9a-f]{32}$/)
    expect(first).not.toContain('abc')
    expect(repeated).toBe(first)
    expect(other).not.toBe(first)
  })

  it('uses separate keys for verification and password reset', async () => {
    const { db, rows } = fakeDb()
    const url = 'https://raditi.ru/same-link'

    await notify.verifyEmail({ ...verify, url }, { db })
    await notify.resetPassword({ to: verify.to, url }, { db })

    const [verifyKey, resetKey] = rows().map((row) => row.dedupeKey as string)
    expect(resetKey).toMatch(/^auth\.reset_password:/)
    expect(resetKey).not.toBe(verifyKey)
  })

  it('sends at most one welcome letter per user and keeps the user id out of the payload', async () => {
    const { db, rows } = fakeDb()

    await notify.welcome(
      { userId: 'user-1', to: 'owner@example.ru', name: 'Анна', appUrl: 'https://raditi.ru/app' },
      { db },
    )

    expect(rows()[0]).toMatchObject({
      type: 'auth.welcome',
      dedupeKey: 'auth.welcome:user-1',
      payload: { to: 'owner@example.ru', name: 'Анна', appUrl: 'https://raditi.ru/app' },
    })
    expect(rows()[0]?.payload).not.toHaveProperty('userId')
  })

  it('keeps the name out of letters with one-time links', async () => {
    const { db, rows } = fakeDb()
    const withName = { ...verify, name: 'Анна' } as typeof verify

    await notify.verifyEmail(withName, { db })
    await notify.resetPassword(withName, { db })

    for (const row of rows()) expect(row.payload).not.toHaveProperty('name')
  })

  it('reports a duplicate as not enqueued', async () => {
    const { db } = fakeDb(0)

    expect(await notify.verifyEmail(verify, { db })).toBe(false)
  })
})

describe('enqueueNotification', () => {
  it('validates the payload before writing', async () => {
    const { db, createMany } = fakeDb()

    await expect(
      enqueueNotification('auth.verify_email', { ...verify, to: 'not-an-email' }, { db }),
    ).rejects.toThrow()
    expect(createMany).not.toHaveBeenCalled()
  })

  it('passes a caller-supplied dedupe key through', async () => {
    const { db, rows } = fakeDb()

    await enqueueNotification(
      'auth.welcome',
      { to: 'owner@example.ru', name: '', appUrl: 'https://raditi.ru/app' },
      { db, dedupeKey: 'custom-key' },
    )

    expect(rows()[0]?.dedupeKey).toBe('custom-key')
  })
})

describe('billing notifications', () => {
  const to = 'owner@example.ru'
  const appUrl = 'https://raditi.ru'
  const paymentMethod = 'СБП'
  const periodEnd = '2026-10-18T09:30:00.000Z'

  it('writes a paid tariff to the notifications topic under the key of its order', async () => {
    const { db, createMany, rows } = fakeDb()
    const payload = {
      to,
      item: 'plan',
      planName: 'Бизнес',
      amount: '12900.00',
      periodEnd,
      credits: 800,
      appUrl,
    } as const

    const enqueued = await enqueueNotification('billing.payment_succeeded', payload, {
      db,
      dedupeKey: 'billing.payment_succeeded:order-1',
    })

    expect(enqueued).toBe(true)
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }))
    expect(rows()).toEqual([
      {
        topic: 'notifications',
        type: 'billing.payment_succeeded',
        payload,
        dedupeKey: 'billing.payment_succeeded:order-1',
      },
    ])
  })

  it('writes a paid pack with its size as a number', async () => {
    const { db, rows } = fakeDb()
    const payload = { to, item: 'pack', packCredits: 100, amount: '1990.00', appUrl } as const

    await enqueueNotification('billing.payment_succeeded', payload, { db })

    expect(rows()[0]).toMatchObject({ type: 'billing.payment_succeeded', payload })
  })

  it('refuses a paid tariff without the end of its period, in types and at run time', async () => {
    const { db, createMany } = fakeDb()

    await expect(
      enqueueNotification(
        'billing.payment_succeeded',
        // @ts-expect-error -- a tariff payment carries periodEnd; only a pack goes without it
        { to, item: 'plan', planName: 'Бизнес', amount: '12900.00', credits: 800, appUrl },
        { db },
      ),
    ).rejects.toThrow()
    expect(createMany).not.toHaveBeenCalled()
  })

  it('refuses a paid tariff without the credits it was granted, in types and at run time', async () => {
    const { db, createMany } = fakeDb()

    await expect(
      enqueueNotification(
        'billing.payment_succeeded',
        // @ts-expect-error -- the letter says how many credits the period was granted
        { to, item: 'plan', planName: 'Бизнес', amount: '12900.00', periodEnd, appUrl },
        { db },
      ),
    ).rejects.toThrow()
    expect(createMany).not.toHaveBeenCalled()
  })

  it('writes the renewal notice, the failed charge and the end of the tariff', async () => {
    const { db, rows } = fakeDb()
    const renewalNotice = {
      to,
      planName: 'Бизнес',
      amount: '12900.00',
      chargeAt: periodEnd,
      paymentMethod,
      appUrl,
    }
    const paymentFailed = {
      to,
      planName: 'Бизнес',
      amount: '12900.00',
      paymentMethod,
      giftCreditsLeft: 35,
      appUrl,
    }
    const subscriptionEnded = {
      to,
      planName: 'Бизнес',
      endedAt: periodEnd,
      packCreditsLeft: 7,
      giftCreditsLeft: 35,
      appUrl,
    }

    await enqueueNotification('billing.renewal_notice', renewalNotice, { db })
    await enqueueNotification('billing.payment_failed', paymentFailed, { db })
    await enqueueNotification('billing.subscription_ended', subscriptionEnded, { db })

    expect(rows().map(({ type, payload }) => ({ type, payload }))).toEqual([
      { type: 'billing.renewal_notice', payload: renewalNotice },
      { type: 'billing.payment_failed', payload: paymentFailed },
      { type: 'billing.subscription_ended', payload: subscriptionEnded },
    ])
  })

  it('keeps fields the letter does not use out of the outbox', async () => {
    const { db, rows } = fakeDb()
    const payload = {
      to,
      planName: 'Бизнес',
      amount: '12900.00',
      paymentMethod,
      giftCreditsLeft: 0,
      appUrl,
    }

    await enqueueNotification(
      'billing.payment_failed',
      { ...payload, userId: 'user-1', paymentMethodId: 'pm-secret' } as typeof payload,
      { db },
    )

    expect(rows()[0]?.payload).toEqual(payload)
  })

  it.each([
    ['an amount without kopecks', { amount: '12900' }],
    ['a date that is not ISO', { chargeAt: '18.10.2026' }],
    ['a recipient that is not an address', { to: 'not-an-email' }],
    ['a link that is not http(s)', { appUrl: 'javascript:alert(1)' }],
    ['an empty tariff name', { planName: '' }],
  ])('refuses %s before writing', async (_case, change) => {
    const { db, createMany } = fakeDb()
    const payload = {
      to,
      planName: 'Бизнес',
      amount: '12900.00',
      chargeAt: periodEnd,
      paymentMethod,
      appUrl,
      ...change,
    }

    await expect(enqueueNotification('billing.renewal_notice', payload, { db })).rejects.toThrow()
    expect(createMany).not.toHaveBeenCalled()
  })
})
