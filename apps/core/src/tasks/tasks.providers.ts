import { Counter, type Registry } from '@prometheus-io/client'
import { Logger, type Provider } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import type { PrismaClient } from '@repo/db'
import type {
  JobQueue,
  ObjectStorage,
  SiteLeaseStore,
  TurnCredentialSource,
  TurnExecutor,
} from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { PRISMA } from '@repo/service-runtime'

import { ArtifactChecks } from '../artifacts/artifact-checks.ts'
import { ArtifactOutbox } from '../artifacts/artifact-outbox.ts'
import { BrowserSessions } from '../browser/browser-sessions.ts'
import type { CoreConfig } from '../config/config.ts'
import { BACKGROUND_JOBS, CORE_CONFIG } from '../config/config.tokens.ts'
import { AGENT_DRIVERS } from '../drivers/drivers.tokens.ts'
import { OBJECT_STORAGE } from '../infra/infra.tokens.ts'
import { SITE_LEASES } from '../leases/leases.tokens.ts'
import { POOL_PROBE, TURN_CREDENTIALS } from '../llm/llm.tokens.ts'
import type { PoolProbeClient } from '../llm/pool-probe-client.ts'
import { JOB_QUEUE } from '../queue/queue.tokens.ts'
import { TaskEventTurnJournal } from '../turns/turn-journal.ts'
import { turnRuntimeOf } from '../turns/turn-runtime.ts'
import { TurnSupervisor } from '../turns/turn-supervisor.ts'
import { TURN_EXECUTOR } from '../turns/turns.tokens.ts'
import { ChatFiles } from './chat-files.ts'
import { MemoryChanges } from './memory-changes.ts'
import { RepoChanges, RepoTurnPreparer } from './repo-turns.ts'
import { VkChanges } from './vk-turns.ts'
import type { GitJobs } from '../git/git-jobs.ts'
import { GIT_JOBS } from '../git/git.tokens.ts'
import type { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { GIT_WORKSPACE } from '../git-workspace/git-workspace.tokens.ts'
import { PageChanges } from './page-changes.ts'
import { PageMetrics } from '../pages/page-metrics.ts'
import { ProjectTrash } from '../projects/project-trash.ts'
import { PagePublications } from './page-publications.ts'
import { LivePasses } from './live-passes.ts'
import { PassRunner } from './pass-runner.ts'
import { PassSettlement } from './pass-settlement.ts'
import { QueueDrain } from './queue-drain.ts'
import { ArtifactNotify } from './artifact-notify.ts'
import { ChatNotify } from './chat-notify.ts'
import { NotificationDelivery, notificationDeliveryOf } from './notification-delivery.ts'
import { ScheduleChanges } from './schedule-changes.ts'
import { ScheduleNotify } from '../schedules/schedule-notify.ts'
import { TaskSweep, TaskSweepRuntime } from './task-sweep.ts'
import { TurnCapacity } from './turn-capacity.ts'
import { TurnsProcessor } from './turns.processor.ts'
import { METRICS_REGISTRY } from '../metrics/metrics.tokens.ts'

/**
 * The passes of chats, the worker of `agent-turns` and the sweep of chats, over the turn engine
 * (TurnsModule).
 */
export const taskProviders: Provider[] = [
  LivePasses,
  {
    provide: PassSettlement,
    useFactory: (prisma: PrismaClient, browser: BrowserSessions | null, registry: Registry) => {
      // A pass a window of its workspace stopped (plan 71, §4.4); no id in a label.
      const refusals = new Counter({
        name: 'raditi_workspace_window_refusals_total',
        help: 'Passes and calls refused by a usage window of their workspace',
        labelNames: ['tier', 'window', 'point'],
        registers: [registry],
      })
      return new PassSettlement({
        db: prisma,
        browser,
        onUsageLimit: ({ window, tier }) => refusals.inc({ tier, window, point: 'pass' }),
      })
    },
    inject: [PRISMA, BrowserSessions, METRICS_REGISTRY],
  },
  {
    provide: PassRunner,
    useFactory: (
      prisma: PrismaClient,
      supervisor: TurnSupervisor | null,
      drivers: AgentDriverRegistry,
      leases: SiteLeaseStore,
      config: CoreConfig,
      settlement: PassSettlement,
      live: LivePasses,
      queue: JobQueue,
      browser: BrowserSessions | null,
      storage: ObjectStorage,
      registry: Registry,
      executor: TurnExecutor | null,
      gitJobs: GitJobs | null,
      workspace: GitWorkspaceService | null,
      poolProbe: PoolProbeClient | null,
    ) => {
      // What the pool told a pass (plan 71, §4.4): the limits of the agent out.
      const limitsOut = new Counter({
        name: 'raditi_pass_limits_out_total',
        help: 'Passes the pool ended because its limits are out',
        registers: [registry],
      })
      return new PassRunner({
        pool: { limitsOut: () => limitsOut.inc() },
        db: prisma,
        supervisor,
        browser,
        drivers,
        backends: llmBackends,
        ...(poolProbe ? { poolProbe } : {}),
        leases,
        runtime: turnRuntimeOf(config),
        settlement,
        live,
        queue,
        chatFiles: new ChatFiles({
          db: prisma,
          storage,
          logger: new Logger('ChatFiles'),
          pages: new PagePublications({ db: prisma, logger: new Logger('Pages') }),
        }),
        // The files and imports a turn put from its outbox into artifacts (88-artifacts, §7.5).
        artifactOutbox: new ArtifactOutbox({
          db: prisma,
          storage,
          logger: new Logger('ArtifactOutbox'),
        }),
        // The agent's writes in artifacts (docs/plan/88-artifacts.md, Ар16, Ар19), the versions of
        // the turn and the publications of documents after them (Ар3).
        artifacts: new ArtifactChecks({
          db: prisma,
          logger: new Logger('ArtifactChecks'),
          pages: new PagePublications({ db: prisma, logger: new Logger('Pages') }),
        }),
        // What a turn asked of its pages besides versions (docs/plan/73-pages-sites.md, Дер23).
        pageChanges: new PageChanges({ db: prisma, logger: new Logger('PageChanges') }),
        // What a turn asked of the memory of its chat (docs/plan/84-projects.md, ПР18).
        memoryChanges: new MemoryChanges({ db: prisma, logger: new Logger('MemoryChanges') }),
        // The repository of the chat's project (docs/plan/84-projects.md, ПР12, ПР26).
        ...(gitJobs && workspace
          ? {
              repositories: new RepoTurnPreparer({ db: prisma, git: gitJobs, workspace }),
              repoChanges: new RepoChanges({
                db: prisma,
                storage,
                logger: new Logger('RepoChanges'),
              }),
            }
          : {}),
        // What a turn asked of the scheduled tasks (docs/plan/82-scheduled-tasks.md, Зп33).
        scheduleChanges: new ScheduleChanges({ db: prisma, logger: new Logger('ScheduleChanges') }),
        // The posts and replies a turn proposed for VK (docs/plan/99-vk-community.md, §3.3).
        vkChanges: new VkChanges({ db: prisma, logger: new Logger('VkChanges') }),
        // Docs/plan/70-turn-without-time-limit.md, ВР13 and ВР17.
        workspaceTurnLimit: config.workspaceTurnLimit,
        capacity: new TurnCapacity(executor),
      })
    },
    inject: [
      PRISMA,
      TurnSupervisor,
      AGENT_DRIVERS,
      SITE_LEASES,
      CORE_CONFIG,
      PassSettlement,
      LivePasses,
      JOB_QUEUE,
      BrowserSessions,
      OBJECT_STORAGE,
      METRICS_REGISTRY,
      { token: TURN_EXECUTOR, optional: true },
      { token: GIT_JOBS, optional: true },
      { token: GIT_WORKSPACE, optional: true },
      { token: POOL_PROBE, optional: true },
    ],
  },
  {
    // The channels of a notice: Web Push, letters, the bot (docs/plan/82-scheduled-tasks.md, Зп41).
    provide: NotificationDelivery,
    useFactory: (prisma: PrismaClient, config: CoreConfig) =>
      notificationDeliveryOf(prisma, config),
    inject: [PRISMA, CORE_CONFIG],
  },
  {
    // A chat that waits for its client who is not looking (docs/plan/75-chat-input-output.md, ВВ6),
    // and a pass of a scheduled run without its client (docs/plan/82, Зп38, Зп39).
    provide: ChatNotify,
    useFactory: (prisma: PrismaClient, delivery: NotificationDelivery) =>
      new ChatNotify({
        db: prisma,
        delivery,
        schedules: new ScheduleNotify({ db: prisma, delivery }),
      }),
    inject: [PRISMA, NotificationDelivery],
  },
  {
    // A notice of an artifact (docs/plan/88-artifacts.md, Ар54).
    provide: ArtifactNotify,
    useFactory: (prisma: PrismaClient, delivery: NotificationDelivery) =>
      new ArtifactNotify({ db: prisma, delivery }),
    inject: [PRISMA, NotificationDelivery],
  },
  {
    // The queue of a chat after its pass ended (docs/plan/75-chat-input-output.md, ВВ2).
    provide: QueueDrain,
    useFactory: (prisma: PrismaClient) => new QueueDrain({ db: prisma }),
    inject: [PRISMA],
  },
  TurnsProcessor,
  {
    provide: TaskSweep,
    useFactory: (
      prisma: PrismaClient,
      settlement: PassSettlement,
      live: LivePasses,
      journal: TaskEventTurnJournal,
      drivers: AgentDriverRegistry,
      queue: JobQueue,
      browser: BrowserSessions | null,
      inbox: ObjectStorage,
      registry: Registry,
      workspace: GitWorkspaceService | null,
      credentials: TurnCredentialSource,
    ) => {
      const pageMetrics = new PageMetrics(prisma)
      pageMetrics.register(registry)
      return new TaskSweep({
        db: prisma,
        settlement,
        live,
        journal,
        drivers,
        queue,
        browser,
        inbox,
        pages: new PagePublications({ db: prisma, logger: new Logger('Pages') }),
        pageMetrics,
        projects: new ProjectTrash({ db: prisma, storage: inbox }),
        memory: new MemoryChanges({ db: prisma, logger: new Logger('MemoryChanges') }),
        schedules: new ScheduleChanges({ db: prisma, logger: new Logger('ScheduleChanges') }),
        // The changes of a turn whose end recovery reached (docs/plan/84-projects.md, §10).
        pageChanges: new PageChanges({ db: prisma, logger: new Logger('PageChanges') }),
        // The writes in artifacts of turns the sweep ends, and their collector (Ар16, Ар50) with
        // the objects of the files and exports it removes.
        artifacts: new ArtifactChecks({
          db: prisma,
          storage: inbox,
          logger: new Logger('ArtifactChecks'),
          pages: new PagePublications({ db: prisma, logger: new Logger('Pages') }),
        }),
        values: credentials,
        // The card of a commit recovery published (docs/plan/84-projects.md, ПР12).
        repositories: workspace
          ? {
              workspace,
              // The object storage of the platform: the diff goes to raditi-artifacts.
              changes: new RepoChanges({
                db: prisma,
                storage: inbox,
                logger: new Logger('RepoChanges'),
              }),
            }
          : null,
      })
    },
    inject: [
      PRISMA,
      PassSettlement,
      LivePasses,
      TaskEventTurnJournal,
      AGENT_DRIVERS,
      JOB_QUEUE,
      BrowserSessions,
      OBJECT_STORAGE,
      METRICS_REGISTRY,
      { token: GIT_WORKSPACE, optional: true },
      TURN_CREDENTIALS,
    ],
  },
  {
    provide: TaskSweepRuntime,
    useFactory: (sweep: TaskSweep, background: boolean) => new TaskSweepRuntime(sweep, background),
    inject: [TaskSweep, BACKGROUND_JOBS],
  },
]
