import { NextResponse } from 'next/server'

export function proxy(request) {
  const response = NextResponse.next()
  if (request.nextUrl.pathname === '/b') response.headers.set('referrer-policy', 'no-referrer')
  return response
}

export const config = { matcher: ['/:path*'] }
