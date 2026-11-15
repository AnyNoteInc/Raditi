import type { Metadata } from 'next'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { ScheduledView } from '@/components/scheduled/scheduled-view'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Шаблоны задач' }

/** «Запланированные задачи», the tab «Шаблоны» (docs/plan/82-scheduled-tasks.md, Зп9, §4.6). */
export default async function ScheduledTemplatesPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell user={session.user} toolbar={false}>
      <ScheduledView userId={session.user.id} tab="templates" />
    </ApplicationShell>
  )
}
