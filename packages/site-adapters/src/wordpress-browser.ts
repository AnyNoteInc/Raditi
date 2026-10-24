import type { SiteBrowserRequest } from '@repo/domain'

import {
  isAdminAjaxActionDenied,
  isAdminUrlDenied,
  isRestRequestDenied,
} from './wordpress-mcp-policy.ts'
import { WORDPRESS_MEDIA_DIR } from './wordpress-working-set.ts'

const base = 'https://site.invalid'

/**
 * The media library in the preview is the site's, imported whole (plan 39): a plugin may have put
 * a visitor's file there, or in a folder the import rules do not name (spec §11, §20 «Медиа в
 * репозитории и песочница хода»). Until the owner decides, the agent's browser opens there only
 * what a page draws with — images, styles, scripts, fonts, sound and video, whose text it cannot
 * read — and anything in the agent's own folder; a document, a text, an archive or a listing of a
 * folder is denied, and so is the list of the library through REST.
 */
const uploadsDir = ['wp-content', 'uploads']
const mediaDir = WORDPRESS_MEDIA_DIR.split('/').filter(Boolean)
const pageAsset =
  /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|css|js|mjs|eot|otf|ttf|woff2?|m4a|mp3|mp4|oga|ogg|ogv|wav|webm)$/

const startsWith = (segments: readonly string[], prefix: readonly string[]) =>
  prefix.every((part, index) => segments[index] === part)

/** The decoded, lower-case segments of a path; null for one that cannot be read plainly. */
export function segmentsOf(path: string): string[] | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const segments = decoded
    .toLowerCase()
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  return segments.includes('..') ? null : segments
}

/** A path of the media library (segments from `wp-content`) the agent's browser may not open. */
export function isUploadDenied(segments: readonly string[]): boolean {
  if (!startsWith(segments, uploadsDir)) return false
  if (startsWith(segments, mediaDir) && segments.length > mediaDir.length) return false
  return !pageAsset.test(segments.at(-1) ?? '')
}

/** A REST route of the media library, by path or `rest_route`: its list names every file. */
function isMediaRoute(route: string): boolean {
  const segments = segmentsOf(route)
  if (segments === null) return true
  if (segments[0] === 'index.php') segments.shift()
  if (segments[0] === 'wp-json') segments.shift()
  return startsWith(segments, ['wp', 'v2', 'media'])
}

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
 * script reaches them with its own request as well as `wp_rest` would —; in the media library,
 * whatever a page does not draw with, and its REST list (above). Anything that is not a path of
 * the site is denied.
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
  const segments = segmentsOf(url.pathname)
  if (segments === null || isUploadDenied(segments)) return true
  const path = url.pathname.toLowerCase()
  // By segments, not the end of the path: `admin-ajax.php/x` runs admin-ajax.php (PATH_INFO).
  const adminIndex = segments.indexOf('wp-admin')
  if (adminIndex !== -1 && segments[adminIndex + 1] === 'admin-ajax.php') {
    const actions = ajaxActions(url, request.postData)
    if (actions.some((action) => isAdminAjaxActionDenied(action))) return true
  }
  // `?rest_route=` wins over the path in WordPress; /index.php/wp-json/… reaches it too.
  if (url.searchParams.has('rest_route') || /^\/(?:index\.php\/)?wp-json(?:\/|$)/.test(path)) {
    if ([url.pathname, ...url.searchParams.getAll('rest_route')].some(isMediaRoute)) return true
    return isRestRequestDenied(request.method, `${url.pathname}${url.search}`)
  }
  return false
}
