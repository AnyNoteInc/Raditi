export const dynamic = 'force-dynamic'
export function GET() {
  setTimeout(() => Promise.reject(new Error('ind: an unhandled rejection')), 10)
  return new Response('ok\n', { headers: { 'referrer-policy': 'no-referrer' } })
}
