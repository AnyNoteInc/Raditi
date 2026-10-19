import type { Metadata } from 'next'

import { SiteEnvVars } from '@/components/site/site-env-vars'
import { SiteSettings } from '@/components/site/site-settings'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteCredentials, loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Настройки сайта' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params
  const site = await loadSiteSection(projectId, 'settings')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  const accesses = await loadSiteCredentials(projectId)
  return (
    <SiteSettings site={site} accesses={accesses === UNAVAILABLE ? null : accesses}>
      <SiteEnvVars siteId={site.id} />
    </SiteSettings>
  )
}
