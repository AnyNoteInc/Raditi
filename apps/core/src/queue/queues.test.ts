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

  it('retries the sending of a lead for about two hours and keeps its jobs as the other queues do', () => {
    expect(queueJobDefaults.leads).toEqual({
      attempts: 10,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: { age: DAY, count: 1_000 },
      removeOnFail: { age: 7 * DAY },
    })
  })

  it('retries a message of the bot of the chat for about two hours: the pool of proxies fails often', () => {
    expect(queueJobDefaults.telegram).toEqual({
      attempts: 10,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: DAY, count: 1_000 },
      removeOnFail: { age: 7 * DAY },
    })
  })

  it('starts a run of a scheduled task eight times, from 30 s doubling (docs/plan/82, Зп21)', () => {
    expect(queueJobDefaults.schedules).toEqual({
      attempts: 8,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: DAY, count: 1_000 },
      removeOnFail: { age: 7 * DAY },
    })
  })

  it('builds a workbook of a table three times, from 5 s doubling (docs/plan/88, question 26)', () => {
    expect(queueJobDefaults.artifacts).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: DAY, count: 1_000 },
      removeOnFail: { age: 7 * DAY },
    })
  })

  it('keeps completed jobs of the other queues for a day (at most 1000), failed for a week', () => {
    const retried = ['notifications', 'leads', 'telegram', 'schedules', 'artifacts']
    for (const name of queueNames.filter((queue) => !retried.includes(queue))) {
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
