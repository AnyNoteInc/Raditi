/**
 * The stacks of a site and the values shared by its support and its facts (docs/plan/62-site-stacks.md,
 * §2.3). A leaf without imports: the port, `facts.ts` and the support read it, so none of them
 * imports another (`no-circular` counts type imports too).
 *
 * `siteStacks` is also the PostgreSQL enum `SiteStack`, in its order: new values go at the end.
 */
export const siteStacks = [
  'wordpress',
  'bitrix',
  'laravel',
  'static',
  'node',
  'python',
  'joomla',
  'modx',
  'opencart',
] as const
export type SiteStack = (typeof siteStacks)[number]

/** Why a site gets less than both ways (`SiteSupportNow.limit`, `sites.stack_facts.limit`). */
export const siteLimits = [
  'version_unsupported',
  'version_unknown',
  'not_yet',
  'other_product',
  'outside_root',
  'renamed_folder',
  'other_engine',
  'encoding_unsupported',
  'stack_off',
] as const
export type SiteLimit = (typeof siteLimits)[number]

/** How the platform works on a site: its files, or the browser on its panel. */
export const connectionWays = ['files', 'browser'] as const
export type ConnectionWay = (typeof connectionWays)[number]
