import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { HistoryList } from '@/components/site/history-list'
import { siteHref } from '@/components/site/site-nav'
import { versionItems } from '@/components/site/site-versions'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory, loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Версии сайта' }

/** «Изменения» at its root: every version of the site across the full width (Н6). */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSiteSection((await params).projectId, 'changes')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  const versions = await loadSiteHistory('versions', (caller) =>
    caller.siteHistory.versions({ siteId: site.id }),
  )
  if (versions === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <HistoryList
      label="Версии сайта"
      root={siteHref(site.id, 'changes')}
      items={versionItems(versions)}
      emptyText="Версий пока нет. Первая появится, когда Радити сохранит файлы сайта."
    />
  )
}
