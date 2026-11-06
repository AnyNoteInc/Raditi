import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { SiteFiles } from '@/components/site/site-files'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Терминал' }

/** «Терминал»: the files of the version the site has, to read (owner's request of 06.11.2026). */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSiteSection((await params).projectId, 'terminal')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  return <SiteFiles siteId={site.id} />
}
