import { Module, type DynamicModule } from '@nestjs/common'
import { DatabaseModule } from '@repo/service-runtime'

import { BillingModule } from './billing/billing.module.ts'
import { CoreConfigModule, type AppModuleOptions } from './config/config.module.ts'
import { CoreHealthModule } from './health/health.module.ts'
import { InfraModule } from './infra/infra.module.ts'
import { MetricsRegistryModule } from './metrics/metrics-registry.module.ts'
import { MetricsModule } from './metrics/metrics.module.ts'
import { NotificationsModule } from './notifications/notifications.module.ts'
import { OutboxModule } from './outbox/outbox.module.ts'
import { PreviewsModule } from './previews/previews.module.ts'
import { QueueModule } from './queue/queue.module.ts'
import { ReleaseApiModule } from './release-api/release-api.module.ts'
import { ReleasesModule } from './releases/releases.module.ts'
import { SiteProvisioningModule } from './site-provisioning/site-provisioning.module.ts'
import { TasksModule } from './tasks/tasks.module.ts'
import { TurnsModule } from './turns/turns.module.ts'

/**
 * The core role (spec §5): task lifecycle, BullMQ workers, cron, sandboxes, git publishing.
 * Serves /health and /metrics on CORE_PORT, never on the MCP port; with runner VMs also
 * the runner API on RUNNER_API_PORT, and the release API on RELEASE_API_PORT.
 *
 * Global are only the configuration, the connections (database, S3, Vault, Redis), the queues and
 * the metrics registry; every feature module imports the features it uses.
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config, background } = options
    // The one turn engine of the process: the dialogs and the previews import this same object.
    const turns = TurnsModule.forRoot(config.turnExecutor)
    return {
      module: AppModule,
      imports: [
        CoreConfigModule.forRoot(options),
        DatabaseModule.forRoot(config.db),
        InfraModule,
        QueueModule.forRoot({ redisUrl: config.redisUrl, background }),
        MetricsRegistryModule,
        CoreHealthModule,
        MetricsModule,
        OutboxModule,
        NotificationsModule,
        BillingModule,
        SiteProvisioningModule,
        // The turn engine between the site import and the dialogs: Nest starts and stops the
        // modules of one level in the order it meets them, the order AppModule's test pins.
        turns,
        // Chat → preview → /release (docs/plan/53-chat-preview-release.md).
        TasksModule.forRoot(turns),
        PreviewsModule.forRoot(turns),
        ReleasesModule,
        ReleaseApiModule,
      ],
    }
  }
}
