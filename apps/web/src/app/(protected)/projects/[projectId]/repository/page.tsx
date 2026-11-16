import type { Metadata } from 'next'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { RepositoryView } from '@/components/projects/repo-runs'
import { UNAVAILABLE } from '@/lib/access'

import { loadProject } from '../load-project'

type Params = Promise<{ projectId: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const loaded = await loadProject((await params).projectId)
  return { title: loaded === UNAVAILABLE ? 'Репозиторий' : `Репозиторий — ${loaded.project.name}` }
}

/** The repository of a project and its builds (docs/plan/84-projects.md, ПР17, §4.8; P-repo). */
export default async function RepositoryPage({ params }: { params: Params }) {
  const loaded = await loadProject((await params).projectId)
  if (loaded === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell user={loaded.user} toolbar={false}>
      <RepositoryView key={loaded.project.id} project={loaded.project} />
    </ApplicationShell>
  )
}
