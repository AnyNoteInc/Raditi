import { Module, type DynamicModule } from '@nestjs/common'

import type { RunnerConfig, RunnerOptions } from './config/config.ts'
import { RunnerConfigModule } from './config/config.module.ts'
import { CoreApiModule } from './core-api/core-api.module.ts'
import { HttpRunnerTransport } from './core-api/core-client.ts'
import { ReconcilerModule } from './reconciler/reconciler.module.ts'
import { RunnerReconciler } from './reconciler/runner-reconciler.ts'
import { RunnerLifecycle } from './runner-lifecycle.ts'
import { SandboxModule } from './sandbox/sandbox.module.ts'
import { SandboxRunner } from './sandbox-runner/sandbox-runner.ts'
import { SandboxRunnerModule } from './sandbox-runner/sandbox-runner.module.ts'
import { VmTokenModule } from './vm-token/vm-token.module.ts'

/**
 * The runner role (spec §8 «Раннер на песочной ВМ»): a Nest application context without any HTTP
 * server. It reaches Docker through the local socket and core through its runner API; nothing
 * here can reach PostgreSQL, Redis, Vault or S3 (dependency-cruiser checks it).
 */
@Module({})
export class AppModule {
  static forRoot(config: RunnerConfig, options: RunnerOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        RunnerConfigModule.forRoot(config, options),
        VmTokenModule,
        CoreApiModule,
        SandboxModule,
        SandboxRunnerModule,
        ReconcilerModule,
      ],
      providers: [
        {
          provide: RunnerLifecycle,
          useFactory: (
            runner: SandboxRunner,
            reconciler: RunnerReconciler,
            transport: HttpRunnerTransport,
          ) => new RunnerLifecycle(runner, reconciler, transport),
          inject: [SandboxRunner, RunnerReconciler, HttpRunnerTransport],
        },
      ],
    }
  }
}
