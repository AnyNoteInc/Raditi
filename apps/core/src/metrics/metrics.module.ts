import { Module } from '@nestjs/common'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG, METRICS_TOKEN } from '../infra/tokens.ts'
import { MetricsRegistryModule } from './metrics-registry.module.ts'
import { MetricsController, MetricsTokenGuard } from './metrics.controller.ts'

/** Its metrics carry `app="core"`, the name of the container. */
const registry = MetricsRegistryModule.forApp('core')

/** The registry of the core process and GET /metrics on the core port, with the core's token. */
@Module({
  imports: [registry],
  controllers: [MetricsController],
  providers: [
    {
      provide: METRICS_TOKEN,
      useFactory: (config: CoreConfig): string => config.metricsToken,
      inject: [CORE_CONFIG],
    },
    MetricsTokenGuard,
  ],
  exports: [registry],
})
export class MetricsModule {}
