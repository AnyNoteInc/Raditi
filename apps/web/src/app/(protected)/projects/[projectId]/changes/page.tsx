import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { SiteFiles } from '@/components/site/site-files'
import { TabContent } from '@/components/site/site-section'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Файлы сайта' }

/** «Изменения» at its root: the tab «Файлы», the files of the version the site has. */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSiteSection((await params).projectId, 'changes')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <TabContent>
      <SiteFiles siteId={site.id} />
    </TabContent>
  )
}
