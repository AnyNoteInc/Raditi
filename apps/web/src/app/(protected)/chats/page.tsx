import Box from '@mui/material/Box'
import type { Metadata } from 'next'

import { projectOfSearch } from '@/components/chat/chat-address'
import { NewChat } from '@/components/chat/new-chat'
import { requireSession, UNAVAILABLE } from '@/lib/access'
import { speechAvailable } from '@/server/speech-runtime'

export const metadata: Metadata = { title: 'Чаты' }

/**
 * The root of «Чаты»: beside the list a new chat is ready; on a narrow screen it is the list. The
 * project its pill chose stands in `?project=<id>`, as on «Новый чат», so a reload keeps it.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[] }>
}) {
  const session = await requireSession()
  // The layout says so for the whole section.
  if (session === UNAVAILABLE) return null
  const projectId = projectOfSearch((await searchParams).project)
  return (
    <Box sx={{ display: { xs: 'none', md: 'flex' }, flex: '1 0 auto', flexDirection: 'column' }}>
      <NewChat
        key={projectId ?? 'none'}
        userId={session.user.id}
        userName={session.user.name}
        speech={speechAvailable()}
        projectId={projectId}
        beside
      />
    </Box>
  )
}
