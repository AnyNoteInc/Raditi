import { Inject, Injectable } from '@nestjs/common'
import { withTimeout } from '@repo/domain'

import { LLM_LOGGER } from '../infra/infra.tokens.ts'

/** The background work of the role by name: one run of a name at a time, none once it stops. */
@Injectable()
export class MaintenanceJobs {
  readonly #logger: { warn(message: string): void }
  readonly #timers = new Set<ReturnType<typeof setInterval>>()
  readonly #running = new Map<string, Promise<void>>()
  #closed = false

  constructor(@Inject(LLM_LOGGER) logger: { warn(message: string): void }) {
    this.#logger = logger
  }

  /** A run still going is returned instead of starting a second one. */
  run(name: string, work: () => Promise<void>): Promise<void> {
    if (this.#closed) return Promise.resolve()
    const running = this.#running.get(name)
    if (running) return running
    const job = Promise.resolve()
      .then(work)
      .catch(() => {
        this.#logger.warn(JSON.stringify({ event: 'llm_maintenance_failed', job: name }))
      })
      .finally(() => this.#running.delete(name))
    this.#running.set(name, job)
    return job
  }

  every(name: string, milliseconds: number, work: () => Promise<void>): void {
    const timer = setInterval(() => {
      void this.run(name, work)
    }, milliseconds)
    timer.unref()
    this.#timers.add(timer)
  }

  /** No timer fires again and no run starts; the runs going go on (drain). */
  close(): void {
    this.#closed = true
    for (const timer of this.#timers) clearInterval(timer)
  }

  /** Waits for the runs going at shutdown, at most `withinMs`. */
  async drain(withinMs: number): Promise<void> {
    if (this.#running.size)
      await withTimeout(
        Promise.allSettled([...this.#running.values()]),
        withinMs,
        'LLM jobs shutdown timed out',
      ).catch(() => {})
  }
}
