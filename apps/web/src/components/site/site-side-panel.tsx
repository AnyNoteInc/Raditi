'use client'

import Box from '@mui/material/Box'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'

/** As wide as a form of the wizard needs; a phone gets the whole screen. */
const PANEL_WIDTH = 560

/**
 * A panel that slides in from the right edge over the page of the site (owner's request of
 * 26.10.2026) with a form the page opened: a variable to add or change, an access to change. Modal: the page behind
 * is dimmed, focus stays inside and goes back to the button that opened it. Escape, a click
 * outside and the cross close it, except while `busy` — a save on its way, whose answer the form
 * still has to show.
 */
export function SiteSidePanel({
  open,
  onClose,
  titleId,
  title,
  busy = false,
  onExited,
  children,
}: {
  open: boolean
  onClose: () => void
  /** The id of the heading: the panel is named by it, and a form may focus it. */
  titleId: string
  title: string
  busy?: boolean
  /** The panel slid out: what it showed may go now. */
  onExited?: () => void
  children: ReactNode
}) {
  const close = () => {
    if (!busy) onClose()
  }
  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={close}
      slotProps={{
        paper: {
          role: 'dialog',
          'aria-modal': true,
          'aria-labelledby': titleId,
          sx: {
            width: `min(${PANEL_WIDTH}px, 100vw)`,
            bgcolor: 'background.paper',
            backgroundImage: 'none',
            borderLeft: 1,
            borderColor: 'divider',
          },
        },
        transition: onExited ? { onExited } : {},
      }}
    >
      <Box
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          minHeight: 64,
          pl: { xs: 2, sm: 3 },
          pr: 'max(8px, env(safe-area-inset-right))',
          pt: 'env(safe-area-inset-top)',
          bgcolor: 'background.paper',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Typography
          component="h2"
          id={titleId}
          tabIndex={-1}
          sx={{ fontSize: 18, fontWeight: 600, lineHeight: 1.3, outline: 'none', minWidth: 0 }}
        >
          {title}
        </Typography>
        <IconButton
          aria-label="Закрыть"
          onClick={close}
          disabled={busy}
          sx={{ width: 44, height: 44 }}
        >
          <AppIcon name="close" size={20} />
        </IconButton>
      </Box>
      <Box
        sx={{
          pl: { xs: 2, sm: 3 },
          pr: { xs: 'max(16px, env(safe-area-inset-right))', sm: 3 },
          pt: 2.5,
          pb: 'max(24px, env(safe-area-inset-bottom))',
        }}
      >
        {children}
      </Box>
    </Drawer>
  )
}
