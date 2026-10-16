import type { Metadata } from 'next'

import { SectionEmpty } from '@/components/site/section-empty'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Изменения' }

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const site = await loadSiteSection((await params).projectId, 'changes')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <SectionEmpty title="Изменения">
      Здесь появится всё, что менялось на сайте: версии и правки текстов, цен и фото.
    </SectionEmpty>
  )
}
