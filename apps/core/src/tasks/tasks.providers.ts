import type { Provider } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import type { PrismaClient } from '@repo/db'
import type { JobQueue, ObjectStorage, SecretStore, SiteLeaseStore } from '@repo/domain'
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
import { CandidateBuilder } from './candidate-builder.ts'
import { candidateClientValues } from './candidate-client-values.ts'
import { candidateGitOf, type CandidateGit } from './candidate-git.ts'
import { CandidateRebase } from './candidate-rebase.ts'
import { LivePasses } from './live-passes.ts'
import { PassRunner } from './pass-runner.ts'
import { PassSettlement } from './pass-settlement.ts'
import { TaskSweep, TaskSweepRuntime } from './task-sweep.ts'
import { CANDIDATE_GIT } from './tasks.tokens.ts'
import { TurnsProcessor } from './turns.processor.ts'

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
    ) => new PassSettlement({ db: prisma, candidates, browser }),
    inject: [PRISMA, CandidateBuilder, BrowserSessions],
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
    ) =>
      new PassRunner({
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
      }),
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
    ) => new TaskSweep({ db: prisma, settlement, live, journal, drivers, queue, browser, inbox }),
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
