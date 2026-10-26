import type { Metadata } from 'next'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'

import { variablesBlock } from '../blocks'

export const metadata: Metadata = { title: 'Переменные окружения' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const block = await variablesBlock((await params).projectId)
  return block === UNAVAILABLE ? <ServiceUnavailable /> : block
}
