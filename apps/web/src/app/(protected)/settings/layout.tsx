import { cookies } from 'next/headers'
import type { ReactNode } from 'react'

import { SettingsShell } from '@/components/account/settings-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { requireSession, UNAVAILABLE } from '@/lib/access'
import {
  CABINET_PANEL_COOKIE,
  CABINET_PANEL_WIDTH_COOKIE,
  parseCabinetPanelState,
  parseCabinetPanelWidth,
} from '@/lib/cabinet-panel'

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  // The cookie of the panel is read here so that the first paint already has it shown or hidden.
  const jar = await cookies()
  const panel = parseCabinetPanelState(jar.get(CABINET_PANEL_COOKIE)?.value)
  const panelWidth = parseCabinetPanelWidth(jar.get(CABINET_PANEL_WIDTH_COOKIE)?.value)

  return (
    <SettingsShell user={session.user} panelState={panel} panelWidth={panelWidth}>
      {children}
    </SettingsShell>
  )
}
