import 'server-only'

import type { SiteHttpTransport } from '@repo/domain'

// The icon of a site for the tile on top of its rail: /favicon.ico of the site's own origin,
// fetched by the server — the browser of the cabinet asks only its own origin for images
// (img-src 'self') and never meets the site's content. The transport dials only an address the
// site-address rule allows (in production public ones); a redirect is followed only within the
// same origin, the time and the size are bounded, and what comes back is served only when its
// bytes are one of a few raster image formats — never SVG, never what the site said it is.

export interface SiteFaviconDependencies {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  /** Whether the user of these headers accepted the current required documents (152-FZ). */
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** The public origin of a site the user may open (project.get); null for any other id. */
  siteOrigin: (input: { headers: Headers; siteId: string }) => Promise<string | null>
  /** A pinned transport to the site (createPinnedSiteTransport of @repo/site-connections). */
  transport: SiteHttpTransport
  /** The cache of answers, per site and origin; one per process. */
  cache: FaviconCache
  now?: () => number
  /** For the server log only: the cause never reaches the client. */
  onFailure?: (operation: string, error: unknown) => void
}

export interface FaviconImage {
  bytes: Uint8Array
  type: string
}

/** The answer kept for a site: an icon, or that it has none, until `expiresAt`. */
interface CachedFavicon {
  image: FaviconImage | null
  expiresAt: number
}

export const faviconLimits = Object.freeze({
  /** One request to the site, redirects included. */
  timeoutMs: 3_000,
  maxBytes: 64 * 1024,
  /** Within the same origin only: http → https of the same host is another origin. */
  maxRedirects: 2,
  /** How long a found icon and a missing one are kept before the site is asked again. */
  foundMs: 60 * 60 * 1000,
  missingMs: 10 * 60 * 1000,
  /** Sites kept at once; the oldest entry goes first. */
  entries: 500,
})

/** An in-memory cache of the answers of sites, the oldest entry dropped first. */
export class FaviconCache {
  readonly #entries = new Map<string, CachedFavicon>()
  readonly #limit: number

  constructor(limit: number = faviconLimits.entries) {
    this.#limit = limit
  }

  get(key: string, now: number): CachedFavicon | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= now) {
      this.#entries.delete(key)
      return undefined
    }
    return entry
  }

  set(key: string, entry: CachedFavicon): void {
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }
}

const startsWith = (bytes: Uint8Array, offset: number, hex: string): boolean => {
  if (bytes.length < offset + hex.length / 2) return false
  for (let index = 0; index < hex.length / 2; index += 1) {
    if (bytes[offset + index] !== Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16))
      return false
  }
  return true
}

/** The type of an icon by its leading bytes; null for anything else, SVG included. */
export function faviconType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, 0, '00000100')) return 'image/x-icon'
  if (startsWith(bytes, 0, '89504e470d0a1a0a')) return 'image/png'
  if (startsWith(bytes, 0, '47494638')) return 'image/gif'
  if (startsWith(bytes, 0, 'ffd8ff')) return 'image/jpeg'
  if (startsWith(bytes, 0, '52494646') && startsWith(bytes, 8, '57454250')) return 'image/webp'
  return null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** /favicon.ico of the origin, following redirects of the same origin only; null when none. */
async function fetchFavicon(transport: SiteHttpTransport, origin: string): Promise<FaviconImage | null> {
  const started = Date.now()
  let url = new URL('/favicon.ico', origin)
  for (let redirects = 0; ; redirects += 1) {
    const left = faviconLimits.timeoutMs - (Date.now() - started)
    if (left <= 0) return null
    const response = await transport({
      url: url.href,
      method: 'GET',
      headers: { accept: 'image/*', 'user-agent': 'Raditi favicon' },
      timeoutMs: left,
      maxResponseBytes: faviconLimits.maxBytes,
    })
    if (response.status >= 300 && response.status < 400) {
      if (response.location === undefined || redirects >= faviconLimits.maxRedirects) return null
      let next: URL
      try {
        next = new URL(response.location, url)
      } catch {
        return null
      }
      if (next.origin !== url.origin) return null
      url = next
      continue
    }
    if (response.status !== 200) return null
    const type = faviconType(response.body)
    return type === null ? null : { bytes: response.body, type }
  }
}

const answer = (status: number) =>
  new Response(null, { status, headers: { 'cache-control': 'no-store' } })

export async function getSiteFavicon(
  request: Request,
  params: { projectId: string },
  deps: SiteFaviconDependencies,
): Promise<Response> {
  const now = deps.now ?? Date.now
  try {
    const session = await deps.getSession(request.headers)
    if (!session) return answer(401)
    if (!(await deps.hasRequiredConsents(request.headers))) return answer(428)
    // Someone else's site, one that does not exist and an id that is not one answer the same.
    if (!UUID.test(params.projectId)) return answer(404)
    const origin = await deps.siteOrigin({ headers: request.headers, siteId: params.projectId })
    if (origin === null) return answer(404)

    const key = `${params.projectId.toLowerCase()} ${origin}`
    let cached = deps.cache.get(key, now())
    if (cached === undefined) {
      let image: FaviconImage | null = null
      try {
        image = await fetchFavicon(deps.transport, origin)
      } catch (error) {
        // A refused address, a timeout, a cut connection, an answer too large: no icon.
        deps.onFailure?.('site favicon fetch failed', error)
      }
      cached = {
        image,
        expiresAt: now() + (image ? faviconLimits.foundMs : faviconLimits.missingMs),
      }
      deps.cache.set(key, cached)
    }
    if (cached.image === null) return answer(404)
    return new Response(new Uint8Array(cached.image.bytes), {
      headers: {
        'content-type': cached.image.type,
        'content-length': String(cached.image.bytes.byteLength),
        // The owner's browser keeps a private copy for a day: the rail does not ask on every page.
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  } catch (error) {
    deps.onFailure?.('site favicon failed', error)
    return answer(503)
  }
}
