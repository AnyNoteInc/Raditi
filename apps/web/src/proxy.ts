import { NextResponse, type NextRequest } from 'next/server'

import { contentSecurityPolicy, previewFrameSource } from '@/lib/content-security-policy'
import { PAGES_PATHS, pagesHostOf, pagesOriginOf } from '@/lib/pages-origin'
import { REQUEST_PATH_HEADER } from '@/lib/request-path'

/** The paths the cabinet's policy was never sent on: API routes, build assets, the icon. */
const UNTOUCHED = /^\/(?:api\/|_next\/static|_next\/image|favicon\.ico)/

/** What the domain of pages answers to anything but its own paths: nothing, and no cookie. */
const notFound = () =>
  new NextResponse('Not found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  })

/**
 * Splits the two hosts web answers on (docs/plan/67-agent-documents.md, Д3). On the domain of the
 * pages the agent makes there is a view in the frame (`/v/<token>`) and its robots.txt, nothing
 * else — no page, API route or asset of the cabinet; on the cabinet's
 * host /v/ (and /s/, kept for plan 69) is not found. For the cabinet it passes the requested path to layouts
 * (see REQUEST_PATH_HEADER) and sends the page's Content-Security-Policy with the previews of
 * dialogs and the pages of this environment, read when the request comes, not when the image was
 * built (plan 53, Р20); it replaces the policy of next.config.ts, which frames neither.
 */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname
  const pages = pagesHostOf(process.env)
  // A default port in the header is the same host: Traefik routes `pages.raditi.ru:443` there too.
  const host = (request.headers.get('host')?.toLowerCase() ?? '').replace(/:(?:443|80)$/, '')
  if (pages !== null && host === pages) {
    if (path === '/robots.txt')
      return new NextResponse('User-agent: *\nDisallow: /\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    const read = request.method === 'GET' || request.method === 'HEAD'
    return read && PAGES_PATHS.test(path) ? NextResponse.next() : notFound()
  }
  if (path.startsWith('/v/') || path.startsWith('/s/')) return notFound()
  if (UNTOUCHED.test(path)) return NextResponse.next()
  const headers = new Headers(request.headers)
  headers.set(REQUEST_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set(
    'content-security-policy',
    contentSecurityPolicy(previewFrameSource(process.env), pagesOriginOf(process.env)),
  )
  return response
}

export const config = {
  // Every path: the domain of pages must not reach the cabinet's API routes or assets either.
  matcher: ['/:path*'],
}
