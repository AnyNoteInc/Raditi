import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { TabContent } from '@/components/site/site-section'
import { UNAVAILABLE } from '@/lib/access'

import { accessesBlock } from '../blocks'

export const metadata: Metadata = { title: 'Доступы' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const block = await accessesBlock((await params).projectId, true)
  return block === UNAVAILABLE ? <ServiceUnavailable /> : <TabContent>{block}</TabContent>
}
