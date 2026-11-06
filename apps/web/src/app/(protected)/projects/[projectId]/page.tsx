import { redirect } from 'next/navigation'

import { siteHref } from '@/components/site/site-nav'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'
import { loadSite } from '@/lib/site'

/** The address of a site leads to its overview (docs/plan/61-chats-first.md, К2). */
export default async function SitePage({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSite((await params).projectId)
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  redirect(siteHref(site.id, 'overview'))
}
