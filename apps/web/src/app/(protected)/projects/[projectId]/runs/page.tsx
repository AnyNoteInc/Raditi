import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { HistoryList } from '@/components/site/history-list'
import { siteHref } from '@/components/site/site-nav'
import { runItems } from '@/components/site/site-runs'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory, loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Запуски' }

/** «Запуски» at its root: every run across the full width, with the tabs of the filter (Н5, Н6). */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSiteSection((await params).projectId, 'runs')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  const runs = await loadSiteHistory('runs', (caller) =>
    caller.siteHistory.runs({ siteId: site.id }),
  )
  if (runs === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <HistoryList
      label="Запуски"
      root={siteHref(site.id, 'runs')}
      items={runItems(runs)}
      emptyText="Запусков пока нет. Здесь появится каждое обновление сайта: его шаги и журнал."
      filters
    />
  )
}
