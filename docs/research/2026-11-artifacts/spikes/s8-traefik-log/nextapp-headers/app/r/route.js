export const dynamic = 'force-dynamic'
export function GET() {
  return new Response('r\n', { headers: { 'referrer-policy': 'no-referrer' } })
}
