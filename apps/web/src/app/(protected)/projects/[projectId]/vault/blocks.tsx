import type { ReactNode } from 'react'

import { stackLabels } from '@/components/projects/project-labels'
import { SiteAccesses } from '@/components/site/site-accesses'
import { SiteEnvVars } from '@/components/site/site-env-vars'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteCredentials, loadSiteHistory, loadSiteSection } from '@/lib/site'

// The two blocks of «Переменные» as its tabs read them (`nested`: the heading of the section is
// above). UNAVAILABLE — the site could not be read; the page says so.

/** «Переменные окружения»: the list reads itself, an owner or an admin changes it. */
export async function variablesBlock(
  projectId: string,
  nested = false,
): Promise<ReactNode | typeof UNAVAILABLE> {
  const site = await loadSiteSection(projectId, 'vault')
  if (site === UNAVAILABLE) return UNAVAILABLE
  return (
    <SiteEnvVars
      siteId={site.id}
      withFiles={site.capabilities.repository !== 'absent'}
      nested={nested}
    />
  )
}

/** «Доступы»: the saved accesses, and what a change of one starts from. */
export async function accessesBlock(
  projectId: string,
  nested = false,
): Promise<ReactNode | typeof UNAVAILABLE> {
  const site = await loadSiteSection(projectId, 'vault')
  if (site === UNAVAILABLE) return UNAVAILABLE
  const [accesses, editable] = await Promise.all([
    loadSiteCredentials(projectId),
    loadSiteHistory('editable access', (caller) =>
      caller.siteConnection.editableAccess({ id: site.id }),
    ),
  ])
  return (
    <SiteAccesses
      nested={nested}
      siteId={site.id}
      stack={site.stack}
      platform={stackLabels[site.stack]}
      accesses={accesses === UNAVAILABLE ? null : accesses}
      editable={editable === UNAVAILABLE ? null : editable}
    />
  )
}
