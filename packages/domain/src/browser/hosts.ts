import { badRequest } from '../errors.ts'
import { ipLiteralBytes } from '../policies/site-address.ts'
import { egressHostLimits, formatEgressHost, parseEgressHost } from '../preview/egress-hosts.ts'
import { browserSessionLimits } from './session.ts'

/**
 * Where the browser of a task may go (docs/plan/57-browser-tasks.md, Б11). Its only way out is an
 * egress proxy with a list of `host:port`, the rule of the client's variables (egress-hosts.ts):
 * public DNS names only, resolved by the proxy on every connection, TLS only. Pages open over
 * `https://` only; a disposable local site outside production is named exactly by its origin
 * (`BROWSER_LOCAL_SITES`) and reached without DNS.
 */

const WWW = 'www.'

/** The site's host and its `www.` twin (or the bare host of a `www.` one), https only. */
function siteHosts(siteUrl: string): string[] {
  let url: URL
  try {
    url = new URL(siteUrl)
  } catch {
    throw badRequest('Invalid site address')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return []
  const port = url.port === '' ? '' : `:${url.port}`
  const twin = url.hostname.startsWith(WWW)
    ? url.hostname.slice(WWW.length)
    : `${WWW}${url.hostname}`
  return [url.hostname, twin].flatMap((host) => {
    const parsed = parseEgressHost(`${host}${port}`)
    return parsed === null ? [] : [formatEgressHost(parsed)]
  })
}

/**
 * The allowlist of the browser's egress proxy, `host:port` each once: the site (an https address
 * with a public name; a plain-http, IP or local site adds nothing), the hosts its stack's pages
 * load from (`browserTaskPolicy().extraHosts`) and `BROWSER_EXTRA_HOSTS`. A host there that is
 * not a public name, or more than the proxy takes, is the adapter's or operator's mistake: thrown.
 */
export function browserAllowedHosts(
  siteUrl: string,
  adapterExtraHosts: readonly string[],
  configuredExtra: readonly string[],
): string[] {
  const extra = [...adapterExtraHosts, ...configuredExtra].map((text) => {
    const parsed = parseEgressHost(text)
    if (parsed === null) throw badRequest('Invalid browser host')
    return formatEgressHost(parsed)
  })
  const hosts = [...new Set([...siteHosts(siteUrl), ...extra])]
  if (hosts.length > egressHostLimits.perSite) throw badRequest('Too many browser hosts')
  return hosts
}

/** The exact origin of a local site as `BROWSER_LOCAL_SITES` names it; null for anything else. */
export function browserLocalSiteOrigin(text: string): string | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const plain = url.username === '' && url.password === '' && url.search === '' && url.hash === ''
  const bare = url.pathname === '/' && !text.endsWith('/')
  if (!plain || !bare || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
  return url.origin === text ? text : null
}

/**
 * Whether a page of the session may open `address` (the agent's `web_open`, the client's
 * `navigate`, every navigation the page makes): `https://` to a host of `allowed` (its port, 443
 * by default), or exactly the origin of a local site. Never credentials in the address, an IP
 * literal, another scheme (`http:` to the internet, `file:`, `data:`, `javascript:`…), white space
 * or control characters, or an address longer than the session carries.
 */
export function browserNavigationAllowed(
  address: string,
  allowed: readonly string[],
  localSites: readonly string[],
): boolean {
  if (address.length > browserSessionLimits.urlChars || /[\s\p{Cc}]/u.test(address)) return false
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '') return false
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (localSites.some((site) => browserLocalSiteOrigin(site) === url.origin)) return true
  if (url.protocol !== 'https:') return false
  if (ipLiteralBytes(url.hostname.replace(/^\[(.*)\]$/, '$1')) !== null) return false
  const target = `${url.hostname}:${url.port === '' ? 443 : url.port}`
  return allowed.some((host) => host.toLowerCase() === target)
}
