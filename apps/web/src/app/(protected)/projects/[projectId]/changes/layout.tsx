import type { ReactNode } from 'react'

import { HistoryList } from '@/components/site/history-list'
import { SiteListFrame } from '@/components/site/site-list-frame'
import { siteHref } from '@/components/site/site-nav'
import { versionItems } from '@/components/site/site-versions'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory } from '@/lib/site'

/**
 * «Изменения»: the versions that were on the site beside the one that is open — at the root the
 * one on the site now. Access is checked by every page under it; the list asks the server itself.
 */
export default async function ChangesLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const versions = await loadSiteHistory('versions', (caller) =>
    caller.siteHistory.versions({ siteId: projectId }),
  )
  const items = versions === UNAVAILABLE ? [] : versionItems(versions)
  const current = versions === UNAVAILABLE ? null : (versions.find((v) => v.current) ?? null)
  return (
    <SiteListFrame
      label="Версии сайта"
      title="Изменения"
      root={siteHref(projectId, 'changes')}
      backLabel="Назад к версиям"
      list={
        <HistoryList
          root={siteHref(projectId, 'changes')}
          items={items}
          rootSegment={current?.id ?? null}
          emptyText={
            versions === UNAVAILABLE
              ? 'Не удалось загрузить версии. Обновите страницу через пару минут.'
              : 'Версий пока нет.'
          }
        />
      }
    >
      {children}
    </SiteListFrame>
  )
}
