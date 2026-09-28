import { queueNames, type QueueName } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import type { OutboxWriter } from './outbox.ts'
import { enqueueOutbox } from './outbox.ts'

function fakeWriter(count: number) {
  const createMany = vi.fn().mockResolvedValue({ count })
  return { writer: { outboxEvent: { createMany } } as unknown as OutboxWriter, createMany }
}

describe('enqueueOutbox', () => {
  it('writes one row and skips duplicates by dedupe key', async () => {
    const { writer, createMany } = fakeWriter(1)
    const availableAt = new Date('2026-09-26T10:00:00Z')

    const inserted = await enqueueOutbox(writer, {
      topic: 'notifications',
      type: 'auth.verify_email',
      payload: { to: 'owner@example.ru' },
      dedupeKey: 'auth.verify_email:token-1',
      availableAt,
    })

    expect(inserted).toBe(true)
    expect(createMany).toHaveBeenCalledOnce()
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          topic: 'notifications',
          type: 'auth.verify_email',
          payload: { to: 'owner@example.ru' },
          dedupeKey: 'auth.verify_email:token-1',
          availableAt,
        },
      ],
      skipDuplicates: true,
    })
  })

  it('leaves dedupe key and publish time to the database defaults when omitted', async () => {
    const { writer, createMany } = fakeWriter(1)

    await enqueueOutbox(writer, { topic: 'notifications', type: 'auth.welcome', payload: {} })

    const row = createMany.mock.calls[0]?.[0].data[0]
    expect(row.dedupeKey).toBeUndefined()
    expect(row.availableAt).toBeUndefined()
  })

  it('returns false when the dedupe key already exists', async () => {
    const { writer } = fakeWriter(0)

    const inserted = await enqueueOutbox(writer, {
      topic: 'notifications',
      type: 'auth.verify_email',
      payload: {},
      dedupeKey: 'auth.verify_email:token-1',
    })

    expect(inserted).toBe(false)
  })

  it.each(['', 'notification', 'agent_turns'])(
    'rejects the unknown queue %j before touching the database',
    async (topic) => {
      const { writer, createMany } = fakeWriter(1)

      await expect(
        enqueueOutbox(writer, { topic: topic as QueueName, type: 'x', payload: {} }),
      ).rejects.toThrow()
      expect(createMany).not.toHaveBeenCalled()
    },
  )

  it.each(queueNames)('accepts the queue %s', async (topic) => {
    const { writer } = fakeWriter(1)

    await expect(enqueueOutbox(writer, { topic, type: 'x', payload: {} })).resolves.toBe(true)
  })
})
