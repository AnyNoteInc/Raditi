import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { isDomainError } from '@repo/domain'
import { throttledLogger } from '@repo/observability'

import type { PreviewManager } from './preview-manager.ts'

// The loops of the manager of previews in a running core (docs/plan/53, R5c): the request rows
// the mcp role writes — it has no Redis to put a job — are looked for every 500 ms, and the
// sweep runs every 30 s. Each loop runs one pass at a time; requests of different previews are
// served side by side, and the builds a sweep finds due run beside it (PreviewManager.sweep).

export const previewLoopTimings = Object.freeze({
  requestsMs: 500,
  sweepMs: 30_000,
  /** Previews served at once by the request loop. */
  parallel: 4,
  /** Rows of each kind read per pass. */
  batch: 32,
})

const logged = (error: unknown) =>
  new Error(isDomainError(error) ? error.code : error instanceof Error ? error.name : 'unknown')

export class PreviewLoops implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #logger = new Logger(PreviewLoops.name)
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))
  readonly #timers: NodeJS.Timeout[] = []
  #requests: Promise<void> | undefined
  #sweep: Promise<void> | undefined
  /** Request rows served now, by id. */
  readonly #serving = new Map<string, Promise<unknown>>()
  #closing = false

  constructor(
    private readonly manager: Pick<
      PreviewManager,
      'pendingRequests' | 'serveSync' | 'serveBrowser' | 'sweep' | 'isWorking' | 'idle'
    > | null,
    private readonly background: boolean,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.background || !this.manager || this.#closing || this.#timers.length) return
    const requests = setInterval(() => void this.requests(), previewLoopTimings.requestsMs)
    const sweep = setInterval(() => void this.sweep(), previewLoopTimings.sweepMs)
    requests.unref()
    sweep.unref()
    this.#timers.push(requests, sweep)
    void this.sweep()
  }

  /** One pass over the pending request rows; never two at once. */
  requests(): Promise<void> {
    if (this.#closing || !this.manager) return Promise.resolve()
    this.#requests ??= this.#serveRequests().finally(() => {
      this.#requests = undefined
    })
    return this.#requests
  }

  /** One pass of the sweep; never two at once. */
  sweep(): Promise<void> {
    if (this.#closing || !this.manager) return Promise.resolve()
    const manager = this.manager
    this.#sweep ??= manager
      .sweep()
      .catch((error: unknown) => this.#warn('preview sweep', logged(error)))
      .finally(() => {
        this.#sweep = undefined
      })
    return this.#sweep
  }

  async #serveRequests(): Promise<void> {
    const manager = this.manager!
    let pending: Awaited<ReturnType<PreviewManager['pendingRequests']>>
    try {
      pending = await manager.pendingRequests(previewLoopTimings.batch)
    } catch (error) {
      this.#warn('preview requests', logged(error))
      return
    }
    const rows = [
      ...pending.sync.map((row) => ({ ...row, serve: () => manager.serveSync(row.id) })),
      ...pending.browser.map((row) => ({ ...row, serve: () => manager.serveBrowser(row.id) })),
    ]
    const previews = new Set([...this.#serving.keys()].map((key) => key.split(':')[0]))
    for (const row of rows) {
      if (this.#serving.size >= previewLoopTimings.parallel) break
      const key = `${row.previewId}:${row.id}`
      if (this.#serving.has(key) || previews.has(row.previewId) || manager.isWorking(row.previewId))
        continue
      previews.add(row.previewId)
      const served = row
        .serve()
        .catch((error: unknown) => this.#warn(`preview request ${row.id}`, logged(error)))
        .finally(() => this.#serving.delete(key))
      this.#serving.set(key, served)
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.#closing = true
    for (const timer of this.#timers.splice(0)) clearInterval(timer)
    await Promise.allSettled([this.#requests, this.#sweep, ...this.#serving.values()])
    // The builds the sweep started beside it.
    await this.manager?.idle()
  }
}
