import type { ReactNode } from 'react'

import { SiteBlockNav } from '@/components/site/site-block-nav'
import { SiteListFrame } from '@/components/site/site-list-frame'
import { siteHref } from '@/components/site/site-nav'
import { vaultBlocks } from '@/components/site/vault-blocks'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteCredentials } from '@/lib/site'

/**
 * «Переменные», split by its cards (owner's request of 26.10.2026): the menu of its blocks beside
 * the one that is open, at the root the first. Access is checked by every page under it; the read
 * of the menu checks it itself.
 */
export default async function VaultLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const accesses = await loadSiteCredentials(projectId)
  const root = siteHref(projectId, 'vault')
  return (
    <SiteListFrame
      label="Переменные"
      title="Переменные"
      root={root}
      backLabel="Назад к переменным"
      list={
        <SiteBlockNav
          root={root}
          blocks={vaultBlocks(accesses === UNAVAILABLE ? null : accesses)}
        />
      }
    >
      {children}
    </SiteListFrame>
  )
}
