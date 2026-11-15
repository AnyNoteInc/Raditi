import type { Metadata } from 'next'

import { NewChat } from '@/components/chat/new-chat'
import { requireSession, UNAVAILABLE } from '@/lib/access'
import { speechAvailable } from '@/server/speech-runtime'

export const metadata: Metadata = { title: 'Новый чат' }

export default async function Page() {
  const session = await requireSession()
  // The layout says so for the whole section.
  if (session === UNAVAILABLE) return null
  return (
    <NewChat userId={session.user.id} userName={session.user.name} speech={speechAvailable()} />
  )
}
