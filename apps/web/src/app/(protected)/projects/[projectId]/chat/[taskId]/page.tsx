import type { Metadata } from 'next'

import { DialogView } from '@/components/chat/dialog-view'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'
import { chatServices } from '@/server/chat-services'

import { loadDialog } from './load-dialog'

type Params = Promise<{ projectId: string; taskId: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { projectId, taskId } = await params
  const loaded = await loadDialog(projectId, taskId)
  return { title: loaded === UNAVAILABLE ? 'Диалог' : (loaded.dialog.title ?? 'Диалог') }
}

/** One dialog: its feed and the field under it, and the panel of its changes beside it. */
export default async function Page({ params }: { params: Params }) {
  const { projectId, taskId } = await params
  const loaded = await loadDialog(projectId, taskId)
  if (loaded === UNAVAILABLE) return <ServiceUnavailable />
  const { site, dialog } = loaded
  return (
    <DialogView
      key={dialog.id}
      siteId={site.id}
      siteUrl={site.url}
      taskId={dialog.id}
      title={dialog.title}
      // Where the stream of a task's browser is opened (docs/plan/57-browser-tasks.md, Б12).
      browserStreamUrl={chatServices()?.browser?.streamUrl ?? null}
      // The switch of the mode leads only to a mode the site offers (29.10.2026).
      capabilities={site.capabilities}
    />
  )
}
