import { NextResponse } from 'next/server'

// Like apps/web/src/proxy.ts: the path and query go to layouts in a request header; nothing is logged.
export function proxy(request) {
  const headers = new Headers(request.headers)
  headers.set('x-raditi-path', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.next({ request: { headers } })
}

export const config = { matcher: ['/:path*'] }
