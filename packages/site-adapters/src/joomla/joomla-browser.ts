import type { SiteBrowserRequest } from '@repo/domain'

import { mediaRequestDenied, segmentsOf } from '../php/media.ts'
import { JOOMLA_MEDIA_DIR } from './joomla-working-set.ts'

// The agent's browser on a preview of Joomla (docs/plan/62-site-stacks.md, Т42; docs/plan/53, Р21;
// docs/plan/62-slices/e3.md, Э3.4). The front of the copy has no people and no sign-in: the
// administrator, the web services and the folders of the core are closed by path, and the query
// (`option` and the rest) is not read.

const base = 'https://site.invalid'

/** The first segments of the paths the browser never opens: the administrator, the API, the core. */
const closedFolders = new Set([
  'administrator',
  'api',
  'installation',
  'cli',
  'includes',
  'libraries',
  'cache',
  'tmp',
])

/** The files of the configuration, at any depth. */
const closedFiles = new Set(['configuration.php', 'defines.php'])

/** The media library of Joomla: the images and the documents of the owner. */
const mediaRoots = [['images'], ['files']]
const mediaDir = JOOMLA_MEDIA_DIR.split('/').filter(Boolean)

/** True for anything that is not a plain path of the site, and for what the rules above close. */
export function joomlaBrowserRequestDenied(request: SiteBrowserRequest): boolean {
  if (!request.path.startsWith('/') || request.path.startsWith('//')) return true
  let url: URL
  try {
    url = new URL(request.path, base)
  } catch {
    return true
  }
  if (url.origin !== base) return true
  const segments = segmentsOf(url.pathname)
  if (segments === null) return true
  if (closedFolders.has(segments[0] ?? '')) return true
  if (segments.some((segment) => closedFiles.has(segment))) return true
  return mediaRequestDenied(segments, mediaRoots, mediaDir)
}
