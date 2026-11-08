import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { TabContent } from '@/components/site/site-section'
import { UNAVAILABLE } from '@/lib/access'

import { databaseConnectionBlock } from '../blocks'

export const metadata: Metadata = { title: 'База данных сайта' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const block = await databaseConnectionBlock((await params).projectId, true)
  return block === UNAVAILABLE ? <ServiceUnavailable /> : <TabContent>{block}</TabContent>
}
