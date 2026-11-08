'use client'

import ButtonBase from '@mui/material/ButtonBase'
import Drawer from '@mui/material/Drawer'
import { useState, type ReactNode } from 'react'

import { AppIcon } from './app-icon'

/**
 * Below `md` the panel is not beside the content (docs/plan/64-cabinet-navigation.md, Н7): a button
 * in the bar names where the page is and opens what the panel holds in a drawer from the left.
 */
export function PanelDrawer({
  label,
  current,
  children,
}: {
  /** What the panel holds: «Разделы сайта», «Разделы настроек». */
  label: string
  /** The section of the page, named on the button. */
  current: string
  /** What the drawer holds; `close` is called when a link of it is followed. */
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  return (
    <>
      <ButtonBase
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${current}`}
        onClick={() => setOpen(true)}
        sx={{
          display: { xs: 'inline-flex', md: 'none' },
          flex: 'none',
          gap: 0.75,
          minHeight: 44,
          px: 1.25,
          mr: 1,
          border: 1,
          borderColor: 'divider',
          borderRadius: '12px',
          fontSize: 14,
          fontWeight: 600,
          color: 'text.primary',
        }}
      >
        <AppIcon name="panel" size={18} />
        {current}
        <AppIcon name="down" size={16} />
      </ButtonBase>
      <Drawer
        anchor="left"
        open={open}
        onClose={close}
        slotProps={{
          paper: {
            'aria-label': label,
            sx: {
              width: 300,
              maxWidth: '86vw',
              borderRadius: '0 16px 16px 0',
              p: 1.5,
              pb: 'max(12px, env(safe-area-inset-bottom))',
              gap: 1.5,
            },
          },
        }}
      >
        {children(close)}
      </Drawer>
    </>
  )
}
