// Stack adapters (spec §13): everything that depends on the CMS stays behind SiteAdapter.
export { bitrixAdapter } from './bitrix.ts'
export { fetchSiteTransport } from './http-transport.ts'
export { getSiteAdapter, getSiteContentAdapter } from './registry.ts'
export { wordpressAdapter } from './wordpress.ts'
export {
  wordpressContentAccessSchema,
  wordpressContentAdapter,
  WordpressPublishedContentGateway,
  type WordpressContentAccess,
  type WordpressContentConnection,
} from './wordpress-content.ts'
export {
  isAdminAjaxActionDenied,
  isAdminUrlDenied,
  isProtectedOption,
  isRestRequestDenied,
  isWpCliCommandDenied,
  wordpressMcpPolicy,
  type WordpressMcpPolicy,
} from './wordpress-mcp-policy.ts'
