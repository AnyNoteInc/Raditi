/**
 * The origin of the domain of the pages the agent makes (PAGES_ORIGIN,
 * docs/plan/67-agent-documents.md, Д3): `<scheme>://<host>[:port]` and nothing else. The proxy reads
 * it on every request to split the two hosts and the CSP of the cabinet frames it; both must never
 * throw, so anything that is not exactly an http(s) origin is null — no page is framed or served.
 */
export function pagesOriginOf(env: Record<string, string | undefined>): string | null {
  const value = env.PAGES_ORIGIN?.trim() ?? ''
  if (value === '') return null
  const url = URL.parse(value)
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
  return url.origin === value ? value : null
}

/** The `Host` header the pages answer on: the origin's host with its port, in lower case. */
export function pagesHostOf(env: Record<string, string | undefined>): string | null {
  const origin = pagesOriginOf(env)
  return origin === null ? null : new URL(origin).host.toLowerCase()
}

/** The paths of the domain of pages: a view in the frame, a shared link, and its robots.txt. */
export const PAGES_PATHS = /^\/(?:v|s)\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
