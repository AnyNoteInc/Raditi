import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { DocumentWindow } from '@/components/chat/document-window'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'

import { loadChat } from '../../load-chat'

type Params = Promise<{ taskId: string; fileId: string }>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const metadata: Metadata = { title: 'Страницы' }

/**
 * «Открыть в новой вкладке» of a document of the agent (docs/plan/67-agent-documents.md, Д4): the
 * tab «Страницы» over the whole window, on this version, for a member of the chat. The address of
 * the page in its frame lives five minutes and never leaves the cabinet; this one does.
 */
export default async function Page({ params }: { params: Params }) {
  const { taskId, fileId } = await params
  const chat = await loadChat(taskId)
  if (chat === UNAVAILABLE) return <ServiceUnavailable />
  if (!UUID.test(fileId)) notFound()
  return <DocumentWindow taskId={chat.id} fileId={fileId.toLowerCase()} />
}
