'use client'

import Box from '@mui/material/Box'
import type { SxProps, Theme } from '@mui/material/styles'
import { brandColors } from '@repo/ui/theme/tokens'
import type { CSSProperties, ReactNode } from 'react'

import {
  CABINET_GAP,
  CABINET_PANEL_DEFAULT_WIDTH,
  CABINET_RAIL_WIDTH,
  type CabinetPanelState,
} from '@/lib/cabinet-panel'

import { ApplicationRail } from './application-rail'
import { applicationSurface } from './application-surface'
import { CABINET_PANEL_ID, CabinetPanelProvider, useCabinetPanel } from './cabinet-panel'
import { PANEL_WIDTH_VAR, PanelResizer } from './panel-resizer'
import { SkipLink } from './skip-link'
import type { ApplicationUser } from './user-avatar'

// The frame of every page of the cabinet (docs/plan/64-cabinet-navigation.md, Н1): from `md` the
// rail lies on the ground of the page, and the panel beside it and the content are cards with a
// gap between them. Below `md` there are no cards: the rail, and the content to the edges.

/**
 * The width of the panel beside the rail, from `md`: the variable the shell sets from the viewer's
 * choice — the edge of the panel is dragged —, else the default.
 */
export const CABINET_PANEL_WIDTH = `var(${PANEL_WIDTH_VAR}, ${CABINET_PANEL_DEFAULT_WIDTH}px)`
export { CABINET_GAP }
export const CABINET_RADIUS = '18px'

/** The rail with the side of a phone held sideways. */
const railWidth = (width: number) => `calc(${width}px + env(safe-area-inset-left))`

/** The ground of the page under the cards: a shade below the cards in both colour schemes. */
export const cabinetGround = (theme: Theme) => ({
  backgroundColor: brandColors.paper2,
  ...theme.applyStyles('dark', { backgroundColor: brandColors.ink }),
})

/**
 * Where the content starts from the left from `md`: past the rail, and past the panel while it
 * is shown. The shell sets the variables; the parts that stand fixed beside it read them.
 */
export const CONTENT_LEFT = 'calc(var(--app-rail-width) + var(--cabinet-panel-space))'

/**
 * A card fixed beside the rail from `md`: the panel of a page. Hidden below `md` and while the
 * viewer has hidden it. The list of chats draws itself with these styles in the flow of the page
 * below `md`, so it does not take this component.
 */
export const cabinetPanelSx = (open: boolean) =>
  ({
    position: 'fixed',
    top: CABINET_GAP,
    bottom: CABINET_GAP,
    left: 'var(--app-rail-width)',
    width: CABINET_PANEL_WIDTH,
    display: open ? 'flex' : 'none',
    flexDirection: 'column',
    overflowY: 'auto',
    bgcolor: 'background.paper',
    border: 1,
    borderColor: 'divider',
    borderRadius: CABINET_RADIUS,
    zIndex: 1100,
  }) as const

/** The panel of a page from `md` (Н2): a labelled card with the id the toggles name. */
export function CabinetPanel({ label, children }: { label: string; children: ReactNode }) {
  const { open } = useCabinetPanel()
  return (
    <Box
      component="aside"
      id={CABINET_PANEL_ID}
      aria-label={label}
      sx={{ ...cabinetPanelSx(open), display: { xs: 'none', md: open ? 'flex' : 'none' } }}
    >
      {children}
      <PanelResizer />
    </Box>
  )
}

/** Marks of the outermost box that the parts of a page find it by. */
type RootMarks = Readonly<Record<`data-${string}`, string>>

