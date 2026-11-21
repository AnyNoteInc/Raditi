import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { ApplicationShell } from '@/components/application/application-shell'
import { ArtifactView } from '@/components/artifacts/artifact-view'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'
import { speechAvailable } from '@/server/speech-runtime'

export const metadata: Metadata = { title: 'Артефакт' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Params = Promise<{ artifactId: string }>

/**
 * One artifact (docs/plan/88-artifacts.md, Ар48): the artifact large, the reader's chat of it on
 * the right. An address that is not an id is not found; an artifact that is gone, or someone
 * else's, the page tells itself — the two are never told apart.
 */
export default async function ArtifactRoute({ params }: { params: Params }) {
  const { artifactId } = await params
  if (!UUID.test(artifactId)) notFound()
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell user={session.user} toolbar={false}>
      <ArtifactView
        key={artifactId}
        artifactId={artifactId.toLowerCase()}
        speech={speechAvailable()}
      />
    </ApplicationShell>
  )
}
