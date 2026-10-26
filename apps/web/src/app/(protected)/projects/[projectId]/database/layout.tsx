import type { ReactNode } from 'react'

import { SiteBlockNav } from '@/components/site/site-block-nav'
import { databaseBlocks } from '@/components/site/site-database'
import { SiteListFrame } from '@/components/site/site-list-frame'
import { siteHref } from '@/components/site/site-nav'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory } from '@/lib/site'

/**
 * «База и бэкап», split by its cards (owner's request of 26.10.2026): the menu of its blocks
 * beside the one that is open, at the root the first. Access is checked by every page under it;
 * the reads of the menu check it themselves.
 */
export default async function DatabaseLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const [connections, backups] = await Promise.all([
    loadSiteHistory('connections', (caller) =>
      caller.siteHistory.connections({ siteId: projectId }),
    ),
    loadSiteHistory('backups', (caller) => caller.siteHistory.backups({ siteId: projectId })),
  ])
  const root = siteHref(projectId, 'database')
  return (
    <SiteListFrame
      label="База и бэкап"
      title="База и бэкап"
      root={root}
      backLabel="Назад к базе и бэкапу"
      list={
        <SiteBlockNav
          root={root}
          blocks={databaseBlocks(
            connections === UNAVAILABLE ? undefined : connections.database,
            backups === UNAVAILABLE ? null : backups,
          )}
        />
      }
    >
      {children}
    </SiteListFrame>
  )
}
