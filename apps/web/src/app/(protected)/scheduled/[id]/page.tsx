import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { SchedulePage } from '@/components/scheduled/schedule-page'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Запланированная задача' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Params = Promise<{ id: string }>

/**
 * A scheduled task and its runs (docs/plan/82-scheduled-tasks.md, Зп6). The address that is not
 * an id is not found; one of a task that is gone, or someone else's, the page tells itself.
 */
export default async function ScheduledTaskPage({ params }: { params: Params }) {
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell user={session.user} toolbar={false}>
      <SchedulePage key={id} scheduleId={id.toLowerCase()} userId={session.user.id} />
    </ApplicationShell>
  )
}
