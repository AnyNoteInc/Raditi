import 'server-only'

import { errorMessage } from '@repo/observability'
import { notFound, redirect, unstable_rethrow } from 'next/navigation'
import { cache } from 'react'

import { siteHref, siteSectionAvailable, type SiteSection } from '@/components/site/site-nav'
import { getServerCaller } from '@/trpc/server'

import { requireSession, UNAVAILABLE } from './access'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isNotFound = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'NOT_FOUND' || error.code === 'BAD_REQUEST')

/**
 * The site of a cabinet page, once per request. A site of someone else, a site that does not
 * exist and an address that is not an id all end in the same «not found» page. Every page of
 * the site calls it: a layout is not rendered again on navigation, so it alone guards nothing.
 */
export const loadSite = cache(async (projectId: string) => {
  // First the session: without one the visitor goes to the sign-in page, not to «unavailable».
  if ((await requireSession()) === UNAVAILABLE) return UNAVAILABLE
  if (!UUID.test(projectId)) notFound()
  try {
    return await (await getServerCaller()).project.get({ id: projectId })
  } catch (error) {
    unstable_rethrow(error)
    if (isNotFound(error)) notFound()
    console.error(`[web] site lookup failed: ${errorMessage(error)}`)
    return UNAVAILABLE
  }
})

/**
 * The site of a page of one section. «Not found» comes first, as in `loadSite`; then a site
 * that is being set up, or whose status closes the section — paused, disconnected or archived —
 * is sent to «Обзор». The page itself calls it: the layout above is not rendered again on
 * navigation.
 */
export async function loadSiteSection(projectId: string, section: SiteSection) {
  const site = await loadSite(projectId)
  if (site === UNAVAILABLE) return UNAVAILABLE
  if (!siteSectionAvailable(site.status, section, site.setup)) {
    redirect(siteHref(site.id, 'overview'))
  }
  return site
}

/** The saved accesses of a site the user may open; UNAVAILABLE when they cannot be read. */
export const loadSiteCredentials = cache(async (projectId: string) => {
  if ((await requireSession()) === UNAVAILABLE) return UNAVAILABLE
  try {
    return await (await getServerCaller()).project.credentials({ id: projectId })
  } catch (error) {
    unstable_rethrow(error)
    if (isNotFound(error)) notFound()
    console.error(`[web] site accesses lookup failed: ${errorMessage(error)}`)
    return UNAVAILABLE
  }
})

/**
 * The first import of a site for the setup screen, with the page; null when it cannot be read —
 * the screen then asks for it itself. Access is the procedure's own check: the page calls it only
 * after `loadSite` found the site.
 */
export const loadSiteSetup = cache(async (projectId: string) => {
  try {
    return await (await getServerCaller()).siteConnection.setup({ id: projectId })
  } catch (error) {
    unstable_rethrow(error)
    console.error(`[web] site setup lookup failed: ${errorMessage(error)}`)
    return null
  }
})
