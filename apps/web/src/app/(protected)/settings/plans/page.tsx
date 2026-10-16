import type { Metadata } from 'next'

import { PlansView } from '@/components/billing/plans-view'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Тарифы' }

export default async function PlansPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  // Letters about the tariff go to this address: the page names it where it promises one.
  return <PlansView email={session.user.email} />
}
