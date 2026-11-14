import Box from '@mui/material/Box'
import type { Metadata } from 'next'

import { NewChat } from '@/components/chat/new-chat'
import { requireSession, UNAVAILABLE } from '@/lib/access'
import { speechAvailable } from '@/server/speech-runtime'

export const metadata: Metadata = { title: 'Чаты' }

/** The root of «Чаты»: beside the list a new chat is ready; on a narrow screen it is the list. */
export default async function Page() {
  const session = await requireSession()
  // The layout says so for the whole section.
  if (session === UNAVAILABLE) return null
  return (
    <Box sx={{ display: { xs: 'none', md: 'flex' }, flex: '1 0 auto', flexDirection: 'column' }}>
      <NewChat
        userId={session.user.id}
        userName={session.user.name}
        speech={speechAvailable()}
        beside
      />
    </Box>
  )
}
