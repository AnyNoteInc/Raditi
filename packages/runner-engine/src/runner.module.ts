import { readFile } from 'node:fs/promises'

import {
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { agentEventParser } from '@repo/agent-drivers'
import { parseRunnerToken, type SandboxProvider } from '@repo/domain'
import { createDockerSandboxProvider, type SandboxConfig } from '@repo/sandbox-providers'
import { fetchPresignedTransfer, SandboxSnapshotTransport } from '@repo/snapshots'
import { LocalTurnExecutor } from '@repo/local-turns'

import { SANDBOX_PROVIDER } from './tokens.ts'
import { HttpRunnerTransport } from './core-client.ts'
import type { RunnerConfig } from './runner-config.ts'
import { RunnerReconciler } from './runner-reconciler.ts'
import { readRunnerToken } from './runner-token.ts'
import { SandboxRunner } from './sandbox-runner.ts'

export interface RunnerModuleOptions {
  /** Core retired this session: the process should end so that it restarts under a new one. */
  onRetired?: () => void
}

/** The VM token, read once at start: the transport sends it, its runner id labels containers. */
const RUNNER_TOKEN = Symbol('RUNNER_TOKEN')

/**
 * The runner's Docker settings: its turn containers carry its id, and it lists only those, so
 * two runners sharing one daemon (a verification next to another) never collect each other's.
 */
export function runnerSandboxConfig(config: RunnerConfig, token: string): SandboxConfig {
  const parsed = parseRunnerToken(token)
  if (!parsed) throw new Error('RUNNER_TOKEN_FILE: does not hold a runner token')
  return { ...config.sandbox, runnerId: parsed.runnerId }
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
          provide: RUNNER_TOKEN,
          useFactory: () => readRunnerToken(config.tokenFile, config.appEnv),
        },
        {
          provide: HttpRunnerTransport,
          useFactory: async (token: string) =>
            new HttpRunnerTransport({
              coreUrl: config.coreUrl,
              token,
              ca: config.caFile ? await readFile(config.caFile) : null,
            }),
          inject: [RUNNER_TOKEN],
        },
        {
          provide: SANDBOX_PROVIDER,
          useFactory: (token: string) =>
            createDockerSandboxProvider(runnerSandboxConfig(config, token)),
          inject: [RUNNER_TOKEN],
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
              ...(config.s3Origin === null ? {} : { s3Origin: config.s3Origin }),
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
