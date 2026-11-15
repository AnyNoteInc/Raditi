'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import Link from 'next/link'
import { useSelectedLayoutSegment } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import {
  CABINET_PANEL_ID,
  PanelToggle,
  useCabinetPanel,
} from '@/components/application/cabinet-panel'
import { PanelResizer } from '@/components/application/panel-resizer'
import {
  CABINET_GAP,
  CABINET_PANEL_WIDTH,
  CABINET_RADIUS,
} from '@/components/application/cabinet-shell'

import { CHATS_HREF, NEW_CHAT_HREF, NEW_CHAT_SEGMENT } from './chat-address'
import { PANE_DRAWN } from './pane-layout'
import { chatsText, listText } from './chat-texts'
import { SearchDialog } from './search-dialog'
import { ArchiveButton, DialogList, useChatsKnownEmpty } from './dialog-list'

/** The page draws the panel of the tools beside a chat: the list gives the chat its room. */

/**
 * «Чаты» laid out as «list — content» (docs/plan/61-chats-first.md, §5.11). From `md` the list is
 * a column from the top of the window to its bottom beside the rail, and it scrolls on its own.
 * Below `md` there is one area: the list at the root of the section, an item with the way back on
 * top. Which of them is on the screen is decided by styles alone, so the first paint is right on
 * every width. An open chat gives the column up from `lg` while the panel of its tools is drawn.
 */
