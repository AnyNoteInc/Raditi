import { pagesOriginOf } from '@repo/domain/pages/origin'

export { pagesOriginOf }

/** The `Host` header the pages answer on: the origin's host with its port, in lower case. */
export function pagesHostOf(env: Record<string, string | undefined>): string | null {
  const origin = pagesOriginOf(env)
  return origin === null ? null : new URL(origin).host.toLowerCase()
}

/**
 * Whether a request came to the domain of pages. A default port in the header is the same host:
 * Traefik routes `pages.raditi.ru:443` there too.
 */
export function onPagesHost(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const pages = pagesHostOf(env)
  if (pages === null) return false
  const host = (headers.get('host')?.toLowerCase() ?? '').replace(/:(?:443|80)$/, '')
  return host === pages
}

/** What the domain of pages answers to anything but its own paths: nothing, and no cookie. */
export const pagesNotFound = () =>
  new Response('Not found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  })

/** The path of the domain of pages web answers besides its robots.txt: a view in the frame. */
export const PAGES_PATHS = /^\/v\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
