import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { TabContent } from '@/components/site/site-section'
import { UNAVAILABLE } from '@/lib/access'

import { dangerBlock } from '../blocks'

export const metadata: Metadata = { title: 'Опасная область' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const block = await dangerBlock((await params).projectId, true)
  return block === UNAVAILABLE ? <ServiceUnavailable /> : <TabContent>{block}</TabContent>
}
