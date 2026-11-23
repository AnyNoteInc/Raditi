// A route handler that throws on ?throw=1.
export const dynamic = 'force-dynamic'

export function GET(request) {
  const url = new URL(request.url)
  if (url.searchParams.get('throw') === '1') throw new Error('spike: the route failed')
  return new Response('ok\n')
}
