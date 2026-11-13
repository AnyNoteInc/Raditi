import { pagesOriginOf } from '@repo/domain/preview/hostname'

export { pagesOriginOf }

/** The `Host` header the pages answer on: the origin's host with its port, in lower case. */
export function pagesHostOf(env: Record<string, string | undefined>): string | null {
  const origin = pagesOriginOf(env)
  return origin === null ? null : new URL(origin).host.toLowerCase()
}

/** The path of the domain of pages web answers besides its robots.txt: a view in the frame. */
export const PAGES_PATHS = /^\/v\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
