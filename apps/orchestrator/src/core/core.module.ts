import { Module, type DynamicModule } from '@nestjs/common'

import { BillingModule } from '../billing/billing.module.ts'
import type { CoreConfig } from '../config/config.ts'
import { DriversModule } from '../drivers/drivers.module.ts'
import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { StaleClonesSweep } from '../git-workspace/stale-clones.ts'
import { HealthModule } from '../health/health.module.ts'
import { InfraModule } from '../infra/infra.module.ts'
import { CORE_CONFIG } from '../infra/tokens.ts'
import { LlmModule } from '../llm/llm.module.ts'
import { MetricsModule } from '../metrics/metrics.module.ts'
import { NotificationsModule } from '../notifications/notifications.module.ts'
import { OutboxModule } from '../outbox/outbox.module.ts'
import { PreviewsModule } from '../previews/previews.module.ts'
import { QueueModule } from '../queue/queue.module.ts'
import { ReleaseApiModule } from '../release-api/release-api.module.ts'
import { ReleasesModule } from '../releases/releases.module.ts'
import { SessionsModule } from '../sessions/sessions.module.ts'
import { SiteProvisioningModule } from '../site-provisioning/site-provisioning.module.ts'
import { TasksModule } from '../tasks/tasks.module.ts'
import { TurnsModule } from '../turns/turns.module.ts'
import { CoreConfigModule, type CoreModuleOptions } from './core-config.module.ts'

/**
 * The core role (spec §5): task lifecycle, BullMQ workers, cron, sandboxes, git publishing.
 * Serves /health and /metrics on ORCHESTRATOR_PORT, never on the MCP port; with runner VMs also
 * the runner API on RUNNER_API_PORT, and the release API on RELEASE_API_PORT.
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
        LlmModule,
        OutboxModule,
        NotificationsModule,
        BillingModule,
        SiteProvisioningModule,
        DriversModule,
        SessionsModule,
        // Git of site repositories: the turn supervisor and the candidates of dialogs (R3).
        GitWorkspaceModule,
        TurnsModule.forRoot(options.config.turnExecutor),
        // Chat → preview → /release (docs/plan/53-chat-preview-release.md).
        TasksModule,
        PreviewsModule,
        ReleasesModule,
        ReleaseApiModule,
      ],
      providers: [
        {
          provide: StaleClonesSweep,
          useFactory: (config: CoreConfig) => new StaleClonesSweep(config.appEnv),
          inject: [CORE_CONFIG],
        },
      ],
    }
  }
}
