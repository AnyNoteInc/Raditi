import { randomUUID } from 'node:crypto'

import { Logger, Module } from '@nestjs/common'
import { agentEventParser } from '@repo/agent-drivers'
import { runnerOpenTasksResponseSchema, type SandboxProvider } from '@repo/domain'
import { LocalTurnExecutor, WarmSandboxes } from '@repo/local-turns'
import { createDockerSandboxProvider } from '@repo/sandbox-providers'
import { fetchPresignedTransfer, SandboxSnapshotTransport } from '@repo/snapshots'

import type { RunnerConfig } from '../config/config.ts'
import { RUNNER_CONFIG } from '../config/config.tokens.ts'
import { CoreApiModule } from '../core-api/core-api.module.ts'
import { HttpRunnerTransport } from '../core-api/core-client.ts'
import { VmTokenModule } from '../vm-token/vm-token.module.ts'
import { RUNNER_ID } from '../vm-token/vm-token.tokens.ts'
import { runnerSandboxConfig } from './runner-sandbox-config.ts'
import {
  RUNNER_SESSION,
  SANDBOX_PROVIDER,
  TURN_EXECUTOR,
  WARM_SANDBOXES,
} from './sandbox.tokens.ts'

/**
 * The VM's Docker through its local socket, and the local executor of turns over it: the same
 * sandbox steps core runs itself under TURN_EXECUTOR=local. Snapshot parts move only through
 * the presigned URLs core sends with a command.
 */
/** Why the agent's files for the client stayed in the sandbox (docs/plan/66, В8). */
const outboxLogger = new Logger('TurnOutbox')

/**
 * The warm containers of this VM (owner's decision of 26.10.2026, spec §8 «Тёплая песочница»;
 * docs/plan/93): the container of a completed turn waits for the next turn of its task. The runner
 * has no database: core says which tasks are still open, only of tasks this runner held a turn of,
 * and any failure ends every wait.
 */
export function runnerWarmSandboxes(
  config: Pick<RunnerConfig, 'warmMs' | 'warmMax'>,
  sandboxes: Pick<SandboxProvider, 'get'>,
  transport: Pick<HttpRunnerTransport, 'openTasks'>,
  runnerSession: string,
): WarmSandboxes | null {
  if (config.warmMs <= 0) return null
  return new WarmSandboxes({
    sandboxes,
    warmMs: config.warmMs,
    maxWaiting: config.warmMax,
    wanted: async (taskIds) => {
      const answer = runnerOpenTasksResponseSchema.parse(
        await transport.openTasks({ runnerSession, taskIds: [...taskIds] }),
      )
      return new Set(answer.open)
    },
    logger: new Logger('WarmSandboxes'),
  })
}

@Module({
  imports: [VmTokenModule, CoreApiModule],
  providers: [
    { provide: RUNNER_SESSION, useFactory: () => randomUUID() },
    {
      provide: SANDBOX_PROVIDER,
      useFactory: (config: RunnerConfig, runnerId: string) =>
        createDockerSandboxProvider(runnerSandboxConfig(config, runnerId)),
      inject: [RUNNER_CONFIG, RUNNER_ID],
    },
    {
      provide: WARM_SANDBOXES,
      useFactory: (
        config: RunnerConfig,
        sandboxes: SandboxProvider,
        transport: HttpRunnerTransport,
        session: string,
      ) => runnerWarmSandboxes(config, sandboxes, transport, session),
      inject: [RUNNER_CONFIG, SANDBOX_PROVIDER, HttpRunnerTransport, RUNNER_SESSION],
    },
    {
      provide: TURN_EXECUTOR,
      useFactory: (sandboxes: SandboxProvider, warm: WarmSandboxes | null) =>
        new LocalTurnExecutor({
          sandboxes,
          parser: agentEventParser,
          transport: new SandboxSnapshotTransport(),
          transfer: fetchPresignedTransfer(),
          log: (line) => outboxLogger.warn(line),
          ...(warm ? { warm } : {}),
        }),
      inject: [SANDBOX_PROVIDER, WARM_SANDBOXES],
    },
  ],
  exports: [SANDBOX_PROVIDER, TURN_EXECUTOR, WARM_SANDBOXES, RUNNER_SESSION],
})
export class SandboxModule {}
