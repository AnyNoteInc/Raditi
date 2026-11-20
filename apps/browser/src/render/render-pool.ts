import { randomUUID } from 'node:crypto'

import type { FrameRenderer, FrameRendererTarget } from '@repo/browser-providers/render'
import { DomainError, type BrowserSessionRuntime } from '@repo/domain'
import { artifactRenderLimits } from '@repo/domain/artifacts'

// The pool of render containers (docs/plan/88-artifacts.md, §7.12; spike 3): a Chromium in a
// container of its own on a network without the host and with an egress proxy that lets nothing
// through — the same runtime as the sessions', with no host allowed and no open web —, and the
// renderer's own routes in front of it. Two renders at a time on one Chromium; a container is
// replaced after 200 renders, 30 minutes, or when its browser went away. Outside production a
// worker without the images of the runtime renders on a Chromium of its own machine.

export interface RenderPoolDeps {
  /** The containers of the sessions; null — the images are not configured. */
  runtime: BrowserSessionRuntime | null
  /** A Chromium of this machine when there is no runtime: never in production. */
  local: boolean
  /** How many render containers at most. */
  containers: number
  create: (target: FrameRendererTarget) => Promise<FrameRenderer>
  now?: () => number
  warn?: (event: string, error: unknown) => void
}

interface Entry {
  id: string | null
  renderer: Promise<FrameRenderer>
  active: number
  renders: number
  startedAt: number
  retiring: boolean
}

const WAIT_MS = 15_000

export class RenderPool {
  readonly #deps: Required<Pick<RenderPoolDeps, 'now'>> & RenderPoolDeps
  readonly #entries: Entry[] = []
  readonly #waiting: (() => void)[] = []
  #closed = false

  constructor(deps: RenderPoolDeps) {
    this.#deps = { now: Date.now, ...deps }
  }

  /** Whether the worker can render at all. */
  get available(): boolean {
    return this.#deps.runtime !== null || this.#deps.local
  }

  /**
   * Whether a container is one of the pool's. The sessions remove what an earlier process left only
   * at start, before the pool starts any; a later sweep of the runtime must ask this first.
   */
  holds(sessionId: string): boolean {
    return this.#entries.some((entry) => entry.id === sessionId)
  }

  /** One render on a free slot of the pool; waits for one at most 15 s, then RENDER_BUSY. */
  async run<T>(work: (renderer: FrameRenderer) => Promise<T>): Promise<T> {
    if (!this.available || this.#closed)
      throw new DomainError('RENDER_UNAVAILABLE', 'The renderer is not configured', 503)
    const entry = await this.#slot()
    entry.active += 1
    entry.renders += 1
    try {
      const renderer = await entry.renderer
      return await work(renderer)
    } finally {
      entry.active -= 1
      void this.#recycle(entry)
      this.#waiting.shift()?.()
    }
  }

  async #slot(): Promise<Entry> {
    const deadline = this.#deps.now() + WAIT_MS
    for (;;) {
      await this.#dropDead()
      const free = this.#entries.find(
        (entry) => !entry.retiring && entry.active < artifactRenderLimits.rendersPerContainer,
      )
      if (free) return free
      if (this.#entries.filter((entry) => !entry.retiring).length < this.#deps.containers)
        return this.#start()
      const left = deadline - this.#deps.now()
      if (left <= 0) throw new DomainError('RENDER_BUSY', 'Every renderer is busy', 503)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 1000))
        this.#waiting.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  #start(): Entry {
    const runtime = this.#deps.runtime
    const id = runtime ? randomUUID() : null
    const entry: Entry = {
      id,
      active: 0,
      renders: 0,
      startedAt: this.#deps.now(),
      retiring: false,
      renderer: (async () => {
        if (runtime === null || id === null) return this.#deps.create({ launch: true })
        const { endpoint } = await runtime.start({
          sessionId: id,
          taskId: id,
          siteId: id,
          // Nothing out: no host of a site, no open web, no local site, no public host.
          allowedHosts: [],
          openWeb: false,
          closed: true,
          localSites: [],
          deadline: this.#deps.now() + (artifactRenderLimits.containerMinutes + 5) * 60_000,
        })
        return this.#deps.create({ endpoint })
      })(),
    }
    entry.renderer.catch((error: unknown) => {
      entry.retiring = true
      this.#deps.warn?.('render_container_not_started', error)
      void this.#remove(entry)
    })
    this.#entries.push(entry)
    return entry
  }

  async #dropDead(): Promise<void> {
    for (const entry of [...this.#entries]) {
      const renderer = await Promise.race([entry.renderer, Promise.resolve(null)]).catch(() => null)
      if (renderer !== null && !renderer.connected()) {
        entry.retiring = true
        await this.#recycle(entry)
      }
    }
  }

  async #recycle(entry: Entry): Promise<void> {
    const old =
      entry.renders >= artifactRenderLimits.containerRenders ||
      this.#deps.now() - entry.startedAt >= artifactRenderLimits.containerMinutes * 60_000
    if (old) entry.retiring = true
    if (entry.retiring && entry.active === 0) await this.#remove(entry)
  }

  async #remove(entry: Entry): Promise<void> {
    const at = this.#entries.indexOf(entry)
    if (at < 0) return
    this.#entries.splice(at, 1)
    const renderer = await entry.renderer.catch(() => null)
    await renderer?.close()
    if (entry.id !== null)
      await this.#deps.runtime
        ?.stop(entry.id)
        .catch((error: unknown) => this.#deps.warn?.('render_container_not_stopped', error))
  }

  async close(): Promise<void> {
    this.#closed = true
    await Promise.allSettled([...this.#entries].map((entry) => this.#remove(entry)))
  }
}
