import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  TELEGRAM_DELIVER_JOB,
  TELEGRAM_POLL_JOB,
  TELEGRAM_POLL_QUEUE,
  TELEGRAM_QUEUE,
  TELEGRAM_SEND_JOB,
  TELEGRAM_TOPIC_JOB,
  telegramDeliverJobSchema,
  telegramSendJobSchema,
  telegramTopicJobSchema,
} from '@repo/domain'
import { errorMessage, throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'
import type { z } from 'zod'

import type { TelegramJobs } from './telegram-jobs.ts'
import { TELEGRAM_JOBS } from './telegram.tokens.ts'

function parsed<T>(schema: z.ZodType<T>, job: Job): T {
  const data = schema.safeParse(job.data)
  if (!data.success) throw new UnrecoverableError(`Invalid ${job.name} job`)
  return data.data
}

/**
 * Works the queue `telegram` (docs/plan/80-telegram.md): the messages of the bot, retried by the
 * queue's backoff.
 * Telegram takes about 30 messages a second from a bot: the worker keeps below it. Logs carry the
 * job name and id, never the words.
 */
@Processor(TELEGRAM_QUEUE, { concurrency: 1, limiter: { max: 25, duration: 1_000 } })
export class TelegramProcessor extends WorkerHost {
  readonly #logger = new Logger(TelegramProcessor.name)
  readonly #jobs: Pick<TelegramJobs, 'send' | 'deliver' | 'topic'>
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(@Inject(TELEGRAM_JOBS) jobs: Pick<TelegramJobs, 'send' | 'deliver' | 'topic'>) {
    super()
    this.#jobs = jobs
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case TELEGRAM_SEND_JOB:
        await this.#jobs.send(parsed(telegramSendJobSchema, job))
        return
      case TELEGRAM_DELIVER_JOB:
        await this.#jobs.deliver(parsed(telegramDeliverJobSchema, job))
        return
      case TELEGRAM_TOPIC_JOB:
        await this.#jobs.topic(parsed(telegramTopicJobSchema, job))
        return
      default:
        throw new UnrecoverableError(`Unknown telegram job "${job.name}"`)
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.#logger.warn(
      `Telegram job ${job?.name ?? '?'} (job ${job?.id ?? '?'}, attempt ${job?.attemptsMade ?? '?'}) ` +
        `failed: ${errorMessage(err)}`,
    )
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${TELEGRAM_QUEUE}`, err)
  }
}

/**
 * Works the queue `telegram-updates`: the poll of the bot's updates, one at a time, one attempt —
 * the next tick reads again. Apart from the messages, so an update web is slow to take (a voice, a
 * file) never holds up a reply.
 */
@Processor(TELEGRAM_POLL_QUEUE, { concurrency: 1 })
export class TelegramPollProcessor extends WorkerHost {
  readonly #jobs: Pick<TelegramJobs, 'poll'>
  readonly #warn = throttledLogger((line) => new Logger(TelegramPollProcessor.name).warn(line))

  constructor(@Inject(TELEGRAM_JOBS) jobs: Pick<TelegramJobs, 'poll'>) {
    super()
    this.#jobs = jobs
  }

  async process(job: Job): Promise<void> {
    if (job.name !== TELEGRAM_POLL_JOB)
      throw new UnrecoverableError(`Unknown telegram poll job "${job.name}"`)
    await this.#jobs.poll()
  }

  // The poll fails every tick while the proxies are away: one line a minute, not one a tick.
  @OnWorkerEvent('failed')
  onFailed(_job: Job | undefined, err: Error): void {
    this.#warn('Telegram poll', err)
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${TELEGRAM_POLL_QUEUE}`, err)
  }
}
