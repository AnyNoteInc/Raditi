import { queueNames, type QueueName } from '@repo/domain'
import type { Queue } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'

import { BullMqJobQueue, toBullJobId } from './bullmq-job-queue.ts'

function fakeQueues() {
  const add = vi.fn().mockResolvedValue({ id: 'job' })
  const queues = new Map<QueueName, Queue>(
    queueNames.map((name) => [name, { name, add } as unknown as Queue]),
  )
  return { queues, add }
}

describe('toBullJobId', () => {
  it('keeps ordinary ids as they are', () => {
    expect(toBullJobId('0199a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b')).toBe(
      '0199a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
    )
  })

  it('encodes colons and percent signs, which BullMQ rejects or would confuse', () => {
    expect(toBullJobId('auth.welcome:user-1')).toBe('auth.welcome%3Auser-1')
    expect(toBullJobId('turn:task-1:3')).toBe('turn%3Atask-1%3A3')
    expect(toBullJobId('50%:off')).toBe('50%25%3Aoff')
  })

  it('prefixes integer-like ids, which BullMQ rejects', () => {
    expect(toBullJobId('42')).toBe('%N42')
    expect(toBullJobId('-7')).toBe('%N-7')
  })

  it('never maps two different ids to the same job id', () => {
    const ids = ['a:b', 'a%3Ab', 'a%b', '42', '%N42', 'N42', '%', '%25', ':', '%3A']
    const mapped = ids.map(toBullJobId)
    expect(new Set(mapped).size).toBe(ids.length)
    expect(mapped.every((id) => !id.includes(':'))).toBe(true)
  })
})

describe('BullMqJobQueue', () => {
  it('adds a job with an encoded id, delay and priority', async () => {
    const { queues, add } = fakeQueues()
    const jobQueue = new BullMqJobQueue(queues)

    await jobQueue.enqueue(
      'timers',
      'task.awaiting_user_timeout',
      { taskId: 't1' },
      { jobId: 'timer:t1:awaiting_user', delayMs: 60_000, priority: 2 },
    )

    expect(add).toHaveBeenCalledWith(
      'task.awaiting_user_timeout',
      { taskId: 't1' },
      { jobId: 'timer%3At1%3Aawaiting_user', delay: 60_000, priority: 2 },
    )
  })

  it('also makes the job id a deduplication id on queues configured for it', async () => {
    const { queues, add } = fakeQueues()
    const jobQueue = new BullMqJobQueue(queues, { notifications: 60_000 })

    await jobQueue.enqueue('notifications', 'auth.verify_email', { a: 1 }, { jobId: 'verify:u1' })
    await jobQueue.enqueue('timers', 'task.awaiting_user_timeout', {}, { jobId: 'timer:t1' })
    await jobQueue.enqueue('notifications', 'auth.welcome', {})

    expect(add.mock.calls).toEqual([
      [
        'auth.verify_email',
        { a: 1 },
        { jobId: 'verify%3Au1', deduplication: { id: 'verify%3Au1', ttl: 60_000 } },
      ],
      ['task.awaiting_user_timeout', {}, { jobId: 'timer%3At1' }],
      ['auth.welcome', {}, {}],
    ])
  })

  it('passes no options when none are given', async () => {
    const { queues, add } = fakeQueues()

    await new BullMqJobQueue(queues).enqueue('notifications', 'auth.welcome', {})

    expect(add).toHaveBeenCalledWith('auth.welcome', {}, {})
  })

  it('rejects a queue that is not registered', async () => {
    await expect(
      new BullMqJobQueue(new Map()).enqueue('deploys', 'deploy.start', {}),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
