import { Module } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import type { PrismaClient } from '@repo/db'
import {
  type JobQueue,
  type ObjectStorage,
  type SandboxProvider,
  type SecretStore,
  type SiteLeaseStore,
  type TurnAssignmentStore,
  type TurnCredentialSource,
  type TurnExecutor,
} from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'
import { getSiteAdapter } from '@repo/site-adapters'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import { readSiteEnvValuesToRefuse } from '@repo/turn-keys'
import { PreviewDbValueStorage } from '@repo/site-content'

import type { CoreConfig } from '../config/config.ts'
import { DriversModule } from '../drivers/drivers.module.ts'
import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import {
  AGENT_DRIVERS,
  CORE_CONFIG,
  JOB_QUEUE,
  SANDBOX_PROVIDER,
  SITE_LEASES,
  TURN_ASSIGNMENTS,
  TURN_CREDENTIALS,
  TURN_EXECUTOR,
  BACKGROUND_JOBS,
  OBJECT_STORAGE,
} from '../infra/tokens.ts'
import { LlmModule } from '../llm/llm.module.ts'
import { SessionsModule } from '../sessions/sessions.module.ts'
import { SnapshotService } from '../sessions/snapshot.service.ts'
import { previewDbPlanValues } from '../site-content/db-plan-values.ts'
import { LiveTurns } from '../turns/live-turns.ts'
import { TurnExecRecovery } from '../turns/turn-exec-recovery.ts'
import { TaskEventTurnJournal } from '../turns/turn-journal.ts'
import { TurnReconciler } from '../turns/turn-reconciler.ts'
import { TurnSupervisor } from '../turns/turn-supervisor.ts'
import { CandidateBuilder } from './candidate-builder.ts'
import { candidateGitOf, type CandidateGit } from './candidate-git.ts'
import { CandidateRebase } from './candidate-rebase.ts'
import { LivePasses } from './live-passes.ts'
import { PassRunner } from './pass-runner.ts'
import { PassSettlement } from './pass-settlement.ts'
import { PreviewTurnRollback } from './preview-rollback.ts'
import { TaskSweep, TaskSweepRuntime } from './task-sweep.ts'
import { TurnRuntime, turnRuntimeOf } from './turn-runtime.ts'
import { TurnsProcessor } from './turns.processor.ts'

/** CandidateGit over the workspace service, or null while git is not configured. */
export const CANDIDATE_GIT = Symbol('CANDIDATE_GIT')

type RecoveryAssignments = ConstructorParameters<typeof TurnExecRecovery>[0]['assignments']

/**
 * Dialogs of the core role (docs/plan/53-chat-preview-release.md, R3; roadmap N11/N12): the turn
 * supervisor and its recovery as the stands compose them (scripts/verify-runner-core.mjs), the
 * processor of the `agent-turns` queue, the settlement of a pass with its feed rows, candidate
 * and credits, «Обновить» of a candidate and the sweep of dialogs. Without git (CoreConfig.git
 * is null) core starts, and every pass fails `unavailable` with its reserve given back (spec §20
 * «Транспорт git»).
 */
