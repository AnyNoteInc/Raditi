import Box from '@mui/material/Box'
import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'

import { variablesBlock } from './blocks'

export const metadata: Metadata = { title: 'Переменные' }

/** «Переменные» at its root: the first block beside the menu. On a phone the menu alone is shown. */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const block = await variablesBlock((await params).projectId, true)
  if (block === UNAVAILABLE) return <ServiceUnavailable />
  return <Box sx={{ display: { xs: 'none', md: 'block' } }}>{block}</Box>
}
