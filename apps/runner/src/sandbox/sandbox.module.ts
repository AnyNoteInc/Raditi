import { Module } from '@nestjs/common'
import { agentEventParser } from '@repo/agent-drivers'
import type { SandboxProvider } from '@repo/domain'
import { LocalTurnExecutor } from '@repo/local-turns'
import { createDockerSandboxProvider } from '@repo/sandbox-providers'
import { fetchPresignedTransfer, SandboxSnapshotTransport } from '@repo/snapshots'

import type { RunnerConfig } from '../config/config.ts'
import { RUNNER_CONFIG } from '../config/config.tokens.ts'
import { VmTokenModule } from '../vm-token/vm-token.module.ts'
import { RUNNER_ID } from '../vm-token/vm-token.tokens.ts'
import { runnerSandboxConfig } from './runner-sandbox-config.ts'
import { SANDBOX_PROVIDER, TURN_EXECUTOR } from './sandbox.tokens.ts'

/**
 * The VM's Docker through its local socket, and the local executor of turns over it: the same
 * sandbox steps core runs itself under TURN_EXECUTOR=local. Snapshot parts move only through
 * the presigned URLs core sends with a command.
 */
@Module({
  imports: [VmTokenModule],
  providers: [
    {
      provide: SANDBOX_PROVIDER,
      useFactory: (config: RunnerConfig, runnerId: string) =>
        createDockerSandboxProvider(runnerSandboxConfig(config, runnerId)),
      inject: [RUNNER_CONFIG, RUNNER_ID],
    },
    {
      provide: TURN_EXECUTOR,
      useFactory: (sandboxes: SandboxProvider) =>
        new LocalTurnExecutor({
          sandboxes,
          parser: agentEventParser,
          transport: new SandboxSnapshotTransport(),
          transfer: fetchPresignedTransfer(),
        }),
      inject: [SANDBOX_PROVIDER],
    },
  ],
  exports: [SANDBOX_PROVIDER, TURN_EXECUTOR],
})
export class SandboxModule {}
