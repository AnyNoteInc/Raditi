import type { ReactNode } from 'react'

import Box from '@mui/material/Box'

import { SiteAgentSkills } from '@/components/site/site-agent-skills'
import { SiteDangerZone } from '@/components/site/site-danger-zone'
import { DangerBlock, SiteSettings } from '@/components/site/site-settings'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory, loadSiteSection } from '@/lib/site'

// The two blocks of «Настройки» as its tabs read them (`nested`: the section's heading is above). UNAVAILABLE — the site
// could not be read; the page says so.

/**
 * «Сайт»: what the site is, how its files reach Радити when that could be read, and the agent's
 * skills — the MCP servers it calls, some with a key (docs/plan/80-mcp-server-credentials.md).
 */
export async function siteBlock(
  projectId: string,
  nested = false,
): Promise<ReactNode | typeof UNAVAILABLE> {
  const site = await loadSiteSection(projectId, 'settings')
  if (site === UNAVAILABLE) return UNAVAILABLE
  const [connections, skills] = await Promise.all([
    loadSiteHistory('connections', (caller) => caller.siteHistory.connections({ siteId: site.id })),
    loadSiteHistory('skills', (caller) => caller.siteAgentSkills.list({ siteId: site.id })),
  ])
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.25 }}>
      <SiteSettings
        nested={nested}
        site={site}
        {...(connections === UNAVAILABLE ? {} : { source: connections.source })}
      />
      {skills === UNAVAILABLE ? null : <SiteAgentSkills siteId={site.id} initial={skills} />}
    </Box>
  )
}

/** «Опасная область»: «Удалить проект». */
export async function dangerBlock(
  projectId: string,
  nested = false,
): Promise<ReactNode | typeof UNAVAILABLE> {
  const site = await loadSiteSection(projectId, 'settings')
  if (site === UNAVAILABLE) return UNAVAILABLE
  return (
    <DangerBlock nested={nested}>
      <SiteDangerZone site={{ id: site.id, name: site.name }} untitled />
    </DangerBlock>
  )
}
