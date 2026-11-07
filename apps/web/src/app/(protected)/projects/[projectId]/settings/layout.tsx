import type { ReactNode } from 'react'

import { siteHref } from '@/components/site/site-nav'
import { SiteSection } from '@/components/site/site-section'

/**
 * «Настройки» with its tabs «Сайт» and «Опасная область» (docs/plan/64-cabinet-navigation.md, Н5).
 * Access is checked by every page under it.
 */
export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const root = siteHref((await params).projectId, 'settings')
  return (
    <SiteSection
      title="Настройки"
      root={root}
      tabs={[
        { label: 'Сайт', href: root, segments: ['', 'site'] },
        { label: 'Опасная область', href: `${root}/danger`, segments: ['danger'] },
      ]}
    >
      {children}
    </SiteSection>
  )
}
