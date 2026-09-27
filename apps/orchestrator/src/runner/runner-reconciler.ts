import { Logger } from '@nestjs/common'
import {
  isDomainError,
  runnerReconcileResponseSchema,
  type SandboxLabels,
  type SandboxProvider,
} from '@repo/domain'
import { throttledLogger, type ThrottledLog } from '@repo/observability'

import { RunnerCallError, type RunnerTransport } from './core-client.ts'
import { runnerInventory, type SandboxRunner } from './sandbox-runner.ts'

/** A container of a turn no core knows lives at most this much past its removal by core. */
export const RUNNER_RECONCILE_MS = 5 * 60_000

export interface RunnerReconcileResult {
  removed: string[]
  kept: string[]
  uncertain: string[]
}

/**
 * The runner's garbage collection (spec §8): the runner has no database, so core tells it which
 * of its turn containers no unfinished assignment owns at its epochs. Unknown owners fail closed
 * in core; here only containers this session reported, does not hold itself and whose identity
 * is unchanged are removed.
 */
export class RunnerReconciler {
  #timer: NodeJS.Timeout | undefined
  #running: Promise<unknown> | undefined
  readonly #warn: ThrottledLog

  constructor(
    private readonly deps: {
      runner: Pick<SandboxRunner, 'session' | 'holds'>
      transport: Pick<RunnerTransport, 'reconcile'>
      sandboxes: SandboxProvider
      logger?: { warn(message: string): void }
    },
  ) {
    const logger = deps.logger ?? new Logger('RunnerReconciler')
    this.#warn = throttledLogger((line) => logger.warn(line))
  }

  /** Now and then every RUNNER_RECONCILE_MS. */
  start(intervalMs = RUNNER_RECONCILE_MS): void {
    if (this.#timer) return
    const tick = () => {
      this.#running ??= this.reconcile()
        .catch((error: unknown) =>
          this.#warn(
            'runner reconcile',
            new Error(
              error instanceof RunnerCallError
                ? error.message
                : isDomainError(error)
                  ? error.code
                  : 'failed',
            ),
          ),
        )
        .finally(() => {
          this.#running = undefined
        })
    }
    this.#timer = setInterval(tick, intervalMs)
    this.#timer.unref()
    tick()
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer)
    this.#timer = undefined
    await this.#running
  }

  async reconcile(): Promise<RunnerReconcileResult> {
    const result: RunnerReconcileResult = { removed: [], kept: [], uncertain: [] }
    const inventory = runnerInventory(await this.deps.sandboxes.list())
    const answer = runnerReconcileResponseSchema.parse(
      await this.deps.transport.reconcile({ runnerSession: this.deps.runner.session, inventory }),
    )
    const reported = new Map(inventory.map((entry) => [entry.containerId, entry.labels]))
    for (const id of answer.remove) {
      const labels = reported.get(id) as SandboxLabels | undefined
      // Only what this session reported; its own turns are removed by their commands.
      if (!labels || this.deps.runner.holds(id)) {
        result.kept.push(id)
        continue
      }
      try {
        // Also a container that can no longer run anything, such as one whose gateway died.
        const sandbox = await this.deps.sandboxes.getForRemoval(id)
        if (!sandbox) continue
        // The provider must return the exact immutable container id, never a reused name.
        if (
          sandbox.id !== id ||
          (Object.entries(labels) as [keyof SandboxLabels, unknown][]).some(
            ([key, value]) => sandbox.labels[key] !== value,
          )
        ) {
          result.uncertain.push(id)
          continue
        }
        await sandbox.destroy('gc')
        result.removed.push(id)
      } catch {
        result.uncertain.push(id)
      }
    }
    return result
  }
}
