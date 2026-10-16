import { queueNames, type QueueName } from '@repo/domain'
import type { DefaultJobOptions } from 'bullmq'

export function isQueueName(name: string): name is QueueName {
  return (queueNames as readonly string[]).includes(name)
}

const DAY = 24 * 60 * 60

/** Turns, deploys and timers are retried by the task lifecycle (spec §7), not by BullMQ. */
const lifecycleJobs: DefaultJobOptions = {
  attempts: 1,
  removeOnComplete: { age: DAY, count: 1_000 },
  removeOnFail: { age: 7 * DAY },
}

/** Default job options per queue; `age` is in seconds. */
export const queueJobDefaults: Record<QueueName, DefaultJobOptions> = {
  'agent-turns': lifecycleJobs,
  deploys: lifecycleJobs,
  timers: lifecycleJobs,
  'site-provisioning': lifecycleJobs,
  'site-import': lifecycleJobs,
  // The passes of the renewal schedulers (apps/orchestrator/src/billing). A failed pass is
  // not retried: the next tick does the same work from the rows of the database.
  billing: lifecycleJobs,
  // SendSay hiccups are retried: 15 s, 30 s, … about half an hour in total.
  // Job data holds one-time links: a delivered letter leaves Redis at once, a failed one
  // after a day.
  notifications: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: true,
    removeOnFail: { age: DAY },
  },
}

/**
 * Queues whose jobs leave Redis at once, so a job id alone stops deduplicating right after
 * the job is done. For them the id is also a BullMQ deduplication id kept this long (ms):
 * a repeated publish of the same outbox row stays a no-op instead of a second letter.
 * Matches the outbox retention, the longest a row can be published again.
 */
export const queueDeduplicationTtlMs: Partial<Record<QueueName, number>> = {
  notifications: 7 * DAY * 1_000,
}
