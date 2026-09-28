// Stack adapters (spec §13): everything that depends on the CMS stays behind SiteAdapter.
export { bitrixAdapter } from './bitrix.ts'
export { getSiteAdapter } from './registry.ts'
export { wordpressAdapter } from './wordpress.ts'
export {
  isAdminAjaxActionDenied,
  isAdminUrlDenied,
  isProtectedOption,
  isRestRequestDenied,
  isWpCliCommandDenied,
  wordpressMcpPolicy,
  type WordpressMcpPolicy,
} from './wordpress-mcp-policy.ts'
