import type { Buffer } from 'node:buffer'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import { BROWSER_STREAM_PATH } from '@repo/domain'
import { WebSocketServer, type WebSocket } from 'ws'

import { browserWorkerOrigin } from '../worker-url.ts'
import { StreamConnection } from './connection.ts'
import {
  browserStreamGatewayLimitDefaults,
  browserStreamTimingDefaults,
  type BrowserStreamGatewayLimits,
  type BrowserStreamStore,
  type BrowserStreamTimings,
} from './settings.ts'

// The screencast gateway (docs/plan/57-browser-tasks.md, Б12–Б14, §3.6) that apps/preview serves
// on its own listener: the cabinet's canvas ↔ WSS ↔ this gateway ↔ WS with the worker's token ↔
// the browser worker. It knows tickets, the viewer's right to watch and the shapes of messages;
// it knows neither Playwright nor the page. Tickets, inputs and frames never reach a log.

/**
 * The one path a stream is opened on (in domain: the cabinet's address of the gateway ends in it);
 * the ticket comes in the first message, never in the URL.
 */
export { BROWSER_STREAM_PATH }

export interface BrowserStreamGatewayOptions {
  store: BrowserStreamStore
  /** The worker's internal origin and its `BROWSER_WORKER_TOKEN`. */
  worker: { baseUrl: string; token: string }
  /** The cabinet (APP_URL): a stream opens only for exactly this `Origin`. */
  appOrigin: string
  timings?: Partial<BrowserStreamTimings>
  limits?: Partial<BrowserStreamGatewayLimits>
  logger?: { warn(message: string): void }
}

/** What went through, for the operator: no session, user or content in it. */
export interface BrowserStreamGatewayStats {
  connections: number
  framesRelayed: number
  /** Frames a slow viewer did not get (Б13). */
  framesDropped: number
}

export interface BrowserStreamGateway {
  /** The `request` of a listener: plain HTTP is no way in (426 on the path, 404 elsewhere). */
  handleRequest(request: IncomingMessage, response: ServerResponse): void
  /** The `upgrade` of a listener. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void
  /** Mounts both on a server created without a request listener. */
  attach(server: Server): void
  stats(): BrowserStreamGatewayStats
  /**
   * Ends every stream (`unavailable`) and takes no new one; a viewer's socket still open after
   * a short grace is cut.
   */
  close(): void
}

/** How long close() lets viewers answer the close frame before their sockets are cut. */
const CLOSE_GRACE_MS = 2_000

/** A visible ASCII token: it goes into a header as it is. */
const TOKEN = /^[\x21-\x7e]+$/

/** A raw answer on a socket that never became a WebSocket. */
function refuseSocket(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/** The cabinet's origin; an address that has none (a `file:` URL, garbage) is a setting error. */
function originOf(appOrigin: string): string {
  let url: URL
  try {
    url = new URL(appOrigin)
  } catch {
    throw new Error('The cabinet address of the browser stream is not a URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('The cabinet address of the browser stream must be http or https')
  return url.origin
}

/**
 * The gateway of browser streams. A WebSocket opens only on `BROWSER_STREAM_PATH`, only from
 * exactly the cabinet's `Origin` (cross-site WebSocket hijacking), refused before the upgrade
 * otherwise; everything after that is one StreamConnection per viewer.
 */
export function createBrowserStreamGateway(
  options: BrowserStreamGatewayOptions,
): BrowserStreamGateway {
  const appOrigin = originOf(options.appOrigin)
  const worker = {
    baseUrl: browserWorkerOrigin(options.worker.baseUrl),
    token: options.worker.token,
  }
  if (!TOKEN.test(worker.token)) throw new Error('The browser worker token is empty or not ASCII')
  const timings = { ...browserStreamTimingDefaults, ...options.timings }
  const limits = { ...browserStreamGatewayLimitDefaults, ...options.limits }
  const connections = new Set<StreamConnection>()
  /** Every viewer's socket until it is closed, ended streams included. */
  const sockets = new Set<WebSocket>()
  const counts = { framesRelayed: 0, framesDropped: 0 }
  let closed = false

  // The gateway checks every upgrade itself; `ws` only speaks the protocol on the socket.
  const server = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: limits.clientMessageBytes,
    perMessageDeflate: false,
  })

  const warn = (event: string, error?: unknown): void => {
    // The name of an error only: a message may carry an address or a value.
    const reason = error instanceof Error ? error.name : undefined
    options.logger?.warn(JSON.stringify({ event, ...(reason ? { reason } : {}) }))
  }

  const context = {
    store: options.store,
    worker,
    timings,
    limits,
    warn,
    frameRelayed: () => {
      counts.framesRelayed += 1
    },
    frameDropped: () => {
      counts.framesDropped += 1
    },
    ended: (connection: StreamConnection) => {
      connections.delete(connection)
    },
  }

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const status = request.url === BROWSER_STREAM_PATH ? 426 : 404
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-length': '0',
      ...(status === 426 ? { connection: 'Upgrade', upgrade: 'websocket' } : {}),
    })
    response.end()
  }

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => undefined)
    if (
      request.method !== 'GET' ||
      String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket'
    ) {
      refuseSocket(socket, 400, 'Bad Request')
      return
    }
    // The exact path, no query: a ticket put into a URL would end up in access logs.
    if (request.url !== BROWSER_STREAM_PATH) {
      refuseSocket(socket, 404, 'Not Found')
      return
    }
    if (request.headers.origin !== appOrigin) {
      refuseSocket(socket, 403, 'Forbidden')
      return
    }
    if (closed || connections.size >= limits.connections) {
      refuseSocket(socket, 503, 'Service Unavailable')
      return
    }
    server.handleUpgrade(request, socket, head, (client) => {
      if (closed) {
        client.terminate()
        return
      }
      sockets.add(client)
      client.once('close', () => sockets.delete(client))
      connections.add(new StreamConnection(client, context))
    })
  }

  return {
    handleRequest,
    handleUpgrade,
    attach(target) {
      target.on('request', handleRequest)
      target.on('upgrade', handleUpgrade)
    },
    stats: () => ({ connections: connections.size, ...counts }),
    close() {
      closed = true
      for (const connection of [...connections]) connection.end('unavailable')
      connections.clear()
      server.close()
      // A viewer that does not answer the close frame does not hold the listener up for long.
      setTimeout(() => {
        for (const client of sockets) client.terminate()
      }, CLOSE_GRACE_MS).unref()
    },
  }
}
