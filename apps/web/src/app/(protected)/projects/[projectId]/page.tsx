import { redirect } from 'next/navigation'

import { siteEntryHref, siteLanding } from '@/components/site/site-nav'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'
import { loadSite } from '@/lib/site'

/**
 * The address of a site leads to a new dialog of its chat; a site that is not connected yet and
 * a site whose other sections are closed — paused, disconnected, archived — to the overview.
 */
export default async function SitePage({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSite((await params).projectId)
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  redirect(siteEntryHref(site.id, siteLanding(site.status)))
}
