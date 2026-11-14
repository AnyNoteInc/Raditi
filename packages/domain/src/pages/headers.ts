/**
 * The headers of every answer of the page server (docs/plan/69-pages.md, Ст9). A page is HTML
 * the agent wrote: it runs in a CSP sandbox without `allow-same-origin` — an opaque origin that
 * reads and sets no cookie, on `<slug>.pages.raditi.ru` too, which is same-site with the cabinet
 * (Ст3). It has no fetch, XHR or WebSocket (`connect-src`), no form, no frame, no worker, and it
 * is never framed. It is not sealed: its scripts may still send data out by the address of a
 * picture, a pop-up or a link (`img-src https:`, `allow-popups-to-escape-sandbox`). The owner
 * accepted that on 13.11.2026 — a page is the agent's work for the client, and the password of
 * a page is the platform's form, never the page's.
 */

const PAGE_POLICY_TAIL = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob: https:',
  'font-src data: blob: https:',
  'media-src data: blob: https:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
]

/** The sandbox of a page: its scripts and pop-ups, never the same origin, forms or the top. */
export const PAGE_CSP_SANDBOX = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox'

/** The policy of a page the agent wrote as HTML: its inline scripts run. */
export const PAGE_CSP = [PAGE_CSP_SANDBOX, "script-src 'unsafe-inline'", ...PAGE_POLICY_TAIL].join(
  '; ',
)

/** The policy of a page the platform drew from Markdown (a document, Ст11): no script at all. */
export const PAGE_READING_CSP = [
  'sandbox allow-popups allow-popups-to-escape-sandbox',
  "script-src 'none'",
  ...PAGE_POLICY_TAIL,
].join('; ')

/**
 * The policy of the platform's own answers on a page host: the password form, the stubs of 404
 * and 410, «Документ ещё пишется». No sandbox — the form must post — but no script, no request
 * and no frame either; the form posts to the page itself only.
 */
export const PAGE_PLATFORM_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "script-src 'none'",
  "connect-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ')

/** What every answer of a page host carries beside its policy. */
export const PAGE_COMMON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()',
})

export type PageAnswerKind = 'html' | 'reading' | 'platform'

const POLICY: Record<PageAnswerKind, string> = {
  html: PAGE_CSP,
  reading: PAGE_READING_CSP,
  platform: PAGE_PLATFORM_CSP,
}

/**
 * The headers of one answer. A page goes `no-cache` (a new version shows at once, Ст16); the
 * platform's answers — the form and its outcome — `no-store`.
 */
export function pageResponseHeaders(kind: PageAnswerKind): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': POLICY[kind],
    'Cache-Control': kind === 'platform' ? 'no-store' : 'private, no-cache',
    ...PAGE_COMMON_HEADERS,
  }
}

/** `robots.txt` of every page host. */
export const PAGE_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n'

/** The methods a page host answers; the rest is 405. `POST` — only `/`, the password form. */
export const PAGE_METHODS = ['GET', 'HEAD', 'POST'] as const
