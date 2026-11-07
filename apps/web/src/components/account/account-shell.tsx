'use client'

import Box from '@mui/material/Box'
import type { ReactNode } from 'react'

import { ApplicationToolbar } from '@/components/application/application-toolbar'
import { CabinetShell } from '@/components/application/cabinet-shell'
import type { ApplicationUser } from '@/components/application/user-avatar'

/**
 * The personal pages — the profile: the rail of the cabinet, no panel, the page at a reading width
 * in the content card (docs/plan/64-cabinet-navigation.md, Н1).
 */
export function AccountShell({ user, children }: { user: ApplicationUser; children: ReactNode }) {
  return (
    <CabinetShell user={user} skipTarget="account-content">
      <ApplicationToolbar
        label="Панель аккаунта"
        crumbs={[{ label: 'Профиль' }]}
        sx={{ px: { xs: 2.5, sm: 4 } }}
      />
      <Box
        component="main"
        id="account-content"
        tabIndex={-1}
        sx={{
          width: '100%',
          maxWidth: 864,
          mx: 'auto',
          boxSizing: 'border-box',
          px: { xs: 2.5, sm: 4 },
          pt: { xs: 4, sm: 5 },
          pb: { xs: 6, sm: 10 },
          outline: 'none',
        }}
      >
        {children}
      </Box>
    </CabinetShell>
  )
}
