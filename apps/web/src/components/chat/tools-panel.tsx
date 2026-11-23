'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Tooltip from '@mui/material/Tooltip'
import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { toolText } from './chat-texts'
import {
  tabsLayout,
  toolPanelId,
  toolTabId,
  toolsShown,
  type DialogTool,
  type ToolsState,
} from './dialog-tools'
import { PANE_OPEN_MARK, SITE_PANE_WIDTH } from './pane-layout'
import { CABINET_GAP, CABINET_RADIUS } from '@/components/application/cabinet-shell'
import { PaneResizer } from './pane-resizer'

// The panel of the tools beside a dialog (docs/plan/59-dialog-tools-panel.md, И7, И8, И14, И20):
// one landmark «Инструменты чата», drawn only while a tool is on the screen. From `lg` it stands
// at the right edge under the bar of breadcrumbs, its edge dragged to make it wider; below it takes
// the place of the dialog, «К чату» (which closes the tab on the screen and leaves the others
// behind the dialog) and «+» over its tabs. On its strip the tabs of the open tools —
// a sign and a name each, closed by the cross at its end or by Delete —, and from `lg` «Скрыть
// панель» and «+» outside the tabs: a tablist holds its tabs alone (axe), and MUI takes every child
// of `Tabs` for a tab. Since plan 88 (Ар44) every artifact and file has its tab: the active one
// keeps its name up to ≈180 px, the others shrink to their sign and the start of the name, the
// browser among many to its sign; the tabs that do not fit go into «Ещё N ▾».

/** The width a tab takes on the strip, for the reckoning of what fits (Ар44). */
const TAB_ROOM = 132
/** «Ещё N ▾», «Скрыть панель» and «+»: what the strip keeps besides its tabs. */
const STRIP_RESERVED = 220

const tabSx = {
  minHeight: 44,
  minWidth: 0,
  py: 0,
  pl: 1.5,
  pr: 0,
  borderRadius: '12px',
  fontSize: 14,
  fontWeight: 400,
  whiteSpace: 'nowrap',
  color: 'text.secondary',
  // The sign of the tool 8px before its name, as MUI spaces the icon of a tab by a class that
  // `AppIcon` does not take.
  '& > svg': { mr: 1 },
  '&:hover': { color: 'text.primary' },
  '&.Mui-selected': { color: 'text.primary', bgcolor: 'action.selected', fontWeight: 500 },
} as const

/** The shell of the chats knows the panel is drawn, from its first paint to its last. */
function usePaneMark(drawn: boolean) {
  useLayoutEffect(() => {
    if (!drawn) return
    const shell = document.querySelector('[data-chat-shell]')
    shell?.setAttribute(PANE_OPEN_MARK, '')
    return () => shell?.removeAttribute(PANE_OPEN_MARK)
  }, [drawn])
}

