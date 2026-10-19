import { connectableStacks } from '@repo/site-adapters'
import type { Metadata } from 'next'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { ProjectWizard } from '@/components/projects/wizard/project-wizard'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Новый проект' }

/**
 * The wizard of a new project (spec §12). `/projects/new` is a static segment and wins over the
 * site page `/projects/[projectId]`. The platforms come from the registry of site adapters, so
 * the wizard offers exactly the stacks the server accepts.
 */
export default async function NewProjectPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell
      user={session.user}
      crumbs={[{ label: 'Проекты', href: '/projects' }, { label: 'Новый проект' }]}
    >
      <ProjectWizard stacks={connectableStacks} />
    </ApplicationShell>
  )
}
