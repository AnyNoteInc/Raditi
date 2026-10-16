'use client'

import Box from '@mui/material/Box'
import Breadcrumbs from '@mui/material/Breadcrumbs'
import MuiLink from '@mui/material/Link'
import type { SxProps, Theme } from '@mui/material/styles'
import Typography from '@mui/material/Typography'
import Link from 'next/link'
import type { ReactNode } from 'react'

/** One step of the path to the page. A step without `href` is plain text. */
export type Crumb = { label: string; href?: string }

/**
 * The top bar of a cabinet shell: it says where the page is and leaves room for the shell's
 * own controls on both sides. The last crumb is the page itself and is never a link.
 */
export function ApplicationToolbar({
  label = 'Панель приложения',
  crumbs,
  linkUnderline = 'always',
  start,
  end,
  sx,
}: {
  /** The accessible name of the bar. */
  label?: string
  crumbs: readonly Crumb[]
  /** `hover` is the quiet look of the settings: no underline and a darker text on hover. */
  linkUnderline?: 'always' | 'hover'
  /** Controls before the breadcrumbs. */
  start?: ReactNode
  /** Controls after the breadcrumbs; the shell places them through `sx`. */
  end?: ReactNode
  /** Paddings and the layout of the slots, which differ between the shells. */
  sx?: SxProps<Theme>
}) {
  return (
    <Box
      component="header"
      aria-label={label}
      sx={[
        {
          minHeight: 64,
          display: 'flex',
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {start}
      <Breadcrumbs aria-label="Хлебные крошки" sx={{ minWidth: 0 }}>
        {crumbs.map((crumb, index) =>
          index === crumbs.length - 1 ? (
            <Typography
              key={index}
              aria-current="page"
              variant="body2"
              sx={{ fontWeight: 500, color: 'text.primary', overflowWrap: 'anywhere' }}
            >
              {crumb.label}
            </Typography>
          ) : crumb.href ? (
            <MuiLink
              key={index}
              component={Link}
              href={crumb.href}
              variant="body2"
              color="text.secondary"
              underline={linkUnderline}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: 44,
                ...(linkUnderline === 'hover' && { '&:hover': { color: 'text.primary' } }),
              }}
            >
              {crumb.label}
            </MuiLink>
          ) : (
            <Typography key={index} variant="body2" color="text.secondary">
              {crumb.label}
            </Typography>
          ),
        )}
      </Breadcrumbs>
      {end}
    </Box>
  )
}
