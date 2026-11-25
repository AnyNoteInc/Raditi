import { Module } from '@nestjs/common'
import type { TurnExecutor } from '@repo/domain'
import type { WarmSandboxes } from '@repo/local-turns'

import type { RunnerConfig, RunnerOptions } from '../config/config.ts'
import { RUNNER_CONFIG, RUNNER_OPTIONS } from '../config/config.tokens.ts'
import { CoreApiModule } from '../core-api/core-api.module.ts'
import { HttpRunnerTransport } from '../core-api/core-client.ts'
import { SandboxModule } from '../sandbox/sandbox.module.ts'
import { RUNNER_SESSION, TURN_EXECUTOR, WARM_SANDBOXES } from '../sandbox/sandbox.tokens.ts'
import { SandboxRunner } from './sandbox-runner.ts'

/** The poll loop: core's commands, carried out by the local executor over the VM's Docker. */
@Module({
  imports: [CoreApiModule, SandboxModule],
  providers: [
    {
      provide: SandboxRunner,
      useFactory: (
        config: RunnerConfig,
        options: RunnerOptions,
        transport: HttpRunnerTransport,
        executor: TurnExecutor,
        session: string,
        warm: WarmSandboxes | null,
      ) =>
        new SandboxRunner({
          transport,
          executor,
          session,
          ...(warm ? { warm } : {}),
          maxTurns: config.maxTurns,
          ...(config.s3Origin === null ? {} : { s3Origin: config.s3Origin }),
          ...(options.onRetired ? { onRetired: options.onRetired } : {}),
        }),
      inject: [
        RUNNER_CONFIG,
        RUNNER_OPTIONS,
        HttpRunnerTransport,
        TURN_EXECUTOR,
        RUNNER_SESSION,
        WARM_SANDBOXES,
      ],
    },
  ],
  exports: [SandboxRunner],
})
export class SandboxRunnerModule {}