function Frame({
  children,
  style,
  marks,
  sx,
}: {
  children: ReactNode
  style?: CSSProperties
  marks?: RootMarks
  sx?: SxProps<Theme>
}) {
  const { open, present } = useCabinetPanel()
  const space = present && open ? `calc(${CABINET_PANEL_WIDTH} + ${CABINET_GAP}px)` : '0px'
  return (
    <Box
      data-cabinet-shell=""
      {...marks}
      style={style}
      sx={[
        // One block for `md`: a responsive value and a key of the same media query would be two
        // rules of one name, and the second would drop the first.
        (theme) => ({
          '--cabinet-panel-space': '0px',
          '--cabinet-gap': '0px',
          // The margins of the content card stay inside: they would collapse through this box.
          display: 'flow-root',
          // Below `md` the page is the content itself; from `md` the ground under the cards.
          backgroundColor: theme.vars?.palette.background.paper,
          [theme.breakpoints.up('md')]: {
            '--cabinet-panel-space': space,
            '--cabinet-gap': `${CABINET_GAP}px`,
            ...cabinetGround(theme),
          },
        }),
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {children}
    </Box>
  )
}

/**
 * A page of the cabinet: the rail, the panel when the page has one, and the content as a card.
 * The content scrolls with the window; a frame fixed over its edges from `md` keeps the rounded
 * corners and the gap around it while it scrolls, and lets every click through.
 */
export function CabinetShell({
  user,
  panel,
  panelState = 'open',
  panelWidth = null,
  skipTarget,
  railHiddenOnPhone = false,
  style,
  marks,
  sx,
  contentSx,
  frameSx,
  children,
}: {
  user: ApplicationUser
  /** The panel of the page (`CabinetPanel`), or `true` when the page draws it itself. */
  panel?: ReactNode
  /** What the server read from the cookie of the panel. */
  panelState?: CabinetPanelState
  /** The width the viewer dragged the panel to, from its cookie; null — the default. */
  panelWidth?: number | null
  /** The id of the element that holds the page's content. */
  skipTarget: string
  /** An item that takes the whole phone screen: its way back stands in place of the rail. */
  railHiddenOnPhone?: boolean
  /** CSS variables of the page, set on the outermost box. */
  style?: CSSProperties
  /** Marks of the outermost box: the chats find their shell by one. */
  marks?: RootMarks
  sx?: SxProps<Theme>
  /** The card of the content: a page that stands at the height of the window says so here. */
  contentSx?: SxProps<Theme>
  /** The frame over the edges of the content: a page with a card on the right moves its edge. */
  frameSx?: SxProps<Theme>
  children: ReactNode
}) {
  const present = panel !== undefined && panel !== false && panel !== null
  return (
    <CabinetPanelProvider present={present} initial={panelState}>
      <Frame
        style={
          panelWidth === null
            ? style
            : ({ ...style, [PANEL_WIDTH_VAR]: `${panelWidth}px` } as CSSProperties)
        }
        marks={marks}
        sx={[
          {
            ...applicationSurface,
            '--app-rail-width': {
              xs: railHiddenOnPhone ? '0px' : railWidth(56),
              sm: railWidth(CABINET_RAIL_WIDTH),
            },
          },
          ...(Array.isArray(sx) ? sx : [sx]),
        ]}
      >
        <SkipLink target={skipTarget} left={{ xs: 8, sm: 84 }} />
        <ApplicationRail user={user} hiddenOnPhone={railHiddenOnPhone} />
        {panel === true ? null : panel}
        <Box
          sx={[
            {
              ml: CONTENT_LEFT,
              mr: 'calc(var(--cabinet-gap) + env(safe-area-inset-right))',
              my: 'var(--cabinet-gap)',
              minWidth: 0,
              minHeight: 'calc(100dvh - 2 * var(--cabinet-gap))',
              display: 'flex',
              flexDirection: 'column',
              bgcolor: 'background.paper',
              borderRadius: { md: CABINET_RADIUS },
            },
            ...(Array.isArray(contentSx) ? contentSx : [contentSx]),
          ]}
        >
          {children}
        </Box>
        <Box
          aria-hidden="true"
          sx={[
            (theme) => ({
              display: { xs: 'none', md: 'block' },
              position: 'fixed',
              top: CABINET_GAP,
              bottom: CABINET_GAP,
              left: CONTENT_LEFT,
              right: `calc(${CABINET_GAP}px + env(safe-area-inset-right))`,
              border: 1,
              borderColor: 'divider',
              borderRadius: CABINET_RADIUS,
              pointerEvents: 'none',
              zIndex: 1080,
              // The ground is painted around the card: what scrolls past its edges hides under it.
              boxShadow: `0 0 0 ${CABINET_GAP + 4}px ${brandColors.paper2}`,
              ...theme.applyStyles('dark', {
                boxShadow: `0 0 0 ${CABINET_GAP + 4}px ${brandColors.ink}`,
              }),
            }),
            ...(Array.isArray(frameSx) ? frameSx : [frameSx]),
          ]}
        />
      </Frame>
    </CabinetPanelProvider>
  )
}
