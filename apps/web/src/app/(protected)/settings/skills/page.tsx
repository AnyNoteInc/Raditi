import type { Metadata } from 'next'

import { WorkspaceAgentSkills } from '@/components/account/agent-skills'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Навыки агента' }

/** «Настройки → Навыки агента» (docs/plan/81-mcp-server-credentials.md; plan 83, БП11). */
export default async function SkillsPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return <WorkspaceAgentSkills />
}
