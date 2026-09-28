import { queueNames } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { OUTBOX_RETENTION_MS } from '../outbox/outbox-relay.service.ts'
import { isQueueName, queueDeduplicationTtlMs, queueJobDefaults } from './queues.ts'

const DAY = 24 * 60 * 60

describe('queueJobDefaults', () => {
  it('removes a delivered notification from Redis at once and a failed one after a day: they hold one-time links', () => {
    expect(queueJobDefaults.notifications).toMatchObject({
      removeOnComplete: true,
      removeOnFail: { age: DAY },
    })
  })

  it('keeps completed jobs of the other queues for a day (at most 1000), failed for a week', () => {
    for (const name of queueNames.filter((queue) => queue !== 'notifications')) {
      expect(queueJobDefaults[name]).toMatchObject({
        attempts: 1,
        removeOnComplete: { age: DAY, count: 1_000 },
        removeOnFail: { age: 7 * DAY },
      })
    }
  })
})

describe('queueDeduplicationTtlMs', () => {
  it('deduplicates every queue whose completed jobs leave Redis at once, for as long as outbox rows live', () => {
    for (const name of queueNames) {
      if (queueJobDefaults[name].removeOnComplete === true) {
        expect(queueDeduplicationTtlMs[name]).toBe(OUTBOX_RETENTION_MS)
      }
    }
    expect(Object.keys(queueDeduplicationTtlMs)).toEqual(['notifications'])
  })
})

describe('isQueueName', () => {
  it('knows exactly the queues of the domain', () => {
    expect(queueNames.every(isQueueName)).toBe(true)
    expect(isQueueName('emails')).toBe(false)
  })
})
