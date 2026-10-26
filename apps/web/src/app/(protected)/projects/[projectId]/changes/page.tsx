import Box from '@mui/material/Box'
import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { NoVersions, VersionDetail } from '@/components/site/site-versions'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory, loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Изменения' }

/** «Изменения» at its root: the version on the site now. On a phone the list alone is shown. */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSiteSection((await params).projectId, 'changes')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  const versions = await loadSiteHistory('versions', (caller) =>
    caller.siteHistory.versions({ siteId: site.id }),
  )
  if (versions === UNAVAILABLE) return <ServiceUnavailable />
  const index = versions.findIndex((version) => version.current)
  const version = versions[index === -1 ? 0 : index]
  if (!version) return <NoVersions />
  return (
    <Box sx={{ display: { xs: 'none', md: 'block' } }}>
      <VersionDetail
        siteId={site.id}
        version={version}
        next={versions[(index === -1 ? 0 : index) - 1] ?? null}
        now={new Date()}
        nested
      />
    </Box>
  )
}
