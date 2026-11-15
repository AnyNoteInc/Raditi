import { describe, expect, it } from 'vitest'

import {
  COOKIE_CONSENT_COOKIE,
  COOKIE_CONSENT_MAX_AGE,
  cookieConsentAssignment,
  cookieConsentValue,
  parseCookieConsent,
  readCookieConsent,
} from './cookie-consent'

const now = new Date('2026-11-15T10:00:00.000Z')

describe('cookie consent', () => {
  it('reads back what it writes', () => {
    expect(parseCookieConsent(cookieConsentValue(true, now))).toEqual({
      analyticsAllowed: true,
      chosenAt: now,
    })
    expect(parseCookieConsent(cookieConsentValue(false, now))).toEqual({
      analyticsAllowed: false,
      chosenAt: now,
    })
  })

  it('asks again when there is no choice, it is spoiled or of another version', () => {
    for (const value of [undefined, '', 'accepted', 'v1.maybe.1', 'v1.all.', 'v2.all.1', 'v0.all.1']) {
      expect(parseCookieConsent(value)).toBeNull()
    }
  })

  it('writes a cookie of the whole site for a year, Secure only over https', () => {
    const https = cookieConsentAssignment(false, now, true)
    expect(https).toBe(
      `${COOKIE_CONSENT_COOKIE}=v1.necessary.${now.getTime() / 1000}; Path=/; Max-Age=${COOKIE_CONSENT_MAX_AGE}; SameSite=Lax; Secure`,
    )
    expect(cookieConsentAssignment(false, now, false)).not.toContain('Secure')
  })

  it('finds its cookie among the others', () => {
    const header = `theme=dark; ${COOKIE_CONSENT_COOKIE}=${cookieConsentValue(true, now)}; other=1`
    expect(readCookieConsent(header)?.analyticsAllowed).toBe(true)
    expect(readCookieConsent('theme=dark')).toBeNull()
  })
})
