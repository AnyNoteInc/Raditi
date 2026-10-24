import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { WORKER_STORE } from './store.tokens.ts'
import { PostgresBrowserWorkerStore, type BrowserWorkerStore } from './worker-store.ts'

/**
 * What the worker records of its sessions (`browser_sessions`, `browser_checkpoints`) and reads of
 * their tasks, on the Prisma client of DatabaseModule (global).
 */
@Module({
  providers: [
    {
      provide: WORKER_STORE,
      useFactory: (prisma: PrismaClient): BrowserWorkerStore =>
        new PostgresBrowserWorkerStore(prisma),
      inject: [PRISMA],
    },
  ],
  exports: [WORKER_STORE],
})
export class StoreModule {}
