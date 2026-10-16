import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { NewDialog } from '@/components/site/new-dialog'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Новый диалог' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSiteSection((await params).projectId, 'chat')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  return <NewDialog />
}
