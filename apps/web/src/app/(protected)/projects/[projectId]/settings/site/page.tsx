import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'

import { siteBlock } from '../blocks'

export const metadata: Metadata = { title: 'Сайт' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const block = await siteBlock((await params).projectId)
  return block === UNAVAILABLE ? <ServiceUnavailable /> : block
}
