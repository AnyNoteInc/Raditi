import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { AccountSkills } from '@/components/account/account-skills'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Навыки' }

/**
 * «Настройки → Навыки»: the skills of the account (docs/plan/97-skills.md, Нв21). The MCP servers
 * that lived here are «Подключения» now: a return from the sign-in of a server begun before the
 * move (`?mcp=…`) goes there, for one release.
 */
export default async function SkillsPage({ searchParams }: PageProps<'/settings/skills'>) {
  const query = await searchParams
  if (typeof query.mcp === 'string') {
    const kept = new URLSearchParams({ mcp: query.mcp })
    if (typeof query.skill === 'string') kept.set('skill', query.skill)
    redirect(`/settings/connections?${kept.toString()}`)
  }
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return <AccountSkills />
}
