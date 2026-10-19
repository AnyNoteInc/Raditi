import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { stackLabels } from '@/components/projects/project-labels'
import { inSiteSetup } from '@/components/site/site-nav'
import { SiteOverview } from '@/components/site/site-overview'
import { SiteSetup } from '@/components/site/site-setup'
import { UNAVAILABLE } from '@/lib/access'
import { loadSite, loadSiteSetup } from '@/lib/site'

export const metadata: Metadata = { title: 'Обзор' }

/** «Обзор»; while the first import of the site has not succeeded, the setup screen instead. */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSite((await params).projectId)
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  if (inSiteSetup(site.setup)) {
    const setup = await loadSiteSetup(site.id)
    return (
      <SiteSetup
        siteId={site.id}
        stack={site.stack}
        platform={stackLabels[site.stack]}
        initial={setup ?? undefined}
      />
    )
  }
  return <SiteOverview site={site} />
}
