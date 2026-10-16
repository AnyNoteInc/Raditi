import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

import { SiteListFrame } from '@/components/site/site-list-frame'
import { siteHref } from '@/components/site/site-nav'

/**
 * «Чат»: the list of dialogs beside the dialog. The layout reads nothing about the site — it
 * is not rendered again on navigation, so access is checked by every page under it.
 */
export default async function ChatLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  return (
    <SiteListFrame
      label="Диалоги"
      title="Чат"
      root={siteHref((await params).projectId, 'chat')}
      action={{ segment: 'new', label: 'Новый диалог' }}
      backLabel="Назад к диалогам"
      list={
        <Typography variant="body2" color="text.secondary">
          Диалогов пока нет — они появятся здесь, когда мы начнём принимать задания из кабинета.
        </Typography>
      }
    >
      {children}
    </SiteListFrame>
  )
}
