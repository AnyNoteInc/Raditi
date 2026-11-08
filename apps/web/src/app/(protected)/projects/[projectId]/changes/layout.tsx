import type { ReactNode } from 'react'

import { siteHref } from '@/components/site/site-nav'
import { SiteSection } from '@/components/site/site-section'

/**
 * «Изменения»: the versions of the site, a list across the full width; a version opens as a page of
 * its own under it (docs/plan/64-cabinet-navigation.md, Н6). The tab «Файлы» — the files of the
 * version on the site — is gone since 07.11.2026 (the owner's request). Access is checked by every
 * page.
 */
export default async function ChangesLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const root = siteHref((await params).projectId, 'changes')
  return (
    <SiteSection title="Изменения" root={root}>
      {children}
    </SiteSection>
  )
}
