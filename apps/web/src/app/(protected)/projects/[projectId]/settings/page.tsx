import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { TabContent } from '@/components/site/site-section'
import { UNAVAILABLE } from '@/lib/access'

import { siteBlock } from './blocks'

export const metadata: Metadata = { title: 'Настройки сайта' }

/** The section at its root: its first tab (docs/plan/64-cabinet-navigation.md, Н5). */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const block = await siteBlock((await params).projectId, true)
  if (block === UNAVAILABLE) return <ServiceUnavailable />
  return <TabContent>{block}</TabContent>
}
