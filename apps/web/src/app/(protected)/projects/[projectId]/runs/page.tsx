import type { Metadata } from 'next'

import { SectionEmpty } from '@/components/site/section-empty'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Запуски' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSiteSection((await params).projectId, 'runs')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <SectionEmpty title="Запуски">
      Здесь появится каждое обновление сайта: его шаги и журнал.
    </SectionEmpty>
  )
}
