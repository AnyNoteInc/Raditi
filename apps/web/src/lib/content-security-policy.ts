/**
 * The Content-Security-Policy of the cabinet. next.config.ts sends it on every route, fixed at
 * `next build`, and frames no preview there: the image is built once for every environment.
 * proxy.ts sends it again on every page, per request, with the previews of the environment the
 * server runs in (docs/plan/53, Р19, Р20); Next lets the proxy's header replace the config's.
 * next.config.ts spells its copy out (it cannot import this file safely); next-config.test.ts
 * checks that copy equals contentSecurityPolicy(null).
 */

/**
 * The previews of dialogs as a CSP source: `<scheme>://*.<PREVIEW_BASE_DOMAIN>[:port]`, from the
 * same variables web-env.ts reads. null — no preview is framed: previews are off, or a value
 * would widen the source or break the header.
 */
export function previewFrameSource(env: Record<string, string | undefined>): string | null {
  const base = env.PREVIEW_BASE_DOMAIN?.trim() ?? ''
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(base))
    return null
  const scheme = env.PREVIEW_SCHEME?.trim() || (env.APP_ENV === 'production' ? 'https' : 'http')
  if (scheme !== 'http' && scheme !== 'https') return null
  const port = env.PREVIEW_PUBLIC_PORT?.trim() ?? ''
  const own = scheme === 'https' ? '443' : '80'
  return `${scheme}://*.${base}${/^\d{1,5}$/.test(port) && port !== own ? `:${port}` : ''}`
}

/**
 * Directives that need no allowlist of scripts. Images come only from the site itself (the
 * avatar route, a chosen photo's preview as blob:) and the captcha, so a stored external
 * address can never make the browser call another host. Frames: the captcha and the previews
 * of dialogs only; the cabinet itself is never framed.
 * TODO(M8): full CSP (script-src with per-request nonces from the proxy, plus
 * smartcaptcha.cloud.yandex.ru for the captcha script).
 */
export function contentSecurityPolicy(previews: string | null): string {
  return [
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "img-src 'self' data: blob: https://smartcaptcha.cloud.yandex.ru",
    `frame-src 'self' https://smartcaptcha.cloud.yandex.ru${previews ? ` ${previews}` : ''}`,
  ].join('; ')
}
