import { Suspense } from 'react'
export const dynamic = 'force-dynamic'
async function Late() { await new Promise((r) => setTimeout(r, 300)); throw new Error('ind: the stream failed') }
export default async function S({ searchParams }) {
  await searchParams
  return (<main><p>shell</p><Suspense fallback={<p>…</p>}><Late /></Suspense></main>)
}
