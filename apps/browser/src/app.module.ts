import { Module, type DynamicModule } from '@nestjs/common'
import { DatabaseModule } from '@repo/service-runtime'

import { ApiModule } from './api/api.module.ts'
import type { BrowserWorkerConfig } from './config/config.ts'
import { BrowserConfigModule } from './config/config.module.ts'
import { BrowserHealthModule } from './health/health.module.ts'
import { MetricsRegistryModule } from './metrics/metrics-registry.module.ts'
import { MetricsModule } from './metrics/metrics.module.ts'
import { WorkerModule } from './worker/worker.module.ts'

/**
 * The browser worker app (docs/plan/57-browser-tasks.md, Б10): the internal API of the sessions
 * for core and mcp, the stream for the gateway of preview, /health (the database and Docker) and
 * /metrics. It holds the sessions' Chromium through Playwright and owns no task's life: core opens
 * and closes the sessions, the worker records what happens in them. The database module is
 * global, so Nest closes its pool after the worker has closed every session.
 */
@Module({})
export class AppModule {
  static forRoot(config: BrowserWorkerConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        BrowserConfigModule.forRoot(config),
        DatabaseModule.forRoot(config.db),
        MetricsRegistryModule,
        BrowserHealthModule,
        MetricsModule,
        WorkerModule,
        ApiModule,
      ],
    }
  }
}
