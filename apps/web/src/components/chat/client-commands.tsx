'use client'

import type { ChatCommandId } from '@repo/domain/release/chat-commands'
import Box from '@mui/material/Box'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { useThemePreference } from '@repo/ui/providers'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode, type RefObject } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { CHATS_HREF, newChatHref } from './chat-address'
import { useChatDetails } from './chat-details'
import { clientCommandText } from './chat-texts'

const PAGE_COMMANDS = ['new', 'sessions', 'details', 'themes'] as const
export type PageCommandId = (typeof PAGE_COMMANDS)[number]
export const isPageCommand = (id: ChatCommandId): id is PageCommandId =>
  (PAGE_COMMANDS as readonly ChatCommandId[]).includes(id)

const THEMES = [
  { value: 'light', label: clientCommandText.light },
  { value: 'dark', label: clientCommandText.dark },
  { value: 'system', label: clientCommandText.system },
] as const

/** The menu of `/themes`: it stands over the field, as the menus of its row do. */
function ThemeMenu({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const { preference, setPreference } = useThemePreference()
  return (
    <Menu
      anchorEl={anchor}
      open
      onClose={onClose}
      anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{
        paper: { sx: { borderRadius: '14px', minWidth: 220, mt: -1 } },
        list: { 'aria-label': clientCommandText.themes },
      }}
    >
      {THEMES.map(({ value, label }) => (
        <MenuItem
          key={value}
          role="menuitemradio"
          aria-checked={value === preference}
          selected={value === preference}
          onClick={() => {
            onClose()
            setPreference(value)
          }}
          sx={{ gap: 1.5 }}
        >
          <ListItemText primary={label} slotProps={{ primary: { sx: { fontSize: 14 } } }} />
          <Box
            component="span"
            aria-hidden="true"
            sx={{ display: 'flex', visibility: value === preference ? 'visible' : 'hidden' }}
          >
            <AppIcon name="check" size={18} />
          </Box>
        </MenuItem>
      ))}
    </Menu>
  )
}

/**
 * The commands of the page that need no chat and work the same on a new chat and in one that goes
 * on: `/new`, `/sessions`, `/details` and `/themes`. `run` returns what a screen reader is told;
 * `menu` stands in the screen that uses it. `/models` and `/export` are the screens' own: they
 * reach what the screen holds. `/help` is the field's.
 */
export function useClientCommands({
  projectId,
  anchor,
}: {
  /** The project a new chat keeps. */
  projectId: string | null
  /** What the menu of `/themes` stands over. */
  anchor: RefObject<HTMLElement | null>
}): {
  run: (id: PageCommandId) => string | undefined
  menu: ReactNode
} {
  const router = useRouter()
  const { toggle } = useChatDetails()
  const [themeAnchor, setThemeAnchor] = useState<HTMLElement | null>(null)

  function run(id: PageCommandId): string | undefined {
    switch (id) {
      case 'new':
        router.push(newChatHref(projectId))
        return undefined
      case 'sessions':
        router.push(CHATS_HREF)
        return undefined
      case 'details':
        return toggle() ? clientCommandText.detailsShown : clientCommandText.detailsHidden
      case 'themes':
        setThemeAnchor(anchor.current)
        return undefined
    }
  }

  return {
    run,
    menu:
      themeAnchor === null ? null : (
        <ThemeMenu anchor={themeAnchor} onClose={() => setThemeAnchor(null)} />
      ),
  }
}
