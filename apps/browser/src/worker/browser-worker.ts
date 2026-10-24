import type { Server } from 'node:http'

import { Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common'
import { throttledLogger } from '@repo/observability'
import type {
  BrowserSessionRuntime,
  CloudBrowserFactory,
  SiteAdapter,
  SiteStack,
} from '@repo/domain'
import type { Registry } from '@prometheus-io/client'

import { AttachmentFiles, type InboxStorage } from '../attachments/attachments.ts'
import { errorName } from '../common/browser-codes.ts'
import type { BrowserWorkerConfig } from '../config/config.ts'
import { registerBrowserWorkerMetrics } from '../metrics/worker-metrics.ts'
import { SessionManager, sessionTimingDefaults } from '../sessions/session-manager.ts'
import { BrowserStreamServer } from '../stream/stream-server.ts'
import type { BrowserWorkerStore } from '../store/worker-store.ts'

/** How often idle, expired and lost sessions are looked for. */
export const SWEEP_MS = 15_000

export interface BrowserWorkerParts {
  config: BrowserWorkerConfig
  store: BrowserWorkerStore
  runtime: BrowserSessionRuntime | null
  browsers: CloudBrowserFactory
  inbox: InboxStorage
  adapters: (stack: SiteStack) => SiteAdapter
  registry: Registry
  /** Seams of the tests; the worker's own numbers otherwise. */
  timings?: Partial<typeof sessionTimingDefaults> & { sweepMs?: number; pingMs?: number }
  now?: () => number
}

/**
 * The browser worker as one piece (docs/plan/57-browser-tasks.md, Б10): the sessions, the stream
 * on the app's HTTP server and their metrics; it sweeps idle and expired sessions, removes what
 * an earlier process left at start and closes every session when the app stops. Its log lines
 * name events and errors, never an address, an input or a frame.
 */
export class BrowserWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  readonly sessions: SessionManager
  readonly stream: BrowserStreamServer
  readonly #sweepMs: number
  #sweep: ReturnType<typeof setInterval> | undefined
  #sweeping = false

  constructor(parts: BrowserWorkerParts) {
    const logger = new Logger('BrowserWorker')
    const warnOnce = throttledLogger((line) => logger.warn(line))
    const warn = (event: string, error?: unknown) =>
      warnOnce(event, error === undefined ? 'refused' : errorName(error))
    const now = parts.now ?? Date.now
    const { config } = parts
    const live = { sessions: () => this.sessions.size, viewers: () => this.stream.viewers }
    const metrics = registerBrowserWorkerMetrics(parts.registry, live)
    this.sessions = new SessionManager({
      runtime: parts.runtime,
      browsers: parts.browsers,
      store: parts.store,
      files: new AttachmentFiles(parts.store, parts.inbox),
      adapters: parts.adapters,
      metrics,
      now,
      warn,
      settings: {
        ...sessionTimingDefaults,
        ...parts.timings,
        idleMinutes: config.session.idleMinutes,
        maxHours: config.session.maxHours,
        maxSessions: config.session.maxSessions,
        extraHosts: config.extraHosts,
        localSites: config.localSites,
        stream: { maxFps: config.stream.maxFps, quality: config.stream.quality },
      },
    })
    this.stream = new BrowserStreamServer({
      token: config.token,
      sessions: this.sessions,
      store: parts.store,
      metrics,
      flow: { maxFps: config.stream.maxFps, window: config.stream.window },
      ...(parts.timings?.pingMs === undefined ? {} : { pingMs: parts.timings.pingMs }),
      now,
      warn,
    })
    this.#sweepMs = parts.timings?.sweepMs ?? SWEEP_MS
    if (!this.sessions.configured)
      logger.warn(
        'browser images are not configured (BROWSER_IMAGE, BROWSER_FORWARDER_IMAGE, BROWSER_EGRESS_IMAGE): every session is unavailable',
      )
  }

  /** The stream takes the upgrades of the app's HTTP server. */
  listenOn(server: Server): void {
    this.stream.attach(server)
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.sessions.removeLeftovers()
    this.#sweep = setInterval(() => void this.#sweepOnce(), this.#sweepMs)
    this.#sweep.unref()
  }

  async #sweepOnce(): Promise<void> {
    if (this.#sweeping) return
    this.#sweeping = true
    try {
      await this.sessions.sweep()
    } finally {
      this.#sweeping = false
    }
  }

  /** Before the HTTP server and the database close: every session ends, then every stream. */
  async beforeApplicationShutdown(): Promise<void> {
    clearInterval(this.#sweep)
    await this.sessions.shutdown()
    this.stream.close()
  }
}
