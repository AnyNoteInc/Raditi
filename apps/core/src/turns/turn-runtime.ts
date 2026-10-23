import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { isProduction, type SandboxRuntime } from '@repo/domain'

import type { CoreConfig } from '../config/config.ts'
import type { TurnExecRecovery } from './turn-exec-recovery.ts'
import type { TurnReconciler } from './turn-reconciler.ts'

/**
 * The runtime a turn spec names: core's own Docker with the local executor, the runners' with
 * runner VMs (CoreConfig.runnerRuntime) — a runner refuses a spec of another runtime than its
 * own. gVisor in production, runc elsewhere when neither names one (CLAUDE.md, «Локальная
 * разработка на macOS»).
 */
export const turnRuntimeOf = (
  config: Pick<CoreConfig, 'sandbox' | 'runnerRuntime' | 'appEnv'>,
): SandboxRuntime =>
  config.runnerRuntime ??
  config.sandbox?.runtime ??
  (isProduction(config.appEnv) ? 'runsc' : 'runc')

/** How often core's own Docker is checked for turn containers nobody owns (local executor only). */
export const TURN_RECONCILE_INTERVAL_MS = 5 * 60_000

/**
 * The background side of turns in a running core (spec §8 «Восстановление незавершённого
 * хода»): recovery of the turns a core left unfinished, at start and every 30 seconds, and with
 * the local executor the removal of turn containers nobody owns. Tests and tools start nothing.
 */
export class TurnRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #logger: { warn(message: string): void }
  #timer: NodeJS.Timeout | undefined
  #pending: Promise<void> | undefined
  #closing = false

  constructor(
    private readonly recovery: Pick<TurnExecRecovery, 'start' | 'stop'> | null,
    private readonly reconciler: Pick<TurnReconciler, 'reconcile'> | null,
    private readonly background: boolean,
    logger?: { warn(message: string): void },
  ) {
    this.#logger = logger ?? new Logger('TurnRuntime')
  }

  onApplicationBootstrap(): void {
    if (!this.background || this.#closing) return
    this.recovery?.start()
    if (!this.reconciler || this.#timer) return
    this.#timer = setInterval(() => void this.reconcile(), TURN_RECONCILE_INTERVAL_MS)
    this.#timer.unref()
    void this.reconcile()
  }

  /** One pass of the reconciler at a time; its failure is logged without a message. */
  reconcile(): Promise<void> {
    if (this.#closing || !this.reconciler) return Promise.resolve()
    if (this.#pending) return this.#pending
    const pending = this.reconciler
      .reconcile()
      .then(
        () => undefined,
        () => this.#logger.warn('turn_reconcile_failed'),
      )
      .finally(() => {
        if (this.#pending === pending) this.#pending = undefined
      })
    this.#pending = pending
    return pending
  }

  async onModuleDestroy(): Promise<void> {
    this.#closing = true
    clearInterval(this.#timer)
    this.#timer = undefined
    await this.#pending
    await this.recovery?.stop()
  }
}
