import { pagePathSchema, type PageLinkWarning } from '@repo/domain'

/**
 * The links of a page to its own site that lead nowhere (docs/plan/73-pages-sites.md, Дер20): a
 * root-relative `href="/a/b"` no page of the site has after the turn — a page the same turn
 * reserved is there —, and a relative `href="b"`, which a canonical path without a slash at the
 * end resolves against the parent (GitLab Pages). A word to the client, never a refusal: the page
 * goes live as it is. What is no link of the site — another site, `#`, `mailto:`, `tel:`,
 * `data:`, a protocol-relative `//` — is not looked at. At most 20, each told once.
 */
export function pageLinkWarnings(html: string, sitePaths: ReadonlySet<string>): PageLinkWarning[] {
  const warnings: PageLinkWarning[] = []
  const told = new Set<string>()
  for (const match of html.matchAll(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    const problem = problemOf(href, sitePaths)
    if (problem === null || told.has(href)) continue
    told.add(href)
    // Only what the row may carry is told by its text; the rest only counts as a missing link.
    const shown = /^[A-Za-z0-9/._~-]{1,200}$/.test(href) ? href : '…'
    warnings.push({ href: shown, problem })
    if (warnings.length === 20) break
  }
  return warnings
}

function problemOf(href: string, sitePaths: ReadonlySet<string>): 'missing' | 'relative' | null {
  if (href === '' || href.startsWith('#') || href.startsWith('//')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null
  if (href.startsWith('/')) {
    const path = href.split(/[?#]/)[0]!
    // The shared files of a site (Дер34) are no pages: they have their own check.
    if (path.startsWith('/_files/')) return null
    return pagePathSchema.safeParse(path).success && sitePaths.has(path) ? null : 'missing'
  }
  return 'relative'
}
