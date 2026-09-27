import { Module } from '@nestjs/common'
import { createMetricsRegistry } from '@repo/observability'

import { METRICS_REGISTRY } from '../infra/tokens.ts'
import { MetricsController, MetricsTokenGuard } from './metrics.controller.ts'

@Module({
  controllers: [MetricsController],
  providers: [
    { provide: METRICS_REGISTRY, useFactory: () => createMetricsRegistry('orchestrator') },
    MetricsTokenGuard,
  ],
  exports: [METRICS_REGISTRY],
})
export class MetricsModule {}
