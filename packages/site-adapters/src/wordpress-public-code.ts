// The published originals of the files of a WordPress site (owner's decision of 26.10.2026): the
// plugins and themes of WordPress.org and the core are public, and their release files are kept
// in the repositories of WordPress.org by version. A file the secret scan of the import flagged —
// a form template with an `api_key` field, a Google Maps key a plugin ships — is public code when
// it is byte for byte the published release, and the import takes it. Only names and versions of
// plugins, themes and the core leave the platform: the request of an update check of a site.

const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,39}$/
/** The files of the core outside wp-admin/ and wp-includes/. */
const CORE_ROOT = /^(?:index\.php|wp-[a-z-]+\.php|xmlrpc\.php|license\.txt|readme\.html)$/

const decoder = new TextDecoder('utf-8', { fatal: false })

/** `Version: 3.4.1` of the header comment of a plugin's main file or a theme's style.css. */
function headerVersion(text: string): string | null {
  const head = text.slice(0, 8192)
  const match = /^[ \t/*#@]*Version:[ \t]*([^\r\n]+)/im.exec(head)
  const version = match?.[1]?.trim() ?? null
  return version !== null && VERSION.test(version) ? version : null
}

/** `$wp_version = '6.9';` of wp-includes/version.php. */
function coreVersion(text: string): string | null {
  const match = /^\$wp_version\s*=\s*'([^']+)'\s*;/m.exec(text)
  const version = match?.[1] ?? null
  return version !== null && VERSION.test(version) ? version : null
}

const encodePath = (segments: readonly string[]) => segments.map(encodeURIComponent).join('/')

type Read = (path: string) => Promise<Uint8Array | null>

/**
 * The URL of the published original of each path that is a file of a plugin of WordPress.org
 * (`plugins.svn.wordpress.org/<slug>/tags/<version>/…`), of a theme
 * (`themes.svn.wordpress.org/<slug>/<version>/…`) or of the core
 * (`core.svn.wordpress.org/tags/<version>/…`), by the version the site's own files name. A
 * plugin's version is the header of `<slug>/<slug>.php`. Other paths get no answer.
 */
export async function wordpressPublicOriginals(
  paths: readonly string[],
  read: Read,
): Promise<ReadonlyMap<string, string>> {
  const versions = new Map<string, Promise<string | null>>()
  const versionOf = (key: string, file: string, parse: (text: string) => string | null) => {
    let found = versions.get(key)
    if (!found) {
      found = read(file).then((bytes) => (bytes === null ? null : parse(decoder.decode(bytes))))
      versions.set(key, found)
    }
    return found
  }
  const answers = new Map<string, string>()
  for (const path of paths) {
    const segments = path.split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) continue
    const [top, kind, slug, ...rest] = segments
    if (top === 'wp-content' && (kind === 'plugins' || kind === 'themes')) {
      if (slug === undefined || !SLUG.test(slug) || rest.length === 0) continue
      const version =
        kind === 'plugins'
          ? await versionOf(`plugin:${slug}`, `wp-content/plugins/${slug}/${slug}.php`, headerVersion)
          : await versionOf(`theme:${slug}`, `wp-content/themes/${slug}/style.css`, headerVersion)
      if (version === null) continue
      answers.set(
        path,
        kind === 'plugins'
          ? `https://plugins.svn.wordpress.org/${slug}/tags/${encodeURIComponent(version)}/${encodePath(rest)}`
          : `https://themes.svn.wordpress.org/${slug}/${encodeURIComponent(version)}/${encodePath(rest)}`,
      )
      continue
    }
    const core =
      ((top === 'wp-admin' || top === 'wp-includes') && segments.length > 1) ||
      (segments.length === 1 && CORE_ROOT.test(path))
    if (!core) continue
    const version = await versionOf('core', 'wp-includes/version.php', coreVersion)
    if (version === null) continue
    answers.set(path, `https://core.svn.wordpress.org/tags/${encodeURIComponent(version)}/${encodePath(segments)}`)
  }
  return answers
}
