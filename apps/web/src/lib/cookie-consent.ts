/**
 * The visitor's choice about cookies (privacy policy, section 9). Necessary cookies — the session,
 * the colour mode, the captcha — work without it; analytics cookies may be set only after
 * «Принять все». No analytics is connected yet: a counter, when it comes, loads only when
 * `analyticsAllowed` is true and listens for COOKIE_CONSENT_CHANGE_EVENT.
 *
 * The choice is a cookie of its own, not a record on the server: a visitor who has not signed in
 * has no identity to attach it to. Raising COOKIE_CONSENT_VERSION asks everyone again — do it when
 * the banner starts naming a new kind of cookie (for example, Yandex Metrika).
 */

export const COOKIE_CONSENT_COOKIE = 'raditi_cookie_consent'
export const COOKIE_CONSENT_VERSION = 1
/** A year, in seconds: the choice is asked again after it. */
export const COOKIE_CONSENT_MAX_AGE = 60 * 60 * 24 * 365

/** Sent on window by «Настройки cookie»: the banner opens again. */
export const COOKIE_SETTINGS_OPEN_EVENT = 'raditi:cookie-settings'
/** Sent on window after the visitor chose; `detail` is the CookieConsent. */
export const COOKIE_CONSENT_CHANGE_EVENT = 'raditi:cookie-consent'

export type CookieConsent = {
  /** Analytics cookies are allowed. Necessary ones are always on. */
  analyticsAllowed: boolean
  /** When the visitor chose. */
  chosenAt: Date
}

const VALUE = /^v(\d+)\.(all|necessary)\.(\d{1,12})$/

/** The choice stored in the cookie; null when there is none, it is spoiled or of an older version. */
export function parseCookieConsent(value: string | undefined): CookieConsent | null {
  const match = value === undefined ? null : VALUE.exec(value)
  if (match === null || Number(match[1]) !== COOKIE_CONSENT_VERSION) return null
  return { analyticsAllowed: match[2] === 'all', chosenAt: new Date(Number(match[3]) * 1000) }
}

/** The value of the cookie: `v<version>.<all|necessary>.<unix seconds>`. */
export function cookieConsentValue(analyticsAllowed: boolean, now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000)
  return `v${COOKIE_CONSENT_VERSION}.${analyticsAllowed ? 'all' : 'necessary'}.${seconds}`
}

/** The string for `document.cookie`. Secure only over https: dev runs on http://localhost. */
export function cookieConsentAssignment(
  analyticsAllowed: boolean,
  now: Date,
  secure: boolean,
): string {
  const value = cookieConsentValue(analyticsAllowed, now)
  return `${COOKIE_CONSENT_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_CONSENT_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`
}

/** Reads the choice in the browser. */
export function readCookieConsent(cookieHeader: string): CookieConsent | null {
  const prefix = `${COOKIE_CONSENT_COOKIE}=`
  const entry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
  return parseCookieConsent(entry?.slice(prefix.length))
}
