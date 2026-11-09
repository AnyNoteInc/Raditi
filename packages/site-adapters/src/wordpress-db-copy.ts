import type {
  DatabaseCopyPolicy,
  PreviewCopyTarget,
  SiteDatabaseSettings,
  SiteFacts,
} from '@repo/domain'
import {
  badRequest,
  databaseCopyPolicySchema,
  siteDatabaseSettingsSchema,
  siteImportLimits,
} from '@repo/domain'

import { phpStringsAfter, type ConfigFileReader } from './php-config.ts'

const ws = '[ \\t\\r\\n]*'
const defineOf = (name: string) =>
  new RegExp(`\\bdefine${ws}\\(${ws}(['"])${name}\\1${ws},${ws}`, 'i')
const defineEnd = new RegExp(`${ws}\\)`)
const tablePrefixAssignment = new RegExp(`\\$table_prefix${ws}=${ws}`)
const statementEnd = new RegExp(`${ws};`)
/** A multisite network keeps a set of tables per site: its copy is not supported. */
const multisite = new RegExp(`\\bdefine${ws}\\(${ws}(['"])MULTISITE\\1${ws},${ws}true\\b`, 'i')

/** The one value a configuration states, or null when it states none or several. */
function single(values: readonly string[]): string | null {
  const distinct = [...new Set(values)]
  return distinct.length === 1 ? (distinct[0] ?? null) : null
}

/**
 * The encoding of the production connection, as `wpdb::determine_charset` makes it of
 * DB_CHARSET and DB_COLLATE: `utf8` becomes `utf8mb4` (every server WordPress supports has it),
 * and with it a `utf8_` collation its `utf8mb4_` twin, `utf8_general_ci` or none
 * `utf8mb4_unicode_ci`.
 */
function connectionEncoding(
  charset: string,
  collate: string,
): Pick<SiteDatabaseSettings, 'charset' | 'collation'> {
  if (charset !== 'utf8' && charset !== 'utf8mb4') return { charset, collation: collate || null }
  if (collate === '' || collate === 'utf8_general_ci')
    return { charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' }
  return { charset: 'utf8mb4', collation: collate.replace(/^utf8_/, 'utf8mb4_') }
}

/**
 * `SiteAdapter.databaseSettings`: `$table_prefix`, DB_CHARSET and DB_COLLATE of wp-config.php
 * in the site root, each a constant literal stated once. null for a multisite network, a
 * configuration that computes them, and an empty DB_CHARSET (the server's default then decides,
 * which the platform cannot know).
 */
export async function wordpressDatabaseSettings(
  read: ConfigFileReader,
): Promise<SiteDatabaseSettings | null> {
  const file = await read('wp-config.php')
  if (!file || file.byteLength > siteImportLimits.configFileBytes) return null
  if (multisite.test(new TextDecoder('latin1').decode(file))) return null
  const tablePrefix = single(phpStringsAfter(file, tablePrefixAssignment, statementEnd))
  const charset = single(phpStringsAfter(file, defineOf('DB_CHARSET'), defineEnd))
  const collations = phpStringsAfter(file, defineOf('DB_COLLATE'), defineEnd)
  const collate = collations.length === 0 ? '' : single(collations)
  if (tablePrefix === null || !charset || collate === null) return null
  const parsed = siteDatabaseSettingsSchema.safeParse({
    tablePrefix,
    ...connectionEncoding(charset.toLowerCase(), collate.toLowerCase()),
  })
  return parsed.success ? parsed.data : null
}

/**
 * The database settings of production (`SiteAdapter.databaseSettings`), which the recipe, the
 * policy and the copier take from the same `SiteFacts.database`: without them the prefix of the
 * copied tables and the one the preview reads could differ, and WordPress would offer to install
 * itself to anyone with a preview session.
 */
export function wordpressDatabaseOf(site: SiteFacts): SiteDatabaseSettings {
  if (!site.database)
    throw badRequest('A WordPress preview needs the database settings of production')
  return site.database
}

const catalogTables = [
  'posts',
  'postmeta',
  'users',
  'terms',
  'term_taxonomy',
  'term_relationships',
  'termmeta',
  'options',
]

/** With no prefix, the catalog cannot distinguish plugin tables from other applications. */
const unprefixedCoreTables = [...catalogTables, 'usermeta', 'comments', 'commentmeta', 'links']

/** Copy the site's rows, keeping the preview's own platform binding and receipts. */
export function wordpressDatabaseCopyPolicy(
  site: SiteFacts,
  preview: PreviewCopyTarget,
): DatabaseCopyPolicy {
  const { tablePrefix } = wordpressDatabaseOf(site)
  return databaseCopyPolicySchema.parse({
    engine: 'mysql',
    catalogTables,
    ...(tablePrefix !== '' ? { copyUnlistedRows: true } : {}),
    tables: [
      ...(tablePrefix === ''
        ? unprefixedCoreTables
            .filter((table) => table !== 'options')
            .map((table) => ({ table, where: [] }))
        : []),
      {
        table: 'options',
        where: [
          {
            op: 'notLike',
            column: 'option_name',
            patterns: ['raditi\\_content\\_call\\_%'],
          },
        ],
      },
    ],
    overrides: [
      // The plugin «Радити» of the copy answers to this preview, from epoch 0, with no receipt.
      option('raditi_content_site_id', preview.previewId),
      option('raditi_content_epoch', '0'),
      // Search engines are told to stay away; the address of the site's admin is not a person's.
      option('blog_public', '0'),
      option('admin_email', 'admin@preview.invalid'),
    ],
  })
}

function option(name: string, value: string) {
  return {
    table: 'options',
    match: { column: 'option_name', value: name },
    set: { option_value: value },
  }
}
