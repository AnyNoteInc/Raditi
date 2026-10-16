import type { Metadata } from 'next'

import { SectionEmpty } from '@/components/site/section-empty'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'База и бэкап' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSiteSection((await params).projectId, 'database')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <SectionEmpty title="База и бэкап">
      Здесь появятся резервные копии базы и их расписание.
    </SectionEmpty>
  )
}
