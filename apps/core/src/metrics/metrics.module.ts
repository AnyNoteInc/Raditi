import { Module } from '@nestjs/common'
import {
  MetricsController,
  MetricsRegistryModule,
  MetricsTokenGuard,
  METRICS_TOKEN,
} from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../infra/tokens.ts'

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
