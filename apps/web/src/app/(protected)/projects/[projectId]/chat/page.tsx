import Box from '@mui/material/Box'
import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { NewDialog } from '@/components/site/new-dialog'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Чат' }

/** The root of «Чат»: beside the list a new dialog is ready; on a narrow screen it is the list. */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSiteSection((await params).projectId, 'chat')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  // Beside the list only: on a narrow screen the list is the whole area.
  return (
    <Box sx={{ display: { xs: 'none', md: 'flex' }, flex: '1 0 auto', flexDirection: 'column' }}>
      <NewDialog heading="h2" />
    </Box>
  )
}
