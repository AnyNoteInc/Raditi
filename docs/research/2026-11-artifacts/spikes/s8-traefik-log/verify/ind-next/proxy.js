import { NextResponse } from 'next/server'
// As apps/web/src/proxy.ts: path and query into a request header, a header set on the response.
export function proxy(request) {
  const headers = new Headers(request.headers)
  headers.set('x-raditi-path', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  const response = NextResponse.next({ request: { headers } })
  if (request.nextUrl.pathname === '/c') response.headers.set('referrer-policy', 'no-referrer')
  return response
}
export const config = { matcher: ['/:path*'] }
