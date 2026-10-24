import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { BrowserSessionRuntime } from '@repo/domain'
import { databaseCheck, type HealthChecks } from '@repo/observability'
import { HealthModule, PRISMA } from '@repo/service-runtime'

import type { BrowserWorkerConfig } from '../config/config.ts'
import { BROWSER_CONFIG } from '../config/config.module.ts'
import { SessionsModule } from '../sessions/sessions.module.ts'
import { SESSION_RUNTIME } from '../sessions/sessions.tokens.ts'

/** What GET /health of the worker checks: the database and, when configured, Docker. */
export function browserHealthChecks(
  prisma: PrismaClient,
  runtime: BrowserSessionRuntime | null,
): HealthChecks {
  return {
    database: databaseCheck(() => prisma),
    // The daemon of the sessions' containers answers (a list by labels, nothing started).
    ...(runtime ? { docker: async () => Array.isArray(await runtime.list()) } : {}),
  }
}

/** GET /health of the worker: status for anyone, the details with METRICS_TOKEN. */
@Module({
  imports: [
    HealthModule.forRootAsync({
      imports: [SessionsModule],
      inject: [PRISMA, SESSION_RUNTIME],
      useFactory: browserHealthChecks,
      details: {
        inject: [BROWSER_CONFIG],
        useFactory: (config: BrowserWorkerConfig): string => config.metricsToken,
      },
    }),
  ],
})
export class BrowserHealthModule {}
