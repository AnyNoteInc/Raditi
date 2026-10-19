import 'server-only'

import { errorMessage } from '@repo/observability'
import { notFound, unstable_rethrow } from 'next/navigation'
import { cache } from 'react'

import { UNAVAILABLE } from '@/lib/access'
import { loadSiteSection } from '@/lib/site'
import { getServerCaller } from '@/trpc/server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isNotFound = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'NOT_FOUND' || error.code === 'BAD_REQUEST')

/**
 * The dialog of a page, once per request: the site first (its access and its closed sections),
 * then the dialog of that very site. A dialog of someone else, of another site, one that does not
 * exist and an address that is not an id end in the same «not found» page.
 */
export const loadDialog = cache(async (projectId: string, taskId: string) => {
  const site = await loadSiteSection(projectId, 'chat')
  if (site === UNAVAILABLE) return UNAVAILABLE
  if (!UUID.test(taskId)) notFound()
  try {
    const dialog = await (await getServerCaller()).task.get({ taskId })
    if (dialog.siteId.toLowerCase() !== site.id.toLowerCase()) notFound()
    return { site, dialog }
  } catch (error) {
    unstable_rethrow(error)
    if (isNotFound(error)) notFound()
    console.error(`[web] dialog lookup failed: ${errorMessage(error)}`)
    return UNAVAILABLE
  }
})
