import type { Buffer } from 'node:buffer'
import { once } from 'node:events'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { BlockList, isIP, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'
import {
  parsePreviewHostname,
  PREVIEW_CONTROL_PREFIX,
  previewGatewayPaths,
  previewOrigin,
} from '@repo/domain'

import { PreviewSessions } from '../access/preview-sessions.ts'
import { PREVIEW_CONFIG, type PreviewGatewayConfig } from '../config/config.tokens.ts'
import { previewRevisionSeen } from '../cookie/preview-cookie.ts'
import { PreviewEntry } from './entry.ts'
import { isServiceWorkerScript } from './headers.ts'
import { previewGatewayLimits } from './limits.ts'
import { gatewayPages, type PagesContext } from './pages.ts'
import { PreviewProxy } from './proxy.ts'
import {
  cookieHeader,
  pagesContext,
  refuse,
  refuseSocket,
  sendJson,
  sendPage,
  sendStatus,
  warn,
  type Refusal,
  type Target,
} from './replies.ts'
import { PreviewTunnels } from './tunnels.ts'

/**
 * A request from another host under the same registrable domain — another preview, whose site
 * code would ride this preview's cookies. Legitimate traffic is same-origin, cross-site from
 * the cabinet, or typed by the visitor (none).
 */
const fromSiblingSite = (headers: IncomingHttpHeaders): boolean =>
  String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'same-site'

/** A document the browser navigates to (a client without fetch metadata counts as one). */
const isNavigation = (headers: IncomingHttpHeaders): boolean => {
  const mode = headers['sec-fetch-mode']
  return mode === undefined || mode.toLowerCase() === 'navigate'
}

const sourceAddress = (address: string | undefined): string =>
  (address ?? '').replace(/^::ffff:/, '')

/**
 * The gateway of previews, role `preview` (docs/plan/53-chat-preview-release.md, Р19). Plain
 * node:http. The exact Host names the preview; its row names the upstream, nothing a client
 * sends does. A visitor gets in only with a one-time ticket from the cabinet, which becomes the
 * gateway's own cookie (PreviewEntry); the site never sees that cookie and cannot set one like
 * it, and its pages may be framed by the cabinet alone (PreviewProxy, PreviewTunnels). The
 * agent's browser comes through a relay in absolute form, with a ticket of its own kind;
 * CONNECT is never served. close() alone stops the gateway: its parts have no shutdown hooks.
 */
@Injectable()
export class PreviewGatewayServer implements OnApplicationShutdown {
  #server: Server | undefined
  readonly #config: PreviewGatewayConfig
  readonly #pages: PagesContext
  readonly #relays = new BlockList()
  readonly #sessions: PreviewSessions
  readonly #entry: PreviewEntry
  readonly #proxy: PreviewProxy
  readonly #tunnels: PreviewTunnels
  #tunnelTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    @Inject(PREVIEW_CONFIG) config: PreviewGatewayConfig,
    @Inject(PreviewSessions) sessions: PreviewSessions,
    @Inject(PreviewEntry) entry: PreviewEntry,
    @Inject(PreviewProxy) proxy: PreviewProxy,
    @Inject(PreviewTunnels) tunnels: PreviewTunnels,
  ) {
    this.#config = config
    this.#pages = pagesContext(config.appUrl)
    for (const range of config.browserRelays)
      this.#relays.addSubnet(range.address, range.prefix, range.family)
    this.#sessions = sessions
    this.#entry = entry
    this.#proxy = proxy
    this.#tunnels = tunnels
  }

  readonly #handle = (request: IncomingMessage, response: ServerResponse): void => {
    this.#serve(request, response).catch((error: unknown) => {
      warn('preview_gateway_failed', error)
      if (!response.headersSent) sendPage(response, gatewayPages.unavailable(this.#pages))
      else response.destroy()
    })
  }

  readonly #handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => undefined)
    this.#upgrade(request, socket, head).catch((error: unknown) => {
      warn('preview_gateway_upgrade_failed', error)
      refuseSocket(socket, 503, 'Service Unavailable')
    })
  }

  /** CONNECT is never a way to a preview, from anyone (Р21). */
  readonly #handleConnect = (_request: IncomingMessage, socket: Duplex): void => {
    refuseSocket(socket, 405, 'Method Not Allowed')
  }

  async listen(port: number, host?: string): Promise<AddressInfo> {
    const server = createServer({ maxHeaderSize: previewGatewayLimits.headerBytes }, this.#handle)
    server.headersTimeout = previewGatewayLimits.headersTimeoutMs
    server.requestTimeout = previewGatewayLimits.requestTimeoutMs
    server.on('upgrade', this.#handleUpgrade)
    server.on('connect', this.#handleConnect)
    server.on('clientError', (_error, socket) => refuseSocket(socket, 400, 'Bad Request'))
    this.#server = server
    server.listen(port, host)
    await once(server, 'listening')
    this.#tunnelTimer = setInterval(() => {
      void this.recheckTunnels()
    }, previewGatewayLimits.tunnelCheckMs)
    this.#tunnelTimer.unref()
    return server.address() as AddressInfo
  }

  /** Where it listens; null before listen() and after close(). */
  address(): AddressInfo | null {
    const address = this.#server?.address()
    return address && typeof address === 'object' ? address : null
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close()
  }

  async close(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    clearInterval(this.#tunnelTimer)
    this.#proxy.stop()
    this.#tunnels.endAll()
    if (!server?.listening) return
    const closed = once(server, 'close')
    server.close()
    server.closeIdleConnections()
    // Long answers and websockets of a preview are not waited for long.
    setTimeout(() => server.closeAllConnections(), 2_000).unref()
    await closed
  }

  /**
   * Checks every open websocket again (PreviewTunnels.recheck). The timer of listen() calls it;
   * tests call it directly.
   */
  async recheckTunnels(): Promise<void> {
    await this.#tunnels.recheck()
  }

  // -------------------------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------------------------

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const head = request.method === 'HEAD'
    if (
      request.method === 'GET' &&
      (request.url ?? '').split('?')[0] === previewGatewayPaths.health
    ) {
      sendJson(response, 200, { status: 'ok' })
      return
    }
    const target = this.#target(request)
    if ('refused' in target) {
      refuse(response, target, this.#pages, head)
      return
    }
    if (fromSiblingSite(request.headers)) {
      sendStatus(response, 403)
      return
    }
    const route = await this.#sessions.route(target.hostname)
    if (route === null) {
      refuse(response, { refused: target.relayed ? 'forbidden' : 'not_found' }, this.#pages, head)
      return
    }
    const pathname = target.path.split('?')[0] ?? '/'
    if (pathname.startsWith(PREVIEW_CONTROL_PREFIX)) {
      await this.#entry.control(request, response, route, target, pathname)
      return
    }
    if (request.method === 'TRACE') {
      sendStatus(response, 405)
      return
    }
    // A service worker would outlive the session and the revision it was registered under.
    if (isServiceWorkerScript(request.headers)) {
      sendStatus(response, 403)
      return
    }
    const session = await this.#sessions.session(
      cookieHeader(request.headers),
      route,
      target.relayed,
    )
    if (session === null) {
      this.#entry.noSession(request, response, route, target)
      return
    }
    if (!this.#proxy.serving(response, route, head)) return
    // The cache and storage of the origin belong to the browser and outlive every session: a
    // document of a revision this browser has not got clears them (Р19). The site's answer
    // carries it, so an answer the gateway makes itself (502, 504, 413) never spends the clear.
    const clearForRevision =
      isNavigation(request.headers) &&
      !previewRevisionSeen(cookieHeader(request.headers), route.revision)
        ? route.revision
        : undefined
    this.#proxy.proxy(request, response, route, target.path, clearForRevision)
  }

  /** The Host of an origin-form request, or the URL of an absolute-form one from a relay. */
  #target(request: IncomingMessage): Target | Refusal {
    const raw = request.url ?? ''
    const base = this.#config.address.baseDomain
    if (raw.startsWith('/')) {
      // X-Forwarded-Host and the like are never read: the Host is what the browser asked for.
      // A port, if any, is the public one; the name alone picks the preview.
      const hostname = (request.headers.host ?? '').replace(/:\d{1,5}$/, '').toLowerCase()
      if (parsePreviewHostname(hostname, base) === null) return { refused: 'not_found' }
      return { hostname, path: raw, relayed: false }
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { refused: 'bad_request' }
    // Absolute form: a forward-proxy request, only from a relay of the agent's browser.
    if (!this.#fromRelay(request)) return { refused: 'forbidden' }
    const url = URL.parse(raw)
    if (url?.protocol !== 'http:' || url.username !== '' || url.password !== '')
      return { refused: 'forbidden' }
    const hostname = url.hostname
    if (
      parsePreviewHostname(hostname, base) === null ||
      url.origin !== previewOrigin(hostname, this.#config.address)
    )
      return { refused: 'forbidden' }
    return { hostname, path: `${url.pathname}${url.search}`, relayed: true }
  }

  #fromRelay(request: IncomingMessage): boolean {
    const source = sourceAddress(request.socket.remoteAddress)
    const family = isIP(source)
    return family !== 0 && this.#relays.check(source, family === 4 ? 'ipv4' : 'ipv6')
  }

  // -------------------------------------------------------------------------------------------
  // WebSockets
  // -------------------------------------------------------------------------------------------

  /** A handshake's own checks; PreviewTunnels opens the websocket of one that passes them. */
  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (
      request.method !== 'GET' ||
      String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket'
    ) {
      refuseSocket(socket, 400, 'Bad Request')
      return
    }
    const target = this.#target(request)
    if ('refused' in target) {
      refuseSocket(socket, target.refused === 'not_found' ? 404 : 403, 'Refused')
      return
    }
    if (fromSiblingSite(request.headers)) {
      refuseSocket(socket, 403, 'Forbidden')
      return
    }
    await this.#tunnels.open(request, socket, head, target)
  }
}
