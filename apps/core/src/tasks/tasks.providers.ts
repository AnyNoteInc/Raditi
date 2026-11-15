import { Counter, type Registry } from '@prometheus-io/client'
import { Logger, type Provider } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import type { PrismaClient } from '@repo/db'
import type { JobQueue, ObjectStorage, SiteLeaseStore, TurnExecutor } from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { PRISMA } from '@repo/service-runtime'

import { BrowserSessions } from '../browser/browser-sessions.ts'
import type { CoreConfig } from '../config/config.ts'
import { BACKGROUND_JOBS, CORE_CONFIG } from '../config/config.tokens.ts'
import { AGENT_DRIVERS } from '../drivers/drivers.tokens.ts'
import { OBJECT_STORAGE } from '../infra/infra.tokens.ts'
import { SITE_LEASES } from '../leases/leases.tokens.ts'
import { JOB_QUEUE } from '../queue/queue.tokens.ts'
import { TaskEventTurnJournal } from '../turns/turn-journal.ts'
import { turnRuntimeOf } from '../turns/turn-runtime.ts'
import { TurnSupervisor } from '../turns/turn-supervisor.ts'
import { TURN_EXECUTOR } from '../turns/turns.tokens.ts'
import { ChatFiles } from './chat-files.ts'
import { DocSections } from './doc-sections.ts'
import { PageChanges } from './page-changes.ts'
import { PageMetrics } from '../pages/page-metrics.ts'
import { ProjectTrash } from '../projects/project-trash.ts'
import { PagePublications } from './page-publications.ts'
import { LivePasses } from './live-passes.ts'
import { PassRunner } from './pass-runner.ts'
import { PassSettlement } from './pass-settlement.ts'
import { QueueDrain } from './queue-drain.ts'
import { ChatNotify, webPushSender } from './chat-notify.ts'
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
        docs: new DocSections({
          db: prisma,
          logger: new Logger('DocSections'),
          pages: new PagePublications({ db: prisma, logger: new Logger('Pages') }),
        }),
        // What a turn asked of its pages besides versions (docs/plan/73-pages-sites.md, Дер23).
        pageChanges: new PageChanges({ db: prisma, logger: new Logger('PageChanges') }),
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
    ],
  },
  {
    // A chat that waits for its client who is not looking (docs/plan/75-chat-input-output.md, ВВ6).
    provide: ChatNotify,
    useFactory: async (prisma: PrismaClient, config: CoreConfig) =>
      new ChatNotify({
        db: prisma,
        appUrl: config.billing.appUrl,
        push: config.webPush
          ? await webPushSender({ ...config.webPush, subject: config.billing.appUrl })
          : null,
      }),
    inject: [PRISMA, CORE_CONFIG],
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
    ],
  },
  {
    provide: TaskSweepRuntime,
    useFactory: (sweep: TaskSweep, background: boolean) => new TaskSweepRuntime(sweep, background),
    inject: [TaskSweep, BACKGROUND_JOBS],
  },
]
