import { Global, Module } from '@nestjs/common'
import { createMetricsRegistry } from '@repo/observability'

import { METRICS_REGISTRY } from './metrics.tokens.ts'

/**
 * The one Prometheus registry of the process, for every module that counts something: global,
 * and static, so Nest makes it once however many import it. Its metrics carry `app="core"` — the
 * name of the container.
 */
@Global()
@Module({
  providers: [{ provide: METRICS_REGISTRY, useFactory: () => createMetricsRegistry('core') }],
  exports: [METRICS_REGISTRY],
})
export class MetricsRegistryModule {}
