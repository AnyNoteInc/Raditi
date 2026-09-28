import Container from '@mui/material/Container'
import Paper from '@mui/material/Paper'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { AuthUiProvider } from '@/components/auth/auth-ui'
import { env } from '@/env'

export const metadata: Metadata = { robots: { index: false } }

// Signed-in users are sent away by the pages themselves (redirectIfSignedIn): the new-password
// page stays open to anyone holding a reset link, and sign-in honours ?next=.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <AuthUiProvider appUrl={env.web().appUrl} captchaSiteKey={env.auth().captcha?.clientKey}>
      <Container
        component="main"
        maxWidth="sm"
        sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', py: { xs: 4, md: 8 } }}
      >
        <Paper variant="outlined" sx={{ width: '100%', p: { xs: 3, sm: 5 }, borderRadius: 5 }}>
          {children}
        </Paper>
      </Container>
    </AuthUiProvider>
  )
}
