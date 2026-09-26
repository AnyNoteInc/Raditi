import { Module } from '@nestjs/common'

import { METRICS_REGISTRY } from '../infra/tokens.ts'
import { createMetricsRegistry } from './metrics.ts'
import { MetricsController, MetricsTokenGuard } from './metrics.controller.ts'

@Module({
  controllers: [MetricsController],
  providers: [{ provide: METRICS_REGISTRY, useFactory: createMetricsRegistry }, MetricsTokenGuard],
  exports: [METRICS_REGISTRY],
})
export class MetricsModule {}
