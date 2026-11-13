import { pagesOriginOf } from '@repo/domain/preview/hostname'

export { pagesOriginOf }

/** The `Host` header the pages answer on: the origin's host with its port, in lower case. */
export function pagesHostOf(env: Record<string, string | undefined>): string | null {
  const origin = pagesOriginOf(env)
  return origin === null ? null : new URL(origin).host.toLowerCase()
}

/** The paths of the domain of pages: a view in the frame, a shared link, and its robots.txt. */
export const PAGES_PATHS = /^\/(?:v|s)\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
