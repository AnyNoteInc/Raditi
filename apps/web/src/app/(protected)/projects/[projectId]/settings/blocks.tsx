import type { ReactNode } from 'react'

import { SiteDangerZone } from '@/components/site/site-danger-zone'
import { DangerBlock, SiteSettings } from '@/components/site/site-settings'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory, loadSiteSection } from '@/lib/site'

// The two blocks of «Настройки» as its pages read them: the block's own page, and the root of
// the section, which shows the first block beside the menu (`nested`). UNAVAILABLE — the site
// could not be read; the page says so.

/** «Сайт»: what the site is, and how its files reach Радити when that could be read. */
export async function siteBlock(
  projectId: string,
  nested = false,
): Promise<ReactNode | typeof UNAVAILABLE> {
  const site = await loadSiteSection(projectId, 'settings')
  if (site === UNAVAILABLE) return UNAVAILABLE
  const connections = await loadSiteHistory('connections', (caller) =>
    caller.siteHistory.connections({ siteId: site.id }),
  )
  return (
    <SiteSettings
      nested={nested}
      site={site}
      {...(connections === UNAVAILABLE ? {} : { source: connections.source })}
    />
  )
}

/** «Опасная область»: «Удалить проект». */
export async function dangerBlock(projectId: string): Promise<ReactNode | typeof UNAVAILABLE> {
  const site = await loadSiteSection(projectId, 'settings')
  if (site === UNAVAILABLE) return UNAVAILABLE
  return (
    <DangerBlock>
      <SiteDangerZone site={{ id: site.id, name: site.name }} untitled />
    </DangerBlock>
  )
}
