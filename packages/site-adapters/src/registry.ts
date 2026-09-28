import type { SiteAdapter, SiteStack } from '@repo/domain'
import { badRequest, notImplemented } from '@repo/domain'
import { bitrixAdapter } from './bitrix.ts'
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
