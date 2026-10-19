import { createHash } from 'node:crypto'

import { PREVIEW_SESSION_COOKIE } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  cookiesForUpstream,
  cookieValues,
  hasPreviewRetry,
  isGatewayCookieName,
  PREVIEW_RETRY_COOKIE,
  PREVIEW_REVISION_COOKIE,
  previewCookieClaims,
  previewCookieValue,
  previewRetrySetCookie,
  previewRevisionSeen,
  previewRevisionSetCookie,
  previewSetCookie,
  previewTicketHash,
  verifyPreviewCookie,
} from './preview-cookie.ts'

const secret = 'a'.repeat(48)
const session = {
  id: '01960000-0000-7000-8000-000000000001',
  expiresAt: new Date(1_800_000_000_123),
}
const host = 'site-abcd1234-chat-ef5678.localhost'

const claimOf = (value: string) =>
  previewCookieClaims(`${PREVIEW_SESSION_COOKIE}=${value}`)[0] ?? null

describe('the gateway cookie', () => {
  it('is set host-only, Secure, HttpOnly, SameSite=None and Partitioned — always', () => {
    const header = previewSetCookie(secret, session, host)
    expect(header).toMatch(
      /^__Host-raditi-preview=01960000-0000-7000-8000-000000000001\.[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=None; Partitioned; Path=\/$/,
    )
    expect(header).not.toMatch(/Domain|Max-Age|Expires/i)
  })

  it('verifies against the row it names, on the host it was given for', () => {
    const claim = claimOf(previewCookieValue(secret, session, host))!
    expect(verifyPreviewCookie(secret, claim, session, host)).toBe(true)
    // Another preview, another expiry, another secret: nothing opens.
    expect(verifyPreviewCookie(secret, claim, session, 'site-abcd1234-chat-000000.localhost')).toBe(
      false,
    )
    expect(
      verifyPreviewCookie(
        secret,
        claim,
        { ...session, expiresAt: new Date(1_800_000_000_124) },
        host,
      ),
    ).toBe(false)
    expect(verifyPreviewCookie('b'.repeat(48), claim, session, host)).toBe(false)
    expect(
      verifyPreviewCookie(
        secret,
        claim,
        { ...session, id: '01960000-0000-7000-8000-000000000002' },
        host,
      ),
    ).toBe(false)
  })

  it('reads only well-formed values of its own name', () => {
    const good = previewCookieValue(secret, session, host)
    expect(previewCookieClaims(undefined)).toEqual([])
    expect(previewCookieClaims(`raditi-preview=${good}`)).toEqual([])
    expect(previewCookieClaims(`${PREVIEW_SESSION_COOKIE}=nope`)).toEqual([])
    expect(previewCookieClaims(`${PREVIEW_SESSION_COOKIE}=${good}.extra`)).toEqual([])
    expect(previewCookieClaims(`${PREVIEW_SESSION_COOKIE}=NOT-A-UUID.${'a'.repeat(43)}`)).toEqual(
      [],
    )
    // A page's script may add a look-alike next to the real one: both are tried, in order.
    const both = previewCookieClaims(
      `wp=1; ${PREVIEW_SESSION_COOKIE}=${session.id}.${'x'.repeat(43)}; ${PREVIEW_SESSION_COOKIE}=${good}`,
    )
    expect(both.map((claim) => claim.sessionId)).toEqual([session.id, session.id])
    expect(verifyPreviewCookie(secret, both[1]!, session, host)).toBe(true)
  })

  it('never reaches the site, nor anything named like it', () => {
    expect(
      cookiesForUpstream(
        `wordpress_logged_in=abc; ${PREVIEW_SESSION_COOKIE}=x.y; raditi-preview=1; __Secure-Raditi-Preview-x=2; theme=dark`,
      ),
    ).toBe('wordpress_logged_in=abc; theme=dark')
    expect(cookiesForUpstream(`${PREVIEW_SESSION_COOKIE}=x.y`)).toBeUndefined()
    expect(cookiesForUpstream(undefined)).toBeUndefined()
    expect(isGatewayCookieName('__Host-raditi-preview')).toBe(true)
    expect(isGatewayCookieName('wordpress_sec')).toBe(false)
  })

  it('remembers the revision a browser got, and the one retry of a ticket, under its own names', () => {
    const header = `wp=1; ${PREVIEW_REVISION_COOKIE}=2; ${PREVIEW_REVISION_COOKIE}=7`
    expect(previewRevisionSeen(header, 7)).toBe(true)
    expect(previewRevisionSeen(header, 3)).toBe(false)
    expect(previewRevisionSeen(undefined, 0)).toBe(false)
    expect(previewRevisionSeen(`${PREVIEW_REVISION_COOKIE}x=7`, 7)).toBe(false)
    expect(previewRevisionSetCookie(5)).toBe(
      '__Host-raditi-preview-rev=5; Max-Age=2678400; HttpOnly; Secure; SameSite=None; Partitioned; Path=/',
    )
    expect(hasPreviewRetry(`${PREVIEW_RETRY_COOKIE}=1`)).toBe(true)
    expect(hasPreviewRetry('wp=1')).toBe(false)
    expect(previewRetrySetCookie(true)).toMatch(/^__Host-raditi-preview-retry=1; Max-Age=60; /)
    expect(previewRetrySetCookie(false)).toMatch(/^__Host-raditi-preview-retry=; Max-Age=0; /)
    // Neither reaches the site, and the site can set neither.
    for (const name of [PREVIEW_REVISION_COOKIE, PREVIEW_RETRY_COOKIE])
      expect(isGatewayCookieName(name)).toBe(true)
    expect(cookieValues('a=1; b=2; a=3', 'a')).toEqual(['1', '3'])
  })

  it('keeps only the SHA-256 of a ticket, as web stores it', () => {
    const ticket = 'A'.repeat(43)
    expect(previewTicketHash(ticket)).toBe(createHash('sha256').update(ticket).digest('hex'))
    expect(previewTicketHash(ticket)).toMatch(/^[0-9a-f]{64}$/)
  })
})
