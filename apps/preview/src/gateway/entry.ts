import type { IncomingMessage, ServerResponse } from 'node:http'

import { Inject, Injectable } from '@nestjs/common'
import {
  isPreviewPath,
  previewGatewayPaths,
  previewOpenUrl,
  previewOrigin,
  previewTicketSchema,
  type PreviewSessionKind,
} from '@repo/domain'

import type { PreviewRoute } from '../access/preview-access.ts'
import { PreviewSessions } from '../access/preview-sessions.ts'
import { PREVIEW_CONFIG } from '../config/config.tokens.ts'
import type { PreviewGatewayConfig } from '../config/config.ts'
import {
  hasPreviewRetry,
  previewRetrySetCookie,
  previewSetCookie,
  previewTicketHash,
} from '../cookie/preview-cookie.ts'
import { gatewayPages, type PagesContext } from './pages.ts'
import {
  cookieHeader,
  pagesContext,
  redirect,
  refuse,
  sendPage,
  sendStatus,
  type Target,
} from './replies.ts'

/**
 * The ways into a preview (Р19, Р21): a one-time ticket of the cabinet becomes the gateway's
 * cookie on `/__raditi/enter`; a visitor without a session goes to the cabinet for one, a frame
 * of the cabinet asks it for a fresh ticket; the agent's browser is never sent anywhere.
 */
@Injectable()
export class PreviewEntry {
  readonly #config: PreviewGatewayConfig
  readonly #sessions: PreviewSessions
  readonly #pages: PagesContext

  constructor(
    @Inject(PREVIEW_CONFIG) config: PreviewGatewayConfig,
    @Inject(PreviewSessions) sessions: PreviewSessions,
  ) {
    this.#config = config
    this.#sessions = sessions
    this.#pages = pagesContext(config.appUrl)
  }

  /** A path under `/__raditi/` of a preview's host. */
  async control(
    request: IncomingMessage,
    response: ServerResponse,
    route: PreviewRoute,
    target: Target,
    pathname: string,
  ): Promise<void> {
    if (pathname !== previewGatewayPaths.enter && pathname !== previewGatewayPaths.frameTicket) {
      refuse(response, { refused: 'not_found' }, this.#pages, request.method === 'HEAD')
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

  noSession(
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
    const session = await this.#sessions.enter({
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
    const cookies = [previewSetCookie(this.#config.sessionSecret, session, route.hostname)]
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
    if ((await this.#sessions.session(cookieHeader(request.headers), route, false)) !== null) {
      redirect(response, `${this.#origin(route)}${to}`)
      return
    }
    sendPage(
      response,
      gatewayPages.frameTicket(this.#pages, { hostname: route.hostname, path: to }),
    )
  }

  #origin(route: PreviewRoute): string {
    return previewOrigin(route.hostname, this.#config.address)
  }

  /** The cabinet's page that issues a ticket for this preview and path. */
  #openUrl(route: PreviewRoute, path: string): string {
    return previewOpenUrl(this.#pages.appOrigin, route.hostname, path)
  }

  /** The page of this preview that asks the cabinet's frame for a fresh ticket. */
  #frameTicketUrl(route: PreviewRoute, path: string): string {
    return `${this.#origin(route)}${previewGatewayPaths.frameTicket}?${new URLSearchParams({ to: path })}`
  }
}
