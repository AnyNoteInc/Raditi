import { Logger, Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'
import { createTelegramBotApi } from '@repo/telegram'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { LeadsJobs } from './leads-jobs.ts'
import { LeadsProcessor } from './leads.processor.ts'
import { LeadsScheduler } from './leads-scheduler.ts'
import { LEADS_JOBS } from './leads.tokens.ts'

/**
 * The leads of the landing on their way to Telegram (docs/plan/65-landing-platforms-leads.md):
 * the worker of the queue `leads` and the scheduler of the poll of «Обработано». AppModule imports
 * it only with the bot of leads configured; without it the leads wait in the queue.
 */
@Module({
  providers: [
    {
      provide: LEADS_JOBS,
      useFactory: (prisma: PrismaClient, config: CoreConfig) => {
        const leads = config.leads
        if (!leads)
          throw new Error('LeadsModule needs LEADS_TELEGRAM_BOT_TOKEN and LEADS_TELEGRAM_CHAT_ID')
        const logger = new Logger('Leads')
        return new LeadsJobs({
          prisma,
          bot: createTelegramBotApi({ token: leads.botToken, proxyUrl: leads.proxyUrl }),
          chatId: leads.chatId,
          logger: { log: (line) => logger.log(line), warn: (line) => logger.warn(line) },
        })
      },
      inject: [PRISMA, CORE_CONFIG],
    },
    LeadsProcessor,
    LeadsScheduler,
  ],
})
export class LeadsModule {}
