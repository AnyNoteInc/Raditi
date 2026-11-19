// A byte-for-byte replica of the headers the repository sends today (tree feat/artifacts at
// b1349f3b). Every constant below is copied from the file and line named next to it; the spike
// only adds variants on top (see variants.mjs) and never changes these.

// packages/domain/src/pages/headers.ts:16-20
const PUBLISHED_RESOURCES = [
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
]

// packages/domain/src/pages/headers.ts:27
const FRAMED_RESOURCES = ['img-src data: blob:', 'font-src data: blob:', 'media-src data: blob:']

// packages/domain/src/pages/headers.ts:30
const PAGE_POLICY_TAIL = ["connect-src 'none'", "form-action 'none'", "frame-src 'none'"]

// packages/domain/src/pages/headers.ts:33-38
const PAGE_POLICY_END = [
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
]

// packages/domain/src/pages/headers.ts:45-50
export const PAGE_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox'
export const PAGE_CSP_SANDBOX = `sandbox ${PAGE_SANDBOX}`
const PAGE_READING_SANDBOX = 'sandbox allow-popups allow-popups-to-escape-sandbox'

// docs/plan/88-artifacts.md, Ар28 (proposed, not in code yet)
export const ARTIFACT_SANDBOX = 'allow-scripts'

// packages/domain/src/pages/headers.ts:58-75
export function pagePolicy(kind, framedBy) {
  return [
    kind === 'html' ? PAGE_CSP_SANDBOX : PAGE_READING_SANDBOX,
    kind === 'html'
      ? framedBy
        ? "script-src 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline'"
      : "script-src 'none'",
    "default-src 'none'",
    framedBy ? "style-src 'unsafe-inline'" : "style-src 'self' 'unsafe-inline'",
    ...(framedBy ? FRAMED_RESOURCES : PUBLISHED_RESOURCES),
    ...PAGE_POLICY_TAIL,
    `frame-ancestors ${framedBy ?? "'none'"}`,
    ...PAGE_POLICY_END,
  ].join('; ')
}

// packages/domain/src/pages/headers.ts:88-98
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

// packages/domain/src/pages/headers.ts:101-109
export const PAGE_COMMON_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), cross-origin-isolated=()',
})

// packages/domain/src/pages/headers.ts:118-128
export function pageResponseHeaders(kind, { framedBy } = {}) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': kind === 'platform' ? PAGE_PLATFORM_CSP : pagePolicy(kind, framedBy),
    'Cache-Control': kind === 'platform' || framedBy ? 'no-store' : 'private, no-cache',
    ...PAGE_COMMON_HEADERS,
  }
}

// packages/domain/src/pages/headers.ts:131
export const PAGE_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n'

// apps/web/src/server/page-response.ts:12-17 — the frame of the cabinet (/v/<token>)
export function pageHeaders(appOrigin, length) {
  return {
    ...pageResponseHeaders('html', { framedBy: appOrigin }),
    'Content-Length': String(length),
  }
}

// apps/web/src/server/page-response.ts:20-29 — a short answer of the domain of pages
export const pageAnswerHeaders = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
}

// apps/web/src/lib/pages-origin.ts:12 — the only path of the pages root besides robots.txt
export const PAGES_PATHS = /^\/v\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

// apps/web/src/lib/content-security-policy.ts:18-27 — the cabinet's policy, sent by proxy.ts:49
export function contentSecurityPolicy(pages = null) {
  return [
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "img-src 'self' data: blob: https://smartcaptcha.cloud.yandex.ru",
    `frame-src 'self' https://smartcaptcha.cloud.yandex.ru${pages ? ` ${pages}` : ''}`,
  ].join('; ')
}

// apps/web/next.config.ts:47-58 — the other headers of every cabinet route (CSP replaced by the
// proxy's). HSTS is left out on purpose: it is sent only with NODE_ENV=production and would pin
// the stand's names to https for the http pass of the same browser.
export const cabinetSecurityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
}

// packages/domain/src/pages/files.ts:97-111 — a shared file of a site of pages (/_files/)
export function pageFileHeaders(type) {
  return {
    'Content-Type': type,
    'Content-Security-Policy':
      type === 'image/svg+xml'
        ? "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'"
        : "default-src 'none'; sandbox; frame-ancestors 'none'",
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    ...(type === 'application/pdf' ? { 'Content-Disposition': 'attachment' } : {}),
  }
}

// packages/domain/src/pages/files.ts:33-48 — the types a shared file may have (subset used here)
export const FILE_TYPES = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  png: 'image/png',
  woff2: 'font/woff2',
}

// apps/preview/src/pages/page-cookie.ts:10-14, 21-30 — the cookie of a right password
export const PAGE_COOKIE = 'raditi_page'
const COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=None; Path=/'
export function pageSetCookie(value, seconds) {
  return `${PAGE_COOKIE}=${value}; Max-Age=${seconds}; ${COOKIE_ATTRIBUTES}`
}

// apps/preview/src/pages/pages-server.ts:89-106 — sendText: the plain answers of a page host
export function sendTextHeaders(length) {
  return {
    ...PAGE_COMMON_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Content-Length': String(length),
  }
}
