import type { Metadata } from 'next'

import { NewChat } from '@/components/chat/new-chat'
import { requireSession, UNAVAILABLE } from '@/lib/access'
import { speechAvailable } from '@/server/speech-runtime'

export const metadata: Metadata = { title: 'Новый чат' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * «Новый чат»; `?project=<id>` chooses the project of the chat at once (docs/plan/84-projects.md,
 * ПР30). Whose project it is the field learns from the list of the user's projects.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[] }>
}) {
  const session = await requireSession()
  // The layout says so for the whole section.
  if (session === UNAVAILABLE) return null
  const { project } = await searchParams
  const projectId = typeof project === 'string' && UUID.test(project) ? project : null
  return (
    <NewChat
      // A new address of a project is a new start: the field takes its project anew.
      key={projectId ?? 'none'}
      userId={session.user.id}
      userName={session.user.name}
      speech={speechAvailable()}
      projectId={projectId}
    />
  )
}
