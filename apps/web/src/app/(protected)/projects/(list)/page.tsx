import type { Metadata } from 'next'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { ProjectsView } from '@/components/projects/projects-view'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Проекты' }

/**
 * The list of projects. The shell is the page's own, not a layout's: each page of the list
 * names its place in its own way. The list names itself in its heading, beside its actions
 * (docs/plan/64-cabinet-navigation.md, Н8), so it has no bar of breadcrumbs.
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
