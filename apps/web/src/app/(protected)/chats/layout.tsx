import type { Viewport } from 'next'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'

import { CHATS_GROUP_COOKIE, parseChatsGroup } from '@/components/chat/chats-group'
import { ChatsFrame } from '@/components/chat/chats-frame'
import { ChatsShell } from '@/components/chat/chats-shell'
import { parsePaneWidth, SITE_PANE_COOKIE } from '@/components/chat/pane-layout'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

/** The field of a chat sits above the gesture area of a phone. */
export const viewport: Viewport = { viewportFit: 'cover' }

/**
 * «Чаты» (docs/plan/61-chats-first.md, §5.11): the rail, the list of chats and the content. It reads
 * nothing about a site, and it is not rendered again on navigation: the list asks the server
 * itself, and access to a chat is checked by its page. The viewer's width of the panel beside a
 * chat (docs/plan/57, Б29) and the way of the list are drawn at once, from their cookies.
 */
export default async function ChatsLayout({ children }: { children: ReactNode }) {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  const jar = await cookies()
  return (
    <ChatsShell user={session.user} paneWidth={parsePaneWidth(jar.get(SITE_PANE_COOKIE)?.value)}>
      <ChatsFrame group={parseChatsGroup(jar.get(CHATS_GROUP_COOKIE)?.value)}>
        {children}
      </ChatsFrame>
    </ChatsShell>
  )
}
