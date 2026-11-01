import { notFound, redirect } from 'next/navigation'

import { movedChatAddress } from '@/components/chat/chat-address'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { UNAVAILABLE } from '@/lib/access'
import { loadSite } from '@/lib/site'

/**
 * The addresses a chat of a project had (docs/plan/61-chats-first.md, К4): they lead to «Чаты». The
 * site is read first, so that the old address of a project of someone else is «not found».
 */
export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string; rest?: string[] }>
}) {
  const { projectId, rest = [] } = await params
  const site = await loadSite(projectId)
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  const address = movedChatAddress(site.id, rest)
  if (address === null) notFound()
  redirect(address)
}
