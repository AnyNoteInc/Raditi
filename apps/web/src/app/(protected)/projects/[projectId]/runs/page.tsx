import Box from '@mui/material/Box'
import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { NoRuns, RunDetail } from '@/components/site/site-runs'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory, loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Запуски' }

/** «Запуски» at its root: the newest run. On a phone the list alone is shown. */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSiteSection((await params).projectId, 'runs')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  const runs = await loadSiteHistory('runs', (caller) =>
    caller.siteHistory.runs({ siteId: site.id }),
  )
  if (runs === UNAVAILABLE) return <ServiceUnavailable />
  const newest = runs[0]
  if (!newest) return <NoRuns />
  const run = await loadSiteHistory('run', (caller) =>
    caller.siteHistory.run({ siteId: site.id, runId: newest.id }),
  )
  if (run === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <Box sx={{ display: { xs: 'none', md: 'block' } }}>
      <RunDetail siteId={site.id} run={run} now={new Date()} nested />
    </Box>
  )
}