@Module({
  imports: [GitWorkspaceModule, DriversModule, SessionsModule, LlmModule],
  providers: [
    // One per process, shared by the supervisor and recovery: a turn driven here is never taken over.
    { provide: LiveTurns, useFactory: () => new LiveTurns() },
    {
      provide: TaskEventTurnJournal,
      useFactory: (prisma: PrismaClient) => new TaskEventTurnJournal(prisma),
      inject: [PRISMA],
    },
    {
      provide: TurnSupervisor,
      useFactory: (
        workspace: GitWorkspaceService | null,
        leases: SiteLeaseStore,
        assignments: TurnAssignmentStore,
        snapshots: SnapshotService,
        journal: TaskEventTurnJournal,
        executor: TurnExecutor,
        drivers: AgentDriverRegistry,
        live: LiveTurns,
        credentials: TurnCredentialSource,
        prisma: PrismaClient,
      ): TurnSupervisor | null => {
        const [driver] = drivers.list()
        if (!workspace || !driver) return null
        return new TurnSupervisor({
          leases,
          assignments,
          workspace,
          snapshots,
          journal,
          executor,
          driver,
          live,
          credentials,
          contentRollback: new PreviewTurnRollback(prisma),
        })
      },
      inject: [
        GitWorkspaceService,
        SITE_LEASES,
        TURN_ASSIGNMENTS,
        SnapshotService,
        TaskEventTurnJournal,
        TURN_EXECUTOR,
        AGENT_DRIVERS,
        LiveTurns,
        TURN_CREDENTIALS,
        PRISMA,
      ],
    },
    {
      provide: TurnExecRecovery,
      useFactory: (
        workspace: GitWorkspaceService | null,
        leases: SiteLeaseStore,
        assignments: RecoveryAssignments,
        snapshots: SnapshotService,
        journal: TaskEventTurnJournal,
        executor: TurnExecutor,
        drivers: AgentDriverRegistry,
        live: LiveTurns,
        credentials: TurnCredentialSource,
      ): TurnExecRecovery | null =>
        workspace
          ? new TurnExecRecovery({
              leases,
              assignments,
              executor,
              journal,
              driver: (id) => drivers.get(id),
              workspace,
              snapshots,
              credentials,
              live,
            })
          : null,
      inject: [
        GitWorkspaceService,
        SITE_LEASES,
        TURN_ASSIGNMENTS,
        SnapshotService,
        TaskEventTurnJournal,
        TURN_EXECUTOR,
        AGENT_DRIVERS,
        LiveTurns,
        TURN_CREDENTIALS,
      ],
    },
    {
      provide: TurnRuntime,
      useFactory: (
        recovery: TurnExecRecovery | null,
        config: CoreConfig,
        sandboxes: SandboxProvider | null,
        leases: SiteLeaseStore,
        assignments: TurnAssignmentStore,
        background: boolean,
      ) =>
        new TurnRuntime(
          recovery,
          // Only core's own Docker: with runner VMs each runner removes what is its own.
          config.turnExecutor === 'local' && sandboxes
            ? new TurnReconciler(sandboxes, leases, assignments)
            : null,
          background,
        ),
      inject: [
        TurnExecRecovery,
        CORE_CONFIG,
        { token: SANDBOX_PROVIDER, optional: true },
        SITE_LEASES,
        TURN_ASSIGNMENTS,
        BACKGROUND_JOBS,
      ],
    },
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
      ) =>
        git
          ? new CandidateBuilder(prisma, git, storage, getSiteAdapter, {
              // The values the agent wrote into the preview, as the mcp role sealed them (R7):
              // the description of the plan the client reads before `/release`.
              values: previewDbPlanValues({
                prisma,
                values: new PreviewDbValueStorage(storage, secrets),
              }),
              // The rows before the values: a row set after them is seen when the revision is
              // recorded, and its description dropped there.
              clientValues: async (siteId) => {
                const variables = await prisma.siteEnvVar.findMany({
                  where: { siteId },
                  select: { name: true, keyVersion: true },
                })
                return {
                  values:
                    variables.length === 0
                      ? []
                      : await readSiteEnvValuesToRefuse(
                          secrets,
                          siteId,
                          variables.map((variable) => variable.name),
                        ),
                  variables,
                }
              },
            })
          : null,
      inject: [PRISMA, CANDIDATE_GIT, OBJECT_STORAGE, SECRET_STORE],
    },
    {
      provide: PassSettlement,
      useFactory: (prisma: PrismaClient, candidates: CandidateBuilder | null) =>
        new PassSettlement({ db: prisma, candidates }),
      inject: [PRISMA, CandidateBuilder],
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
      ) =>
        new PassRunner({
          db: prisma,
          supervisor,
          git,
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
      ) => new TaskSweep({ db: prisma, settlement, live, journal, drivers, queue }),
      inject: [PRISMA, PassSettlement, LivePasses, TaskEventTurnJournal, AGENT_DRIVERS, JOB_QUEUE],
    },
    {
      provide: TaskSweepRuntime,
      useFactory: (sweep: TaskSweep, background: boolean) =>
        new TaskSweepRuntime(sweep, background),
      inject: [TaskSweep, BACKGROUND_JOBS],
    },
  ],
  exports: [PassSettlement, LivePasses],
})
export class TasksModule {}
