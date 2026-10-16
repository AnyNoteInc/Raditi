import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

/** The heading every section of the site page starts with. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Typography
      component="h1"
      sx={{ fontSize: { xs: 26, md: 30 }, fontWeight: 600, lineHeight: 1.25 }}
    >
      {children}
    </Typography>
  )
}

/**
 * A section that has nothing to show yet says so in one phrase. It never shows sample data:
 * a page of the cabinet must not pass an example off as the customer's site.
 */
export function SectionEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box sx={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <SectionTitle>{title}</SectionTitle>
      <Typography color="text.secondary">{children}</Typography>
    </Box>
  )
}
