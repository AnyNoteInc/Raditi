import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'

import type { WarmSandboxes } from '@repo/local-turns'

import type { HttpRunnerTransport } from './core-api/core-client.ts'
import type { RunnerReconciler } from './reconciler/runner-reconciler.ts'
import type { SandboxRunner } from './sandbox-runner/sandbox-runner.ts'

/**
 * Starts polling once the context is up, then the reconciler; on shutdown stops the reconciler,
 * then polling, removes the warm containers that wait for a turn, then closes the connections to
 * core, and leaves the containers of turns alone. The one
 * provider of the runner with hooks: Nest stops the providers of one module level at once, so
 * the order lives here, not in the depth of the module tree.
 */
export class RunnerLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly runner: Pick<SandboxRunner, 'start' | 'stop'>,
    private readonly reconciler: Pick<RunnerReconciler, 'start' | 'stop'>,
    private readonly transport: Pick<HttpRunnerTransport, 'close'>,
    /** The warm containers (docs/plan/93): the waiting ones go with the process. */
    private readonly warm: Pick<WarmSandboxes, 'close'> | null = null,
  ) {}

  onApplicationBootstrap(): void {
    this.runner.start()
    this.reconciler.start()
  }

  async onApplicationShutdown(): Promise<void> {
    await this.reconciler.stop()
    await this.runner.stop()
    // Only the waiting containers: a container a turn took stays with it for recovery.
    await this.warm?.close()
    this.transport.close()
  }
}
