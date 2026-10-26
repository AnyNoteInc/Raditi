import type { ReactNode } from 'react'

import { SiteBlockNav } from '@/components/site/site-block-nav'
import { SiteListFrame } from '@/components/site/site-list-frame'
import { siteHref } from '@/components/site/site-nav'
import { settingsBlocks } from '@/components/site/site-settings'
import { UNAVAILABLE } from '@/lib/access'
import { loadSite } from '@/lib/site'

/**
 * «Настройки», split by its cards (owner's request of 26.10.2026): the menu of its blocks beside
 * the one that is open, at the root the first. Access is checked by every page under it; the read
 * of the menu checks it itself.
 */
export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const site = await loadSite(projectId)
  const root = siteHref(projectId, 'settings')
  return (
    <SiteListFrame
      label="Настройки"
      title="Настройки"
      root={root}
      backLabel="Назад к настройкам"
      list={
        <SiteBlockNav
          root={root}
          blocks={settingsBlocks(site === UNAVAILABLE ? { host: '' } : site)}
        />
      }
    >
      {children}
    </SiteListFrame>
  )
}
