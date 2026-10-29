import type { Provider } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import type { PrismaClient } from '@repo/db'
import type {
  ObjectStorage,
  SandboxProvider,
  SiteLeaseStore,
  TurnAssignmentStore,
  TurnCredentialSource,
  TurnExecutor,
} from '@repo/domain'
import { LocalTurnExecutor } from '@repo/local-turns'
import { PRISMA } from '@repo/service-runtime'
import { fetchPresignedTransfer, SandboxSnapshotTransport } from '@repo/snapshots'

import type { CoreConfig } from '../config/config.ts'
import { BACKGROUND_JOBS, CORE_CONFIG } from '../config/config.tokens.ts'
import { AGENT_DRIVERS } from '../drivers/drivers.tokens.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { OBJECT_STORAGE } from '../infra/infra.tokens.ts'
import { SITE_LEASES, TURN_ASSIGNMENTS } from '../leases/leases.tokens.ts'
import { TURN_CREDENTIALS } from '../llm/llm.tokens.ts'
import { RemoteTurnExecutor } from '../runner-api/remote-turn-executor.ts'
import { SANDBOX_PROVIDER } from '../sandbox/sandbox.tokens.ts'
import { SnapshotService } from '../sessions/snapshot.service.ts'
import { LiveTurns } from './live-turns.ts'
import { PreviewTurnRollback } from './preview-turn-rollback.ts'
import { TurnExecRecovery } from './turn-exec-recovery.ts'
import { TaskInboxFiles } from './turn-inbox.ts'
import { TaskEventTurnJournal } from './turn-journal.ts'
import { TurnReconciler } from './turn-reconciler.ts'
import { TurnRuntime } from './turn-runtime.ts'
import { TurnSupervisor } from './turn-supervisor.ts'
import { TURN_EXECUTOR, WARM_SANDBOXES } from './turns.tokens.ts'
import { CoreWarmSandboxes } from './warm-turn-sandboxes.ts'

type RecoveryAssignments = ConstructorParameters<typeof TurnExecRecovery>[0]['assignments']

/** The runner VMs over the runner API (RunnerApiModule). */
export const remoteTurnExecutor: Provider = {
  provide: TURN_EXECUTOR,
  useExisting: RemoteTurnExecutor,
}

/** Core's own Docker (SandboxModule): the PoC and tests, never production. */
export const localTurnExecutor: Provider = {
  provide: TURN_EXECUTOR,
  useFactory: (
    sandboxes: SandboxProvider,
    drivers: AgentDriverRegistry,
    warm: CoreWarmSandboxes | null,
  ) =>
    new LocalTurnExecutor({
      sandboxes,
      parser: (id) => drivers.get(id),
      transport: new SandboxSnapshotTransport(),
      transfer: fetchPresignedTransfer(),
      ...(warm ? { warm } : {}),
    }),
  inject: [SANDBOX_PROVIDER, AGENT_DRIVERS, { token: WARM_SANDBOXES, optional: true }],
}

/**
 * The turn supervisor and its recovery as the stands compose them (scripts/verify-runner-core.mjs)
 * over TURN_EXECUTOR, with the background side of turns (TurnRuntime). The supervisor is null
 * without a driver. Without git (CoreConfig.git) both still run turns without a repository — in
 * the cloud browser — and refuse the rest (docs/plan/57-browser-tasks.md, Б7).
 */
export const turnEngineProviders: Provider[] = [
  // One per process, shared by the supervisor and recovery: a turn driven here is never taken over.
  { provide: LiveTurns, useFactory: () => new LiveTurns() },
  {
    // Core's own Docker only (spec §8, «Тёплая песочница»): runner VMs remove every container.
    provide: WARM_SANDBOXES,
    useFactory: (
      config: CoreConfig,
      sandboxes: SandboxProvider | null,
      prisma: PrismaClient,
    ): CoreWarmSandboxes | null =>
      config.turnExecutor === 'local' && sandboxes && config.sandboxWarmMs > 0
        ? new CoreWarmSandboxes(sandboxes, prisma, config.sandboxWarmMs)
        : null,
    inject: [CORE_CONFIG, { token: SANDBOX_PROVIDER, optional: true }, PRISMA],
  },
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
      storage: ObjectStorage,
    ): TurnSupervisor | null => {
      const [driver] = drivers.list()
      if (!driver) return null
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
        inbox: new TaskInboxFiles(prisma, storage),
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
      OBJECT_STORAGE,
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
    ): TurnExecRecovery =>
      new TurnExecRecovery({
        leases,
        assignments,
        executor,
        journal,
        driver: (id) => drivers.get(id),
        workspace,
        snapshots,
        credentials,
        live,
      }),
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
      warm: CoreWarmSandboxes | null,
    ) =>
      new TurnRuntime(
        recovery,
        // Only core's own Docker: with runner VMs each runner removes what is its own.
        config.turnExecutor === 'local' && sandboxes
          ? new TurnReconciler(sandboxes, leases, assignments, (id) => warm?.holds(id) ?? false)
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
      { token: WARM_SANDBOXES, optional: true },
    ],
  },
]
