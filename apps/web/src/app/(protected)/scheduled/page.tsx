import type { Metadata } from 'next'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { ScheduledView } from '@/components/scheduled/scheduled-view'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Запланированные задачи' }

/**
 * «Запланированные задачи», the tab «Ваши» (docs/plan/82-scheduled-tasks.md, Зп1, Зп2): the tasks
 * the user created. Like «Страницы» it names itself in its heading, so it has no bar of
 * breadcrumbs, and no panel «]» (plan 64, Н2).
 */
export default async function ScheduledPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell user={session.user} toolbar={false}>
      <ScheduledView userId={session.user.id} tab="yours" />
    </ApplicationShell>
  )
}
