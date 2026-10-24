import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  createBrowserStreamGateway,
  type BrowserStreamGateway,
  type BrowserStreamGatewayStats,
  type BrowserStreamStore,
  type BrowserStreamViewer,
} from '@repo/browser-link'
import { browserViewerAllowed, consumeBrowserStreamTicket, type PrismaClient } from '@repo/db'

import type { BrowserStreamConfig } from '../config/config.tokens.ts'

/** The tickets of streams and the viewer's right to watch, in PostgreSQL (Б12). */
export class PostgresBrowserStreamStore implements BrowserStreamStore {
  readonly #db: Pick<PrismaClient, '$queryRaw'>

  constructor(db: Pick<PrismaClient, '$queryRaw'>) {
    this.#db = db
  }

  async consumeTicket(ticket: string): Promise<BrowserStreamViewer | null> {
    const spent = await consumeBrowserStreamTicket(this.#db, ticket)
    return spent === null ? null : { sessionId: spent.sessionId, userId: spent.userId }
  }

  viewerAllowed(viewer: BrowserStreamViewer): Promise<boolean> {
    return browserViewerAllowed(this.#db, viewer)
  }
}

/** A handshake is a few short headers; it comes quickly or not at all. */
export const browserStreamListenerLimits = Object.freeze({
  headerBytes: 16 * 1024,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
})

export interface BrowserStreamListenerOptions {
  config: BrowserStreamConfig
  /** APP_URL: the cabinet, the only Origin a stream opens for. */
  appUrl: string
  store: BrowserStreamStore
  logger?: { warn(message: string): void }
}

/**
 * The second listener of the preview app (docs/plan/57-browser-tasks.md, Б12): the cabinet's
 * canvas reaches the browser of its task here, through the stream gateway of
 * `@repo/browser-link`. Its own shutdown hook ends the streams before any module's
 * onApplicationShutdown, so the database closes after them.
 */
export class BrowserStreamListener {
  #server: Server | undefined
  readonly #gateway: BrowserStreamGateway

  constructor(options: BrowserStreamListenerOptions) {
    this.#gateway = createBrowserStreamGateway({
      store: options.store,
      worker: { baseUrl: options.config.workerUrl, token: options.config.workerToken },
      appOrigin: new URL(options.appUrl).origin,
      ...(options.logger ? { logger: options.logger } : {}),
    })
  }

  async listen(port: number, host?: string): Promise<AddressInfo> {
    const limits = browserStreamListenerLimits
    const server = createServer({ maxHeaderSize: limits.headerBytes })
    server.headersTimeout = limits.headersTimeoutMs
    server.requestTimeout = limits.requestTimeoutMs
    this.#gateway.attach(server)
    this.#server = server
    server.listen(port, host)
    await once(server, 'listening')
    return server.address() as AddressInfo
  }

  /** Where it listens; null before listen() and after close(). */
  address(): AddressInfo | null {
    const address = this.#server?.address()
    return address && typeof address === 'object' ? address : null
  }

  stats(): BrowserStreamGatewayStats {
    return this.#gateway.stats()
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.close()
  }

  async close(): Promise<void> {
    this.#gateway.close()
    const server = this.#server
    this.#server = undefined
    if (!server?.listening) return
    const closed = once(server, 'close')
    server.close()
    server.closeIdleConnections()
    // Ended streams wait for the viewer's close frame; nobody waits for it long.
    setTimeout(() => server.closeAllConnections(), 2_000).unref()
    await closed
  }
}
