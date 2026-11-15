import { Logger, Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { TELEGRAM_PROGRESS_JOB, TELEGRAM_QUEUE, type JobQueue } from '@repo/domain'
import { PRISMA } from '@repo/service-runtime'
import { createTelegramBotApi } from '@repo/telegram'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { JOB_QUEUE } from '../queue/queue.tokens.ts'
import { TelegramJobs } from './telegram-jobs.ts'
import { TelegramPollProcessor, TelegramProcessor } from './telegram.processor.ts'
import { TelegramScheduler } from './telegram-scheduler.ts'
import { TELEGRAM_JOBS } from './telegram.tokens.ts'

/**
 * The bot of the chat in Telegram (docs/plan/80-telegram.md): the worker of the queue `telegram` and
 * the scheduler of the poll of its updates. AppModule imports it only with the bot configured.
 */
@Module({
  providers: [
    {
      provide: TELEGRAM_JOBS,
      useFactory: (prisma: PrismaClient, config: CoreConfig, queue: JobQueue) => {
        const telegram = config.telegram
        if (!telegram) throw new Error('TelegramModule needs TELEGRAM_BOT_TOKEN')
        const logger = new Logger('Telegram')
        return new TelegramJobs({
          prisma,
          bot: createTelegramBotApi({
            token: telegram.bot.botToken,
            proxyUrl: telegram.bot.proxyUrl,
          }),
          intake: { url: telegram.intakeUrl, secret: telegram.bot.webhookSecret },
          appUrl: config.billing.appUrl,
          logger: { log: (line) => logger.log(line), warn: (line) => logger.warn(line) },
          later: (job, delayMs) =>
            queue.enqueue(TELEGRAM_QUEUE, TELEGRAM_PROGRESS_JOB, job, {
              jobId: `${TELEGRAM_PROGRESS_JOB}:${job.taskId}:${job.chain ?? ''}:${job.tick ?? 0}`,
              delayMs,
            }),
        })
      },
      inject: [PRISMA, CORE_CONFIG, JOB_QUEUE],
    },
    TelegramProcessor,
    TelegramPollProcessor,
    TelegramScheduler,
  ],
})
export class TelegramModule {}
