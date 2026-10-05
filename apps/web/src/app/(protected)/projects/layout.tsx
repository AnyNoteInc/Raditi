import type { ReactNode } from 'react'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

/** Project navigation belongs to project routes, never to personal account pages. */
export default async function ProjectsLayout({ children }: { children: ReactNode }) {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return <ApplicationShell user={session.user}>{children}</ApplicationShell>
}
