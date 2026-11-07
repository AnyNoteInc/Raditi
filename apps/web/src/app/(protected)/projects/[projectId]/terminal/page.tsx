import { redirect } from 'next/navigation'

import { siteHref } from '@/components/site/site-nav'

/**
 * The files of the version on the site are the tab «Файлы» of «Изменения» since 07.11.2026
 * (docs/plan/64-cabinet-navigation.md, Н4): the old address leads there — not for good, so that a
 * browser does not keep the move should the address be needed again.
 */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  redirect(siteHref((await params).projectId, 'changes'))
}
