import type { ReactNode } from 'react'

import { siteHref } from '@/components/site/site-nav'
import { SiteSection } from '@/components/site/site-section'

/**
 * «Изменения» with its tabs «Файлы» — the files of the version on the site, until 07.11.2026 the
 * section «Терминал» — and «Версии», a list across the full width; a version opens as a page of its
 * own under the tab (docs/plan/64-cabinet-navigation.md, Н4–Н6). Access is checked by every page.
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
    <SiteSection
      title="Изменения"
      root={root}
      tabs={[
        { label: 'Файлы', href: root, segments: [''] },
        { label: 'Версии', href: `${root}/versions`, segments: ['versions'], rest: true },
      ]}
    >
      {children}
    </SiteSection>
  )
}
