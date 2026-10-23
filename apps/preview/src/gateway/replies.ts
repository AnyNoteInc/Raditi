import { Buffer } from 'node:buffer'
import type { IncomingHttpHeaders, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import { Logger } from '@nestjs/common'

import { gatewayPages, type GatewayPage, type PagesContext } from './pages.ts'

/** How a request names its preview: by Host, or in absolute form through a relay. */
export interface Target {
  hostname: string
  /** Path and query, always starting with one `/`. */
  path: string
  /** The request came in absolute form from a relay of the agent's browser (Р21). */
  relayed: boolean
}

export interface Refusal {
  refused: 'not_found' | 'forbidden' | 'bad_request'
}

/** The pages of the gateway are framed by the cabinet of APP_URL alone. */
export const pagesContext = (appUrl: string): PagesContext => ({
  appOrigin: new URL(appUrl).origin,
})

export const cookieHeader = (headers: IncomingHttpHeaders): string | undefined =>
  Array.isArray(headers.cookie) ? headers.cookie.join('; ') : headers.cookie

const NO_STORE = { 'cache-control': 'no-store' }

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    ...NO_STORE,
    'content-type': 'application/json',
    'content-length': String(json.byteLength),
  })
  response.end(json)
}

export function sendPage(response: ServerResponse, page: GatewayPage, head = false): void {
  response.writeHead(page.status, page.headers)
  response.end(head ? undefined : page.body)
}

export function sendStatus(response: ServerResponse, status: number): void {
  response.writeHead(status, { ...NO_STORE, 'content-length': '0' })
  response.end()
}

export function redirect(
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

export function refuse(
  response: ServerResponse,
  refusal: Refusal,
  pages: PagesContext,
  head = false,
): void {
  if (refusal.refused === 'forbidden') sendStatus(response, 403)
  else if (refusal.refused === 'bad_request') sendStatus(response, 400)
  else sendPage(response, gatewayPages.notFound(pages), head)
}

/** A raw answer on a socket that is no HTTP response any more (upgrade, CONNECT). */
export function refuseSocket(socket: Duplex, status: number, reason: string): void {
  socket.on('error', () => undefined)
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

const logger = new Logger('PreviewGateway')

/** A warning of the gateway: one JSON line, its event and the name of the error, if any. */
export function warn(event: string, error: unknown): void {
  // The name of an error only: a message may carry a host, a path or a value.
  const reason = error instanceof Error ? error.name : undefined
  logger.warn(JSON.stringify({ event, ...(reason ? { reason } : {}) }))
}
