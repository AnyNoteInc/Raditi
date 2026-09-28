import { NextResponse, type NextRequest } from 'next/server'

import { REQUEST_PATH_HEADER } from '@/lib/request-path'

/** Passes the requested path to layouts (see REQUEST_PATH_HEADER); nothing else. */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers)
  headers.set(REQUEST_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.next({ request: { headers } })
}

export const config = {
  // Pages only: not API routes, build assets or files.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'],
}
