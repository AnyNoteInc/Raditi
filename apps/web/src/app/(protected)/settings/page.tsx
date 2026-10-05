import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { Metadata } from 'next'

import { SettingsPanel } from '@/components/account/settings-panel'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Настройки' }

export default async function SettingsPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />

  return (
    <Box>
      <Typography
        component="h1"
        sx={{
          fontFamily: 'inherit',
          fontSize: { xs: 28, md: 32 },
          fontWeight: 600,
          lineHeight: 1.2,
          letterSpacing: '-0.025em',
        }}
      >
        Общее
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1 }}>
        Внешний вид и письма от Радити.
      </Typography>
      <SettingsPanel email={session.user.email} />
    </Box>
  )
}
