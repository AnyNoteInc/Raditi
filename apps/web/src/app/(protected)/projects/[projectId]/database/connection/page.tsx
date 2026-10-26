import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'

import { databaseConnectionBlock } from '../blocks'

export const metadata: Metadata = { title: 'База данных сайта' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const block = await databaseConnectionBlock((await params).projectId)
  return block === UNAVAILABLE ? <ServiceUnavailable /> : block
}