export function ChatsFrame({ children }: { children: ReactNode }) {
  const segment = useSelectedLayoutSegment()
  const selected = segment !== null
  const collapsed = selected && segment !== NEW_CHAT_SEGMENT
  // «Найти чат» opens by the loupe of the head (docs/plan/77, Р2).
  const [searching, setSearching] = useState(false)
  const empty = useChatsKnownEmpty()
  const { open: panelOpen } = useCabinetPanel()

  // Below `md` a move between the list and an item hides the link that had the focus. The focus
  // then goes to the content instead of being dropped to the top of the document.
  const previous = useRef(segment)
  useEffect(() => {
    if (previous.current === segment) return
    previous.current = segment
    const active = document.activeElement
    if (!active || active === document.body || active.getClientRects().length === 0) {
      document.getElementById('chats-content')?.focus({ preventScroll: true })
    }
  }, [segment])

  return (
    <Box
      sx={{
        flex: '1 0 auto',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        // An open chat stands at the height of the window from `lg`: the frame passes it on.
        ...(collapsed && { flex: { xs: '1 0 auto', lg: '1 1 0' }, minHeight: { lg: 0 } }),
      }}
    >
      <Box
        component="nav"
        id={CABINET_PANEL_ID}
        aria-label={chatsText.title}
        // The browser of a chat over the content covers this column: it leaves the tab order then.
        data-chat-list=""
        sx={{
          // A column on a phone, so the pinned action has the whole list to stick within.
          display: {
            xs: selected ? 'none' : 'flex',
            sm: selected ? 'none' : 'grid',
            md: panelOpen ? 'grid' : 'none',
          },
          ...(collapsed && { [PANE_DRAWN]: { display: { lg: 'none' } } }),
          flexDirection: 'column',
          flex: '1 0 auto',
          minWidth: 0,
          // In the panel from `md` «Новый чат» takes a row of its own under the heading and its
          // buttons: the card is too narrow for all of them in one line.
          gridTemplateColumns: { sm: 'minmax(0, 1fr) auto', md: 'minmax(0, 1fr)' },
          // The last row is «Архив», pinned to the bottom of the card (docs/plan/77, Р1).
          gridTemplateRows: { sm: 'auto 1fr auto', md: 'auto auto 1fr auto' },
          alignItems: { xs: 'stretch', sm: 'start' },
          gap: '12px 8px',
          // From `md` the list is the panel beside the rail (docs/plan/64-cabinet-navigation.md,
          // Н2): a card the viewer hides with «]».
          position: { md: 'fixed' },
          top: { md: CABINET_GAP },
          bottom: { md: CABINET_GAP },
          left: { md: 'var(--app-rail-width)' },
          width: { md: CABINET_PANEL_WIDTH },
          overflowY: { md: 'auto' },
          px: { md: 1.5 },
          pt: { md: 1.5 },
          pb: { md: 'max(16px, env(safe-area-inset-bottom))' },
          bgcolor: { md: 'background.paper' },
          border: { md: 1 },
          borderColor: { md: 'divider' },
          borderRadius: { md: CABINET_RADIUS },
          zIndex: { md: 1100 },
        }}
      >
        {/* First, out of the flow: it stands on the right edge of the card from `md`. */}
        <PanelResizer label="Ширина списка чатов" />
        {/* The heading of the page while the list is all there is; beside an item, of the list. */}
        <Box sx={{ alignSelf: 'center', minWidth: 0, display: 'flex', alignItems: 'center' }}>
          <Typography
            component={selected ? 'h2' : 'h1'}
            sx={{
              flex: '1 1 auto',
              minWidth: 0,
              pl: { md: 1.5 },
              fontSize: { xs: 26, md: 18 },
              fontWeight: 600,
              lineHeight: 1.25,
            }}
          >
            {chatsText.title}
          </Typography>
          {empty ? null : (
            // The loupe left of «]» opens «Поиск чатов» (docs/plan/77, Р2; docs/plan/79, П1).
            <IconButton
              aria-label={listText.search}
              aria-haspopup="dialog"
              onClick={() => setSearching(true)}
              sx={{ width: 44, height: 44, color: 'text.secondary' }}
            >
              <AppIcon name="search" size={18} />
            </IconButton>
          )}
          <PanelToggle place="panel" />
        </Box>
        <Button
          component={Link}
          href={NEW_CHAT_HREF}
          aria-current={segment === NEW_CHAT_SEGMENT ? 'page' : undefined}
          variant="contained"
          startIcon={<AppIcon name="plus" size={18} />}
          sx={{
            order: { xs: 1, sm: 0 },
            gridRow: { sm: 1, md: 2 },
            gridColumn: { sm: 2, md: 1 },
            minHeight: { xs: 48, sm: 44 },
            borderRadius: '999px',
            whiteSpace: 'nowrap',
            // On a phone the action stays within reach under a long list.
            position: { xs: 'sticky', sm: 'static' },
            bottom: { xs: 'calc(12px + env(safe-area-inset-bottom))' },
          }}
        >
          {chatsText.newChat}
        </Button>
        <Box
          sx={{
            flex: { xs: '1 0 auto' },
            gridColumn: { sm: '1 / -1' },
            gridRow: { sm: 2, md: 3 },
            minWidth: 0,
            px: { md: 1.5 },
          }}
        >
          <DialogList />
        </Box>
        {/* «Архив» at the bottom of the card, whatever the length of the list (Р1). */}
        <Box
          sx={{
            order: { xs: 2, sm: 0 },
            gridColumn: { sm: '1 / -1' },
            gridRow: { sm: 3, md: 4 },
            alignSelf: 'end',
            position: { sm: 'sticky' },
            bottom: { sm: 0 },
            zIndex: 1,
            pt: 1,
            bgcolor: { md: 'background.paper' },
          }}
        >
          <ArchiveButton />
          <SearchDialog open={searching} onClose={() => setSearching(false)} />
        </Box>
      </Box>

      {/* Never hidden: at the root a page may answer with a state the user has to see. What is
          only for the wide layout (the new chat beside the list) hides itself. */}
      <Box
        sx={{
          display: 'flex',
          flex: {
            xs: selected ? '1 0 auto' : 'none',
            md: '1 0 auto',
            ...(collapsed && { lg: '1 1 0' }),
          },
          minWidth: 0,
          ...(collapsed && { minHeight: { lg: 0 } }),
          flexDirection: 'column',
        }}
      >
        {selected && (
          <Box
            component={Link}
            href={CHATS_HREF}
            // The browser of a chat over the content covers this way back too: it leaves the tab
            // order then, as the list does.
            data-chat-back=""
            sx={{
              display: { xs: 'inline-flex', md: 'none' },
              // From `lg` the chat drawn beside its panel takes the room of the list: the way to it
              // is shown. Below, a tool drawn in place of a chat has its own way back to the chat
              // (docs/plan/59-dialog-tools-panel.md, И14): one way back at a time.
              ...(collapsed && { [PANE_DRAWN]: { display: { xs: 'none', lg: 'inline-flex' } } }),
              alignSelf: 'flex-start',
              alignItems: 'center',
              gap: 1,
              minHeight: 44,
              mt: -1,
              mb: 1,
              pr: 1,
              color: 'text.primary',
              fontSize: 14,
              textDecoration: 'none',
              '&:hover': { textDecoration: 'underline' },
            }}
          >
            <AppIcon name="back" size={22} />
            {chatsText.back}
          </Box>
        )}
        {panelOpen || collapsed ? null : (
          // The list is hidden: the way to bring it back stands over the content (Н3). An open chat
          // puts it in its own head, on one line with its name (`DialogHead`).
          <Box sx={{ display: { xs: 'none', md: 'flex' }, mt: -1.5, mb: 1, ml: -1.5 }}>
            <PanelToggle place="content" />
          </Box>
        )}
        {children}
      </Box>
    </Box>
  )
}
