import type { PrismaClient } from '@repo/db'
import {
  isProduction,
  type AppEnv,
  type HostLookup,
  type SecretStore,
  type SiteContentGateway,
} from '@repo/domain'
import { getSiteContentAdapter } from '@repo/site-adapters'
import { createPinnedSiteTransport } from '@repo/site-connections/hosting'
import {
  createSiteContentResolver,
  type SiteContentResolver,
  type SiteScope,
} from '@repo/site-content'

/** Makes a resolver of a site's production content gateway, with an access cache of its own. */
export type SiteContentResolvers = () => SiteContentResolver

/**
 * Production's plugin by the site's own access, at an address the site rule allows (spec §12).
 * Every call makes a new resolver: its consumer — the preview manager, the release skill, the
 * undo planner — keeps the site's access it read for itself.
 */
export function siteContentResolvers(deps: {
  prisma: PrismaClient
  secrets: SecretStore
  lookup: HostLookup
  appEnv: AppEnv
}): SiteContentResolvers {
  return () =>
    createSiteContentResolver({
      prisma: deps.prisma,
      secrets: deps.secrets,
      // The stack of the site picks its adapter; core names no CMS.
      adapters: getSiteContentAdapter,
      // The address rule of a site (spec §12): never an address of the platform.
      transport: createPinnedSiteTransport({ lookup: deps.lookup, appEnv: deps.appEnv }),
      // A disposable local site of a stand: plain http on loopback, never in production.
      allowLoopbackHttp: !isProduction(deps.appEnv),
    })
}

/**
 * What the readiness of a release and the plan of an undo read of a site's database: the gateway
 * of the resolver as the stack's own, which carries the plugin's database part.
 */
export function productionContent(
  resolve: SiteContentResolver,
): (scope: SiteScope) => Promise<SiteContentGateway> {
  return (scope) => resolve(scope) as Promise<SiteContentGateway>
}
