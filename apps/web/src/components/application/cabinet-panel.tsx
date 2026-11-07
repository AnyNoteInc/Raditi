'use client'

import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Tooltip from '@mui/material/Tooltip'
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'

import {
  readCabinetPanelState,
  serializeCabinetPanelCookie,
  type CabinetPanelState,
} from '@/lib/cabinet-panel'

import { AppIcon } from './app-icon'

// The panel beside the rail (docs/plan/64-cabinet-navigation.md, Н2, Н3): the list of chats, the
// sections of a project, the sections of the settings. One state for the whole cabinet, in a
// cookie; the button in the head of the panel and the key «]» hide it, the same button in the head
// of the content brings it back.

/** The id of the panel: the buttons that show and hide it name it. */
export const CABINET_PANEL_ID = 'cabinet-panel'

export const panelText = Object.freeze({
  hide: 'Скрыть панель',
  show: 'Показать панель',
  key: ']',
})

const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Writes the state and tells every reader of the cookie. */
export function setCabinetPanelState(next: CabinetPanelState) {
  document.cookie = serializeCabinetPanelCookie(next, {
    secure: window.location.protocol === 'https:',
  })
  for (const listener of listeners) listener()
}

interface CabinetPanel {
  /** The page has a panel at all: the list of projects and the profile have none. */
  present: boolean
  open: boolean
  toggle: () => void
}

const PanelContext = createContext<CabinetPanel>({ present: false, open: false, toggle: () => {} })

export const useCabinetPanel = () => useContext(PanelContext)

/** Where a typed «]» belongs to the text, not to the page (Н3). */
function typesText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  )
}

/**
 * «]» shows and hides the panel on any page that has one, except where a text is typed. The key
 * is the physical one: on a Russian layout the same key types «ъ». A window of MUI over the page
 * keeps its keys.
 */
export function isPanelKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.repeat) return false
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  if (event.code !== 'BracketRight' && event.key !== ']') return false
  if (typesText(event.target)) return false
  return document.querySelector('.MuiModal-root:not(.MuiModal-hidden)') === null
}

export function CabinetPanelProvider({
  present,
  initial,
  children,
}: {
  present: boolean
  /** What the server read from the cookie: the first paint matches it. */
  initial: CabinetPanelState
  children: ReactNode
}) {
  const state = useSyncExternalStore(
    subscribe,
    () => readCabinetPanelState(document.cookie),
    () => initial,
  )
  const open = state === 'open'
  const toggle = () => setCabinetPanelState(open ? 'closed' : 'open')

  useEffect(() => {
    if (!present) return
    const onKey = (event: KeyboardEvent) => {
      if (!isPanelKey(event)) return
      event.preventDefault()
      setCabinetPanelState(readCabinetPanelState(document.cookie) === 'open' ? 'closed' : 'open')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [present])

  return (
    <PanelContext.Provider value={{ present, open: present && open, toggle }}>
      {children}
    </PanelContext.Provider>
  )
}

/**
 * The button that hides the panel (in its head) or shows it (in the head of the content). The key
 * is drawn beside the icon, so it is learnt by looking. Only from `md`: below, the panel is not
 * beside the content.
 */
export function PanelToggle({ place }: { place: 'panel' | 'content' }) {
  const { present, open, toggle } = useCabinetPanel()
  // In the head of the content only while the panel is hidden; in its own head — while it is shown.
  if (!present || (place === 'content') === open) return null
  const label = open ? panelText.hide : panelText.show
  return (
    <Tooltip title={`${label} (${panelText.key})`}>
      <ButtonBase
        onClick={toggle}
        aria-label={label}
        aria-keyshortcuts="]"
        aria-controls={open ? CABINET_PANEL_ID : undefined}
        aria-expanded={open}
        sx={{
          display: { xs: 'none', md: 'inline-flex' },
          flex: 'none',
          alignItems: 'center',
          gap: 0.75,
          height: 44,
          px: 1,
          borderRadius: '12px',
          color: 'text.secondary',
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
        }}
      >
        <AppIcon name="panel" size={20} />
        <Box
          component="kbd"
          aria-hidden="true"
          sx={{
            minWidth: 18,
            height: 20,
            boxSizing: 'border-box',
            border: 1,
            borderColor: 'divider',
            borderRadius: '5px',
            font: 'inherit',
            fontSize: 11,
            lineHeight: '18px',
            textAlign: 'center',
          }}
        >
          {panelText.key}
        </Box>
      </ButtonBase>
    </Tooltip>
  )
}
