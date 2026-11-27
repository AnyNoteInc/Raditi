import type { Metadata } from 'next'

import { WorkspaceAgentSkills } from '@/components/account/agent-skills'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Подключения' }

/**
 * «Настройки → Подключения»: the MCP servers of the agent (docs/plan/81-mcp-server-credentials.md;
 * plan 83, БП11), formerly «Навыки агента» (docs/plan/97-skills.md, Нв21).
 */
export default async function ConnectionsPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return <WorkspaceAgentSkills />
}
