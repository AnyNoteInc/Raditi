import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { PREVIEW_SESSION_COOKIE } from '@repo/domain'

/**
 * The session cookie of the preview gateway (docs/plan/53-chat-preview-release.md, Р19):
 * `<sessionId>.<HMAC-SHA256(PREVIEW_SESSION_SECRET, sessionId|hostname|expiresAtMs)>`. The MAC
 * binds the session to the exact host and to the expiry its row holds, so a cookie copied to
 * another preview or kept past its row's end opens nothing; the row decides everything else.
 */

/** Its attributes, always: Secure works on http://*.localhost too, which browsers trust. */
export const PREVIEW_COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=None; Partitioned; Path=/'

/** Anything that looks like the gateway's cookie: never set by the site, never sent to it. */
export const isGatewayCookieName = (name: string): boolean => /raditi-preview/i.test(name)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAC = /^[A-Za-z0-9_-]{43}$/

/** The column `preview_tickets.token_hash`: SHA-256 of the ticket text, lower-case hex. */
export function previewTicketHash(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex')
}

function mac(secret: string, sessionId: string, hostname: string, expiresAt: Date): Buffer {
  return createHmac('sha256', secret)
    .update(`${sessionId}|${hostname}|${expiresAt.getTime()}`, 'utf8')
    .digest()
}

/** The value of the cookie for a session row. */
export function previewCookieValue(
  secret: string,
  session: { id: string; expiresAt: Date },
  hostname: string,
): string {
  return `${session.id}.${mac(secret, session.id, hostname, session.expiresAt).toString('base64url')}`
}

/** The whole `Set-Cookie` of a new session. */
export function previewSetCookie(
  secret: string,
  session: { id: string; expiresAt: Date },
  hostname: string,
): string {
  return `${PREVIEW_SESSION_COOKIE}=${previewCookieValue(secret, session, hostname)}; ${PREVIEW_COOKIE_ATTRIBUTES}`
}

export interface PreviewCookieClaim {
  sessionId: string
  /** Checked by verifyPreviewCookie once the row (and its expiry) is known. */
  mac: Buffer
}

/** The well-formed values of the gateway cookie in a Cookie header, in order (JS may add more). */
export function previewCookieClaims(cookieHeader: string | undefined): PreviewCookieClaim[] {
  const claims: PreviewCookieClaim[] = []
  for (const pair of (cookieHeader ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at < 0 || pair.slice(0, at).trim() !== PREVIEW_SESSION_COOKIE) continue
    const [sessionId = '', signature = '', ...rest] = pair
      .slice(at + 1)
      .trim()
      .split('.')
    if (rest.length === 0 && UUID.test(sessionId) && MAC.test(signature))
      claims.push({ sessionId, mac: Buffer.from(signature, 'base64url') })
  }
  return claims.slice(0, 4)
}

/** Whether the MAC of a claim matches its session row on this host. */
export function verifyPreviewCookie(
  secret: string,
  claim: PreviewCookieClaim,
  session: { id: string; expiresAt: Date },
  hostname: string,
): boolean {
  if (claim.sessionId !== session.id) return false
  const expected = mac(secret, session.id, hostname, session.expiresAt)
  return claim.mac.byteLength === expected.byteLength && timingSafeEqual(claim.mac, expected)
}

/**
 * The revision of the preview this browser last got (Р19). It belongs to the browser, not to a
 * session: the cache and storage of a preview's origin outlive every session, and every frame
 * of the cabinet opens a new one (Р20). Not a secret — a script of the site that forges it only
 * keeps its own stale cache.
 */
export const PREVIEW_REVISION_COOKIE = '__Host-raditi-preview-rev'

/**
 * Set while a refused ticket inside the cabinet's frame is being replaced by a fresh one: the
 * replacement is asked for once, never in a loop.
 */
export const PREVIEW_RETRY_COOKIE = '__Host-raditi-preview-retry'

/** Longer than any preview lives (PREVIEW_TTL_HOURS is at most 720). */
const REVISION_COOKIE_SECONDS = 31 * 24 * 3_600
const RETRY_COOKIE_SECONDS = 60

/** The values of one cookie in a Cookie header, in order. */
export function cookieValues(cookieHeader: string | undefined, name: string): string[] {
  const values: string[] = []
  for (const pair of (cookieHeader ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at >= 0 && pair.slice(0, at).trim() === name) values.push(pair.slice(at + 1).trim())
  }
  return values
}

/** Whether this browser already got this revision of the preview. */
export function previewRevisionSeen(cookieHeader: string | undefined, revision: number): boolean {
  return cookieValues(cookieHeader, PREVIEW_REVISION_COOKIE).includes(String(revision))
}

export function previewRevisionSetCookie(revision: number): string {
  return `${PREVIEW_REVISION_COOKIE}=${revision}; Max-Age=${REVISION_COOKIE_SECONDS}; ${PREVIEW_COOKIE_ATTRIBUTES}`
}

export const hasPreviewRetry = (cookieHeader: string | undefined): boolean =>
  cookieValues(cookieHeader, PREVIEW_RETRY_COOKIE).length > 0

/** Starts (true) or ends (false) the one replacement of a refused ticket. */
export function previewRetrySetCookie(on: boolean): string {
  return `${PREVIEW_RETRY_COOKIE}=${on ? '1' : ''}; Max-Age=${on ? RETRY_COOKIE_SECONDS : 0}; ${PREVIEW_COOKIE_ATTRIBUTES}`
}

/**
 * The Cookie header the site gets: every cookie but the gateway's (and its look-alikes).
 * undefined — nothing is left, the header is not sent.
 */
export function cookiesForUpstream(cookieHeader: string | undefined): string | undefined {
  const kept = (cookieHeader ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (pair === '') return false
      const at = pair.indexOf('=')
      return !isGatewayCookieName(at < 0 ? pair : pair.slice(0, at))
    })
  return kept.length > 0 ? kept.join('; ') : undefined
}
