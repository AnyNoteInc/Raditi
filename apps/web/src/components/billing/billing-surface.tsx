import Box from '@mui/material/Box'
import type { Theme } from '@mui/material/styles'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'

// The pieces the tariff pages share: a surface with sections, their headings, the rows of
// «label — value» and the sign of a section about payments.

/** The outline of a block of sections, as on the «Общее» page. */
export const surface = {
  bgcolor: 'background.paper',
  border: 1,
  borderColor: 'divider',
  borderRadius: '14px',
} as const

/** The inner fields of one section of a surface. */
export const sectionPadding = { xs: 2.5, sm: 4 } as const

/** The heading of a page: the name of its settings section. */
export const pageHeading = {
  fontFamily: 'inherit',
  fontSize: { xs: 28, md: 32 },
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.025em',
} as const

/** The heading of a section. */
export const sectionHeading = { fontSize: 19, fontWeight: 600, lineHeight: 1.35 } as const

/**
 * The palette that follows the colour scheme: CSS variables under the app theme, plain values
 * where a component is rendered without it.
 */
export const paletteOf = (theme: Theme) => (theme.vars ?? theme).palette

export function DetailRows({ children, mt = 3 }: { children: ReactNode; mt?: number }) {
  return (
    <Box component="dl" sx={{ mt, mb: 0 }}>
      {children}
    </Box>
  )
}

/** One «label — value» pair; the pair stacks on a phone. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          sm: 'minmax(120px, 0.8fr) minmax(0, 1.2fr)',
        },
        alignItems: 'baseline',
        gap: { xs: 0.5, sm: 2 },
        py: 1.5,
        borderTop: 1,
        borderColor: 'divider',
      }}
    >
      <Typography component="dt" variant="body2" color="textSecondary">
        {label}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0, minWidth: 0 }}>
        {children}
      </Typography>
    </Box>
  )
}

/**
 * The sign of a section that is about payments: a card in a tile. Not drawn on a phone, where
 * the words beside it need the whole width.
 */
export function PaymentTile() {
  return (
    <Box
      aria-hidden="true"
      sx={{
        display: { xs: 'none', sm: 'inline-flex' },
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        width: 48,
        height: 48,
        border: 1,
        borderColor: 'divider',
        borderRadius: '12px',
        bgcolor: 'background.default',
        color: 'text.secondary',
      }}
    >
      <AppIcon name="payment" size={24} />
    </Box>
  )
}
