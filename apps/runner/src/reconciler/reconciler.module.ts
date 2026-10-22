import { Module } from '@nestjs/common'
import type { SandboxProvider } from '@repo/domain'

import { CoreApiModule } from '../core-api/core-api.module.ts'
import { HttpRunnerTransport } from '../core-api/core-client.ts'
import { SandboxModule } from '../sandbox/sandbox.module.ts'
import { SANDBOX_PROVIDER } from '../sandbox/sandbox.tokens.ts'
import { SandboxRunner } from '../sandbox-runner/sandbox-runner.ts'
import { SandboxRunnerModule } from '../sandbox-runner/sandbox-runner.module.ts'
import { RunnerReconciler } from './runner-reconciler.ts'

/** The garbage collection of the VM's turn containers, on core's word which have no owner. */
@Module({
  imports: [SandboxRunnerModule, CoreApiModule, SandboxModule],
  providers: [
    {
      provide: RunnerReconciler,
      useFactory: (
        runner: SandboxRunner,
        transport: HttpRunnerTransport,
        sandboxes: SandboxProvider,
      ) => new RunnerReconciler({ runner, transport, sandboxes }),
      inject: [SandboxRunner, HttpRunnerTransport, SANDBOX_PROVIDER],
    },
  ],
  exports: [RunnerReconciler],
})
export class ReconcilerModule {}
