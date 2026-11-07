import type { ReactNode } from 'react'

import { siteHref } from '@/components/site/site-nav'
import { SiteSection } from '@/components/site/site-section'

/**
 * «База» (until 07.11.2026 «База и бэкап») with its tabs «Подключение» and «Копии»
 * (docs/plan/64-cabinet-navigation.md, Н5). Access is checked by every page under it.
 */
export default async function DatabaseLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const root = siteHref((await params).projectId, 'database')
  return (
    <SiteSection
      title="База"
      root={root}
      tabs={[
        { label: 'Подключение', href: root, segments: ['', 'connection'] },
        { label: 'Копии', href: `${root}/backups`, segments: ['backups'] },
      ]}
    >
      {children}
    </SiteSection>
  )
}
