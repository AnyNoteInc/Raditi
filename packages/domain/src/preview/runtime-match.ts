import { z } from 'zod'

import type { SiteRuntime } from '../ports/published-content.ts'

// How the runtime of a preview stands to the site's (docs/plan/53-chat-preview-release.md, Р2,
// Р18): the host of previews runs the closest version of the site's language runtime it has an
// image of (`PREVIEW_WEB_IMAGES`), with the extensions of that image. What differs is told in
// «Проверки»: a check of the preview may pass where the site would fail, and the reverse.

const runtimeVersion = z.string().regex(/^\d{1,2}\.\d{1,2}$/)
const extensionName = z.string().regex(/^[a-z0-9][a-z0-9_ .+-]{0,62}$/)

/** The most missing extensions a match names. */
export const PREVIEW_RUNTIME_MISSING_MAX = 32

/**
 * Extensions that only watch or speed up a server, never change what a page does: not told as
 * missing.
 */
const unobservable = new Set(['zend opcache', 'xdebug', 'newrelic', 'blackfire', 'tideways'])

export const previewRuntimeMatchSchema = z.strictObject({
  /** The version the site's server runs. */
  production: runtimeVersion,
  /** The version the preview runs; null — the preview could not tell. */
  preview: runtimeVersion.nullable(),
  /** Extensions the site's server has loaded and the preview has not. */
  missing: z.array(extensionName).max(PREVIEW_RUNTIME_MISSING_MAX),
})
export type PreviewRuntimeMatch = z.infer<typeof previewRuntimeMatchSchema>

/** The match of the two runtimes; null — the site's own could not be read. */
export function previewRuntimeMatch(
  production: SiteRuntime | null,
  preview: SiteRuntime | null,
): PreviewRuntimeMatch | null {
  if (!production) return null
  const has = new Set(preview?.extensions ?? [])
  return {
    production: production.runtimeVersion,
    preview: preview?.runtimeVersion ?? null,
    missing: preview
      ? production.extensions
          .filter((name) => !has.has(name) && !unobservable.has(name))
          .slice(0, PREVIEW_RUNTIME_MISSING_MAX)
      : [],
  }
}

/** Whether the preview may behave unlike the site: another version, or missing extensions. */
export const previewRuntimeDiffers = (match: PreviewRuntimeMatch | null): boolean =>
  match !== null &&
  ((match.preview !== null && match.preview !== match.production) || match.missing.length > 0)
