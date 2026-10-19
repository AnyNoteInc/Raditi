import type { DeployManifest, SiteHttpResponse, SiteHttpTransport } from '@repo/domain'

// The check of the site before a release writes, after it and after its rollback (Р30, Р31;
// `SiteAdapter.verify()`): each page of the plan at the origin of the site must end in a 2xx and
// show none of the stack's failure markers. A redirect is followed while it stays on the site —
// the same host or its `www.` twin, the same scheme or an upgrade to https — at most
// `redirects` times; each hop is a request of its own through the pinned transport, so its
// address is checked again. A redirect elsewhere, or past the limit, fails the page: a page
// whose PHP never ran for the checked address proves nothing. A page that fails is asked once
// more after a pause (a cache warming up); the whole check is bounded in time.

export const siteCheckLimits = Object.freeze({
  pageTimeoutMs: 15_000,
  /** A larger page is not read to its end and counts as broken. */
  pageBytes: 8 * 1024 * 1024,
  tries: 2,
  pauseMs: 3_000,
  totalMs: 180_000,
  redirects: 3,
})

export interface SiteCheckResult {
  ok: boolean
  pages: number
  /** Pages that did not pass: a count only, never a path or a status (rule 1). */
  failed: number
}

const bareHost = (host: string): string => host.replace(/^www\./, '')

/**
 * Where a redirect from `from` leads when it stays on the site of `origin`; null — it leaves the
 * site, downgrades to http, names a credential or another port, or names nothing.
 */
export function redirectWithinSite(
  from: URL,
  location: string | undefined,
  origin: URL,
): URL | null {
  if (!location) return null
  let next: URL
  try {
    next = new URL(location, from)
  } catch {
    return null
  }
  if (next.username || next.password) return null
  const sameScheme = next.protocol === from.protocol
  const upgrade = from.protocol === 'http:' && next.protocol === 'https:'
  if (!sameScheme && !upgrade) return null
  if (bareHost(next.hostname) !== bareHost(origin.hostname)) return null
  // The port of the site, or the default one of an upgrade.
  if (sameScheme ? next.port !== from.port : next.port !== '') return null
  return next
}

export async function checkSite(
  transport: SiteHttpTransport,
  verify: DeployManifest['verify'],
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<SiteCheckResult> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const deadline = now() + siteCheckLimits.totalMs
  const origin = new URL(verify.origin)
  const markers = verify.failureMarkers.map((marker) => Buffer.from(marker, 'utf8'))

  /** The final answer of a page after the redirects within the site; null — it left or looped. */
  const fetchPage = async (start: URL): Promise<SiteHttpResponse | null> => {
    let url = start
    for (let hop = 0; ; hop += 1) {
      const left = deadline - now()
      if (left <= 0) return null
      const response = await transport({
        url: url.href,
        method: 'GET',
        headers: { accept: 'text/html,*/*', 'user-agent': 'Raditi release check' },
        timeoutMs: Math.min(siteCheckLimits.pageTimeoutMs, left),
        maxResponseBytes: siteCheckLimits.pageBytes,
      })
      if (response.status < 300 || response.status >= 400) return response
      const next = redirectWithinSite(url, response.location, origin)
      if (next === null || hop >= siteCheckLimits.redirects) return null
      url = next
    }
  }

  let failed = 0
  for (const page of verify.pages) {
    // Glued, not resolved: `//host/` stays a path of this origin and never names another host.
    const url = new URL(`${verify.origin}${page}`)
    if (url.origin !== verify.origin) {
      failed += 1
      continue
    }
    let passed = false
    for (let attempt = 0; attempt < siteCheckLimits.tries && !passed; attempt += 1) {
      if (attempt > 0) await sleep(siteCheckLimits.pauseMs)
      if (deadline - now() <= 0) break
      try {
        const response = await fetchPage(url)
        if (response === null) continue
        const body = Buffer.from(response.body)
        passed =
          response.status >= 200 &&
          response.status < 300 &&
          !markers.some((marker) => body.includes(marker))
      } catch {
        passed = false
      }
    }
    if (!passed) failed += 1
  }
  return { ok: failed === 0, pages: verify.pages.length, failed }
}
