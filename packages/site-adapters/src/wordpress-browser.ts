import type { SiteBrowserRequest } from '@repo/domain'

import {
  isAdminAjaxActionDenied,
  isAdminUrlDenied,
  isRestRequestDenied,
} from './wordpress-mcp-policy.ts'

const base = 'https://site.invalid'
/** `name="action"` of a multipart form, then its value up to the next boundary line. */
const multipartAction = /name="action"\r?\n(?:[^\r\n]+\r?\n)*\r?\n([^\r\n]*)/gi

/** The `action` fields a page sends to admin-ajax.php: in its query, a form or a multipart body. */
function ajaxActions(url: URL, postData: string | null): string[] {
  const actions = url.searchParams.getAll('action')
  if (postData === null) return actions
  try {
    actions.push(...new URLSearchParams(postData).getAll('action'))
  } catch {
    // Not a form: the multipart reading below decides.
  }
  for (const match of postData.matchAll(multipartAction)) actions.push(match[1] ?? '')
  return actions
}

/**
 * The agent's browser on a WordPress preview (docs/plan/53-chat-preview-release.md, Р21): the
 * admin pages and AJAX actions of `wordpressMcpPolicy`, and the REST routes it denies — a page's
 * script reaches them with its own request as well as `wp_rest` would. Anything that is not a
 * path of the site is denied.
 */
export function wordpressBrowserRequestDenied(request: SiteBrowserRequest): boolean {
  if (!request.path.startsWith('/') || request.path.startsWith('//')) return true
  let url: URL
  try {
    url = new URL(request.path, base)
  } catch {
    return true
  }
  if (url.origin !== base) return true
  if (isAdminUrlDenied(request.path)) return true
  const path = url.pathname.toLowerCase()
  if (path.endsWith('/wp-admin/admin-ajax.php')) {
    const actions = ajaxActions(url, request.postData)
    if (actions.some((action) => isAdminAjaxActionDenied(action))) return true
  }
  // `?rest_route=` wins over the path in WordPress; /index.php/wp-json/… reaches it too.
  if (url.searchParams.has('rest_route') || /^\/(?:index\.php\/)?wp-json(?:\/|$)/.test(path))
    return isRestRequestDenied(request.method, `${url.pathname}${url.search}`)
  return false
}
