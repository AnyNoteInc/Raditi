import type { ReactNode } from 'react'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

import { AccountShell } from './account-shell'

export async function AccountLayout({ children }: { children: ReactNode }) {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return <AccountShell user={session.user}>{children}</AccountShell>
}
