import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'

import type { CredentialSweeper } from './credential-sweeper.ts'

export const TURN_CREDENTIAL_SWEEP_INTERVAL_MS = 60_000

/** The core timer only starts in running applications; durable rows make every pass repeatable. */
export class CoreCredentialRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined
  #pending: Promise<void> | undefined
  #closing = false

  constructor(
    private readonly sweeper: Pick<CredentialSweeper, 'tick' | 'close'>,
    private readonly background: boolean,
    private readonly logger: { warn(message: string): void } = new Logger('CoreCredentials'),
  ) {}

  onApplicationBootstrap(): void {
    if (!this.background || this.#timer || this.#closing) return
    this.#timer = setInterval(() => void this.tick(), TURN_CREDENTIAL_SWEEP_INTERVAL_MS)
    this.#timer.unref()
    void this.tick()
  }

  tick(): Promise<void> {
    if (this.#closing) return Promise.resolve()
    if (this.#pending) return this.#pending
    const pending = Promise.resolve()
      .then(() => this.sweeper.tick())
      .catch(() => {
        if (!this.#closing) this.logger.warn('llm_credentials_sweep_failed kind=runtime')
      })
      .finally(() => {
        if (this.#pending === pending) this.#pending = undefined
      })
    this.#pending = pending
    return pending
  }

  async onModuleDestroy(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    clearInterval(this.#timer)
    this.#timer = undefined
    await this.sweeper.close()
  }
}
