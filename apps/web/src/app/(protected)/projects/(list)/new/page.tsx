import type { Metadata } from 'next'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { ProjectWizard } from '@/components/projects/wizard/project-wizard'
import { requireSession, UNAVAILABLE } from '@/lib/access'
import { chatServices } from '@/server/chat-services'
import { siteConnections } from '@/server/site-connections'

export const metadata: Metadata = { title: 'Новый проект' }

/**
 * The wizard of a new project (spec §12). `/projects/new` is a static segment and wins over the
 * site page `/projects/[projectId]`. The platforms are the stacks the services of the wizard
 * connect by the files (the support of the site adapters in this environment), so the wizard
 * offers exactly what the server accepts; without the services the list is empty and creating a
 * project answers SITE_CONNECTION_UNAVAILABLE, as before.
 */
export default async function NewProjectPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell
      user={session.user}
      crumbs={[{ label: 'Проекты', href: '/projects' }, { label: 'Новый проект' }]}
    >
      <ProjectWizard
        stacks={siteConnections()?.connectableStacks('files') ?? []}
        // A site without access to its files works only through the browser (docs/plan/57, Б8),
        // and only on a platform the server takes that way (docs/plan/62-site-stacks.md, Т6).
        browserAccess={(chatServices()?.browser ?? null) !== null}
        browserStacks={siteConnections()?.connectableStacks('browser') ?? []}
      />
    </ApplicationShell>
  )
}
