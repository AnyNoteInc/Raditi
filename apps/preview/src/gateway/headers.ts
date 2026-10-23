import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'

import {
  cookiesForUpstream,
  isGatewayCookieName,
  previewRevisionSetCookie,
} from '../cookie/preview-cookie.ts'

/**
 * Headers across the gateway of previews (docs/plan/53-chat-preview-release.md, Р19). Towards
 * the site: no gateway cookie, no forwarding header a client chose, the preview's own origin.
 * Towards the browser: framed only by the cabinet, no cookie that could pass for the
 * gateway's or reach another host, never indexed.
 */

/** Hop-by-hop: they describe one connection and never cross the gateway (RFC 9110, 7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Request headers a client may not choose for the site: the gateway sets its own. */
const CLIENT_FORWARDING = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-prefix',
  'x-forwarded-server',
  'x-real-ip',
  'host',
  'cookie',
  // The gateway answers 100-continue itself; the site gets the whole body.
  'expect',
])

/**
 * Response headers of the site the gateway drops: framing is the gateway's to decide, the
 * transport policy is the platform's, and nothing of the site may wipe the gateway's cookie
 * or widen a service worker.
 */
const SITE_RESPONSE_DROPPED = new Set([
  'x-frame-options',
  'strict-transport-security',
  'alt-svc',
  'clear-site-data',
  'service-worker-allowed',
  'x-robots-tag',
])

/** The names a Connection header lists are hop-by-hop too. */
function connectionTokens(value: string | string[] | undefined): Set<string> {
  const list = Array.isArray(value) ? value.join(',') : (value ?? '')
  return new Set(
    list
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  )
}

export interface UpstreamRequestContext {
  /** host[:port] of the preview's public origin. */
  originHost: string
  /** http or https: what the visitor's browser used. */
  scheme: string
  /** Upgrade: websocket — the two hop-by-hop headers of the handshake pass. */
  websocket?: boolean
}

/** The headers the site gets for one request of a visitor. */
export function upstreamRequestHeaders(
  incoming: IncomingHttpHeaders,
  context: UpstreamRequestContext,
): OutgoingHttpHeaders {
  const listed = connectionTokens(incoming.connection)
  const headers: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name) || listed.has(name) || CLIENT_FORWARDING.has(name)) continue
    headers[name] = value
  }
  const cookie = cookiesForUpstream(
    Array.isArray(incoming.cookie) ? incoming.cookie.join('; ') : incoming.cookie,
  )
  if (cookie !== undefined) headers.cookie = cookie
  headers.host = context.originHost
  headers['x-forwarded-host'] = context.originHost
  headers['x-forwarded-proto'] = context.scheme
  if (context.websocket) {
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
  }
  return headers
}

/**
 * A policy without its `frame-ancestors` directive; null — nothing is left of it. A header that
 * joined several policies with commas keeps each.
 */
export function withoutFrameAncestors(policy: string): string | null {
  const policies = policy
    .split(',')
    .map((one) =>
      one
        .split(';')
        .map((directive) => directive.trim())
        .filter((directive) => directive !== '' && !/^frame-ancestors(\s|$)/i.test(directive))
        .join('; '),
    )
    .filter((one) => one !== '')
  return policies.length > 0 ? policies.join(', ') : null
}

/** A Set-Cookie of the site without Domain; null — it names the gateway's cookie. */
export function siteSetCookie(line: string): string | null {
  const [pair = '', ...attributes] = line.split(';')
  const at = pair.indexOf('=')
  const name = (at < 0 ? pair : pair.slice(0, at)).trim()
  if (name === '' || isGatewayCookieName(name)) return null
  const kept = attributes.filter((attribute) => !/^\s*domain\s*(=|$)/i.test(attribute))
  return [pair, ...kept].join(';')
}

export interface ResponseRewriteContext {
  /** The cabinet's origin: the one ancestor that may frame a preview. */
  appOrigin: string
  /**
   * A revision this browser has not got yet: the answer clears the origin's cache and storage
   * and records the revision in the gateway's own cookie, so the clear comes once (Р19).
   */
  clearForRevision?: number
}

/** The headers the browser gets for one answer of the site. */
export function browserResponseHeaders(
  incoming: IncomingHttpHeaders,
  context: ResponseRewriteContext,
): OutgoingHttpHeaders {
  const listed = connectionTokens(incoming.connection)
  // Keyed by plain strings: Node types a few known headers as a single string.
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name) || listed.has(name) || SITE_RESPONSE_DROPPED.has(name)) continue
    if (name === 'set-cookie') {
      const cookies = (Array.isArray(value) ? value : [value])
        .map(siteSetCookie)
        .filter((cookie): cookie is string => cookie !== null)
      if (cookies.length > 0) headers['set-cookie'] = cookies
      continue
    }
    if (name === 'content-security-policy' || name === 'content-security-policy-report-only') {
      const kept = (Array.isArray(value) ? value : [value])
        .map(withoutFrameAncestors)
        .filter((policy): policy is string => policy !== null)
      if (kept.length > 0) headers[name] = kept
      continue
    }
    headers[name] = value
  }
  const own = `frame-ancestors ${context.appOrigin}`
  const policies = headers['content-security-policy']
  headers['content-security-policy'] = Array.isArray(policies) ? [...policies, own] : [own]
  headers['x-robots-tag'] = 'noindex, nofollow'
  if (context.clearForRevision !== undefined) {
    headers['clear-site-data'] = '"cache", "storage"'
    const cookies = headers['set-cookie']
    const own = previewRevisionSetCookie(context.clearForRevision)
    headers['set-cookie'] = Array.isArray(cookies) ? [...cookies, own] : [own]
  }
  return headers as OutgoingHttpHeaders
}

/** `Service-Worker: script`: a registration the gateway refuses (Р19). */
export const isServiceWorkerScript = (headers: IncomingHttpHeaders): boolean =>
  String(headers['service-worker'] ?? '')
    .trim()
    .toLowerCase() === 'script'
