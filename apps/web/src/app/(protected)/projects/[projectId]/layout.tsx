import type { Viewport } from 'next'
import type { ReactNode } from 'react'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { SiteShell } from '@/components/site/site-shell'
import { requireSession, UNAVAILABLE } from '@/lib/access'
import { loadSite } from '@/lib/site'

/** The bottom bar of a phone sits above the gesture area. */
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
  return (
    <SiteShell
      user={session.user}
      site={{
        id: site.id,
        name: site.name,
        url: site.url,
        status: site.status,
        setup: site.setup,
      }}
    >
      {children}
    </SiteShell>
  )
}
