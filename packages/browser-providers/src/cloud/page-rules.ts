import {
  browserForeignPageAllowed,
  browserNavigationAllowed,
  type BrowserController,
  type BrowserTaskPolicy,
  type SiteBrowserRequest,
} from '@repo/domain'

/**
 * Where the pages of a task's browser may go and what they may send (docs/plan/57-browser-tasks.md,
 * Б11, Б21; docs/plan/60-browser-foreign-redirects.md). The agent and the client open pages of the
 * site only (`openAllowed`); a page of the site may take the browser on to another public https
 * site — a payment, a sign-in service — and that site's pages and requests are its own, not the
 * stack's policy's to judge. The egress proxy of the session is the barrier — it reaches public
 * hosts only, never an address of the platform — and this is the second line, which also knows
 * the site's paths: every request of every page is checked before it leaves (`requestVerdict`),
 * and what a frame committed is checked after the fact (`committedAllowed`), because a redirect
 * is not routed. Pure, no I/O.
 */
export interface PageRules {
  /** `host:port` of the egress allowlist (`browserAllowedHosts`). */
  allowedHosts: readonly string[]
  /** Exact origins of local sites outside production. */
  localSites: readonly string[]
  policy: BrowserTaskPolicy
}

/** What the route does with a request: lets it go, or aborts it with Chromium's error. */
export type RequestVerdict = 'continue' | 'blockedbyclient' | 'accessdenied'

/** A policy that cannot read what it is asked denies it. */
function denies(check: () => boolean): boolean {
  try {
    return check()
  } catch {
    return true
  }
}

const pathOf = (url: URL) => `${url.pathname}${url.search}`

/**
 * Whether a URL is of a host the session reaches: https to a listed `host:port`, or exactly the
 * origin of a local site. Only the origin is judged here, so a long address of a subresource
 * (the admin's `load-scripts.php?…`) is not refused for its length; the agent's and the client's
 * own addresses are checked whole by `openAllowed`.
 */
export function originAllowed(url: URL, rules: PageRules): boolean {
  if (url.username !== '' || url.password !== '') return false
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  return browserNavigationAllowed(`${url.origin}/`, rules.allowedHosts, rules.localSites)
}

/** Whether a URL is of another site a page may go on to (Ч1, Ч4): public https, unrelated. */
function foreignOrigin(url: URL, rules: PageRules): boolean {
  return browserForeignPageAllowed(url.href, rules.allowedHosts, rules.localSites)
}

/**
 * Where a request or a commit comes from: the page's main frame or a frame inside it, and the
 * address the page's main frame shows (null for a request of no frame — a worker's). `siteOnly`:
 * nothing leaves for another site — while the saved sign-in is typed (Ч7).
 */
export interface PagePlace {
  main: boolean
  document: string | null
  siteOnly?: boolean
}

/** A place nothing of another site is reached from: a frame inside a page of the site. */
const INSIDE_THE_SITE: PagePlace = { main: false, document: null }

/** Whether the page of a place shows another site. */
function onAnotherSite(place: PagePlace, rules: PageRules): boolean {
  const shown = place.document === null ? null : URL.parse(place.document)
  return shown !== null && foreignOrigin(shown, rules)
}

/**
 * Whether a place reaches another site at `url` (Ч1): the page goes there itself — its main
 * frame, by a redirect, a link, a form, a script, a new tab (`navigates`) — or it is there
 * already. A page of the site loads nothing of another site: no picture, script, frame or call of
 * a service its stack's adapter does not list (`extraHosts`).
 */
function reaches(url: URL, rules: PageRules, place: PagePlace, navigates: boolean): boolean {
  if (place.siteOnly === true || !foreignOrigin(url, rules)) return false
  return navigates || onAnotherSite(place, rules)
}

/** Methods that only read: what a page of another site may ask of the site (Ч6). */
const READS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Headers with which a page asks the server to run a request as another method: WordPress obeys
 * `X-HTTP-Method-Override` on any method, and the block editor deletes by a POST that carries
 * it. The policy sees no headers, so it is asked with each such method as well.
 */
const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override']

/** The methods a request may run as on the server: its own and those its headers ask for. */
function methodsOf(method: string, headers: Readonly<Record<string, string>>): string[] {
  const methods = new Set([method])
  for (const [name, value] of Object.entries(headers))
    if (METHOD_OVERRIDE_HEADERS.includes(name.toLowerCase()))
      for (const asked of value.split(',')) methods.add(asked.trim().toUpperCase())
  return [...methods]
}

/**
 * A request of a page: to a host of the session, and nothing the stack's policy denies to who
 * holds the browser (`by`, the agent's when absent; Б37) — nor a write of a page of another site,
 * whose saves the task does not count (Ч6) — or on to another site from where it may be reached
 * (`reaches`), which the policy does not judge (Ч5). `place` defaults to a frame inside a page of
 * the site.
 */
export function requestVerdict(
  rules: PageRules,
  request: {
    url: string
    method: string
    postData: string | null
    navigation: boolean
    /** Its headers, names in any case; only the method overrides among them are read. */
    headers?: Readonly<Record<string, string>>
  },
  by: BrowserController = 'agent',
  place: PagePlace = INSIDE_THE_SITE,
): RequestVerdict {
  const url = URL.parse(request.url)
  if (!url) return 'blockedbyclient'
  const navigates = request.navigation && place.main
  if (!originAllowed(url, rules))
    return reaches(url, rules, place, navigates) ? 'continue' : 'blockedbyclient'
  const path = pathOf(url)
  const methods = methodsOf(request.method, request.headers ?? {})
  if (onAnotherSite(place, rules) && methods.some((method) => !READS.has(method)))
    return 'accessdenied'
  for (const method of methods) {
    const asked: SiteBrowserRequest = { path, method, postData: request.postData }
    if (denies(() => rules.policy.requestDenied(asked, by))) return 'accessdenied'
  }
  if (request.navigation && denies(() => rules.policy.pageDenied(path, by))) return 'accessdenied'
  return 'continue'
}

/** Documents a frame may show that no site served: an empty one, Chromium's error page, its own. */
const LOCAL_SCHEMES = new Set(['about:', 'chrome-error:', 'data:', 'blob:'])

/**
 * Whether a frame may keep what it committed: a page of a host of the session the policy does
 * not deny, a page of another site where the frame may reach it (Ч1: a main frame, or a frame
 * inside a page of another site), or a document no site served. Anything else came by a redirect
 * the route never saw and is dropped before anyone reads it.
 */
export function committedAllowed(
  rules: PageRules,
  address: string,
  by: BrowserController = 'agent',
  place: PagePlace = INSIDE_THE_SITE,
): boolean {
  const url = URL.parse(address)
  if (!url) return false
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return LOCAL_SCHEMES.has(url.protocol)
  if (!originAllowed(url, rules)) return reaches(url, rules, place, place.main)
  return !denies(() => rules.policy.pageDenied(pathOf(url), by))
}

/**
 * Whether the agent's `web_open` or the client's `navigate` may go to an address at all: a page
 * of the site only — another site is reached from a page of the site, never by address (Ч2).
 */
export function openAllowed(
  rules: PageRules,
  address: string,
  by: BrowserController = 'agent',
): boolean {
  if (!browserNavigationAllowed(address, rules.allowedHosts, rules.localSites)) return false
  const url = URL.parse(address)
  return url !== null && !denies(() => rules.policy.pageDenied(pathOf(url), by))
}
