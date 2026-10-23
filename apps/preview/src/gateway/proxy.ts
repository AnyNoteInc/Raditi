import type { Buffer } from 'node:buffer'
import { Agent, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { pipeline, Transform, type TransformCallback } from 'node:stream'

import { Inject, Injectable } from '@nestjs/common'
import {
  isPreviewServing,
  isProduction,
  previewOrigin,
  type AppEnv,
  type PreviewAddress,
} from '@repo/domain'
import { ipLiteral, isLoopbackAddress, isPrivateAddress } from '@repo/ip-address'

import type { PreviewRoute } from '../access/preview-access.ts'
import { PREVIEW_CONFIG, type PreviewGatewayConfig } from '../config/config.tokens.ts'
import { browserResponseHeaders, upstreamRequestHeaders } from './headers.ts'
import { previewGatewayLimits } from './limits.ts'
import { gatewayPages, type PagesContext } from './pages.ts'
import { pagesContext, sendPage, warn } from './replies.ts'

const NO_BODY_STATUSES = new Set([204, 304])

/** An IP literal only; in production a private or loopback one (spec §19). */
export function upstreamAllowed(host: string, appEnv: AppEnv): boolean {
  if (ipLiteral(host) !== host) return false
  return !isProduction(appEnv) || isPrivateAddress(host) || isLoopbackAddress(host)
}

/** What the site is told of the origin the browser asked for. */
export function forwardedOf(route: PreviewRoute, address: PreviewAddress) {
  return {
    originHost: new URL(previewOrigin(route.hostname, address)).host,
    scheme: address.scheme,
  }
}

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
 * A request of a visitor or of the agent's browser to the site of its preview: the upstream of
 * the row only, over a keep-alive pool that PreviewGatewayServer.close() ends.
 */
@Injectable()
export class PreviewProxy {
  readonly #config: PreviewGatewayConfig
  readonly #pages: PagesContext
  readonly #agent = new Agent({ keepAlive: true, maxSockets: 256 })

  constructor(@Inject(PREVIEW_CONFIG) config: PreviewGatewayConfig) {
    this.#config = config
    this.#pages = pagesContext(config.appUrl)
  }

  /** The preview runs and its upstream is one the gateway may connect to. */
  serving(response: ServerResponse, route: PreviewRoute, head: boolean): boolean {
    if (!isPreviewServing(route.status) || route.upstream === null) {
      const preparing = route.status === 'pending' || route.status === 'building'
      sendPage(
        response,
        preparing ? gatewayPages.preparing(this.#pages) : gatewayPages.unavailable(this.#pages),
        head,
      )
      return false
    }
    if (!upstreamAllowed(route.upstream.host, this.#config.appEnv)) {
      warn('preview_gateway_upstream_refused', null)
      sendPage(response, gatewayPages.unavailable(this.#pages), head)
      return false
    }
    return true
  }

  proxy(
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
      headers: upstreamRequestHeaders(request.headers, forwardedOf(route, this.#config.address)),
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

  /** Ends the pooled connections to the sites: a step of PreviewGatewayServer.close(). */
  stop(): void {
    this.#agent.destroy()
  }
}
