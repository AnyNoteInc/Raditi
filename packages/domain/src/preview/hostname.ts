import { z } from 'zod'

import { badRequest } from '../errors.ts'
import { isAlias } from './alias.ts'

/**
 * The address of a preview and the way in (docs/plan/53-chat-preview-release.md, Р17, Р19):
 * `site-<siteAlias>-chat-<taskAlias>.<PREVIEW_BASE_DOMAIN>`. The gateway of the `preview` role
 * finds the upstream by this exact host and nothing else; whoever builds or reads an address
 * goes through these functions, so the two never disagree.
 */
export const previewSchemes = ['http', 'https'] as const
export type PreviewScheme = (typeof previewSchemes)[number]

/** Where a preview is served: the base domain, the scheme and the public port (null — the scheme's own). */
export interface PreviewAddress {
  baseDomain: string
  scheme: PreviewScheme
  publicPort: number | null
}

export interface PreviewHostParts {
  siteAlias: string
  taskAlias: string
}

const SITE_PREFIX = 'site-'
const CHAT_INFIX = '-chat-'
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** The longest preview label: `site-` + 12 + `-chat-` + 12. */
const MAX_PREVIEW_LABEL = SITE_PREFIX.length + 12 + CHAT_INFIX.length + 12
const MAX_HOSTNAME = 253

/**
 * A base domain: lower-case DNS labels, no port, no trailing dot, a letter in the last label
 * (an IP address is never a base). `localhost` is one, for `http://…localhost:8090` in dev.
 */
export function isPreviewBaseDomain(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HOSTNAME - MAX_PREVIEW_LABEL - 1) return false
  const labels = value.split('.')
  return labels.every((label) => LABEL.test(label)) && /[a-z]/.test(labels.at(-1) ?? '')
}

export const previewBaseDomainSchema = z
  .string()
  .refine(isPreviewBaseDomain, 'expected a lower-case domain name without a port')

/** The one spelling of a preview host. Throws on an alias or a base it would not parse back. */
export function previewHostname(parts: PreviewHostParts, baseDomain: string): string {
  if (!isAlias(parts.siteAlias) || !isAlias(parts.taskAlias) || !isPreviewBaseDomain(baseDomain))
    throw badRequest('Invalid preview address')
  return `${SITE_PREFIX}${parts.siteAlias}${CHAT_INFIX}${parts.taskAlias}.${baseDomain}`
}

/**
 * The aliases of a host, or null when it is not exactly a preview host of this base: another
 * base, an extra label, a port, upper case or a trailing dot are refused, not repaired. The
 * gateway lower-cases nothing — a browser sends the host as the address spelled it.
 */
export function parsePreviewHostname(
  hostname: string,
  baseDomain: string,
): PreviewHostParts | null {
  if (!isPreviewBaseDomain(baseDomain) || hostname.length > MAX_HOSTNAME) return null
  const suffix = `.${baseDomain}`
  if (!hostname.endsWith(suffix)) return null
  const label = hostname.slice(0, -suffix.length)
  if (!label.startsWith(SITE_PREFIX)) return null
  const rest = label.slice(SITE_PREFIX.length)
  // Aliases have no hyphen, so the infix splits the label in one way only.
  const at = rest.indexOf(CHAT_INFIX)
  if (at < 0) return null
  const siteAlias = rest.slice(0, at)
  const taskAlias = rest.slice(at + CHAT_INFIX.length)
  return isAlias(siteAlias) && isAlias(taskAlias) ? { siteAlias, taskAlias } : null
}

const defaultPorts: Record<PreviewScheme, number> = { http: 80, https: 443 }

/** `scheme://host[:port]`: the port only when it is not the scheme's own. */
export function previewOrigin(
  hostname: string,
  address: Omit<PreviewAddress, 'baseDomain'>,
): string {
  const port =
    address.publicPort === null || address.publicPort === defaultPorts[address.scheme]
      ? ''
      : `:${address.publicPort}`
  return `${address.scheme}://${hostname}${port}`
}

// ---------------------------------------------------------------------------------------------
// The way in: a one-time ticket, then a session cookie of the gateway
// ---------------------------------------------------------------------------------------------

/** Paths the gateway answers itself; everything else goes to the upstream of the host. */
export const PREVIEW_CONTROL_PREFIX = '/__raditi/'
export const previewGatewayPaths = Object.freeze({
  /** `?t=<ticket>&to=<path>`: exchanges the ticket for the session cookie. */
  enter: '/__raditi/enter',
  /** The page inside the iframe that asks its parent for a new ticket over postMessage. */
  frameTicket: '/__raditi/frame-ticket',
  health: '/__raditi/health',
})

/** Host-only, Secure, Partitioned: the cabinet's cookies never reach a preview and back. */
export const PREVIEW_SESSION_COOKIE = '__Host-raditi-preview'

export const previewTimings = Object.freeze({
  /** A ticket lives this long and opens one session. */
  ticketSeconds: 60,
  /** Membership and the site status are checked again at least this often. */
  membershipCheckSeconds: 60,
  /** A browser of the agent with no action this long is stopped. */
  browserIdleMinutes: 15,
})

/** 32 random bytes in base64url; the database keeps only the SHA-256 of it. */
export const previewTicketSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const previewPathLimit = 2048
// Printable ASCII but a backslash: a browser reads `\` as `/`, which would make `/\host` a host.
const PATH = /^\/(?!\/)[\x21-\x5b\x5d-\x7e]*$/

/**
 * Where the gateway sends a viewer after the ticket: a path of the same host with exactly one
 * leading `/` (and an optional query), never an origin, `//host` or a fragment. The redirect is
 * built from the hostname of the preview row, not from this value.
 */
export function isPreviewPath(path: string): boolean {
  return path.length <= previewPathLimit && PATH.test(path) && !path.includes('#')
}

/** The ticket URL of a preview: what an iframe `src` and «Открыть в новой вкладке» open. */
export function previewEnterUrl(origin: string, ticket: string, to = '/'): string {
  if (!previewTicketSchema.safeParse(ticket).success || !isPreviewPath(to))
    throw badRequest('Invalid preview entry')
  return `${origin}${previewGatewayPaths.enter}?t=${ticket}&to=${encodeURIComponent(to)}`
}

/** The cabinet's route that issues a fresh ticket for a preview and a path (apps/web, Р19). */
export const PREVIEW_OPEN_PATH = '/preview/open'

/**
 * `<APP_URL origin>/preview/open?host=…&path=…`: where the gateway sends a visitor whose
 * session ended outside the cabinet's iframe, and what «Открыть в новой вкладке» opens. A path
 * the gateway would not send a viewer to becomes `/`.
 */
export function previewOpenUrl(appUrl: string, hostname: string, path = '/'): string {
  const query = new URLSearchParams({ host: hostname, path: isPreviewPath(path) ? path : '/' })
  return `${new URL(appUrl).origin}${PREVIEW_OPEN_PATH}?${query.toString()}`
}
