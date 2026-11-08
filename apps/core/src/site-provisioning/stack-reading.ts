import {
  siteStackFactsPatchSchema,
  versionFactsOf,
  type SiteAdapter,
  type SiteRead,
  type SiteStackFactsPatch,
  type SiteTree,
} from '@repo/domain'

/**
 * What one look at the files of a site root says for its record (docs/plan/62-site-stacks.md, Т13,
 * Т14, Т16): the part of `sites.stack_facts` to write, and whether the copy can be built at all.
 * Shared by the import and a fresh copy; no stack is named here (rule 8).
 */
export interface StackReading {
  patch: SiteStackFactsPatch
  /** The layout was refused: its `limit` is already in `patch`. */
  refused: boolean
  /** The layout was read and its values passed the schema of the record. */
  layoutRead: boolean
}

/**
 * Reads the version and then the layout of the site, strictly one after the other: the session
 * may be one. A reading that says nothing (`unknown`, a version that fails its schema) writes no
 * key, so a hiccup of the hosting never wipes what the record has. A refused layout gives its
 * `limit`, which wins over the `other_product` of the version. `limit` goes back to null only when
 * the version was read and the layout was read too, or the stack has none: otherwise a broken
 * read would erase a reason written earlier.
 */
type StackReader = Pick<SiteAdapter, 'support' | 'readVersion' | 'readLayout'>

/**
 * The version part of a reading: no key when it says nothing (`unknown`, a version that fails its
 * schema), the three keys of `versionFactsOf` for another product, the version and its generation
 * otherwise. `read` — the version itself was read.
 */
async function versionPart(
  adapter: StackReader,
  read: SiteRead,
): Promise<{ part: SiteStackFactsPatch; read: boolean }> {
  if (!adapter.readVersion) return { part: {}, read: false }
  const reading = await adapter.readVersion(read)
  if (reading.kind === 'unknown') return { part: {}, read: false }
  const facts = versionFactsOf(adapter.support, reading)
  if (facts.limit !== null) return { part: facts, read: false }
  if (facts.cmsVersion === null) return { part: {}, read: false }
  return { part: { cmsVersion: facts.cmsVersion, generation: facts.generation }, read: true }
}

/** `limit` goes back to null only with the version read and the layout read, or none to read. */
const clearsLimit = (adapter: StackReader, versionRead: boolean, layoutRead: boolean) =>
  versionRead && (layoutRead || adapter.readLayout === null)

/**
 * Reads the version and then the layout of the site, strictly one after the other: the session
 * may be one. A reading that says nothing (`unknown`, a version that fails its schema) writes no
 * key, so a hiccup of the hosting never wipes what the record has. A refused layout gives its
 * `limit`, which wins over the `other_product` of the version. `limit` goes back to null only when
 * the version was read and the layout was read too, or the stack has none: otherwise a broken
 * read would erase a reason written earlier.
 */
export async function readStack(adapter: StackReader, tree: SiteTree): Promise<StackReading> {
  const version = await versionPart(adapter, tree.read)
  const patch: SiteStackFactsPatch = { ...version.part }

  let refused = false
  let layoutRead = false
  if (adapter.readLayout) {
    const layout = await adapter.readLayout(tree)
    if (layout.kind === 'refused') {
      patch.limit = layout.limit
      refused = true
    } else {
      const part = siteStackFactsPatchSchema.safeParse({
        extras: layout.extras,
        adminPath: layout.adminPath,
      })
      if (part.success) {
        patch.extras = part.data.extras
        patch.adminPath = part.data.adminPath
        layoutRead = true
      }
    }
  }

  if (!refused && clearsLimit(adapter, version.read, layoutRead)) patch.limit = null
  return { patch, refused, layoutRead }
}

/**
 * The version of the copy that was taken (Т14): `read` gives the downloaded files, so the record
 * names the version `main` holds even when the hosting changed it during the walk. Only the
 * version keys, by the rules of `readStack`, against the layout it read; nothing when the copy
 * says nothing or says what `first` already wrote.
 */
export async function recheckVersion(
  adapter: StackReader,
  read: SiteRead,
  first: StackReading,
): Promise<SiteStackFactsPatch> {
  if (first.refused) return {}
  const version = await versionPart(adapter, read)
  if (Object.keys(version.part).length === 0) return {}
  const patch: SiteStackFactsPatch = { ...version.part }
  if (clearsLimit(adapter, version.read, first.layoutRead)) patch.limit = null
  const keys = Object.keys(patch) as (keyof SiteStackFactsPatch)[]
  return keys.every((key) => first.patch[key] === patch[key]) ? {} : patch
}
