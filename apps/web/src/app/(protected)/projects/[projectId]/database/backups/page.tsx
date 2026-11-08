import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { TabContent } from '@/components/site/site-section'
import { UNAVAILABLE } from '@/lib/access'

import { backupsBlock } from '../blocks'

export const metadata: Metadata = { title: 'Копии' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const block = await backupsBlock((await params).projectId, true)
  return block === UNAVAILABLE ? <ServiceUnavailable /> : <TabContent>{block}</TabContent>
}
