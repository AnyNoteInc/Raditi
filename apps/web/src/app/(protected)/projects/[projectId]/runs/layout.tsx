import type { ReactNode } from 'react'

import { HistoryList } from '@/components/site/history-list'
import { SiteListFrame } from '@/components/site/site-list-frame'
import { siteHref } from '@/components/site/site-nav'
import { runItems } from '@/components/site/site-runs'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory } from '@/lib/site'

/**
 * «Запуски»: the runs of the site — its first import and every release — beside the one that is
 * open, at the root the newest. Access is checked by every page under it.
 */
export default async function RunsLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const runs = await loadSiteHistory('runs', (caller) => caller.siteHistory.runs({ siteId: projectId }))
  const items = runs === UNAVAILABLE ? [] : runItems(runs)
  return (
    <SiteListFrame
      label="Запуски"
      title="Запуски"
      root={siteHref(projectId, 'runs')}
      backLabel="Назад к запускам"
      list={
        <HistoryList
          root={siteHref(projectId, 'runs')}
          items={items}
          rootSegment={items[0]?.segment ?? null}
          emptyText={
            runs === UNAVAILABLE
              ? 'Не удалось загрузить запуски. Обновите страницу через пару минут.'
              : 'Запусков пока нет.'
          }
          filters
        />
      }
    >
      {children}
    </SiteListFrame>
  )
}
