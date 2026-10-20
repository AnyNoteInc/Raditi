import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { BlockList, isIP, type AddressInfo, type Socket } from 'node:net'
import { pipeline, Transform, type Duplex, type TransformCallback } from 'node:stream'

import {
  isPreviewPath,
  isPreviewServing,
  isProduction,
  parsePreviewHostname,
  PREVIEW_CONTROL_PREFIX,
  previewGatewayPaths,
  previewOpenUrl,
  previewOrigin,
  previewTicketSchema,
  previewTimings,
  type AppEnv,
  type PreviewAddress,
  type PreviewSessionKind,
} from '@repo/domain'
import { ipLiteral, isLoopbackAddress, isPrivateAddress } from '@repo/ip-address'

import type { PreviewRelayRange } from './preview-relays.ts'
import type { PreviewAccessStore, PreviewRoute, PreviewSessionRecord } from './preview-access.ts'
import {
  hasPreviewRetry,
  previewCookieClaims,
  previewRetrySetCookie,
  previewRevisionSeen,
  previewSetCookie,
  previewTicketHash,
  verifyPreviewCookie,
} from './preview-cookie.ts'
import {
  browserResponseHeaders,
  isServiceWorkerScript,
  upstreamRequestHeaders,
} from './preview-headers.ts'
import { gatewayPages, type GatewayPage, type PagesContext } from './preview-pages.ts'
import { TtlCache } from './ttl-cache.ts'

export const previewGatewayLimits = Object.freeze({
  /** A body a visitor sends to the site: a form, a media upload in the admin of the copy. */
  requestBodyBytes: 32 * 1024 * 1024,
  /** All the headers of one request; Node's own default is 16 KiB. */
  headerBytes: 32 * 1024,
  /** The headers of a request arrive within this, the whole request within the next. */
  headersTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
  /** The site answers (or sends more of its answer) within this, or the gateway gives up. */
  upstreamIdleMs: 60_000,
  /** A websocket with no traffic either way this long is closed. */
  websocketIdleMs: 10 * 60_000,
  /**
   * How often an open websocket is checked again — its preview, session, membership and site
   * (Р19). A quarter of the membership interval: a tunnel never runs a minute and a quarter
   * past a membership that ended.
   */
  tunnelCheckMs: (previewTimings.membershipCheckSeconds * 1_000) / 4,
  /** What the gateway read from the database is reused this long (Р19: at most 5 s). */
  cacheMs: 5_000,
  cacheEntries: 10_000,
})

export interface PreviewGatewayOptions {
  appEnv: AppEnv
  address: PreviewAddress
  sessionSecret: string
  /** APP_URL: the one frame ancestor and the way back to the cabinet. */
  appUrl: string
  /** Sources that may use the gateway as a forward proxy (the agent's browser, Р21). */
  browserRelays: readonly PreviewRelayRange[]
  store: PreviewAccessStore
  logger?: { warn(message: string): void }
  now?: () => number
}

/** How a request names its preview: by Host, or in absolute form through a relay. */
interface Target {
  hostname: string
  /** Path and query, always starting with one `/`. */
  path: string
  /** The request came in absolute form from a relay of the agent's browser (Р21). */
  relayed: boolean
}

interface Refusal {
  refused: 'not_found' | 'forbidden' | 'bad_request'
}

/** An upgraded websocket and what let it through: checked again while it is open. */
interface Tunnel {
  hostname: string
  relayed: boolean
  /** The Cookie header of the handshake: the session the tunnel was opened under. */
  cookie: string | undefined
  sessionId: string
  upstream: { host: string; port: number }
  end: () => void
}

const cookieHeader = (headers: IncomingHttpHeaders): string | undefined =>
  Array.isArray(headers.cookie) ? headers.cookie.join('; ') : headers.cookie

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

const NO_STORE = { 'cache-control': 'no-store' }
const NO_BODY_STATUSES = new Set([204, 304])

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    ...NO_STORE,
    'content-type': 'application/json',
    'content-length': String(json.byteLength),
  })
  response.end(json)
}

function sendPage(response: ServerResponse, page: GatewayPage, head = false): void {
  response.writeHead(page.status, page.headers)
  response.end(head ? undefined : page.body)
}

