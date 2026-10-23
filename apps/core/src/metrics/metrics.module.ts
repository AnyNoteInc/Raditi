import { Module } from '@nestjs/common'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { MetricsController, MetricsTokenGuard } from './metrics.controller.ts'
import { METRICS_TOKEN } from './metrics.tokens.ts'

/**
 * GET /metrics on the core port, with the core's token, over the registry of the process
 * (MetricsRegistryModule, global).
 */
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: METRICS_TOKEN,
      useFactory: (config: CoreConfig): string => config.metricsToken,
      inject: [CORE_CONFIG],
    },
    MetricsTokenGuard,
  ],
})
export class MetricsModule {}
