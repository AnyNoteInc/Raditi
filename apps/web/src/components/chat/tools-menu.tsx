'use client'

import Box from '@mui/material/Box'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import MenuList from '@mui/material/MenuList'
import Popover from '@mui/material/Popover'
import Typography from '@mui/material/Typography'
import { useId, useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { toolText } from './chat-texts'
import { offScreen } from './composer'
import {
  toolIcons,
  toolMenuNames,
  toolsLabel,
  type DialogTool,
  type ToolsDot,
  type ToolTile,
} from './dialog-tools'

// «+» of a dialog and its menu «Инструменты» (docs/plan/59-dialog-tools-panel.md, И4, И5, И13,
// И14): the tools the dialog has, as tiles in two columns, each with what it holds or who drives it.
// The button stands in the top right corner of the dialog — in its head while the panel is closed,
// at the end of the tabs while it is open; a dot on it says that something new is behind it. From
// `lg` the menu is a card beside the button, below it comes up from the bottom as a sheet. Opened
// from the keyboard, the menu puts the focus on its first tile; the arrows go through the tiles in
// the order of reading, Enter or Space chooses one, Esc and Tab close it with the focus back on «+».

/**
 * The id of «+»: one on the screen, in the head or at the end of the tabs. The focus comes back to
 * it once the last tab is closed (И8).
 */
export const TOOLS_BUTTON_ID = 'dialog-tools'

/**
 * The mark of the card or the sheet of the menu, which stands apart from «+» in a portal: a focus
 * inside it is a focus on the menu of «+», which goes with «+» when the panel opens by itself
 * (`DialogView`, docs/plan/59, И3).
 */
export const TOOLS_MENU_MARK = 'data-tools-menu'
/** React passes a data attribute on to the element, though the props of a paper of MUI name none. */
const menuMark = { [TOOLS_MENU_MARK]: '' }

const tileSx = {
  // MUI lets the height of a menu item go from `sm` up, by a media query of its own that wins over
  // a plain value: a value given by breakpoint comes after it and keeps the tile 52px high on every
  // width — never under the 44px of a finger (DESIGN.md).
  minHeight: { xs: 52 },
  gap: 1.5,
  pl: 1.75,
  pr: 1.5,
  borderRadius: '12px',
  bgcolor: 'action.hover',
  fontSize: 15,
  '&:hover': { bgcolor: 'action.selected', '@media (hover: none)': { bgcolor: 'action.hover' } },
} as const

/**
 * A tile of the sheet, under a finger: taller, the name under the sign and the mark, so that it
 * wraps instead of being cut. The name stays first in the order of reading.
 */
const sheetTileSx = {
  ...tileSx,
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  gridTemplateAreas: '"sign mark" "name name"',
  alignItems: 'center',
  alignContent: 'space-between',
  rowGap: 1.25,
  columnGap: 1,
  minHeight: { xs: 92 },
  p: 1.75,
  borderRadius: '16px',
  lineHeight: 1.3,
  whiteSpace: 'normal',
} as const

/** The mark on the right of a tile; the tool already open is said on the colour of a chosen tab. */
const markSx = (open: boolean) =>
  ({
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    height: 24,
    px: 1.125,
    borderRadius: '999px',
    bgcolor: open ? 'action.selected' : 'divider',
    color: open ? 'text.primary' : 'text.secondary',
    fontSize: 12.5,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  }) as const

/** The card of the menu: its title, and in the sheet the way to close it under a finger. */
const cardSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1.5,
  borderRadius: '18px',
  border: 1,
  borderColor: 'divider',
} as const

