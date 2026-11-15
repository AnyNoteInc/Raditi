import { Module } from '@nestjs/common'
import { createBrowserWorkerClient } from '@repo/browser-link'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { BrowserSessions } from './browser-sessions.ts'
import { BrowserSessionsProcessor } from './browser-sessions.processor.ts'

/**
 * The cloud browser of tasks for the core role (docs/plan/57-browser-tasks.md, Б10, Б18).
 * BrowserSessions is null while CoreConfig.browser is (BROWSER_WORKER_URL unset): core starts,
 * and a task that needs a browser is refused `unavailable`. The processor of `browser-sessions`
 * starts the session the first `web_*` call of a turn asks for (docs/plan/61-chats-first.md, К11).
 */
@Module({
  providers: [
    {
      provide: BrowserSessions,
      useFactory: (config: CoreConfig, prisma: PrismaClient): BrowserSessions | null =>
        config.browser
          ? new BrowserSessions({
              db: prisma,
              client: createBrowserWorkerClient({
                baseUrl: config.browser.url,
                token: config.browser.token,
              }),
            })
          : null,
      inject: [CORE_CONFIG, PRISMA],
    },
    BrowserSessionsProcessor,
  ],
  exports: [BrowserSessions],
})
export class BrowserModule {}
