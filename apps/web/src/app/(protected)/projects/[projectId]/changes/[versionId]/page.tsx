import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { siteHref } from '@/components/site/site-nav'
import { BackLink } from '@/components/site/site-section'
import { VersionDetail } from '@/components/site/site-versions'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory, loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Версия сайта' }

/** One version of «Изменения», a page of its own under «Версии» (Н6); one of no such site — «not found». */
export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string; versionId: string }>
}) {
  const { projectId, versionId } = await params
  const site = await loadSiteSection(projectId, 'changes')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  const versions = await loadSiteHistory('versions', (caller) =>
    caller.siteHistory.versions({ siteId: site.id }),
  )
  if (versions === UNAVAILABLE) return <ServiceUnavailable />
  const index = versions.findIndex((version) => version.id === versionId)
  const version = versions[index]
  if (!version) notFound()
  return (
    <>
      <BackLink href={siteHref(site.id, 'changes')}>Все версии</BackLink>
      <VersionDetail
        siteId={site.id}
        version={version}
        next={versions[index - 1] ?? null}
        now={new Date()}
        nested
      />
    </>
  )
}
