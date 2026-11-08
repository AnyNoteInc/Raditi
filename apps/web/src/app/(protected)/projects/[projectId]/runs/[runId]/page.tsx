import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { siteHref } from '@/components/site/site-nav'
import { RunDetail } from '@/components/site/site-runs'
import { BackLink } from '@/components/site/site-section'
import { UNAVAILABLE } from '@/lib/access'
import { loadSiteHistory, loadSiteSection } from '@/lib/site'

export const metadata: Metadata = { title: 'Запуск' }

const RUN_ID = /^(import|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** One run of «Запуски» with its steps and journal, a page of its own (Н6). */
export default async function Page({
  params,
}: {
  params: Promise<{ projectId: string; runId: string }>
}) {
  const { projectId, runId } = await params
  const site = await loadSiteSection(projectId, 'runs')
  if (site === UNAVAILABLE) return <ServiceUnavailable />
  if (!RUN_ID.test(runId)) notFound()
  const run = await loadSiteHistory('run', (caller) =>
    caller.siteHistory.run({ siteId: site.id, runId: runId.toLowerCase() }),
  )
  if (run === UNAVAILABLE) return <ServiceUnavailable />
  return (
    <>
      <BackLink href={siteHref(site.id, 'runs')}>Все запуски</BackLink>
      <RunDetail run={run} now={new Date()} nested />
    </>
  )
}