export function ToolsPanel({
  tools,
  pane,
  wide,
  fullscreen,
  menu,
  onShow,
  onClose,
  onCloseAll,
  onBack,
  content,
  labelOf,
  iconOf,
}: {
  tools: ToolsState
  /** The panel itself: its edge measures it, the browser over the content finds the shell by it. */
  pane: RefObject<HTMLElement | null>
  /** From `lg`: the panel beside the dialog; below, the area in its place (И14). */
  wide: boolean
  /** The browser over the whole area of the content (Б29): no edge to drag then. */
  fullscreen: boolean
  /** «+» at the end of the strip, or beside «К чату» (`ToolsMenu`). */
  menu: ReactNode
  /** A tab chosen on the strip. */
  onShow: (tool: DialogTool) => void
  /** The cross of a tab, or Delete on it. */
  onClose: (tool: DialogTool) => void
  /** «Скрыть панель»: every tab at once. */
  onCloseAll: () => void
  /** «К чату» below `lg`: the tab on the screen closes, the others stay behind the dialog. */
  onBack: () => void
  /** What the panel of a tool holds. */
  content: (tool: DialogTool) => ReactNode
  /** The name of a tool on its tab: the browser's, an artifact's title, a file's. */
  labelOf: (tool: DialogTool) => string
  iconOf: (tool: DialogTool) => AppIconName
}) {
  const drawn = toolsShown(tools)
  usePaneMark(drawn)
  const [strip, setStrip] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (strip === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0))
    observer.observe(strip)
    return () => observer.disconnect()
  }, [strip])
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null)
  if (!drawn) return null
  // Unmeasured (the first paint, a test without layout): every tab on the strip.
  const fit = width > 0 ? Math.floor((width - STRIP_RESERVED) / TAB_ROOM) : tools.open.length
  const { inline, more } = tabsLayout(tools, fit)
  const crowded = tools.open.length > 1
  return (
    <Box
      component="aside"
      ref={pane}
      aria-label={toolText.panel}
      // The shell leaves this panel its room at the right edge only while it is drawn.
      data-chat-pane=""
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        // Below `lg` the area of a tool takes what the window leaves under the paddings of the
        // content: the shell is as high as the window at least and hands its height down to the
        // dialog, so the page does not scroll under the area. What it holds scrolls inside it,
        // never sideways.
        flex: { xs: '1 1 0', lg: 'none' },
        minHeight: { xs: 480, lg: 0 },
        // From `lg` a card at the right edge, like the panel beside the rail
        // (docs/plan/64-cabinet-navigation.md, Н1).
        position: { lg: 'fixed' },
        top: { lg: CABINET_GAP },
        bottom: { lg: CABINET_GAP },
        right: { lg: `calc(${CABINET_GAP}px + env(safe-area-inset-right))` },
        width: { lg: SITE_PANE_WIDTH },
        border: 1,
        borderColor: 'divider',
        borderRadius: { xs: '14px', lg: CABINET_RADIUS },
        zIndex: { lg: 1100 },
        // The panel holds its edge outside itself: the edge is not cut off.
        overflow: { xs: 'hidden', lg: 'visible' },
        bgcolor: 'background.paper',
        // Over the whole area of the content, the rail beside it; under the windows of MUI.
        ...(fullscreen && {
          position: 'fixed',
          top: 0,
          bottom: 0,
          right: 0,
          left: 'var(--app-rail-width)',
          width: 'auto',
          height: 'auto',
          minHeight: 0,
          border: 0,
          borderRadius: 0,
          zIndex: 1200,
        }),
      }}
    >
      {fullscreen || !wide ? null : <PaneResizer pane={pane} label={toolText.separator} />}
      <Box
        sx={{
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 'inherit',
        }}
      >
        {wide ? null : (
          // Below `lg` the way back to the dialog is in plain sight, «+» in its corner (И14).
          <Box
            sx={{
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1,
              minHeight: 56,
              pl: 0.5,
              pr: 0.75,
              borderBottom: 1,
              borderColor: 'divider',
            }}
          >
            <Button
              onClick={onBack}
              startIcon={<AppIcon name="back" size={22} />}
              sx={{
                minHeight: 44,
                minWidth: 0,
                px: 1.5,
                borderRadius: '12px',
                color: 'text.primary',
                fontSize: 15,
                fontWeight: 500,
                '& .MuiButton-startIcon': { mr: 0.75 },
              }}
            >
              {toolText.back}
            </Button>
            {menu}
          </Box>
        )}
        <Box
          ref={setStrip}
          sx={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            minWidth: 0,
            // As high as the head of the dialog: «+» keeps its corner when the panel opens (И4).
            minHeight: 56,
            pl: 1.25,
            pr: 0.75,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Tabs
            value={tools.active !== null && inline.includes(tools.active) ? tools.active : false}
            onChange={(_event, tool: DialogTool) => onShow(tool)}
            aria-label={toolText.tabs}
            variant="scrollable"
            scrollButtons={false}
            sx={{
              flex: '1 1 auto',
              minWidth: 0,
              minHeight: 44,
              '& .MuiTabs-indicator': { display: 'none' },
              '& .MuiTabs-list': { gap: 0.5 },
            }}
          >
            {inline.map((tool) => {
              const name = labelOf(tool)
              const active = tool === tools.active
              // Among several tabs the browser is its sign, a name hint on hover (Ар44).
              const signOnly = tool === 'browser' && crowded && !active
              return (
                <Tab
                  key={tool}
                  value={tool}
                  id={toolTabId(tool)}
                  aria-controls={toolPanelId(tool)}
                  aria-keyshortcuts="Delete"
                  aria-label={name}
                  title={name}
                  onKeyDown={(event) => {
                    if (event.key !== 'Delete') return
                    event.preventDefault()
                    onClose(tool)
                  }}
                  icon={<AppIcon name={iconOf(tool)} size={18} />}
                  iconPosition="start"
                  label={
                    <>
                      {signOnly ? null : (
                        <Box
                          component="span"
                          sx={{
                            maxWidth: active ? 180 : 72,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {name}
                        </Box>
                      )}
                      {/* The cross is the pointer's way: the keyboard closes the tab by Delete, so a
                          screen reader hears one tab, not a button inside it (И7). Inactive tabs
                          show it on hover and in focus (Ар44). */}
                      <Box
                        component="span"
                        aria-hidden="true"
                        className="tab-close"
                        title={toolText.closeTab(name)}
                        onClick={(event) => {
                          event.stopPropagation()
                          onClose(tool)
                        }}
                        sx={{
                          alignSelf: 'stretch',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 32,
                          ml: 0.25,
                          color: 'text.secondary',
                          visibility: active || !crowded ? 'visible' : 'hidden',
                          '&:hover': { color: 'text.primary' },
                        }}
                      >
                        <AppIcon name="close" size={15} />
                      </Box>
                    </>
                  }
                  sx={{
                    ...tabSx,
                    pr: 0,
                    '&:hover .tab-close, &.Mui-focusVisible .tab-close': { visibility: 'visible' },
                  }}
                />
              )
            })}
          </Tabs>
          {more.length > 0 && (
            <>
              <Tooltip title={toolText.moreLabel(more.length)}>
                <Button
                  size="small"
                  aria-haspopup="menu"
                  aria-expanded={moreAnchor !== null}
                  aria-label={toolText.moreLabel(more.length)}
                  onClick={(event) => setMoreAnchor(event.currentTarget)}
                  endIcon={<AppIcon name="down" size={14} />}
                  sx={{
                    flex: 'none',
                    minHeight: 36,
                    borderRadius: 999,
                    px: 1.25,
                    color: 'text.primary',
                    bgcolor: 'action.hover',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {toolText.more(more.length)}
                </Button>
              </Tooltip>
              <Menu
                anchorEl={moreAnchor}
                open={moreAnchor !== null}
                onClose={() => setMoreAnchor(null)}
              >
                {more.map((tool) => (
                  <MenuItem
                    key={tool}
                    onClick={() => {
                      setMoreAnchor(null)
                      onShow(tool)
                    }}
                    sx={{ gap: 1.25, minHeight: 44 }}
                  >
                    <AppIcon name={iconOf(tool)} size={18} />
                    {labelOf(tool)}
                  </MenuItem>
                ))}
              </Menu>
            </>
          )}
          {wide ? (
            <>
              <IconButton
                aria-label={toolText.hide}
                title={toolText.hide}
                onClick={onCloseAll}
                sx={{
                  flex: 'none',
                  width: 44,
                  height: 44,
                  borderRadius: '12px',
                  color: 'text.secondary',
                  '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
                }}
              >
                <AppIcon name="paneHide" size={20} />
              </IconButton>
              {menu}
            </>
          ) : null}
        </Box>
        {tools.open.map((tool) => {
          const shown = tool === tools.active
          return (
            <Box
              key={tool}
              role="tabpanel"
              id={toolPanelId(tool)}
              aria-labelledby={toolTabId(tool)}
              hidden={!shown}
              sx={{
                flex: '1 1 auto',
                minHeight: 0,
                minWidth: 0,
                display: shown ? 'flex' : 'none',
                flexDirection: 'column',
                overflowY: 'hidden',
              }}
            >
              {/* Every tool stays mounted while its tab is open, hidden behind another one: the
                  browser keeps its last picture, «Документы» their place (docs/plan/67, Д4). */}
              {content(tool)}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
