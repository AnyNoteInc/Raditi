import { queueNames, scheduleLimits, type QueueName } from '@repo/domain'
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
  // The passes of the renewal schedulers (apps/core/src/billing). A failed pass is
  // not retried: the next tick does the same work from the rows of the database.
  billing: lifecycleJobs,
  // Builds, syncs and browsers of previews (docs/plan/53-chat-preview-release.md): a failed job
  // is put again by the rows of its preview, never by BullMQ.
  previews: lifecycleJobs,
  // The start of a task's browser: a failed job is put again by the call that waits for it.
  'browser-sessions': lifecycleJobs,
  // A lead on its way to Telegram (docs/plan/65-landing-platforms-leads.md): its sending is retried
  // for about two hours (15 s doubling, ten tries), then the poll posts it again; job data holds
  // only the id. The poll of the bot's buttons sets its own single attempt.
  leads: {
    attempts: 10,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: { age: DAY, count: 1_000 },
    removeOnFail: { age: 7 * DAY },
  },
  // A message of the bot of the chat (docs/plan/80-telegram.md): the pool of free proxies fails
  // often, so a sending is retried for about two hours (10 s doubling, ten tries). Job data of
  // `telegram.send` holds the words of the message: a sent one leaves Redis within a day, a
  // failed one after a week. The poll sets its own single attempt.
  telegram: {
    attempts: 10,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: DAY, count: 1_000 },
    removeOnFail: { age: 7 * DAY },
  },
  // The poll of the bot's updates (docs/plan/80-telegram.md): one attempt, the next tick reads again.
  'telegram-updates': lifecycleJobs,
  // The checks, lists and first fetch of git connections and repositories (docs/plan/84-projects.md,
  // §4.3): a failed job is put again by the client's «Обновить» or its next look, never by BullMQ.
  git: lifecycleJobs,
  // The starts of the runs of scheduled tasks (docs/plan/82-scheduled-tasks.md, Зп19, Зп21): web
  // away, a deploy or a fault of the platform is tried again — eight tries, from 30 s doubling,
  // about an hour —, then the run is «Не запустилась: сбой платформы». Job data holds the id of
  // the run only. The tick sets its own single attempt: the next one does the same work again.
  schedules: {
    attempts: scheduleLimits.startAttempts,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: DAY, count: 1_000 },
    removeOnFail: { age: 7 * DAY },
  },
  // An export of an artifact (docs/plan/88-artifacts.md, §7.13): three tries, from 5 s
  // doubling; after them the export is «failed» and the person asks again. Job data holds the id only.
  artifacts: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: DAY, count: 1_000 },
    removeOnFail: { age: 7 * DAY },
  },
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
