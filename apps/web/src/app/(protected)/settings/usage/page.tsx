import type { Metadata } from 'next'

import { UsageView } from '@/components/billing/usage-view'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Использование' }

export default async function UsagePage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return <UsageView />
}
