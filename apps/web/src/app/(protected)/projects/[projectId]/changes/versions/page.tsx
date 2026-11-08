import { redirect } from 'next/navigation'

import { siteHref } from '@/components/site/site-nav'

/**
 * The versions are the root of «Изменения» since 07.11.2026, when the tab «Файлы» went away: the
 * old address of the tab «Версии» leads there.
 */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  redirect(siteHref((await params).projectId, 'changes'))
}
