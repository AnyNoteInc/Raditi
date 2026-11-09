import type { SiteBrowserRequest } from '@repo/domain'

import { isRestRequestDenied } from './wordpress-mcp-policy.ts'

const base = 'https://site.invalid'

/** Both WordPress browsers follow the site's own permissions on well-formed local requests. */
export function wordpressBrowserRequestDenied(request: SiteBrowserRequest): boolean {
  if (!request.path.startsWith('/') || request.path.startsWith('//')) return true
  const url = URL.parse(request.path, base)
  if (url === null || url.origin !== base) return true
  return isRestRequestDenied(request.method, url.pathname + url.search)
}
