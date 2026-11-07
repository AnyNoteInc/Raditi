import { mediaLimits, type MediaRules } from '@repo/domain'

// Media of a PHP site, shared by its stacks (docs/plan/62-site-stacks.md, Т11; docs/plan/53, Р12,
// Р21): what the agent may add to a folder of its own, and what of the media library the agent's
// browser on a preview may open.

/** Leading bytes, all of which a file of the extension carries (lower-case hex). */
const jpeg = [{ offset: 0, hex: 'ffd8ff' }]
const extensions: MediaRules['extensions'] = {
  jpg: jpeg,
  jpeg,
  png: [{ offset: 0, hex: '89504e470d0a1a0a' }],
  // GIF87a and GIF89a.
  gif: [
    { offset: 0, hex: '47494638' },
    { offset: 5, hex: '61' },
  ],
  webp: [
    { offset: 0, hex: '52494646' },
    { offset: 8, hex: '57454250' },
  ],
  // ISO media with an `avif` or `avis` brand.
  avif: [{ offset: 4, hex: '66747970617669' }],
  mp4: [{ offset: 4, hex: '66747970' }],
  webm: [{ offset: 0, hex: '1a45dfa3' }],
  pdf: [{ offset: 0, hex: '255044462d' }],
  woff2: [{ offset: 0, hex: '774f4632' }],
}

/**
 * The media the agent adds to `addOnlyPath`, a folder of its own it never edits: the leading bytes
 * of each extension, the names Apache and PHP run or read as configuration — and SVG, which a
 * browser runs —, the limit of a file. The same on every PHP stack; only the folder differs.
 */
export function phpMediaRules(addOnlyPath: string): MediaRules {
  return {
    addOnlyPaths: [addOnlyPath],
    extensions: structuredClone(extensions),
    refusedNameParts: ['.php', '.pht', '.phar', '.htaccess', '.user.ini', '.svg'],
    maxFileBytes: mediaLimits.fileBytes,
  }
}

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

/** A file a page draws with — images, styles, scripts, fonts, sound and video — by its last segment. */
export const pageAsset =
  /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|css|js|mjs|eot|otf|ttf|woff2?|m4a|mp3|mp4|oga|ogg|ogv|wav|webm)$/

const startsWith = (segments: readonly string[], prefix: readonly string[]) =>
  prefix.every((part, index) => segments[index] === part)

/**
 * A path in the media library the agent's browser on a preview does not open (spec §11, §20
 * «Медиа в репозитории и песочница хода»). The library is the site's, imported whole: a plugin may
 * have put a visitor's file there. Below one of `roots` the browser opens only what a page draws
 * with (`pageAsset`), whose text it cannot read, and anything below `own`, the agent's folder; a
 * document, a text, an archive or the listing of a folder is denied. `segments` — of `segmentsOf`,
 * from the root of the site; the parts of `roots` and `own` are lower-case.
 */
export function mediaRequestDenied(
  segments: readonly string[],
  roots: readonly (readonly string[])[],
  own: readonly string[],
): boolean {
  if (!roots.some((root) => startsWith(segments, root))) return false
  if (startsWith(segments, own) && segments.length > own.length) return false
  return !pageAsset.test(segments.at(-1) ?? '')
}
