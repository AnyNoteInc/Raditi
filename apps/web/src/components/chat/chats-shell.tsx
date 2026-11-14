'use client'

import Box from '@mui/material/Box'
import { useSelectedLayoutSegment } from 'next/navigation'
import type { CSSProperties, ReactNode } from 'react'

import { CABINET_GAP, CabinetShell } from '@/components/application/cabinet-shell'
import type { ApplicationUser } from '@/components/application/user-avatar'
import type { CabinetPanelState } from '@/lib/cabinet-panel'

import { NEW_CHAT_SEGMENT } from './chat-address'
import {
  PANE_DRAWN,
  PANE_OPEN_MARK,
  paneWidthCss,
  SITE_PANE_WIDTH,
  SITE_PANE_WIDTH_VAR,
} from './pane-layout'

/** The page draws the card of the tools beside a chat. */
/** The room the card of the tools takes at the right edge from `lg`, with the gaps around it. */
const PANE_ROOM = `calc(${SITE_PANE_WIDTH} + ${2 * CABINET_GAP}px)`

/**
 * «Чаты», the first section of the cabinet (docs/plan/61-chats-first.md, §5.11; the frame —
 * docs/plan/64-cabinet-navigation.md): the rail, the list of chats as the panel beside it, and the
 * content. At the root of the section a phone keeps the rail of 56; a new chat and an open one take
 * the whole phone screen, with their way back on top. From `lg` an open chat stands at the height
 * of the window and scrolls inside itself, and while the card of its tools is drawn at the right
 * edge, the list steps aside and the content leaves the card its room.
 */
export function ChatsShell({
  user,
  paneWidth = null,
  panelState = 'open',
  panelWidth = null,
  children,
}: {
  user: ApplicationUser
  /** The viewer's width of the panel beside a chat, from its cookie; null — the default. */
  paneWidth?: number | null
  /** The state of the list beside the rail, from its cookie. */
  panelState?: CabinetPanelState
  /** The width the viewer dragged the panel to, from its cookie; null — the default. */
  panelWidth?: number | null
  children: ReactNode
}) {
  const segment = useSelectedLayoutSegment()
  const item = segment !== null
  const chat = item && segment !== NEW_CHAT_SEGMENT
  return (
    <CabinetShell
      user={user}
      // The list of chats draws itself: below `md` it is the page at the root of the section.
      panel
      panelState={panelState}
      panelWidth={panelWidth}
      skipTarget="chats-content"
      railHiddenOnPhone={item}
      marks={{ 'data-chat-shell': '' }}
      // The panel beside a chat and the room the content leaves it read the same width.
      style={
        paneWidth === null
          ? undefined
          : ({ [SITE_PANE_WIDTH_VAR]: paneWidthCss(paneWidth) } as CSSProperties)
      }
      sx={
        chat ? { [`&[${PANE_OPEN_MARK}]`]: { '--cabinet-panel-space': { lg: '0px' } } } : undefined
      }
      contentSx={
        chat
          ? {
              // An open chat from `lg`: nothing below the card, the chat scrolls inside itself.
              height: { lg: 'calc(100dvh - 2 * var(--cabinet-gap))' },
              minHeight: { lg: 0 },
              overflow: { lg: 'hidden' },
              [PANE_DRAWN]: { mr: { lg: PANE_ROOM } },
            }
          : undefined
      }
      frameSx={chat ? { [PANE_DRAWN]: { right: { lg: PANE_ROOM } } } : undefined}
    >
      {/* Below `lg` a tool drawn in place of the chat takes the height the window leaves
          (docs/plan/59, И14): the content passes it down. */}
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
            [PANE_DRAWN]: { flex: { xs: '1 0 auto', lg: '1 1 0' } },
          }),
        }}
      >
        {children}
      </Box>
    </CabinetShell>
  )
}
