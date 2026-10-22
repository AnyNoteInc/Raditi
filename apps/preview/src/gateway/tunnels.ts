import type { Buffer } from 'node:buffer'
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import { Inject, Injectable } from '@nestjs/common'
import { isPreviewServing, PREVIEW_CONTROL_PREFIX } from '@repo/domain'

import { PreviewSessions } from '../access/preview-sessions.ts'
import { PREVIEW_CONFIG } from '../config/config.tokens.ts'
import type { PreviewGatewayConfig } from '../config/config.ts'
import { browserResponseHeaders, upstreamRequestHeaders } from './headers.ts'
import { previewGatewayLimits } from './limits.ts'
import type { PagesContext } from './pages.ts'
import { forwardedOf, upstreamAllowed } from './proxy.ts'
import { cookieHeader, pagesContext, refuseSocket, warn, type Target } from './replies.ts'

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

function rawHead(status: number, message: string, headers: OutgoingHttpHeaders): string {
  const lines = [`HTTP/1.1 ${status} ${message}`]
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * The websockets of previews: a handshake under a session goes on as a tunnel to the same
 * upstream as every other request of its host, and every open tunnel is checked again as a
 * request would be. PreviewGatewayServer.close() ends them.
 */
@Injectable()
export class PreviewTunnels {
  readonly #config: PreviewGatewayConfig
  readonly #sessions: PreviewSessions
  readonly #pages: PagesContext
  /** Open websockets: the server does not count them as its connections any more. */
  readonly #tunnels = new Map<Duplex, Tunnel>()

  constructor(
    @Inject(PREVIEW_CONFIG) config: PreviewGatewayConfig,
    @Inject(PreviewSessions) sessions: PreviewSessions,
  ) {
    this.#config = config
    this.#sessions = sessions
    this.#pages = pagesContext(config.appUrl)
  }

  /** The upgrade of a websocket handshake the server took: its target, from no sibling site. */
  async open(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: Target,
  ): Promise<void> {
    const route = await this.#sessions.route(target.hostname)
    if (route === null || target.path.startsWith(PREVIEW_CONTROL_PREFIX)) {
      refuseSocket(socket, 404, 'Not Found')
      return
    }
    const session = await this.#sessions.session(
      cookieHeader(request.headers),
      route,
      target.relayed,
    )
    if (session === null) {
      refuseSocket(socket, 403, 'Forbidden')
      return
    }
    if (
      !isPreviewServing(route.status) ||
      route.upstream === null ||
      !upstreamAllowed(route.upstream.host, this.#config.appEnv)
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
        ...forwardedOf(route, this.#config.address),
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
   */
  async recheck(): Promise<void> {
    await Promise.all(
      [...this.#tunnels.values()].map(async (tunnel) => {
        let allowed = false
        try {
          allowed = await this.#allowed(tunnel)
        } catch (error) {
          warn('preview_gateway_tunnel_check_failed', error)
        }
        if (!allowed) tunnel.end()
      }),
    )
  }

  /** Ends every open websocket: a step of PreviewGatewayServer.close(). */
  endAll(): void {
    for (const tunnel of this.#tunnels.values()) tunnel.end()
    this.#tunnels.clear()
  }

  async #allowed(tunnel: Tunnel): Promise<boolean> {
    const route = await this.#sessions.route(tunnel.hostname)
    if (
      route === null ||
      !isPreviewServing(route.status) ||
      route.upstream?.host !== tunnel.upstream.host ||
      route.upstream.port !== tunnel.upstream.port
    )
      return false
    const session = await this.#sessions.session(tunnel.cookie, route, tunnel.relayed)
    return session?.id === tunnel.sessionId
  }
}
