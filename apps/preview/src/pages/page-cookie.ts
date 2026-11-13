import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The cookie of a right password (docs/plan/69-pages.md, Ст13): `raditi_page`, only of the page's
 * own host — no `Domain`, so neither the cabinet nor another page ever gets it, on
 * `pages.raditi.ru`, which is same-site with the cabinet (Ст3), too. The value binds the page, the
 * epoch of its password (a new password stops the old cookies) and the expiry:
 * `<epoch>.<expiresAtMs>.<HMAC-SHA256(PAGES_COOKIE_SECRET, pageId|epoch|expiresAtMs)>`.
 */
export const PAGE_COOKIE = 'raditi_page'
const ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/'

const mac = (secret: string, pageId: string, epoch: number, expiresAt: number) =>
  createHmac('sha256', secret)
    .update(`raditi-page-v1|${pageId}|${epoch}|${expiresAt}`, 'utf8')
    .digest()

export function pageSetCookie(
  secret: string,
  page: { id: string; passwordEpoch: number },
  now: number,
  seconds: number,
): string {
  const expiresAt = now + seconds * 1000
  const value = `${page.passwordEpoch}.${expiresAt}.${mac(secret, page.id, page.passwordEpoch, expiresAt).toString('base64url')}`
  return `${PAGE_COOKIE}=${value}; Max-Age=${seconds}; ${ATTRIBUTES}`
}

const VALUE = /^(\d{1,9})\.(\d{13})\.([A-Za-z0-9_-]{43})$/

/** Whether a `Cookie` header carries a live cookie of this page and this password. */
export function pageCookieOpens(
  secret: string,
  page: { id: string; passwordEpoch: number },
  cookieHeader: string | undefined,
  now: number,
): boolean {
  for (const pair of (cookieHeader ?? '').split(';')) {
    const at = pair.indexOf('=')
    if (at === -1 || pair.slice(0, at).trim() !== PAGE_COOKIE) continue
    const match = VALUE.exec(pair.slice(at + 1).trim())
    if (!match) continue
    const epoch = Number(match[1])
    const expiresAt = Number(match[2])
    if (epoch !== page.passwordEpoch || expiresAt <= now) continue
    const want = mac(secret, page.id, epoch, expiresAt)
    const got = Buffer.from(match[3]!, 'base64url')
    if (got.length === want.length && timingSafeEqual(got, want)) return true
  }
  return false
}
