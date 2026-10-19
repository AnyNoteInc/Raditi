import { Module, type DynamicModule } from '@nestjs/common'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import type { SandboxProvider, TurnExecutorKind } from '@repo/domain'

import { DriversModule } from '../drivers/drivers.module.ts'
import { AGENT_DRIVERS, SANDBOX_PROVIDER, TURN_EXECUTOR } from '../infra/tokens.ts'
import { RemoteTurnExecutor } from '../runner-api/remote-turn-executor.ts'
import { RunnerApiModule } from '../runner-api/runner-api.module.ts'
import { SandboxModule } from '../sandbox/sandbox.module.ts'
import { fetchPresignedTransfer } from '../sessions/presigned-transfer.ts'
import { SandboxSnapshotTransport } from '../sessions/sandbox-snapshot.ts'
import { LocalTurnExecutor } from './local-turn-executor.ts'

/**
 * TURN_EXECUTOR by configuration: runner VMs over the runner API, or core's own Docker (PoC,
 * never in production). Global: the supervisor that uses it, its recovery and, for the local
 * executor, TurnReconciler over the same SANDBOX_PROVIDER are wired with the task queue in
 * TasksModule (docs/plan/53-chat-preview-release.md, R3).
 */
@Module({})
export class TurnsModule {
  static forRoot(executor: TurnExecutorKind): DynamicModule {
    if (executor === 'runner')
      return {
        module: TurnsModule,
        global: true,
        imports: [RunnerApiModule],
        providers: [{ provide: TURN_EXECUTOR, useExisting: RemoteTurnExecutor }],
        exports: [TURN_EXECUTOR, RunnerApiModule],
      }
    return {
      module: TurnsModule,
      global: true,
      imports: [SandboxModule, DriversModule],
      providers: [
        {
          provide: TURN_EXECUTOR,
          useFactory: (sandboxes: SandboxProvider, drivers: AgentDriverRegistry) =>
            new LocalTurnExecutor({
              sandboxes,
              parser: (id) => drivers.get(id),
              transport: new SandboxSnapshotTransport(),
              transfer: fetchPresignedTransfer(),
            }),
          inject: [SANDBOX_PROVIDER, AGENT_DRIVERS],
        },
      ],
      exports: [TURN_EXECUTOR, SandboxModule],
    }
  }
}
