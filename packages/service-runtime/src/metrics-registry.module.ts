import { Module, type DynamicModule } from '@nestjs/common'
import { createMetricsRegistry } from '@repo/observability'

import { METRICS_REGISTRY } from './tokens.ts'

/**
 * The Prometheus registry of the process: every module that counts something imports the module
 * that registers it. Its metrics carry the label `app` — the name of the app's container.
 */
@Module({})
export class MetricsRegistryModule {
  static forApp(app: string): DynamicModule {
    return {
      module: MetricsRegistryModule,
      providers: [{ provide: METRICS_REGISTRY, useFactory: () => createMetricsRegistry(app) }],
      exports: [METRICS_REGISTRY],
    }
  }
}
