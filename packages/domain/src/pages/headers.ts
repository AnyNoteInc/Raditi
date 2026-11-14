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

/** What a published page loads: its own data and anything by `https:` (the leak Ст9 accepted). */
const PUBLISHED_RESOURCES = [
  'img-src data: blob: https:',
  'font-src data: blob: https:',
  'media-src data: blob: https:',
]

/**
 * What a page of a chat framed by the cabinet loads: its own data only. It may hold what the client
 * never meant to publish, and the leak by the address of a picture was accepted for a published
 * page alone (Ст9) — the frame keeps the narrower rule of plan 67 (Д3).
 */
const FRAMED_RESOURCES = ['img-src data: blob:', 'font-src data: blob:', 'media-src data: blob:']

/** The directives of a page after what it loads, up to its framing. */
const PAGE_POLICY_TAIL = ["connect-src 'none'", "form-action 'none'", "frame-src 'none'"]

/** The directives of a page after its framing. */
const PAGE_POLICY_END = [
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
]

/**
 * The sandbox of a page: its scripts and pop-ups, never the same origin, forms or the top. The
 * frame of the cabinet that shows a page of a chat (`/v/`, docs/plan/67-agent-documents.md, Д3)
 * carries the very same set in its `sandbox` attribute — one family of rules for both plans (Ст9).
 */
export const PAGE_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'

export const PAGE_CSP_SANDBOX = `sandbox ${PAGE_SANDBOX}`

/** The sandbox of a page the platform drew from Markdown: the same without its scripts. */
const PAGE_READING_SANDBOX = 'sandbox allow-popups allow-popups-to-escape-sandbox'

/**
 * The policy of a page: `html` — the agent wrote it, its inline scripts run; `reading` — the
 * platform drew it from Markdown (a document, Ст11), no script at all. `framedBy` — the origin of
 * the cabinet, the only one that may frame it (a page of a chat on `/v/`, plan 67), and the page
 * loads nothing by `https:`; none — the page is never framed (a published page, plan 69).
 */
export function pagePolicy(kind: 'html' | 'reading', framedBy?: string): string {
  return [
    kind === 'html' ? PAGE_CSP_SANDBOX : PAGE_READING_SANDBOX,
    kind === 'html' ? "script-src 'unsafe-inline'" : "script-src 'none'",
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    ...(framedBy ? FRAMED_RESOURCES : PUBLISHED_RESOURCES),
    ...PAGE_POLICY_TAIL,
    `frame-ancestors ${framedBy ?? "'none'"}`,
    ...PAGE_POLICY_END,
  ].join('; ')
}

/** The policy of a page the agent wrote as HTML: its inline scripts run. */
export const PAGE_CSP = pagePolicy('html')

/** The policy of a page the platform drew from Markdown (a document, Ст11): no script at all. */
export const PAGE_READING_CSP = pagePolicy('reading')

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
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), cross-origin-isolated=()',
})

export type PageAnswerKind = 'html' | 'reading' | 'platform'

/**
 * The headers of one answer. A page goes `no-cache` (a new version shows at once, Ст16); the
 * platform's answers — the form and its outcome — `no-store`. `framedBy` — the cabinet that frames
 * a page of a chat (plan 67): that page is `no-store` too, its address lives five minutes.
 */
export function pageResponseHeaders(
  kind: PageAnswerKind,
  { framedBy }: { framedBy?: string } = {},
): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': kind === 'platform' ? PAGE_PLATFORM_CSP : pagePolicy(kind, framedBy),
    'Cache-Control': kind === 'platform' || framedBy ? 'no-store' : 'private, no-cache',
    ...PAGE_COMMON_HEADERS,
  }
}

/** `robots.txt` of every page host. */
export const PAGE_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n'

/** The methods a page host answers; the rest is 405. `POST` — only `/`, the password form. */
export const PAGE_METHODS = ['GET', 'HEAD', 'POST'] as const
