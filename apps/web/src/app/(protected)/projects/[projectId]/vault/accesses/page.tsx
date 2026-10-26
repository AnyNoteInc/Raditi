import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'

import { accessesBlock } from '../blocks'

export const metadata: Metadata = { title: 'Доступы' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const block = await accessesBlock((await params).projectId)
  return block === UNAVAILABLE ? <ServiceUnavailable /> : block
}
