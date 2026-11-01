'use client'

import Box from '@mui/material/Box'
import { useSelectedLayoutSegment } from 'next/navigation'
import type { CSSProperties, ReactNode } from 'react'

import { ApplicationRail } from '@/components/application/application-rail'
import { applicationSurface } from '@/components/application/application-surface'
import { SkipLink } from '@/components/application/skip-link'
import type { ApplicationUser } from '@/components/application/user-avatar'

import { NEW_CHAT_SEGMENT } from './chat-address'
import { CHATS_LIST_WIDTH, paneWidthCss, SITE_PANE_WIDTH, SITE_PANE_WIDTH_VAR } from './pane-layout'

/** The rail of the section with the side of a phone held sideways. */
const railWidth = (width: number) => `calc(${width}px + env(safe-area-inset-left))`

/**
 * «Чаты», the first section of the cabinet (docs/plan/61-chats-first.md, §5.11): the rail, and under
 * no bar the column of chats and the content. At the root of the section a phone keeps the rail
 * of 56; a new chat and an open one take the whole phone screen, with their way back on top. From
 * `lg` an open chat stands at the height of the window and scrolls inside itself, and the content
 * leaves room for the panel of its tools only while that is drawn.
 */
export function ChatsShell({
  user,
  paneWidth = null,
  children,
}: {
  user: ApplicationUser
  /** The viewer's width of the panel beside a chat, from its cookie; null — the default. */
  paneWidth?: number | null
  children: ReactNode
}) {
  const segment = useSelectedLayoutSegment()
  const item = segment !== null
  const chat = item && segment !== NEW_CHAT_SEGMENT
  return (
    <Box
      data-chat-shell=""
      // The panel beside a chat and the room the content leaves it read the same width.
      style={
        paneWidth === null
          ? undefined
          : ({ [SITE_PANE_WIDTH_VAR]: paneWidthCss(paneWidth) } as CSSProperties)
      }
      sx={{
        ...applicationSurface,
        '--app-rail-width': { xs: item ? '0px' : railWidth(56), sm: railWidth(72) },
        bgcolor: 'background.paper',
      }}
    >
      <SkipLink target="chats-content" left={{ xs: 8, sm: 84 }} />
      <ApplicationRail user={user} hiddenOnPhone={item} />
      <Box
        sx={{
          ml: 'var(--app-rail-width)',
          mr: 'env(safe-area-inset-right)',
          minWidth: 0,
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          // An open chat from `lg`: nothing below the surface, the chat scrolls inside itself.
          ...(chat && { height: { lg: '100dvh' }, overflow: { lg: 'hidden' } }),
        }}
      >
        {/* The content leaves room for the column of chats from `md`, and from `lg` for the panel
            of the tools. Below `lg` a tool drawn in place of the chat takes the height the window
            leaves (docs/plan/59, И14): this box and the content pass it down. */}
        <Box
          sx={{
            ml: { md: `${CHATS_LIST_WIDTH}px` },
            minWidth: 0,
            flex: '1 0 auto',
            display: 'flex',
            flexDirection: 'column',
            ...(chat && {
              flex: { lg: '1 1 0' },
              minHeight: { lg: 0 },
              '&:has([data-chat-pane])': {
                ml: { lg: 0 },
                mr: { lg: SITE_PANE_WIDTH },
                flex: { xs: '1 0 auto', lg: '1 1 0' },
              },
            }),
          }}
        >
          <Box
            component="main"
            id="chats-content"
            tabIndex={-1}
            sx={{
              px: { xs: 2, sm: 2.5, md: 4 },
              py: { xs: 3, md: 3.5 },
              minWidth: 0,
              outline: 'none',
              flex: '1 0 auto',
              display: 'flex',
              flexDirection: 'column',
              ...(chat && {
                flex: { lg: '1 1 0' },
                minHeight: { lg: 0 },
                '&:has([data-chat-pane])': { flex: { xs: '1 0 auto', lg: '1 1 0' } },
              }),
            }}
          >
            {children}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
