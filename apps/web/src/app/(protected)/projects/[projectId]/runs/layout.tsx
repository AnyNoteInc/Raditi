import type { ReactNode } from 'react'

import { siteHref } from '@/components/site/site-nav'
import { SiteSection } from '@/components/site/site-section'

/**
 * «Запуски»: the list across the full width, a run as a page of its own
 * (docs/plan/64-cabinet-navigation.md, Н6). Access is checked by every page under it.
 */
export default async function RunsLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  return (
    <SiteSection title="Запуски" root={siteHref((await params).projectId, 'runs')}>
      {children}
    </SiteSection>
  )
}
