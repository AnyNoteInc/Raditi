/**
 * The Content-Security-Policy of the cabinet. next.config.ts sends it on every route, fixed at
 * `next build`, and frames no page of the agent there: the image is built once for every
 * environment. proxy.ts sends it again on every page, per request, with the domain of pages of the
 * environment the server runs in; Next lets the proxy's header replace the config's.
 * next.config.ts spells its copy out (it cannot import this file safely); next-config.test.ts
 * checks that copy equals contentSecurityPolicy(null).
 */

/**
 * Directives that need no allowlist of scripts. Images come only from the site itself (the
 * avatar route, a chosen photo's preview as blob:) and the captcha, so a stored external
 * address can never make the browser call another host. Frames: the captcha and the pages the
 * agent makes (`pagesOriginOf`, docs/plan/67, Д3) only; the cabinet itself is never framed.
 * TODO(M8): full CSP (script-src with per-request nonces from the proxy, plus
 * smartcaptcha.cloud.yandex.ru for the captcha script).
 */
export function contentSecurityPolicy(pages: string | null = null): string {
  return [
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "img-src 'self' data: blob: https://smartcaptcha.cloud.yandex.ru",
    `frame-src 'self' https://smartcaptcha.cloud.yandex.ru${pages ? ` ${pages}` : ''}`,
  ].join('; ')
}