export function ToolsMenu({
  tiles,
  onOpen,
  dot = null,
  sheet = false,
}: {
  /** The tools of the dialog in the order of the menu (`toolTilesOf`). */
  tiles: readonly ToolTile[]
  /** A tool chosen: the dialog opens it, or shows it when it is open (`openTool`). */
  onOpen: (tool: DialogTool) => void
  /** What is new behind «+» while the panel is closed (`toolsDot`): its dot, said after its name. */
  dot?: ToolsDot | null
  /** Below `lg`: the menu comes up from the bottom of the screen (И14). */
  sheet?: boolean
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const menuId = useId()
  const titleId = useId()
  const list = useRef<HTMLUListElement>(null)
  const open = anchor !== null
  const close = () => setAnchor(null)
  const label = toolsLabel(dot)
  // The first tile takes the focus as the card or the sheet comes in, as the Menu of MUI moves it
  // there (И5). A list of MUI used on its own leaves that to its user: the focus it gives its first
  // tile does not outlive a modal mounted again (Strict Mode, `next dev`), which hands it back to
  // «+» and then to the card, where no arrow reaches a tile.
  const focusFirstTile = () =>
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  const card = (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: sheet ? 44 : 0 }}>
        {/* The title names the menu from outside it: a menu holds its items alone (axe). */}
        <Typography
          id={titleId}
          sx={{ flex: '1 1 auto', px: 0.5, fontSize: 15, fontWeight: 500, lineHeight: 1.5 }}
        >
          {toolText.label}
        </Typography>
        {sheet ? (
          <IconButton
            aria-label={toolText.closeMenu}
            onClick={close}
            sx={{ width: 44, height: 44, borderRadius: '12px', color: 'text.secondary' }}
          >
            <AppIcon name="close" size={18} />
          </IconButton>
        ) : null}
      </Box>
      <MenuList
        ref={list}
        id={menuId}
        aria-labelledby={titleId}
        autoFocusItem={open}
        variant="menu"
        disablePadding
        onKeyDown={(event) => {
          // As a menu of MUI does: Tab leaves it closed, the focus back on «+».
          if (event.key !== 'Tab') return
          event.preventDefault()
          close()
        }}
        sx={{
          display: 'grid',
          gridTemplateColumns: tiles.length > 1 ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
          gap: 1,
          outline: 'none',
        }}
      >
        {tiles.map(({ tool, open: shown, mark }) => (
          <MenuItem
            key={tool}
            onClick={() => {
              close()
              onOpen(tool)
            }}
            sx={sheet ? sheetTileSx : tileSx}
          >
            <Box component="span" sx={{ gridArea: 'sign', display: 'flex' }}>
              <AppIcon name={toolIcons[tool]} size={sheet ? 22 : 20} />
            </Box>
            <Box
              component="span"
              sx={
                sheet
                  ? { gridArea: 'name', minWidth: 0, overflowWrap: 'anywhere' }
                  : // Beside a mark the name takes a second line rather than losing its end: two
                    // lines of it keep the tile 52px high.
                    {
                      flex: '1 1 auto',
                      minWidth: 0,
                      whiteSpace: 'normal',
                      overflowWrap: 'anywhere',
                      lineHeight: 1.3,
                    }
              }
            >
              {toolMenuNames[tool]}
            </Box>
            {mark === null ? null : (
              <>
                {/* Read after the name as «Файлы и изменения, 4». */}
                <Box component="span" sx={offScreen}>
                  ,{' '}
                </Box>
                <Box
                  component="span"
                  sx={{
                    ...markSx(shown),
                    ...(sheet ? { gridArea: 'mark', justifySelf: 'end' } : {}),
                  }}
                >
                  {mark}
                </Box>
              </>
            )}
          </MenuItem>
        ))}
      </MenuList>
    </>
  )
  return (
    <>
      <IconButton
        id={TOOLS_BUTTON_ID}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{
          // The pressing area of 44px on every width (DESIGN.md); a frame tells it from «⋯».
          position: 'relative',
          width: 44,
          height: 44,
          flex: 'none',
          borderRadius: '12px',
          color: 'text.primary',
          '&::before': {
            content: '""',
            position: 'absolute',
            inset: 4,
            borderRadius: '10px',
            border: 1,
            borderColor: 'divider',
            pointerEvents: 'none',
          },
          '&[aria-expanded="true"]::before': { bgcolor: 'action.selected' },
          '& > svg': { position: 'relative' },
        }}
      >
        <AppIcon name="plus" size={20} />
        {dot === null ? null : (
          // The dot only shows what the name says (И13): no colour carries the meaning alone.
          <Box
            component="span"
            aria-hidden="true"
            data-tools-dot=""
            sx={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 14,
              height: 14,
              borderRadius: '50%',
              border: 2,
              borderColor: 'background.paper',
              bgcolor: 'primary.main',
            }}
          />
        )}
      </IconButton>
      {sheet ? (
        <Drawer
          anchor="bottom"
          open={open}
          onClose={close}
          // The focus goes to the first tile, not to the sheet.
          disableAutoFocus
          slotProps={{
            transition: { onEntering: focusFirstTile },
            paper: {
              // The sheet is a modal dialog of MUI: named by its title, as the menu in it is.
              'aria-labelledby': titleId,
              ...menuMark,
              sx: {
                ...cardSx,
                // A sheet at the bottom of a phone; no wider than a hand on a tablet.
                width: '100%',
                maxWidth: 560,
                mx: 'auto',
                px: 2,
                pt: 1,
                pb: 'max(24px, env(safe-area-inset-bottom))',
                borderBottom: 0,
                borderRadius: '24px 24px 0 0',
              },
            },
          }}
        >
          {card}
        </Drawer>
      ) : (
        <Popover
          open={open}
          anchorEl={anchor}
          onClose={close}
          // The focus goes to the first tile, not to the card.
          disableAutoFocus
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          slotProps={{
            transition: { onEntering: focusFirstTile },
            paper: {
              ...menuMark,
              sx: {
                ...cardSx,
                width: tiles.length > 1 ? 500 : 300,
                maxWidth: 'calc(100vw - 32px)',
                mt: 0.75,
                p: 2,
              },
            },
          }}
        >
          {card}
        </Popover>
      )}
    </>
  )
}
