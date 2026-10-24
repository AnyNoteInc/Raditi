import { Module } from '@nestjs/common'

import type { BrowserWorkerConfig } from '../config/config.ts'
import { BROWSER_CONFIG } from '../config/config.module.ts'
import { MetricsController, MetricsTokenGuard } from './metrics.controller.ts'
import { METRICS_TOKEN } from './metrics.tokens.ts'

/**
 * GET /metrics on the worker's port, with METRICS_TOKEN, over the registry of the process
 * (MetricsRegistryModule, global).
 */
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: METRICS_TOKEN,
      useFactory: (config: BrowserWorkerConfig): string => config.metricsToken,
      inject: [BROWSER_CONFIG],
    },
    MetricsTokenGuard,
  ],
})
export class MetricsModule {}
