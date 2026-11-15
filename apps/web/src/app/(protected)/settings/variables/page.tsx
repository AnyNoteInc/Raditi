import type { Metadata } from 'next'

import { WorkspaceVariables } from '@/components/account/workspace-variables'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Переменные' }

/** «Настройки → Переменные» (docs/plan/83-remove-projects.md, БП4). */
export default async function VariablesPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return <WorkspaceVariables />
}
