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
