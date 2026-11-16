import type { Metadata } from 'next'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { ProjectView } from '@/components/projects/project-view'
import { UNAVAILABLE } from '@/lib/access'
import { speechAvailable } from '@/server/speech-runtime'

import { loadProject } from './load-project'

type Params = Promise<{ projectId: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const loaded = await loadProject((await params).projectId)
  return { title: loaded === UNAVAILABLE ? 'Проект' : loaded.project.name }
}

/** One project (docs/plan/84-projects.md, ПР6): its field, its chats and its column. */
export default async function ProjectPage({ params }: { params: Params }) {
  const loaded = await loadProject((await params).projectId)
  if (loaded === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell user={loaded.user} toolbar={false}>
      <ProjectView
        key={loaded.project.id}
        initial={loaded.project}
        userId={loaded.user.id}
        speech={speechAvailable()}
      />
    </ApplicationShell>
  )
}
