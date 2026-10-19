import { z } from 'zod'

/**
 * Short aliases of a site and of a dialog (docs/plan/53-chat-preview-release.md, Р17): the two
 * variable labels of a preview address `site-<siteAlias>-chat-<taskAlias>.<base>`. The database
 * gives them (`sites.alias`, `tasks.alias` DEFAULT) and checks the same pattern; a uuid v7 is
 * not shortened, because its leading bits are a timestamp.
 */
export const ALIAS_PATTERN_SOURCE = '^[0-9a-z]{4,12}$'
const ALIAS = new RegExp(ALIAS_PATTERN_SOURCE)

export const aliasLimits = Object.freeze({
  min: 4,
  max: 12,
  /** `sites.alias`: unique across the platform. */
  site: 8,
  /** `tasks.alias`: unique within its site. */
  task: 6,
})

/** Lower-case letters and digits: a DNS label of its own, without a hyphen to split on. */
export const aliasSchema = z.string().regex(ALIAS)
export type Alias = z.infer<typeof aliasSchema>

export const isAlias = (value: unknown): value is Alias =>
  typeof value === 'string' && ALIAS.test(value)
