import Container from '@mui/material/Container'
import Paper from '@mui/material/Paper'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'
import { TRPCReactProvider } from '@/trpc/client'

export const metadata: Metadata = { robots: { index: false } }

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />

  return (
    <TRPCReactProvider userId={session.user.id}>
      <Container
        component="main"
        maxWidth="sm"
        sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', py: { xs: 4, md: 8 } }}
      >
        <Paper variant="outlined" sx={{ width: '100%', p: { xs: 3, sm: 5 }, borderRadius: 5 }}>
          {children}
        </Paper>
      </Container>
    </TRPCReactProvider>
  )
}
