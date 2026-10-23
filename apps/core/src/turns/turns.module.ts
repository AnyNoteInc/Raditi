import { Module, type DynamicModule } from '@nestjs/common'
import type { TurnExecutorKind } from '@repo/domain'

import { DriversModule } from '../drivers/drivers.module.ts'
import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { LeasesModule } from '../leases/leases.module.ts'
import { LlmModule } from '../llm/llm.module.ts'
import { RunnerApiModule } from '../runner-api/runner-api.module.ts'
import { SandboxModule } from '../sandbox/sandbox.module.ts'
import { SessionsModule } from '../sessions/sessions.module.ts'
import { TaskEventTurnJournal } from './turn-journal.ts'
import { TurnSupervisor } from './turn-supervisor.ts'
import { localTurnExecutor, remoteTurnExecutor, turnEngineProviders } from './turns.providers.ts'
import { TURN_EXECUTOR } from './turns.tokens.ts'

/**
 * The turn engine of the core role (spec §8): TURN_EXECUTOR by configuration — runner VMs over
 * the runner API, or core's own Docker (PoC, never in production) — the supervisor that drives
 * a turn with it, its recovery, the journal of turns, and the background side: recovery at start
 * and, for the local executor, TurnReconciler over the same SANDBOX_PROVIDER.
 *
 * Built once per process, by AppModule.forRoot, and imported as that same object by the modules
 * that run turns (TasksModule, PreviewsModule): Nest tells dynamic modules apart by reference,
 * and a second one would be a second LiveTurns — a turn driven here taken over by recovery.
 */
@Module({})
export class TurnsModule {
  static forRoot(executor: TurnExecutorKind): DynamicModule {
    return {
      module: TurnsModule,
      imports: [
        DriversModule,
        GitWorkspaceModule,
        SessionsModule,
        LlmModule,
        LeasesModule,
        // Last: of the modules of one level Nest stops first the one it met last, so the runner
        // API closes before GitWorkspaceModule revokes the git credentials (AppModule's test).
        executor === 'runner' ? RunnerApiModule : SandboxModule,
      ],
      providers: [
        executor === 'runner' ? remoteTurnExecutor : localTurnExecutor,
        ...turnEngineProviders,
      ],
      exports: [TURN_EXECUTOR, TurnSupervisor, TaskEventTurnJournal],
    }
  }
}
