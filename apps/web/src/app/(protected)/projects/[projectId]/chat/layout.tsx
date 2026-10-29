import type { ReactNode } from 'react'

import { DialogList } from '@/components/chat/dialog-list'
import { SiteListFrame } from '@/components/site/site-list-frame'
import { siteHref } from '@/components/site/site-nav'

/**
 * «Чат»: the list of dialogs beside the dialog; the credits are over the account menu of the
 * rail (owner's request of 29.10.2026). The layout reads nothing about the site — it is not
 * rendered again on navigation, so access is checked by every page under it, and the list asks
 * the server itself. An open dialog takes the width of the list from `lg`: the panel of its
 * changes stands beside it.
 */
export default async function ChatLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  return (
    <SiteListFrame
      label="Диалоги"
      title="Чат"
      root={siteHref(projectId, 'chat')}
      action={{ segment: 'new', label: 'Новый диалог' }}
      backLabel="Назад к диалогам"
      collapseOnItem
      list={<DialogList siteId={projectId} />}
    >
      {children}
    </SiteListFrame>
  )
}
