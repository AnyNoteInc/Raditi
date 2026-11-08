/**
 * What the check of the wizard finds in the folder of a site (docs/plan/62-site-stacks.md, §2.3, Т26,
 * Т27): the stack whose markers the root holds, the version of that stack read in the same session,
 * a hint of the layout and whether the root has an `index.php`. No stack is named here (rule 8): the
 * adapters answer, in the order of the registry. `versionFactsOf` lives here and not in `facts.ts`,
 * because it reads the types of the port (Р1).
 */
import { z } from 'zod'

import {
  otherProducts,
  type SiteAdapter,
  type SiteRead,
  type SiteVersionReading,
} from '../ports/site-adapter.ts'
import { isNestedSiteRoot } from '../site-connection/import-policy.ts'
import { parseSiteVersion, siteVersionSchema, type SiteStackFacts } from './facts.ts'
import { siteLimits, siteStacks } from './stacks.ts'
import { generationOf, type StackSupport } from './support.ts'

const siteVersionReadingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('read'), version: siteVersionSchema }),
  z.strictObject({ kind: z.literal('other_product'), product: z.enum(otherProducts) }),
  z.strictObject({ kind: z.literal('unknown') }),
])

export const siteRootInspectionSchema = z.strictObject({
  /** The stack of the markers; markers that did not pass — the stack of the hint (question В11 of Э2). */
  foundStack: z.enum(siteStacks).nullable(),
  /** Without a stack of the markers `unknown`, and nothing is read. */
  version: siteVersionReadingSchema,
  /** `rootHint`, read for the stack whose markers passed too (question В11 of Э2). */
  hint: z.enum(siteLimits).nullable(),
  /** `index.php` in the root, case aside: a site of an unknown system, not a wrong folder (Т27, В9). */
  hasIndexPhp: z.boolean(),
})
export type SiteRootInspection = z.infer<typeof siteRootInspectionSchema>

export type SiteRootInspector = Pick<
  SiteAdapter,
  'stack' | 'rootMarkers' | 'readVersion' | 'recognition'
>

const unknownVersion: SiteVersionReading = Object.freeze({ kind: 'unknown' })

/** The hint of one adapter: a value outside the closed list is no hint. */
function hintOf(adapter: SiteRootInspector, names: readonly string[]): SiteRootInspection['hint'] {
  const parsed = siteRootInspectionSchema.shape.hint.safeParse(adapter.recognition.rootHint(names))
  return parsed.success ? parsed.data : null
}

/**
 * The version of the found stack. `watched` remembers what `read` threw: such a failure is a failure
 * of the connection, so it goes on even when the adapter caught it and answered `unknown` (Т26). An
 * exception of the adapter itself, and a value outside the schema, are an unknown version.
 */
async function versionOf(adapter: SiteRootInspector, read: SiteRead): Promise<SiteVersionReading> {
  if (adapter.readVersion === null) return unknownVersion
  let failure: { error: unknown } | null = null
  const watched: SiteRead = async (path) => {
    try {
      return await read(path)
    } catch (error) {
      failure ??= { error }
      throw error
    }
  }
  let reading: unknown
  try {
    reading = await adapter.readVersion(watched)
  } catch {
    reading = unknownVersion
  }
  if (failure !== null) throw (failure as { error: unknown }).error
  const parsed = siteVersionReadingSchema.safeParse(reading)
  return parsed.success ? parsed.data : unknownVersion
}

/** The stack by its markers in the order of the registry, its version, the hint of the root. A failure of `read` goes out and never becomes a version. */
export async function inspectSiteRoot(
  adapters: readonly SiteRootInspector[],
  names: readonly string[],
  read: SiteRead,
): Promise<SiteRootInspection> {
  const hasIndexPhp = names.some((name) => name.toLowerCase() === 'index.php')
  const found = adapters.find((adapter) => isNestedSiteRoot(names, adapter.rootMarkers()))
  if (found !== undefined) {
    // The markers of MODX pass for a site with a renamed `assets` too: the found stack is asked (Э5).
    const hint = hintOf(found, names)
    const version = await versionOf(found, read)
    return { foundStack: found.stack, version, hint, hasIndexPhp }
  }
  // No markers: the first hint names its stack, which the tab «Без доступа» puts in (question В11).
  for (const adapter of adapters) {
    const hint = hintOf(adapter, names)
    if (hint !== null)
      return { foundStack: adapter.stack, version: unknownVersion, hint, hasIndexPhp }
  }
  return { foundStack: null, version: unknownVersion, hint: null, hasIndexPhp }
}

/** What a reading of the version means for the record of the site. */
export function versionFactsOf(
  support: StackSupport,
  reading: SiteVersionReading,
): Pick<SiteStackFacts, 'cmsVersion' | 'generation' | 'limit'> {
  if (reading.kind === 'other_product')
    return { cmsVersion: null, generation: null, limit: 'other_product' }
  const version = reading.kind === 'read' ? parseSiteVersion(reading.version) : null
  if (version === null) return { cmsVersion: null, generation: null, limit: null }
  return {
    cmsVersion: version,
    generation: generationOf(support, version)?.id ?? null,
    limit: null,
  }
}
