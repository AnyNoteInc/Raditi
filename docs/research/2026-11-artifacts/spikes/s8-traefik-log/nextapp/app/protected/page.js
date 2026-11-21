import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

// Like requireSession in apps/web/src/lib/access.ts: no session, so off to /sign-in?next=<path+query>.
export const dynamic = 'force-dynamic'

export default async function Protected() {
  const path = (await headers()).get('x-raditi-path') ?? '/'
  redirect(`/sign-in?next=${encodeURIComponent(path)}`)
}
