import { readFile } from 'node:fs/promises'

import {
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { agentEventParser } from '@repo/agent-drivers'
import type { SandboxProvider } from '@repo/domain'
import { createDockerSandboxProvider } from '@repo/sandbox-providers'

import { SANDBOX_PROVIDER } from '../infra/tokens.ts'
import { fetchPresignedTransfer } from '../sessions/presigned-transfer.ts'
import { SandboxSnapshotTransport } from '../sessions/sandbox-snapshot.ts'
import { LocalTurnExecutor } from '../turns/local-turn-executor.ts'
import { HttpRunnerTransport } from './core-client.ts'
import type { RunnerConfig } from './runner-config.ts'
import { RunnerReconciler } from './runner-reconciler.ts'
import { readRunnerToken } from './runner-token.ts'
import { SandboxRunner } from './sandbox-runner.ts'

export interface RunnerModuleOptions {
  /** Core retired this session: the process should end so that it restarts under a new one. */
  onRetired?: () => void
}

/** Starts polling once the context is up; stops it on shutdown and leaves containers alone. */
class RunnerLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly runner: SandboxRunner,
    private readonly reconciler: RunnerReconciler,
    private readonly transport: HttpRunnerTransport,
  ) {}

  onApplicationBootstrap(): void {
    this.runner.start()
    this.reconciler.start()
  }

  async onApplicationShutdown(): Promise<void> {
    await this.reconciler.stop()
    await this.runner.stop()
    this.transport.close()
  }
}

/**
 * The runner role (spec §8 «Раннер на песочной ВМ»): a Nest application context without any HTTP
 * server. It reaches Docker through the local socket and core through its runner API; nothing
 * here can reach PostgreSQL, Redis, Vault or S3 (dependency-cruiser checks it).
 */
@Module({})
export class RunnerModule {
  static forRoot(config: RunnerConfig, options: RunnerModuleOptions = {}): DynamicModule {
    return {
      module: RunnerModule,
      providers: [
        {
          provide: HttpRunnerTransport,
          useFactory: async () =>
            new HttpRunnerTransport({
              coreUrl: config.coreUrl,
              token: await readRunnerToken(config.tokenFile, config.appEnv),
              ca: config.caFile ? await readFile(config.caFile) : null,
            }),
        },
        {
          provide: SANDBOX_PROVIDER,
          useFactory: () => createDockerSandboxProvider(config.sandbox),
        },
        {
          provide: SandboxRunner,
          useFactory: (transport: HttpRunnerTransport, sandboxes: SandboxProvider) =>
            new SandboxRunner({
              transport,
              executor: new LocalTurnExecutor({
                sandboxes,
                parser: agentEventParser,
                transport: new SandboxSnapshotTransport(),
                transfer: fetchPresignedTransfer(),
              }),
              maxTurns: config.maxTurns,
              ...(options.onRetired ? { onRetired: options.onRetired } : {}),
            }),
          inject: [HttpRunnerTransport, SANDBOX_PROVIDER],
        },
        {
          provide: RunnerReconciler,
          useFactory: (
            runner: SandboxRunner,
            transport: HttpRunnerTransport,
            sandboxes: SandboxProvider,
          ) => new RunnerReconciler({ runner, transport, sandboxes }),
          inject: [SandboxRunner, HttpRunnerTransport, SANDBOX_PROVIDER],
        },
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
      exports: [SandboxRunner],
    }
  }
}
