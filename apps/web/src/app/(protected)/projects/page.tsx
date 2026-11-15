import type { Metadata } from 'next'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { ProjectsView } from '@/components/projects/projects-view'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Проекты' }

/**
 * «Проекты» (docs/plan/84-projects.md, ПР4): like «Страницы», a page without a panel that names
 * itself in its heading, so it has no bar of breadcrumbs.
 */
export default async function ProjectsPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell user={session.user} toolbar={false}>
      <ProjectsView />
    </ApplicationShell>
  )
}
