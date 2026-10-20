import {
  siteDatabaseSettingsSchema,
  type DatabaseCopyPolicy,
  type SiteDatabaseSettings,
} from '@repo/domain'

// What the database of a site is, for its copy (docs/plan/53-chat-preview-release.md, Р15, R5c),
// when the configuration on the hosting does not tell it. `SiteAdapter.databaseSettings(read)`
// takes the table prefix and the encoding from that configuration, through the file source the
// connection wizard recorded (plan 39, site-sources.ts); a site without one, a hosting that cannot
// be read now, or a configuration that computes them leaves core the catalog of the database
// itself: the prefix is the one under which every table the adapter's copy policy names exists —
// one prefix, or none is guessed — and the encoding is the character set those tables share, with
// their collation when they share one too — else the server's default of that set: a condition of
// the copy compares by the collation of its column, which outranks the connection's. Tables in
// different character sets — a text read through the wrong one is changed — are not copied.

export interface CatalogTable {
  name: string
  collation: string | null
  charset: string | null
}

const PREFIX = /^[A-Za-z0-9_]{0,32}$/

/** null — no single prefix holds the policy's tables, or they share no character set. */
export function databaseSettingsFromCatalog(
  policy: Pick<DatabaseCopyPolicy, 'tables'>,
  catalog: readonly CatalogTable[],
): SiteDatabaseSettings | null {
  const wanted = [...new Set(policy.tables.map((rule) => rule.table))]
  if (!wanted.length) return null
  const byName = new Map(catalog.map((table) => [table.name, table]))
  const prefixes = new Set<string>()
  for (const table of catalog)
    for (const name of wanted)
      if (table.name.endsWith(name)) prefixes.add(table.name.slice(0, -name.length))
  const fitting = [...prefixes].filter(
    (prefix) => PREFIX.test(prefix) && wanted.every((name) => byName.has(`${prefix}${name}`)),
  )
  if (fitting.length !== 1) return null
  const prefix = fitting[0]!
  const encodings = wanted.map((name) => byName.get(`${prefix}${name}`)!)
  const charsets = new Set(encodings.map((table) => table.charset))
  const collations = new Set(encodings.map((table) => table.collation))
  const charset = encodings[0]!.charset
  if (charsets.size !== 1 || !charset) return null
  const collation = collations.size === 1 ? encodings[0]!.collation : null
  const parsed = siteDatabaseSettingsSchema.safeParse({ tablePrefix: prefix, charset, collation })
  return parsed.success ? parsed.data : null
}
