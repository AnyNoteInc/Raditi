import type { ReactNode } from 'react'

import { siteHref } from '@/components/site/site-nav'
import { SiteSection } from '@/components/site/site-section'

/**
 * «Переменные» with its tabs «Переменные окружения» and «Доступы»
 * (docs/plan/64-cabinet-navigation.md, Н5). Access is checked by every page under it.
 */
export default async function VaultLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const root = siteHref((await params).projectId, 'vault')
  return (
    <SiteSection
      title="Переменные"
      root={root}
      tabs={[
        { label: 'Переменные окружения', href: root, segments: ['', 'variables'] },
        { label: 'Доступы', href: `${root}/accesses`, segments: ['accesses'] },
      ]}
    >
      {children}
    </SiteSection>
  )
}
