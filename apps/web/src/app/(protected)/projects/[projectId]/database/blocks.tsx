import type { ReactNode } from 'react'

import { DatabaseDumpForm } from '@/components/site/database-dump-form'
import { BackupsBlock, DatabaseBlock } from '@/components/site/site-database'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory, loadSiteSection } from '@/lib/site'

// The two blocks of «База и бэкап» as its pages read them: the block's own page, and the root of
// the section, which shows the first block beside the menu (`nested`). UNAVAILABLE — what the
// block needs could not be read; the page says so.

/** «База данных сайта»: the database as the platform knows it, or the SQL dump form without one. */
export async function databaseConnectionBlock(
  projectId: string,
  nested = false,
): Promise<ReactNode | typeof UNAVAILABLE> {
  const site = await loadSiteSection(projectId, 'database')
  if (site === UNAVAILABLE) return UNAVAILABLE
  const [connections, dump] = await Promise.all([
    loadSiteHistory('connections', (caller) => caller.siteHistory.connections({ siteId: site.id })),
    loadSiteHistory('database dump', (caller) => caller.siteDatabaseDump.get({ siteId: site.id })),
  ])
  if (connections === UNAVAILABLE) return UNAVAILABLE
  return (
    <DatabaseBlock
      nested={nested}
      database={connections.database}
      dump={
        dump === UNAVAILABLE || dump.liveDatabase ? undefined : (
          <DatabaseDumpForm siteId={site.id} initial={dump} />
        )
      }
    />
  )
}

/** «Копии»: the copies the platform made; a list that cannot be read is said in the block. */
export async function backupsBlock(
  projectId: string,
  nested = false,
): Promise<ReactNode | typeof UNAVAILABLE> {
  const site = await loadSiteSection(projectId, 'database')
  if (site === UNAVAILABLE) return UNAVAILABLE
  const backups = await loadSiteHistory('backups', (caller) =>
    caller.siteHistory.backups({ siteId: site.id }),
  )
  return (
    <BackupsBlock
      nested={nested}
      siteId={site.id}
      backups={backups === UNAVAILABLE ? null : backups}
    />
  )
}
