import { NextResponse, type NextRequest } from 'next/server'

import { contentSecurityPolicy } from '@/lib/content-security-policy'
import { PAGES_PATHS, onPagesHost, pagesNotFound, pagesOriginOf } from '@/lib/pages-origin'
import { REQUEST_PATH_HEADER } from '@/lib/request-path'

/** The paths the cabinet's policy was never sent on: API routes, build assets, the icon. */
const UNTOUCHED = /^\/(?:api\/|_next\/static|_next\/image|favicon\.ico)/

/**
 * Splits the two hosts web answers on (docs/plan/67-agent-documents.md, Д3). On the domain of the
 * pages the agent makes there is a view in the frame (`/v/<token>`) and its robots.txt, nothing
 * else — no page, API route or asset of the cabinet (the routes that take a file, which skip the
 * proxy, answer that 404 themselves: `config.matcher`); on the cabinet's
 * host /v/ (and /s/, kept for plan 69) is not found. For the cabinet it passes the requested path to layouts
 * (see REQUEST_PATH_HEADER) and sends the page's Content-Security-Policy with the previews of
 * dialogs and the pages of this environment, read when the request comes, not when the image was
 * built (plan 53, Р20); it replaces the policy of next.config.ts, which frames neither.
 */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname
  if (onPagesHost(request.headers)) {
    if (path === '/robots.txt')
      return new NextResponse('User-agent: *\nDisallow: /\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    const read = request.method === 'GET' || request.method === 'HEAD'
    return read && PAGES_PATHS.test(path) ? NextResponse.next() : pagesNotFound()
  }
  if (path.startsWith('/v/') || path.startsWith('/s/')) return pagesNotFound()
  if (UNTOUCHED.test(path)) return NextResponse.next()
  const headers = new Headers(request.headers)
  headers.set(REQUEST_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set('content-security-policy', contentSecurityPolicy(pagesOriginOf(process.env)))
  return response
}

export const config = {
  // Every path but the routes that take a file: the domain of pages must not reach the cabinet's
  // API routes or assets either. Next copies the body of a request that passes the proxy into
  // memory up to `proxyClientMaxBodySize` (1 MB, next.config.ts) before any check of the route,
  // and hands the route only that much: a message's attachment and a project's file (up to
  // 20 MiB) and the avatar (5 MiB) arrived cut off. Dictation (960 000 bytes) fits, but is read
  // after the route's own checks only without the proxy. These four stream the body after their
  // session, Origin, consent and size checks and answer the domain of pages themselves
  // (server/cabinet-only.ts) — the same four Traefik keeps out of its body limit
  // (infra/app/traefik/dynamic/raditi.yml, `web-api-body`). Only the exact paths of the routes are
  // left out: any other path, `/api/attachments/x/y` included, still gets the proxy's 404 on the
  // domain of pages. Next takes only a literal here; proxy.test.ts compiles it as Next does.
  matcher: ['/((?!api/(?:(?:attachments|project-files)/[^/]+$|profile/avatar$|speech$)).*)'],
}
