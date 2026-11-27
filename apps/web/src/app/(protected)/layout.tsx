import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { SharedLinkWaiting } from '@/components/artifacts/shared-link-waiting'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { CabinetBrowserBridge } from '@/components/notifications/cabinet-browser-bridge'
import { hasRequiredConsents, requireSession, UNAVAILABLE } from '@/lib/access'
import { SHARE_COOKIE } from '@/server/artifact-share'
import { TRPCReactProvider } from '@/trpc/client'

import { UiProviders } from '../ui-providers'

export const metadata: Metadata = { robots: { index: false } }

/**
 * The cabinet: a session and the current editions of the required documents. The bridge listens
 * for the service worker and remembers the zone of the browser (docs/plan/82, Зп12, Зп41).
 */
export default function ProtectedLayout({ children }: { children: ReactNode }) {
  return (
    <UiProviders>
      <Cabinet>{children}</Cabinet>
    </UiProviders>
  )
}

async function Cabinet({ children }: { children: ReactNode }) {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  const consents = await hasRequiredConsents()
  if (consents === UNAVAILABLE) return <ServiceUnavailable />
  if (!consents) redirect('/onboarding/consents')
  // A link opened before the sign-in waits in its cookie (plan 88, Ар33): the way back to /a.
  const sharedWaiting = (await cookies()).has(SHARE_COOKIE)

  return (
    <TRPCReactProvider userId={session.user.id}>
      <CabinetBrowserBridge userId={session.user.id} />
      {sharedWaiting ? <SharedLinkWaiting /> : null}
      {children}
    </TRPCReactProvider>
  )
}
