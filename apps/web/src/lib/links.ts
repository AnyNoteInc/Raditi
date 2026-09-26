const OWN_HOSTS = new Set(['raditi.ru', 'www.raditi.ru'])

export interface ResolvedLink {
  href: string
  /** Opens in a new tab with rel="noopener noreferrer". */
  external: boolean
}

/**
 * Links inside the legal texts: addresses on raditi.ru become site paths (they work locally
 * and skip a full reload), other http(s) links open in a new tab, mail and phone links stay.
 */
export function resolveDocumentLink(href: string | undefined): ResolvedLink {
  if (!href) return { href: '#', external: false }
  if (!/^https?:\/\//i.test(href)) return { href, external: false }
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { href, external: true }
  }
  if (OWN_HOSTS.has(url.hostname.toLowerCase())) {
    return { href: `${url.pathname}${url.search}${url.hash}`, external: false }
  }
  return { href, external: true }
}
