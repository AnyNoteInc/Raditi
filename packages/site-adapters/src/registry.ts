import type {
  AppEnv,
  ConnectionWay,
  SiteAdapter,
  SiteContentAdapter,
  SiteStack,
} from '@repo/domain'
import { badRequest, notImplemented, siteStacks, stackAxisOpen } from '@repo/domain'
import { bitrixAdapter } from './bitrix.ts'
import { joomlaAdapter } from './joomla/joomla.ts'
import { wordpressContentAdapter } from './wordpress-content.ts'
import { wordpressAdapter } from './wordpress.ts'

const adapters = new Map<SiteStack, SiteAdapter>([
  // WordPress first: the wizard starts on the first stack it is given.
  ['wordpress', wordpressAdapter],
  ['bitrix', bitrixAdapter],
  ['joomla', joomlaAdapter],
])

/** Spec §13: stacks without an adapter yet and the stage that brings one. */
const plannedStacks = new Map<SiteStack, string>([
  ['static', 'stage 2'],
  ['laravel', 'stage 3'],
  ['node', 'stage 3'],
  ['python', 'stage 3'],
  ['modx', 'plan 62'],
  ['opencart', 'plan 62'],
])

export function getSiteAdapter(stack: SiteStack): SiteAdapter {
  const adapter = adapters.get(stack)
  if (adapter) return adapter
  const stage = plannedStacks.get(stack)
  if (stage) throw notImplemented(`SiteAdapter for ${stack} (${stage})`)
  // `stack` may come from the database as a plain string.
  throw badRequest(`Unknown site stack: ${String(stack)}`)
}

/** Every adapter of the registry, in its order. */
export const siteAdapters = (): readonly SiteAdapter[] => [...adapters.values()]

/**
 * Stacks whose sites the connection wizard takes by `way` in `env` (spec §12; docs/plan/62-site-stacks.md,
 * Т4, Т6): the adapters whose support opens that axis, in the order of the registry. An adapter alone is
 * not enough — a stack joins when its support says so, and an axis at `dev` is open outside production
 * only.
 */
export function connectableStacks(env: AppEnv, way: ConnectionWay): readonly SiteStack[] {
  return stacksOpenBy(siteAdapters(), env, way)
}

/** The rule of `connectableStacks` over any adapters: the stacks whose `way` axis is open in `env`. */
export function stacksOpenBy(
  of: readonly Pick<SiteAdapter, 'stack' | 'support'>[],
  env: AppEnv,
  way: ConnectionWay,
): readonly SiteStack[] {
  return of
    .filter((adapter) =>
      stackAxisOpen(way === 'files' ? adapter.support.files : adapter.support.browser, env),
    )
    .map((adapter) => adapter.stack)
}

const contentAdapters = new Map<SiteStack, SiteContentAdapter>([
  ['wordpress', wordpressContentAdapter],
])

/**
 * Published content by stack (spec §11, §13): the application asks for the stack of the site
 * and never compares it with a CMS itself.
 */
export function getSiteContentAdapter(stack: SiteStack): SiteContentAdapter {
  const adapter = findSiteContentAdapter(stack)
  if (adapter) return adapter
  throw notImplemented(`Published content for ${stack}`)
}

/**
 * The published-content adapter of a stack; null — the stack has none, and a release of its site
 * goes without the plugin (docs/plan/62-site-stacks.md, Т8).
 */
export function findSiteContentAdapter(stack: SiteStack): SiteContentAdapter | null {
  const adapter = contentAdapters.get(stack)
  if (adapter) return adapter
  if (siteStacks.includes(stack)) return null
  // `stack` may come from the database as a plain string.
  throw badRequest(`Unknown site stack: ${String(stack)}`)
}
