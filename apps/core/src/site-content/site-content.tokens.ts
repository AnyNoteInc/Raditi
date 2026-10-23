/**
 * DbPlanValueReader (previewDbPlanValues): the values the agent wrote into a preview, as the mcp
 * role sealed them (R5c, R7) — what a candidate, a rebuild of a preview, a release and an undo read.
 */
export const PLAN_VALUES = Symbol('PLAN_VALUES')
/** HostLookup: DNS of the site connection (A and AAAA, no hosts file). */
export const HOST_LOOKUP = Symbol('HOST_LOOKUP')
/**
 * SiteContentResolvers: makes a resolver of a site's production content gateway. Each consumer
 * makes its own once: a resolver keeps a site's access in memory for up to 60 seconds.
 */
export const SITE_CONTENT_RESOLVERS = Symbol('SITE_CONTENT_RESOLVERS')
