import type { Metadata } from 'next'

import { WorkspaceBuiltinMcp } from '@/components/account/builtin-mcp'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Встроенные MCP' }

/**
 * «Настройки → Встроенные MCP»: the built-in servers of Радити with their switches, «ВКонтакте» first
 * (docs/plan/99-vk-community.md, ВК15).
 */
export default async function BuiltinMcpPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return <WorkspaceBuiltinMcp />
}
