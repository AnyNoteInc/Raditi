import { cookies } from 'next/headers'
import type { ReactNode } from 'react'

import { SettingsShell } from '@/components/account/settings-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'
import { parseSettingsSidebarState, SETTINGS_SIDEBAR_COOKIE } from '@/lib/settings-sidebar'

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  // The sidebar cookie is read here so that the first paint already has the chosen width.
  const sidebar = parseSettingsSidebarState((await cookies()).get(SETTINGS_SIDEBAR_COOKIE)?.value)

  return (
    <SettingsShell user={session.user} sidebar={sidebar}>
      {children}
    </SettingsShell>
  )
}
