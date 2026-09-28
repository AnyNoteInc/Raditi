import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { hasRequiredConsents, requireSession, UNAVAILABLE } from '@/lib/access'
import { TRPCReactProvider } from '@/trpc/client'

export const metadata: Metadata = { robots: { index: false } }

/** The cabinet: a session and the current editions of the required documents. */
export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  const consents = await hasRequiredConsents()
  if (consents === UNAVAILABLE) return <ServiceUnavailable />
  if (!consents) redirect('/onboarding/consents')

  return <TRPCReactProvider userId={session.user.id}>{children}</TRPCReactProvider>
}
