import type { SiteStatus } from '@repo/db'
import {
  type AppEnv,
  BROWSER_ONLY,
  isProduction,
  REPOSITORY_ONLY,
  type TaskRequirements,
} from '@repo/domain'
import { z } from 'zod'

// What a site can be worked on with now (docs/plan/57-browser-tasks.md, Б9): its repository —
// a copy of its files, a candidate and `/release` — and the cloud browser of the platform, which
// works in the site's own admin pages. The server decides both; the cabinet shows and offers what
// it is told. Neither stands in the way of the other: a site without an import or git still takes
// tasks in the browser.

/**
 * `ready` — a connected site with its repository; `importing` — its first import is queued or
 * running; `failed` — that import failed; `inactive` — the repository is there, the site is not
 * connected (`onboarding`) or is closed; `absent` — no repository and no import.
 */
export const repositoryCapabilityStates = [
  'ready',
  'absent',
  'importing',
  'failed',
  'inactive',
] as const
export type RepositoryCapability = (typeof repositoryCapabilityStates)[number]

/**
 * `ready` — the site takes tasks in the browser; `not_configured` — the platform has no browser in
 * this process; `closed` — the site is paused, disconnected or archived; `insecure` — in
 * production the site's address is not https, and the platform's browser opens https sites only
 * (its egress passes TLS alone, Б11).
 */
export const browserCapabilityStates = ['ready', 'not_configured', 'closed', 'insecure'] as const
export type BrowserCapability = (typeof browserCapabilityStates)[number]

export interface SiteCapabilities {
  repository: RepositoryCapability
  browser: BrowserCapability
}

export const siteCapabilitiesOutput = z.strictObject({
  repository: z.enum(repositoryCapabilityStates),
  browser: z.enum(browserCapabilityStates),
})

/** A site in one of these takes no task at all (`browserClosedSiteStatuses` of @repo/db). */
const CLOSED: readonly SiteStatus[] = ['paused', 'disconnected', 'archived']

/** What the capabilities of a site are decided by, as the procedures read it. */
export interface SiteCapabilityFacts {
  status: SiteStatus
  /** The state of its first import (`siteSetupState`); null — it has none. */
  setup: 'pending' | 'failed' | 'done' | null
  /** It has a row of `git_repositories`. */
  hasRepository: boolean
  /** The cabinet can show a browser of the platform: the stream of the browser is set up. */
  browserConfigured: boolean
  /** The browser can open the site's address: https, or any address outside production. */
  secureAddress: boolean
}

/** `SiteCapabilityFacts.secureAddress` of a site's address in an environment. */
export const browserAddressSecure = (url: string, appEnv: AppEnv | null): boolean =>
  appEnv === null || !isProduction(appEnv) || url.startsWith('https://')

export function siteCapabilities(site: SiteCapabilityFacts): SiteCapabilities {
  const closed = CLOSED.includes(site.status)
  let repository: RepositoryCapability
  if (closed) repository = 'inactive'
  else if (site.setup === 'pending') repository = 'importing'
  else if (site.setup === 'failed') repository = 'failed'
  else if (site.hasRepository) repository = site.status === 'active' ? 'ready' : 'inactive'
  else repository = 'absent'
  let browser: BrowserCapability
  if (closed) browser = 'closed'
  else if (!site.browserConfigured) browser = 'not_configured'
  else if (!site.secureAddress) browser = 'insecure'
  else browser = 'ready'
  return { repository, browser }
}

/**
 * The requirements of a task the client did not choose (`task.create` without them): the
 * repository where it is ready, else the browser where it is — and the repository otherwise, so a
 * site that takes neither is refused in the words it always was.
 */
export function defaultRequirements(capabilities: SiteCapabilities): TaskRequirements {
  if (capabilities.repository === 'ready') return { ...REPOSITORY_ONLY }
  if (capabilities.browser === 'ready') return { ...BROWSER_ONLY }
  return { ...REPOSITORY_ONLY }
}
