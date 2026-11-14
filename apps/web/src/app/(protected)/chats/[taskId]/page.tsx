import type { Metadata } from 'next'

import { DialogView } from '@/components/chat/dialog-view'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'
import { chatServices } from '@/server/chat-services'
import { speechAvailable } from '@/server/speech-runtime'

import { loadChat } from './load-chat'

type Params = Promise<{ taskId: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const loaded = await loadChat((await params).taskId)
  return { title: loaded === UNAVAILABLE ? 'Чат' : (loaded.title ?? 'Чат') }
}

/** One chat: its feed and the field under it, and the panel of its tools beside it. */
export default async function Page({ params }: { params: Params }) {
  const chat = await loadChat((await params).taskId)
  if (chat === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <DialogView
      key={chat.id}
      project={chat.project}
      taskId={chat.id}
      title={chat.title}
      // Where the stream of a task's browser is opened (docs/plan/57-browser-tasks.md, Б12).
      browserStreamUrl={chatServices()?.browser?.streamUrl ?? null}
      // Dictation into the field (docs/plan/75-chat-input-output.md, ВВ16).
      speech={speechAvailable()}
    />
  )
}
