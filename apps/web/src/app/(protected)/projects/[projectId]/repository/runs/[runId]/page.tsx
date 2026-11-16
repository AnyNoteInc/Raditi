import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { RunView } from '@/components/projects/repo-runs'
import { UNAVAILABLE } from '@/lib/access'

import { loadProject } from '../../../load-project'

type Params = Promise<{ projectId: string; runId: string }>

const RUN_ID = /^[1-9][0-9]{0,39}$/

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { runId } = await params
  return { title: RUN_ID.test(runId) ? `Сборка #${runId}` : 'Сборка' }
}

/** A build of a project's repository, its jobs and their logs (ПР17, §4.8; P-pipeline). */
export default async function RunPage({ params }: { params: Params }) {
  const { projectId, runId } = await params
  if (!RUN_ID.test(runId)) notFound()
  const loaded = await loadProject(projectId)
  if (loaded === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell user={loaded.user} toolbar={false}>
      <RunView key={`${loaded.project.id}:${runId}`} project={loaded.project} runId={runId} />
    </ApplicationShell>
  )
}
