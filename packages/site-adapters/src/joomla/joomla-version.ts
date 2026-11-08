import type { SiteDriftProbe, SiteRead, SiteVersionReading } from '@repo/domain'
import { parseSiteVersion } from '@repo/domain'

// Where the version of Joomla is (docs/plan/62-site-stacks.md, Т14, Т17; docs/plan/62-slices/e3.md,
// Э3.2): the manifest of the release, one form from 2.5 to 6.2, without a secret in it.
// `libraries/src/Version.php` is not a second source.

/** The manifest of the files of the release, below the root of the site. */
export const JOOMLA_MANIFEST = 'administrator/manifests/files/joomla.xml'
/** The same file below the origin: a public sign of the stack and of its branch. */
export const JOOMLA_MANIFEST_URL = `/${JOOMLA_MANIFEST}`

const NAME = /<name>\s*files_joomla\s*<\/name>/
/** One token: a value with a line break and text in it is not a version (Т14). */
const VERSION = /<version>\s*([^<\s]{1,64})\s*<\/version>/

/** The text is the manifest of the files of Joomla, whatever version it names. */
export const isJoomlaManifest = (text: string): boolean => NAME.test(text)

/** The version a text of the manifest names; null — not the manifest of Joomla, or no version. */
export function joomlaManifestVersion(text: string): string | null {
  if (!isJoomlaManifest(text)) return null
  const raw = VERSION.exec(text)?.[1]
  return raw === undefined ? null : parseSiteVersion(raw)
}

const decoder = new TextDecoder('utf-8', { fatal: false })

/**
 * One read of the manifest. An error of `read` is not caught: in the check session of the wizard a
 * failure of the connection is `transfer_failed` with a retry, not `version_unknown` (Т26).
 * Joomla never answers `other_product`: the fork UTD 3.17 is the same branch `j3` (Т27).
 */
export async function joomlaReadVersion(read: SiteRead): Promise<SiteVersionReading> {
  const bytes = await read(JOOMLA_MANIFEST)
  if (bytes === null) return { kind: 'unknown' }
  const version = joomlaManifestVersion(decoder.decode(bytes))
  return version === null ? { kind: 'unknown' } : { kind: 'read', version }
}

/** What tells that the site on the hosting moved away from `main` (Т17). */
export const joomlaDriftProbe: SiteDriftProbe = {
  versionFile: JOOMLA_MANIFEST,
  extensionRoots: ['components', 'modules', 'administrator/components', 'administrator/modules'],
}
