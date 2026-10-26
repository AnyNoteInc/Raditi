import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

/**
 * A bordered block of the site page: no shadow, a divider under its title. Without a title it is
 * the block alone — the heading of the page names it.
 */
export function SiteCard({
  title,
  note,
  children,
}: {
  title?: string
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <Box
      component={title === undefined ? 'div' : 'section'}
      sx={{ border: 1, borderColor: 'divider', borderRadius: '14px' }}
    >
      {title === undefined ? null : (
        <Box sx={{ px: { xs: 2, sm: 2.75 }, py: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Typography component="h2" sx={{ fontSize: 17, fontWeight: 600 }}>
            {title}
          </Typography>
          {note ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 720 }}>
              {note}
            </Typography>
          ) : null}
        </Box>
      )}
      {children}
    </Box>
  )
}

/** A named fact: the name small above, the value below. */
export function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Typography component="dt" variant="caption" color="text.secondary">
        {name}
      </Typography>
      <Typography component="dd" sx={{ m: 0, overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </Box>
  )
}

export function Facts({ children }: { children: ReactNode }) {
  return (
    <Box
      component="dl"
      sx={{
        m: 0,
        px: { xs: 2, sm: 2.75 },
        py: 2.25,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
        gap: '14px 28px',
      }}
    >
      {children}
    </Box>
  )
}
