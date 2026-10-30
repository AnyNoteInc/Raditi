'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import type { ReactNode, RefObject } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { SITE_PANE_WIDTH, SITE_RAIL_WIDTH, SITE_TOOLBAR_HEIGHT } from '@/components/site/site-nav'

import { toolText } from './chat-texts'
import {
  isChangesTool,
  toolIcons,
  toolPanelId,
  toolTabId,
  toolTabNames,
  toolsShown,
  type DialogTool,
  type ToolsState,
} from './dialog-tools'
import { PaneResizer } from './pane-resizer'

// The panel of the tools beside a dialog (docs/plan/59-dialog-tools-panel.md, И7, И8, И14, И20):
// one landmark «Инструменты диалога», drawn only while a tool is on the screen. From `lg` it stands
// at the right edge under the bar of breadcrumbs, its edge dragged to make it wider; below it takes
// the place of the dialog, «К диалогу» (which closes the tab on the screen and leaves the others
// behind the dialog) and «+» over its tabs. On its strip the tabs of the open tools —
// a sign and a name each, closed by the cross at its end or by Delete —, and from `lg` «Скрыть
// панель» and «+» outside the tabs: a tablist holds its tabs alone (axe), and MUI takes every child
// of `Tabs` for a tab.

/**
 * A tool that holds a connection of its own stays mounted while its tab is open, hidden behind
 * another one: the preview keeps its frame, so choosing it again spends no new ticket (И11); the
 * browser keeps its last picture, its stream going only while its tab is shown. A tab of the
 * changes reads them only while it is on the screen; what it read stays in the cache.
 */
const keepsMounted = (tool: DialogTool): boolean => tool === 'browser' || tool === 'preview'

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
}: {
  tools: ToolsState
  /** The panel itself: its edge measures it, the browser over the content finds the shell by it. */
  pane: RefObject<HTMLElement | null>
  /** From `lg`: the panel beside the dialog; below, the area in its place (И14). */
  wide: boolean
  /** The browser over the whole area of the content (Б29): no edge to drag then. */
  fullscreen: boolean
  /** «+» at the end of the strip, or beside «К диалогу» (`ToolsMenu`). */
  menu: ReactNode
  /** A tab chosen on the strip. */
  onShow: (tool: DialogTool) => void
  /** The cross of a tab, or Delete on it. */
  onClose: (tool: DialogTool) => void
  /** «Скрыть панель»: every tab at once. */
  onCloseAll: () => void
  /** «К диалогу» below `lg`: the tab on the screen closes, the others stay behind the dialog. */
  onBack: () => void
  /** What the panel of a tool holds. */
  content: (tool: DialogTool) => ReactNode
}) {
  if (!toolsShown(tools)) return null
  return (
    <Box
      component="aside"
      ref={pane}
      aria-label={toolText.panel}
      // The shell leaves this panel its room at the right edge only while it is drawn.
      data-site-pane=""
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        // Below `lg` the area of a tool takes what the window leaves under the bar of the shell —
        // however many lines the bar takes — and the paddings of the content: the shell is as high
        // as the window at least and hands its height down to the dialog, so the page does not
        // scroll under the area. What it holds scrolls inside it, never sideways.
        flex: { xs: '1 1 0', lg: 'none' },
        minHeight: { xs: 480, lg: 0 },
        position: { lg: 'fixed' },
        // Under the bar of breadcrumbs, which runs over the panel to the right edge.
        top: { lg: SITE_TOOLBAR_HEIGHT },
        bottom: { lg: 0 },
        right: { lg: 'env(safe-area-inset-right)' },
        width: { lg: SITE_PANE_WIDTH },
        border: { xs: 1, lg: 0 },
        borderLeft: { lg: 1 },
        borderColor: { xs: 'divider', lg: 'divider' },
        borderRadius: { xs: '14px', lg: 0 },
        // The panel holds its edge outside itself: the edge is not cut off.
        overflow: { xs: 'hidden', lg: 'visible' },
        bgcolor: 'background.paper',
        // Over the whole area of the content, the rail beside it; under the windows of MUI.
        ...(fullscreen && {
          position: 'fixed',
          top: 0,
          bottom: 0,
          right: 0,
          left: { xs: 0, sm: `calc(${SITE_RAIL_WIDTH}px + env(safe-area-inset-left))` },
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
            value={tools.active}
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
            {tools.open.map((tool) => (
              <Tab
                key={tool}
                value={tool}
                id={toolTabId(tool)}
                aria-controls={toolPanelId(tool)}
                aria-keyshortcuts="Delete"
                onKeyDown={(event) => {
                  if (event.key !== 'Delete') return
                  event.preventDefault()
                  onClose(tool)
                }}
                icon={<AppIcon name={toolIcons[tool]} size={18} />}
                iconPosition="start"
                label={
                  <>
                    {toolTabNames[tool]}
                    {/* The cross is the pointer's way: the keyboard closes the tab by Delete, so a
                        screen reader hears one tab, not a button inside it (И7). */}
                    <Box
                      component="span"
                      aria-hidden="true"
                      title={toolText.closeTab(toolTabNames[tool])}
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
                        '&:hover': { color: 'text.primary' },
                      }}
                    >
                      <AppIcon name="close" size={15} />
                    </Box>
                  </>
                }
                sx={tabSx}
              />
            ))}
          </Tabs>
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
                // The tabs of the changes scroll and keep the paddings of their lists.
                overflowY: isChangesTool(tool) ? 'auto' : 'hidden',
                ...(isChangesTool(tool) ? { p: { xs: 2, sm: 2.5 } } : {}),
              }}
            >
              {shown || keepsMounted(tool) ? content(tool) : null}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
