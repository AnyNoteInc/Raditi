import { Counter, type Registry } from '@prometheus-io/client'
import { Logger, type Provider } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import type { PrismaClient } from '@repo/db'
import type {
  JobQueue,
  ObjectStorage,
  SecretStore,
  SiteLeaseStore,
  TurnExecutor,
} from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { getSiteAdapter } from '@repo/site-adapters'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import { BrowserSessions } from '../browser/browser-sessions.ts'
import type { CoreConfig } from '../config/config.ts'
import { BACKGROUND_JOBS, CORE_CONFIG } from '../config/config.tokens.ts'
import { AGENT_DRIVERS } from '../drivers/drivers.tokens.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { OBJECT_STORAGE } from '../infra/infra.tokens.ts'
import { SITE_LEASES } from '../leases/leases.tokens.ts'
import { JOB_QUEUE } from '../queue/queue.tokens.ts'
import type { DbPlanValueReader } from '../site-content/db-plan-values.ts'
import { PLAN_VALUES } from '../site-content/site-content.tokens.ts'
import { TaskEventTurnJournal } from '../turns/turn-journal.ts'
import { turnRuntimeOf } from '../turns/turn-runtime.ts'
import { TurnSupervisor } from '../turns/turn-supervisor.ts'
import { TURN_EXECUTOR } from '../turns/turns.tokens.ts'
import { CandidateBuilder } from './candidate-builder.ts'
import { candidateClientValues } from './candidate-client-values.ts'
import { candidateGitOf, type CandidateGit } from './candidate-git.ts'
import { CandidateEdit } from './candidate-edit.ts'
import { CandidateRebase } from './candidate-rebase.ts'
import { CandidateRewind } from './candidate-rewind.ts'
import { ChatFiles } from './chat-files.ts'
import { DocSections } from './doc-sections.ts'
import { PagePublications } from './page-publications.ts'
import { LivePasses } from './live-passes.ts'
import { PassRunner } from './pass-runner.ts'
import { PassSettlement } from './pass-settlement.ts'
import { TaskSweep, TaskSweepRuntime } from './task-sweep.ts'
import { TurnCapacity } from './turn-capacity.ts'
import { CANDIDATE_GIT } from './tasks.tokens.ts'
import { TurnsProcessor } from './turns.processor.ts'
import { METRICS_REGISTRY } from '../metrics/metrics.tokens.ts'

/**
 * The passes of dialogs, their candidates, the worker of `agent-turns` and the sweep of dialogs,
 * over the turn engine (TurnsModule).
 */
export const taskProviders: Provider[] = [
  LivePasses,
  {
    provide: CANDIDATE_GIT,
    useFactory: (workspace: GitWorkspaceService | null): CandidateGit | null =>
      workspace ? candidateGitOf(workspace) : null,
    inject: [GitWorkspaceService],
  },
  {
    provide: CandidateBuilder,
    useFactory: (
      prisma: PrismaClient,
      git: CandidateGit | null,
      storage: ObjectStorage,
      secrets: SecretStore,
      values: DbPlanValueReader,
    ) =>
      git
        ? new CandidateBuilder(prisma, git, storage, getSiteAdapter, {
            // The values the agent wrote into the preview, as the mcp role sealed them (R7):
            // the description of the plan the client reads before `/release`.
            values,
            clientValues: candidateClientValues(prisma, secrets),
          })
        : null,
    inject: [PRISMA, CANDIDATE_GIT, OBJECT_STORAGE, SECRET_STORE, PLAN_VALUES],
  },
  {
    provide: PassSettlement,
    useFactory: (
      prisma: PrismaClient,
      candidates: CandidateBuilder | null,
      browser: BrowserSessions | null,
      registry: Registry,
    ) => {
      // A pass a window of its workspace stopped (plan 71, §4.4); no id in a label.
      const refusals = new Counter({
        name: 'raditi_workspace_window_refusals_total',
        help: 'Passes and calls refused by a usage window of their workspace',
        labelNames: ['tier', 'window', 'point'],
        registers: [registry],
      })
      return new PassSettlement({
        db: prisma,
        candidates,
        browser,
        onUsageLimit: ({ window, tier }) => refusals.inc({ tier, window, point: 'pass' }),
      })
    },
    inject: [PRISMA, CandidateBuilder, BrowserSessions, METRICS_REGISTRY],
  },
  {
    provide: PassRunner,
    useFactory: (
      prisma: PrismaClient,
      supervisor: TurnSupervisor | null,
      git: CandidateGit | null,
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
        git,
        browser,
        drivers,
        backends: llmBackends,
        adapter: getSiteAdapter,
        leases,
        runtime: turnRuntimeOf(config),
        previews: config.previews?.address ?? null,
        settlement,
        live,
        queue,
        chatFiles: new ChatFiles({
          db: prisma,
          storage,
          logger: new Logger('ChatFiles'),
          pages: new PagePublications({ db: prisma, logger: new Logger('Pages') }),
        }),
        docs: new DocSections({ db: prisma, logger: new Logger('DocSections') }),
        // Docs/plan/70-turn-without-time-limit.md, ВР13 and ВР17.
        workspaceTurnLimit: config.workspaceTurnLimit,
        capacity: new TurnCapacity(executor),
      })
    },
    inject: [
      PRISMA,
      TurnSupervisor,
      CANDIDATE_GIT,
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
    provide: CandidateRebase,
    useFactory: (
      prisma: PrismaClient,
      git: CandidateGit | null,
      candidates: CandidateBuilder | null,
      leases: SiteLeaseStore,
      queue: JobQueue,
    ) =>
      new CandidateRebase({
        db: prisma,
        git,
        candidates,
        leases,
        queue,
        adapter: getSiteAdapter,
      }),
    inject: [PRISMA, CANDIDATE_GIT, CandidateBuilder, SITE_LEASES, JOB_QUEUE],
  },
  {
    provide: CandidateRewind,
    useFactory: (
      prisma: PrismaClient,
      git: CandidateGit | null,
      candidates: CandidateBuilder | null,
      leases: SiteLeaseStore,
      queue: JobQueue,
    ) => new CandidateRewind({ db: prisma, git, candidates, leases, queue }),
    inject: [PRISMA, CANDIDATE_GIT, CandidateBuilder, SITE_LEASES, JOB_QUEUE],
  },
  {
    provide: CandidateEdit,
    useFactory: (
      prisma: PrismaClient,
      git: CandidateGit | null,
      candidates: CandidateBuilder | null,
      leases: SiteLeaseStore,
      queue: JobQueue,
      inbox: ObjectStorage,
    ) =>
      new CandidateEdit({
        db: prisma,
        git,
        candidates,
        leases,
        queue,
        inbox,
        adapter: getSiteAdapter,
      }),
    inject: [PRISMA, CANDIDATE_GIT, CandidateBuilder, SITE_LEASES, JOB_QUEUE, OBJECT_STORAGE],
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
    ) =>
      new TaskSweep({
        db: prisma,
        settlement,
        live,
        journal,
        drivers,
        queue,
        browser,
        inbox,
        pages: new PagePublications({ db: prisma, logger: new Logger('Pages') }),
      }),
    inject: [
      PRISMA,
      PassSettlement,
      LivePasses,
      TaskEventTurnJournal,
      AGENT_DRIVERS,
      JOB_QUEUE,
      BrowserSessions,
      OBJECT_STORAGE,
    ],
  },
  {
    provide: TaskSweepRuntime,
    useFactory: (sweep: TaskSweep, background: boolean) => new TaskSweepRuntime(sweep, background),
    inject: [TaskSweep, BACKGROUND_JOBS],
  },
]
