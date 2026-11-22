import type { Metadata } from 'next'

import { ApplicationShell } from '@/components/application/application-shell'
import { ArtifactsView } from '@/components/artifacts/artifacts-view'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Артефакты' }

/**
 * «Артефакты» (docs/plan/88-artifacts.md, Ар43, Ар50): the gallery of the user's artifacts. Like
 * «Страницы» it names itself in its heading, so it has no bar of breadcrumbs.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function ArtifactsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[] }>
}) {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  // `?project=<id>` — «Все артефакты проекта» of «Контекст» (Ар42); anything else is no filter.
  const { project } = await searchParams
  const projectId = typeof project === 'string' && UUID.test(project) ? project.toLowerCase() : ''
  return (
    <ApplicationShell user={session.user} toolbar={false}>
      <ArtifactsView userId={session.user.id} initialProjectId={projectId} />
    </ApplicationShell>
  )
}
