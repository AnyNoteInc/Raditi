import type { BrowserTaskPolicy, SiteAdapter } from '../ports/site-adapter.ts'
import { browserForeignPageAllowed, browserNavigationAllowed } from './hosts.ts'
import { browserSessionLimits } from './session.ts'

/**
 * The browser of a chat without a site (docs/plan/61-chats-first.md, К12, §5.5): any public
 * `https://` site opens by its address. No site, no stack, no object of the task and no limit of 20
 * objects: only the instructions of the turn hold the agent there. Whether a session is one comes
 * from its row alone (`browser_sessions.site_id IS NULL`), never from a caller.
 *
 * The addresses of the platform stay closed in every session, by name (К37): a client signed in to
 * the cabinet in the cloud browser would hand the agent the button of `/release`.
 */

/** What a session of the browser may open by address. */
export interface BrowserReach {
  /** A chat without a site: any public `https://` site as well. */
  openWeb: boolean
  /** `host:port` of the egress allowlist (`browserAllowedHosts`); none without a site. */
  allowedHosts: readonly string[]
  /** Exact origins of local sites outside production. */
  localSites: readonly string[]
  /** `BROWSER_PLATFORM_HOSTS`: names of the platform, each with everything under it. */
  platformHosts: readonly string[]
}

/** Whether a host name is a name of the platform or anything under one. */
export function browserPlatformHost(hostname: string, platformHosts: readonly string[]): boolean {
  // The root's dot and letter case name the same host.
  const name = hostname.toLowerCase().replace(/\.$/, '')
  return platformHosts.some((host) => name === host || name.endsWith(`.${host}`))
}

/**
 * Whether the agent's `web_open` or the client's `navigate` may go to an address: a page of the
 * site (`browserNavigationAllowed`), or — without a site — what a page could go on to
 * (`browserForeignPageAllowed`): `https://` to a public DNS name on a TLS port of the egress proxy.
 * A name of the platform never, in either session.
 */
export function browserAddressOpens(address: string, reach: BrowserReach): boolean {
  if (address.length > browserSessionLimits.urlChars || /[\s\p{Cc}]/u.test(address)) return false
  const url = URL.parse(address)
  if (url === null || browserPlatformHost(url.hostname, reach.platformHosts)) return false
  if (browserNavigationAllowed(address, reach.allowedHosts, reach.localSites)) return true
  return reach.openWeb && browserForeignPageAllowed(address, [], reach.localSites)
}

/** The policy of a chat without a site: it starts on an empty page and closes nothing itself. */
export const OPEN_WEB_POLICY: BrowserTaskPolicy = Object.freeze({
  startPath: '/',
  extraHosts: [],
  requestDenied: () => false,
  pageDenied: () => false,
})

/** What a session asks of a stack about the objects of its task. */
export type BrowserObjects = Pick<
  SiteAdapter,
  'browserCheckpointOf' | 'browserCommitAction' | 'browserVerification'
>

/** No object of a task lives on the open internet: nothing to record, to hold back or to read. */
export const OPEN_WEB_OBJECTS: BrowserObjects = Object.freeze({
  browserCheckpointOf: () => null,
  browserCommitAction: () => null,
  browserVerification: () => {
    throw new Error('A chat without a site has no object to read')
  },
})
