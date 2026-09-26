import { Module, type DynamicModule } from '@nestjs/common'

import { DriversModule } from '../drivers/drivers.module.ts'
import { HealthModule } from '../health/health.module.ts'
import { InfraModule } from '../infra/infra.module.ts'
import { MetricsModule } from '../metrics/metrics.module.ts'
import { NotificationsModule } from '../notifications/notifications.module.ts'
import { OutboxModule } from '../outbox/outbox.module.ts'
import { QueueModule } from '../queue/queue.module.ts'
import { SandboxModule } from '../sandbox/sandbox.module.ts'
import { TasksModule } from '../tasks/tasks.module.ts'
import { CoreConfigModule, type CoreModuleOptions } from './core-config.module.ts'

/**
 * The core role (spec §5): task lifecycle, BullMQ workers, cron, sandboxes, git publishing.
 * Serves /health and /metrics on ORCHESTRATOR_PORT, never on the MCP port.
 */
@Module({})
export class CoreModule {
  static forRoot(options: CoreModuleOptions): DynamicModule {
    return {
      module: CoreModule,
      imports: [
        CoreConfigModule.forRoot(options),
        InfraModule,
        QueueModule.forRoot({ redisUrl: options.config.redisUrl, background: options.background }),
        HealthModule,
        MetricsModule,
        OutboxModule,
        NotificationsModule,
        TasksModule,
        DriversModule,
        SandboxModule,
      ],
    }
  }
}
