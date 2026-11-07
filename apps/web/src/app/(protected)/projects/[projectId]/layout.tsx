import type { Viewport } from 'next'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { SiteShell } from '@/components/site/site-shell'
import { requireSession, UNAVAILABLE } from '@/lib/access'
import {
  CABINET_PANEL_COOKIE,
  CABINET_PANEL_WIDTH_COOKIE,
  parseCabinetPanelState,
  parseCabinetPanelWidth,
} from '@/lib/cabinet-panel'
import { loadSite } from '@/lib/site'

/** The drawer of the sections of a phone sits beside the gesture area. */
export const viewport: Viewport = { viewportFit: 'cover' }

/**
 * The shell of one site. It only shows the name and the sections: access is checked again by
 * every page under it, because a layout is not rendered anew when the user moves between them.
 */
export default async function SiteLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ projectId: string }>
}) {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  const site = await loadSite((await params).projectId)
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  const jar = await cookies()
  const panel = parseCabinetPanelState(jar.get(CABINET_PANEL_COOKIE)?.value)
  const panelWidth = parseCabinetPanelWidth(jar.get(CABINET_PANEL_WIDTH_COOKIE)?.value)
  return (
    <SiteShell
      user={session.user}
      panelState={panel}
      panelWidth={panelWidth}
      site={{
        id: site.id,
        name: site.name,
        url: site.url,
        status: site.status,
        setup: site.setup,
        chat: site.chat,
      }}
    >
      {children}
    </SiteShell>
  )
}
