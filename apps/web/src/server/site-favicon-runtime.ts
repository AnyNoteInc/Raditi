import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import type { SiteHttpTransport } from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { createHostLookup } from '@repo/site-connections'
import { createPinnedSiteTransport } from '@repo/site-connections/hosting'
import { createCaller, createContext } from '@repo/trpc'

import { env } from '@/env'

import { FaviconCache, type SiteFaviconDependencies } from './site-favicon'

const isNotFound = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'NOT_FOUND' || error.code === 'BAD_REQUEST')

let transport: SiteHttpTransport | undefined
/** Built on first use: the environment is read when an icon is asked for, not at import. */
const pinnedTransport: SiteHttpTransport = (request) =>
  (transport ??= createPinnedSiteTransport({
    lookup: createHostLookup(),
    appEnv: env.web().appEnv,
  }))(request)

export const siteFaviconDependencies: SiteFaviconDependencies = {
  getSession: getSessionFromHeaders,
  async hasRequiredConsents(headers) {
    // The same answer the cabinet layout uses (lib/access.ts).
    const consents = await createCaller(await createContext({ headers })).consent.list()
    return consents.every((consent) => !consent.required || consent.accepted)
  },
  async siteOrigin({ headers, siteId }) {
    // The rule of project.get: a site of one of the user's workspaces, not deleted.
    try {
      const site = await createCaller(await createContext({ headers })).project.get({ id: siteId })
      return new URL(site.url).origin
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  },
  transport: pinnedTransport,
  cache: new FaviconCache(),
  onFailure: throttledLogger((line) => console.error(`[web] ${line}`)),
}
