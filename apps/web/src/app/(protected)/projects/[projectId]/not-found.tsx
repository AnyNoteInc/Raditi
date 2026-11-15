import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { ProjectNotFound } from '@/components/projects/project-not-found'
import { requireSession, UNAVAILABLE } from '@/lib/access'

/**
 * A project the server does not find (`loadProject` calls `notFound`): «Такого проекта нет» in the
 * shell of the cabinet, with the way back to the list.
 */
export default async function NotFound() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell user={session.user} toolbar={false}>
      <ProjectNotFound />
    </ApplicationShell>
  )
}
