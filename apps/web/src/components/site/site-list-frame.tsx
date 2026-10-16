'use client'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import Link from 'next/link'
import { useSelectedLayoutSegment } from 'next/navigation'
import { useEffect, useRef, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { SITE_LIST_WIDTH, SITE_RAIL_WIDTH } from './site-nav'

/** The bottom bar of a phone, which the pinned action of the list stays above. */
const BOTTOM_BAR = 64

/**
 * A section of the site laid out as «list — content». From `md` the list is a column that runs
 * the full height beside the rail and scrolls on its own, and the content keeps the page's
 * scroll. Below `md` there is one area: the list at the root of the section, the content with
 * a back arrow on an item. Which of them is on the screen is decided by styles alone, so the
 * first paint is right on every width; whether an item is open comes from the route.
 */
export function SiteListFrame({
  label,
  title,
  root,
  action,
  backLabel,
  list,
  children,
}: {
  /** The accessible name of the list column. */
  label: string
  /** The heading of the list: the name of the section. */
  title: string
  /** The address of the section itself, where the back arrow leads. */
  root: string
  /** The main action of the list: a link to a segment under the section. */
  action?: { segment: string; label: string }
  backLabel: string
  list: ReactNode
  children: ReactNode
}) {
  const segment = useSelectedLayoutSegment()
  const selected = segment !== null

  // Below `md` a move between the list and an item hides the link that had the focus. The
  // focus then goes to the content instead of being dropped to the top of the document.
  const previous = useRef(segment)
  useEffect(() => {
    if (previous.current === segment) return
    previous.current = segment
    const active = document.activeElement
    if (!active || active === document.body || active.getClientRects().length === 0) {
      document.getElementById('site-content')?.focus({ preventScroll: true })
    }
  }, [segment])

  return (
    <Box sx={{ flex: '1 0 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <Box
        component="nav"
        aria-label={label}
        sx={{
          // A column on a phone, so the pinned action has the whole list to stick within.
          display: {
            xs: selected ? 'none' : 'flex',
            sm: selected ? 'none' : 'grid',
            md: 'grid',
          },
          flexDirection: 'column',
          flex: '1 0 auto',
          minWidth: 0,
          gridTemplateColumns: { sm: 'minmax(0, 1fr) auto' },
          gridTemplateRows: { sm: 'auto 1fr' },
          alignItems: { xs: 'stretch', sm: 'start' },
          gap: '12px 8px',
          position: { md: 'fixed' },
          top: { md: 0 },
          bottom: { md: 0 },
          left: { md: `calc(${SITE_RAIL_WIDTH}px + env(safe-area-inset-left))` },
          width: { md: SITE_LIST_WIDTH },
          overflowY: { md: 'auto' },
          px: { md: 1.5 },
          pt: { md: 2 },
          pb: { md: 'max(16px, env(safe-area-inset-bottom))' },
          bgcolor: { md: 'background.paper' },
          borderRight: { md: 1 },
          borderColor: { md: 'divider' },
        }}
      >
        {/* The heading of the page while the list is all there is; beside an item, of the list. */}
        <Typography
          component={selected ? 'h2' : 'h1'}
          sx={{
            alignSelf: 'center',
            minWidth: 0,
            pl: { md: 1.5 },
            fontSize: { xs: 26, md: 18 },
            fontWeight: 600,
            lineHeight: 1.25,
          }}
        >
          {title}
        </Typography>
        {action && (
          <Button
            component={Link}
            href={`${root}/${action.segment}`}
            aria-current={segment === action.segment ? 'page' : undefined}
            variant="contained"
            startIcon={<AppIcon name="plus" size={18} />}
            sx={{
              order: { xs: 1, sm: 0 },
              gridRow: { sm: 1 },
              gridColumn: { sm: 2 },
              minHeight: { xs: 48, sm: 44 },
              borderRadius: '999px',
              whiteSpace: 'nowrap',
              // On a phone the action stays within reach under a long list, above the bar.
              position: { xs: 'sticky', sm: 'static' },
              bottom: { xs: `calc(${BOTTOM_BAR + 12}px + env(safe-area-inset-bottom))` },
            }}
          >
            {action.label}
          </Button>
        )}
        <Box
          sx={{
            flex: { xs: '1 0 auto' },
            gridColumn: { sm: '1 / -1' },
            gridRow: { sm: 2 },
            minWidth: 0,
            px: { md: 1.5 },
          }}
        >
          {list}
        </Box>
      </Box>

      {/* Never hidden: at the root a page may answer with a state the user has to see. What is
          only for the wide layout («nothing is chosen») hides itself. */}
      <Box
        sx={{
          display: 'flex',
          flex: { xs: selected ? '1 0 auto' : 'none', md: '1 0 auto' },
          minWidth: 0,
          flexDirection: 'column',
        }}
      >
        {selected && (
          <Box
            component={Link}
            href={root}
            sx={{
              display: { xs: 'inline-flex', md: 'none' },
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
            {backLabel}
          </Box>
        )}
        {children}
      </Box>
    </Box>
  )
}
