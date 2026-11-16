import { Logger, Module, type DynamicModule } from '@nestjs/common'
import { DatabaseModule } from '@repo/service-runtime'

import { BillingModule } from './billing/billing.module.ts'
import { GitModule } from './git/git.module.ts'
import { LeadsModule } from './leads/leads.module.ts'
import { TelegramModule } from './telegram/telegram.module.ts'
import { SchedulesModule } from './schedules/schedules.module.ts'
import { CoreConfigModule, type AppModuleOptions } from './config/config.module.ts'
import { CoreHealthModule } from './health/health.module.ts'
import { InfraModule } from './infra/infra.module.ts'
import { MetricsRegistryModule } from './metrics/metrics-registry.module.ts'
import { MetricsModule } from './metrics/metrics.module.ts'
import { NotificationsModule } from './notifications/notifications.module.ts'
import { OutboxModule } from './outbox/outbox.module.ts'
import { QueueModule } from './queue/queue.module.ts'
import { TasksModule } from './tasks/tasks.module.ts'
import { TurnsModule } from './turns/turns.module.ts'

/**
 * The core role (spec §5): task lifecycle, BullMQ workers, cron, sandboxes.
 * Serves /health and /metrics on CORE_PORT, never on the MCP port; with runner VMs also
 * the runner API on RUNNER_API_PORT.
 *
 * Global are only the configuration, the connections (database, S3, Vault, Redis), the queues and
 * the metrics registry; every feature module imports the features it uses.
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config, background } = options
    if (!config.leads && background) {
      new Logger('Leads').warn(
        'The bot of leads is not configured (LEADS_TELEGRAM_BOT_TOKEN, LEADS_TELEGRAM_CHAT_ID): leads of the landing wait in their queue',
      )
    }
    if (!config.schedules && background)
      new Logger('Schedules').warn('Scheduled tasks are off: SCHEDULE_INTAKE_URL is not set')
    // The one turn engine of the process: the chats import this same object.
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
        // The leads of the landing go to Telegram only with the bot of leads configured.
        ...(config.leads ? [LeadsModule] : []),
        // The bot of the chat in Telegram only when it is configured (docs/plan/80-telegram.md).
        ...(config.telegram ? [TelegramModule] : []),
        // The runs of scheduled tasks only with the intake of web (docs/plan/82-scheduled-tasks.md).
        ...(config.schedules ? [SchedulesModule] : []),
        // The turn engine before the chats: Nest starts and stops the modules of one level in
        // the order it meets them, the order AppModule's test pins.
        turns,
        TasksModule.forRoot(turns),
        // The git connections and repositories of projects (docs/plan/84-projects.md, 84.17).
        GitModule,
      ],
    }
  }
}
