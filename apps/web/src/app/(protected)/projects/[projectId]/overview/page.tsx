import type { Metadata } from 'next'

import { SiteOverview } from '@/components/site/site-overview'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'
import { loadSite } from '@/lib/site'

export const metadata: Metadata = { title: 'Обзор' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSite((await params).projectId)
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  return <SiteOverview site={site} />
}
