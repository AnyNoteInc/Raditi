import type { Metadata } from 'next'

import { ApplicationShell } from '@/components/application/application-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { PagesView } from '@/components/pages/pages-view'
import { requireSession, UNAVAILABLE } from '@/lib/access'

export const metadata: Metadata = { title: 'Страницы' }

/**
 * «Страницы» (docs/plan/69-pages.md, Ст30): the pages of the user's workspaces. Like the list of
 * projects it names itself in its heading, so it has no bar of breadcrumbs.
 */
export default async function PagesPage() {
  const session = await requireSession()
  if (session === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <ApplicationShell user={session.user} toolbar={false}>
      <PagesView />
    </ApplicationShell>
  )
}
