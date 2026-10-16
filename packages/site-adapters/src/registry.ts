import type { SiteAdapter, SiteContentAdapter, SiteStack } from '@repo/domain'
import { badRequest, notImplemented, siteStacks } from '@repo/domain'
import { bitrixAdapter } from './bitrix.ts'
import { wordpressContentAdapter } from './wordpress-content.ts'
import { wordpressAdapter } from './wordpress.ts'

const adapters = new Map<SiteStack, SiteAdapter>([
  ['wordpress', wordpressAdapter],
  ['bitrix', bitrixAdapter],
])

/** Spec §13: stacks without an adapter yet and the stage that brings one. */
const plannedStacks = new Map<SiteStack, string>([
  ['static', 'stage 2'],
  ['laravel', 'stage 3'],
  ['node', 'stage 3'],
  ['python', 'stage 3'],
])

export function getSiteAdapter(stack: SiteStack): SiteAdapter {
  const adapter = adapters.get(stack)
  if (adapter) return adapter
  const stage = plannedStacks.get(stack)
  if (stage) throw notImplemented(`SiteAdapter for ${stack} (${stage})`)
  // `stack` may come from the database as a plain string.
  throw badRequest(`Unknown site stack: ${String(stack)}`)
}

/**
 * Stacks whose sites the connection wizard takes (spec §12). An adapter alone is not enough:
 * the stack joins the list when the rest of its way into the product is there.
 */
export const connectableStacks: readonly SiteStack[] = ['wordpress']

const contentAdapters = new Map<SiteStack, SiteContentAdapter>([
  ['wordpress', wordpressContentAdapter],
])

/**
 * Published content by stack (spec §11, §13): the application asks for the stack of the site
 * and never compares it with a CMS itself.
 */
export function getSiteContentAdapter(stack: SiteStack): SiteContentAdapter {
  const adapter = contentAdapters.get(stack)
  if (adapter) return adapter
  if (siteStacks.includes(stack)) throw notImplemented(`Published content for ${stack}`)
  // `stack` may come from the database as a plain string.
  throw badRequest(`Unknown site stack: ${String(stack)}`)
}
