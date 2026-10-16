import type { Metadata } from 'next'

import { BillingView } from '@/components/billing/billing-view'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Оплата' }

export default async function BillingPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return <BillingView />
}
