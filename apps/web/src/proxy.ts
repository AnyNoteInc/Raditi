import { NextResponse, type NextRequest } from 'next/server'

import { contentSecurityPolicy, previewFrameSource } from '@/lib/content-security-policy'
import { REQUEST_PATH_HEADER } from '@/lib/request-path'

/**
 * Passes the requested path to layouts (see REQUEST_PATH_HEADER), and sends the page's
 * Content-Security-Policy with the previews of dialogs of this environment, read when the
 * request comes, not when the image was built (plan 53, Р20). It replaces the policy of
 * next.config.ts, which frames no preview.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers)
  headers.set(REQUEST_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set(
    'content-security-policy',
    contentSecurityPolicy(previewFrameSource(process.env)),
  )
  return response
}

export const config = {
  // Pages only: not API routes, build assets or files.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'],
}
