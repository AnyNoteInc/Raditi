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
export default async function ArtifactsPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell user={session.user} toolbar={false}>
      <ArtifactsView userId={session.user.id} />
    </ApplicationShell>
  )
}