function sendStatus(response: ServerResponse, status: number): void {
  response.writeHead(status, { ...NO_STORE, 'content-length': '0' })
  response.end()
}

function redirect(
  response: ServerResponse,
  location: string,
  extra: OutgoingHttpHeaders = {},
): void {
  response.writeHead(303, {
    ...NO_STORE,
    location,
    'referrer-policy': 'no-referrer',
    'content-length': '0',
    ...extra,
  })
  response.end()
}

/** A raw answer on a socket that is no HTTP response any more (upgrade, CONNECT). */
function refuseSocket(socket: Duplex, status: number, reason: string): void {
  socket.on('error', () => undefined)
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function rawHead(status: number, message: string, headers: OutgoingHttpHeaders): string {
  const lines = [`HTTP/1.1 ${status} ${message}`]
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

const sourceAddress = (address: string | undefined): string =>
  (address ?? '').replace(/^::ffff:/, '')

/** Counts a request body on its way to the site and stops it past the limit. */
class BodyLimit extends Transform {
  #received = 0
  private readonly limit: number

  constructor(limit: number) {
    super()
    this.limit = limit
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.#received += chunk.byteLength
    if (this.#received > this.limit) done(new Error('Request body over the limit'))
    else done(null, chunk)
  }
}

/**
 * The gateway of previews, role `preview` (docs/plan/53-chat-preview-release.md, Р19). Plain
 * node:http. The exact Host names the preview; its row names the upstream, nothing a client
 * sends does. A visitor gets in only with a one-time ticket from the cabinet, which becomes the
 * gateway's own cookie; the site never sees that cookie and cannot set one like it, and its
 * pages may be framed by the cabinet alone. The agent's browser comes through a relay in
 * absolute form, with a ticket of its own kind; CONNECT is never served.
 */
export class PreviewGatewayServer {
  #server: Server | undefined
  readonly #options: PreviewGatewayOptions
  readonly #now: () => number
  readonly #pages: PagesContext
  readonly #relays = new BlockList()
  readonly #routes: TtlCache<string, PreviewRoute | null>
  readonly #sessions: TtlCache<string, PreviewSessionRecord | null>
  readonly #rechecks = new Map<string, Promise<boolean>>()
  /** Open websockets: the server does not count them as its connections any more. */
  readonly #tunnels = new Map<Duplex, Tunnel>()
  #tunnelTimer: ReturnType<typeof setInterval> | undefined
  readonly #agent = new Agent({ keepAlive: true, maxSockets: 256 })

  constructor(options: PreviewGatewayOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#pages = { appOrigin: new URL(options.appUrl).origin }
    for (const range of options.browserRelays)
      this.#relays.addSubnet(range.address, range.prefix, range.family)
    const { cacheMs, cacheEntries } = previewGatewayLimits
    this.#routes = new TtlCache(cacheMs, cacheEntries, this.#now)
    this.#sessions = new TtlCache(cacheMs, cacheEntries, this.#now)
  }

  readonly handle = (request: IncomingMessage, response: ServerResponse): void => {
    this.#serve(request, response).catch((error: unknown) => {
      this.#warn('preview_gateway_failed', error)
      if (!response.headersSent) sendPage(response, gatewayPages.unavailable(this.#pages))
      else response.destroy()
    })
  }

  readonly handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => undefined)
    this.#upgrade(request, socket, head).catch((error: unknown) => {
      this.#warn('preview_gateway_upgrade_failed', error)
      refuseSocket(socket, 503, 'Service Unavailable')
    })
  }

  /** CONNECT is never a way to a preview, from anyone (Р21). */
  readonly handleConnect = (_request: IncomingMessage, socket: Duplex): void => {
    refuseSocket(socket, 405, 'Method Not Allowed')
  }

  async listen(port: number, host?: string): Promise<AddressInfo> {
    const server = createServer({ maxHeaderSize: previewGatewayLimits.headerBytes }, this.handle)
    server.headersTimeout = previewGatewayLimits.headersTimeoutMs
    server.requestTimeout = previewGatewayLimits.requestTimeoutMs
    server.on('upgrade', this.handleUpgrade)
    server.on('connect', this.handleConnect)
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
    this.#agent.destroy()
    for (const tunnel of this.#tunnels.values()) tunnel.end()
    this.#tunnels.clear()
    if (!server?.listening) return
    const closed = once(server, 'close')
    server.close()
    server.closeIdleConnections()
    // Long answers and websockets of a preview are not waited for long.
    setTimeout(() => server.closeAllConnections(), 2_000).unref()
    await closed
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
      this.#refuse(response, target, head)
      return
    }
    if (fromSiblingSite(request.headers)) {
      sendStatus(response, 403)
      return
    }
    const route = await this.#route(target.hostname)
    if (route === null) {
      this.#refuse(response, { refused: target.relayed ? 'forbidden' : 'not_found' }, head)
      return
    }
    const pathname = target.path.split('?')[0] ?? '/'
    if (pathname.startsWith(PREVIEW_CONTROL_PREFIX)) {
      await this.#control(request, response, route, target, pathname)
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
    const session = await this.#session(request.headers, route, target.relayed)
    if (session === null) {
      this.#noSession(request, response, route, target)
      return
    }
    if (!this.#serving(response, route, head)) return
    // The cache and storage of the origin belong to the browser and outlive every session: a
    // document of a revision this browser has not got clears them (Р19). The site's answer
    // carries it, so an answer the gateway makes itself (502, 504, 413) never spends the clear.
    const clearForRevision =
      isNavigation(request.headers) &&
      !previewRevisionSeen(cookieHeader(request.headers), route.revision)
        ? route.revision
        : undefined
    this.#proxy(request, response, route, target.path, clearForRevision)
  }

  /** The Host of an origin-form request, or the URL of an absolute-form one from a relay. */
  #target(request: IncomingMessage): Target | Refusal {
    const raw = request.url ?? ''
    const base = this.#options.address.baseDomain
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
      url.origin !== previewOrigin(hostname, this.#options.address)
    )
      return { refused: 'forbidden' }
    return { hostname, path: `${url.pathname}${url.search}`, relayed: true }
  }

  #fromRelay(request: IncomingMessage): boolean {
    const source = sourceAddress(request.socket.remoteAddress)
    const family = isIP(source)
    return family !== 0 && this.#relays.check(source, family === 4 ? 'ipv4' : 'ipv6')
  }

  #refuse(response: ServerResponse, refusal: Refusal, head = false): void {
    if (refusal.refused === 'forbidden') sendStatus(response, 403)
    else if (refusal.refused === 'bad_request') sendStatus(response, 400)
    else sendPage(response, gatewayPages.notFound(this.#pages), head)
  }

  async #control(
    request: IncomingMessage,
    response: ServerResponse,
    route: PreviewRoute,
    target: Target,
    pathname: string,
  ): Promise<void> {
    if (pathname !== previewGatewayPaths.enter && pathname !== previewGatewayPaths.frameTicket) {
      this.#refuse(response, { refused: 'not_found' }, request.method === 'HEAD')
      return
    }
    if (request.method !== 'GET') {
      sendStatus(response, 405)
      return
    }
    const query = new URLSearchParams(target.path.slice(pathname.length + 1))
    if (pathname === previewGatewayPaths.enter)
      await this.#enter(request, response, route, target, query)
    else await this.#frameTicket(request, response, route, target, query)
  }

  /** `/__raditi/enter?t=&to=`: the ticket becomes the cookie, then the page it was for. */
  async #enter(
    request: IncomingMessage,
    response: ServerResponse,
    route: PreviewRoute,
    target: Target,
    query: URLSearchParams,
  ): Promise<void> {
    const tickets = query.getAll('t')
    const destinations = query.getAll('to')
    const ticket = tickets[0] ?? ''
    const to = destinations[0] ?? '/'
    if (
      tickets.length !== 1 ||
      destinations.length > 1 ||
      !previewTicketSchema.safeParse(ticket).success ||
      !isPreviewPath(to)
    ) {
      sendPage(response, gatewayPages.badLink(this.#pages))
      return
    }
    const kind: PreviewSessionKind = target.relayed ? 'browser' : 'user'
    const session = await this.#options.store.enter({
      previewId: route.id,
      tokenHash: previewTicketHash(ticket),
      kind,
    })
    const retrying = hasPreviewRetry(cookieHeader(request.headers))
    if (session === null) {
      if (target.relayed) sendStatus(response, 403)
      // A frame of the cabinet whose ticket went stale (a lazy or a background tab) asks the
      // cabinet for a fresh one, once: a second refusal ends on the page below.
      else if (request.headers['sec-fetch-dest'] === 'iframe' && !retrying)
        redirect(response, this.#frameTicketUrl(route, to), {
          'set-cookie': previewRetrySetCookie(true),
        })
      else sendPage(response, gatewayPages.ticketRefused(this.#pages, this.#openUrl(route, to)))
      return
    }
    this.#sessions.set(session.id, session)
    const cookies = [previewSetCookie(this.#options.sessionSecret, session, route.hostname)]
    if (retrying) cookies.push(previewRetrySetCookie(false))
    // From the row's hostname, never from anything the request named.
    redirect(response, `${this.#origin(route)}${to}`, { 'set-cookie': cookies })
  }

  /** The page in the cabinet's iframe that asks the cabinet for a new ticket. */
  async #frameTicket(
    request: IncomingMessage,
    response: ServerResponse,
    route: PreviewRoute,
    target: Target,
    query: URLSearchParams,
  ): Promise<void> {
    if (target.relayed) {
      sendStatus(response, 403)
      return
    }
    const written = query.get('to') ?? '/'
    const to = isPreviewPath(written) ? written : '/'
    if ((await this.#session(request.headers, route, false)) !== null) {
      redirect(response, `${this.#origin(route)}${to}`)
      return
    }
    sendPage(
      response,
      gatewayPages.frameTicket(this.#pages, { hostname: route.hostname, path: to }),
    )
  }

  #noSession(
    request: IncomingMessage,
    response: ServerResponse,
    route: PreviewRoute,
    target: Target,
  ): void {
    // The agent's browser is never sent anywhere else: no session, no way.
    if (target.relayed) {
      sendStatus(response, 403)
      return
    }
    const to = isPreviewPath(target.path) ? target.path : '/'
    if (request.headers['sec-fetch-dest'] === 'iframe') {
      redirect(response, this.#frameTicketUrl(route, to))
      return
    }
    redirect(response, this.#openUrl(route, to))
  }

  /** The preview runs and its upstream is one the gateway may connect to. */
  #serving(response: ServerResponse, route: PreviewRoute, head: boolean): boolean {
    if (!isPreviewServing(route.status) || route.upstream === null) {
      const preparing = route.status === 'pending' || route.status === 'building'
      sendPage(
        response,
        preparing ? gatewayPages.preparing(this.#pages) : gatewayPages.unavailable(this.#pages),
        head,
      )
      return false
    }
    if (!this.#upstreamAllowed(route.upstream.host)) {
      this.#warn('preview_gateway_upstream_refused', null)
      sendPage(response, gatewayPages.unavailable(this.#pages), head)
      return false
    }
    return true
  }

  /** An IP literal only; in production a private or loopback one (spec §19). */
  #upstreamAllowed(host: string): boolean {
    if (ipLiteral(host) !== host) return false
    return !isProduction(this.#options.appEnv) || isPrivateAddress(host) || isLoopbackAddress(host)
  }

  #proxy(
    request: IncomingMessage,
    response: ServerResponse,
    route: PreviewRoute,
    path: string,
    clearForRevision: number | undefined,
  ): void {
    const upstream = route.upstream!
    const limit = previewGatewayLimits.requestBodyBytes
    const declared = Number(request.headers['content-length'] ?? 0)
    if (!Number.isFinite(declared) || declared > limit) {
      response.setHeader('connection', 'close')
      sendPage(response, gatewayPages.tooLarge(this.#pages))
      return
    }
    // Redirects of the site go back to the browser as they are: the gateway follows nothing.
    const outgoing = httpRequest({
      host: upstream.host,
      port: upstream.port,
      method: request.method,
      path,
      headers: upstreamRequestHeaders(request.headers, this.#forwarded(route)),
      agent: this.#agent,
    })
    let timedOut = false
    outgoing.setTimeout(previewGatewayLimits.upstreamIdleMs, () => {
      timedOut = true
      outgoing.destroy()
    })
    outgoing.on('response', (incoming) => {
      const status = incoming.statusCode ?? 502
      response.writeHead(
        status,
        incoming.statusMessage,
        browserResponseHeaders(incoming.headers, {
          appOrigin: this.#pages.appOrigin,
          clearForRevision,
        }),
      )
      if (request.method === 'HEAD' || NO_BODY_STATUSES.has(status)) {
        incoming.resume()
        response.end()
        return
      }
      pipeline(incoming, response, (error) => {
        if (error) response.destroy()
      })
    })
    outgoing.on('error', () => {
      if (response.headersSent || response.destroyed) {
        response.destroy()
        return
      }
      sendPage(
        response,
        timedOut
          ? gatewayPages.upstreamTimeout(this.#pages)
          : gatewayPages.upstreamFailed(this.#pages),
      )
    })
    // A visitor who went away takes the site's request with them.
    response.on('close', () => {
      if (!response.writableFinished) outgoing.destroy()
    })
    // Past the limit without a declared length the connection is cut: the body cannot be
    // refused politely while it is still arriving.
    pipeline(request, new BodyLimit(limit), outgoing, () => undefined)
  }

  // -------------------------------------------------------------------------------------------
  // WebSockets
  // -------------------------------------------------------------------------------------------

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
    const route = await this.#route(target.hostname)
    if (route === null || target.path.startsWith(PREVIEW_CONTROL_PREFIX)) {
      refuseSocket(socket, 404, 'Not Found')
      return
    }
    const session = await this.#session(request.headers, route, target.relayed)
    if (session === null) {
      refuseSocket(socket, 403, 'Forbidden')
      return
    }
    if (
      !isPreviewServing(route.status) ||
      route.upstream === null ||
      !this.#upstreamAllowed(route.upstream.host)
    ) {
      refuseSocket(socket, 503, 'Service Unavailable')
      return
    }
    // The same upstream as every other request of this host, and nothing else.
    const upstream = route.upstream
    const outgoing = httpRequest({
      host: upstream.host,
      port: upstream.port,
      method: 'GET',
      path: target.path,
      headers: upstreamRequestHeaders(request.headers, {
        ...this.#forwarded(route),
        websocket: true,
      }),
      agent: false,
    })
    outgoing.setTimeout(previewGatewayLimits.upstreamIdleMs, () => outgoing.destroy())
    outgoing.on('upgrade', (incoming, upstreamSocket: Socket, upstreamHead: Buffer) => {
      outgoing.setTimeout(0)
      const headers = browserResponseHeaders(incoming.headers, {
        appOrigin: this.#pages.appOrigin,
      })
      socket.write(
        rawHead(101, 'Switching Protocols', {
          ...headers,
          connection: 'Upgrade',
          upgrade: 'websocket',
        }),
      )
      if (upstreamHead.byteLength > 0) socket.write(upstreamHead)
      if (head.byteLength > 0) upstreamSocket.write(head)
      const end = () => {
        this.#tunnels.delete(socket)
        socket.destroy()
        upstreamSocket.destroy()
      }
      this.#tunnels.set(socket, {
        hostname: route.hostname,
        relayed: target.relayed,
        cookie: cookieHeader(request.headers),
        sessionId: session.id,
        upstream,
        end,
      })
      // Either side ending ends both: the sockets of a server stay half-open otherwise.
      for (const side of [socket, upstreamSocket])
        for (const event of ['error', 'end', 'close']) side.on(event, end)
      upstreamSocket.setTimeout(previewGatewayLimits.websocketIdleMs, end)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    // The site did not switch: its answer goes back as it is, and the connection ends.
    outgoing.on('response', (incoming) => {
      const headers = browserResponseHeaders(incoming.headers, {
        appOrigin: this.#pages.appOrigin,
      })
      delete headers['content-length']
      socket.write(
        rawHead(incoming.statusCode ?? 502, incoming.statusMessage ?? '', {
          ...headers,
          connection: 'close',
        }),
      )
      incoming.pipe(socket)
    })
    outgoing.on('error', () => refuseSocket(socket, 502, 'Bad Gateway'))
    outgoing.end()
  }

  /**
   * Checks every open websocket again, as a request would be (Р19): the preview still serves
   * from the same upstream, and the session the tunnel was opened under is still valid —
   * membership and the site included. A tunnel that fails, or that cannot be checked, is closed.
   * The timer of listen() calls it; tests call it directly.
   */
  async recheckTunnels(): Promise<void> {
    await Promise.all(
      [...this.#tunnels.values()].map(async (tunnel) => {
        let allowed = false
        try {
          allowed = await this.#tunnelAllowed(tunnel)
        } catch (error) {
          this.#warn('preview_gateway_tunnel_check_failed', error)
        }
        if (!allowed) tunnel.end()
      }),
    )
  }

  async #tunnelAllowed(tunnel: Tunnel): Promise<boolean> {
    const route = await this.#route(tunnel.hostname)
    if (
      route === null ||
      !isPreviewServing(route.status) ||
      route.upstream?.host !== tunnel.upstream.host ||
      route.upstream.port !== tunnel.upstream.port
    )
      return false
    const session = await this.#session({ cookie: tunnel.cookie }, route, tunnel.relayed)
    return session?.id === tunnel.sessionId
  }

  // -------------------------------------------------------------------------------------------
  // Previews and sessions
  // -------------------------------------------------------------------------------------------

  async #route(hostname: string): Promise<PreviewRoute | null> {
    const cached = this.#routes.get(hostname)
    if (cached !== undefined) return cached
    const route = await this.#options.store.route(hostname)
    this.#routes.set(hostname, route)
    return route
  }

  /**
   * The session of a request on this preview: a cookie whose MAC matches its row, a row that is
   * neither revoked nor expired, of the preview's current access epoch, of the kind this way
   * in takes, and whose membership and site were checked within the last minute.
   */
  async #session(
    headers: IncomingHttpHeaders,
    route: PreviewRoute,
    relayed: boolean,
  ): Promise<PreviewSessionRecord | null> {
    for (const claim of previewCookieClaims(cookieHeader(headers))) {
      const session = await this.#sessionRecord(claim.sessionId)
      if (
        session === null ||
        session.previewId !== route.id ||
        !verifyPreviewCookie(this.#options.sessionSecret, claim, session, route.hostname) ||
        session.revokedAt !== null ||
        session.expiresAt.getTime() <= this.#now() ||
        session.accessEpoch !== route.accessEpoch ||
        session.kind !== (relayed ? 'browser' : 'user')
      )
        continue
      if (await this.#fresh(session)) return session
    }
    return null
  }

  async #sessionRecord(id: string): Promise<PreviewSessionRecord | null> {
    const cached = this.#sessions.get(id)
    if (cached !== undefined) return cached
    const session = await this.#options.store.session(id)
    this.#sessions.set(id, session)
    return session
  }

  /** Membership and the site, checked again at most a minute ago (Р19). */
  async #fresh(session: PreviewSessionRecord): Promise<boolean> {
    const checked = session.checkedAt?.getTime()
    if (
      checked !== undefined &&
      this.#now() - checked < previewTimings.membershipCheckSeconds * 1_000
    )
      return true
    let running = this.#rechecks.get(session.id)
    if (running === undefined) {
      running = this.#options.store
        .recheck(session.id)
        .then((result) => {
          if (result === null) {
            this.#sessions.set(session.id, { ...session, revokedAt: new Date(this.#now()) })
            return false
          }
          this.#sessions.update(session.id, (record) =>
            record === null ? record : { ...record, checkedAt: result.checkedAt },
          )
          return true
        })
        .finally(() => this.#rechecks.delete(session.id))
      this.#rechecks.set(session.id, running)
    }
    return running
  }

  // -------------------------------------------------------------------------------------------

  #origin(route: PreviewRoute): string {
    return previewOrigin(route.hostname, this.#options.address)
  }

  #forwarded(route: PreviewRoute) {
    return {
      originHost: new URL(this.#origin(route)).host,
      scheme: this.#options.address.scheme,
    }
  }

  /** The cabinet's page that issues a ticket for this preview and path. */
  #openUrl(route: PreviewRoute, path: string): string {
    return previewOpenUrl(this.#pages.appOrigin, route.hostname, path)
  }

  /** The page of this preview that asks the cabinet's frame for a fresh ticket. */
  #frameTicketUrl(route: PreviewRoute, path: string): string {
    return `${this.#origin(route)}${previewGatewayPaths.frameTicket}?${new URLSearchParams({ to: path })}`
  }

  #warn(event: string, error: unknown): void {
    // The name of an error only: a message may carry a host, a path or a value.
    const reason = error instanceof Error ? error.name : undefined
    this.#options.logger?.warn(JSON.stringify({ event, ...(reason ? { reason } : {}) }))
  }
}
