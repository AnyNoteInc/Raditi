import { redirect } from 'next/navigation'

import { siteHref } from '@/components/site/site-nav'

/**
 * The section «Терминал» went into «Изменения» on 07.11.2026 (docs/plan/64-cabinet-navigation.md,
 * Н4), and its tab «Файлы» went away the same day: the old address leads to «Изменения» — not for
 * good, so that a browser does not keep the move should the address be needed again.
 */
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  redirect(siteHref((await params).projectId, 'changes'))
}
