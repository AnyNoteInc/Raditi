import type { SiteDatabaseSettings, SiteLayoutReading, SiteTree } from '@repo/domain'
import { siteDatabaseSettingsSchema, siteImportLimits } from '@repo/domain'
import { z } from 'zod'
import {
  type ConfigFileReader,
  phpBareAfter,
  phpConfigStrings,
  phpStringsAfter,
  secretValues,
} from '../php-config.ts'

// What `configuration.php` of Joomla tells the platform (docs/plan/62-site-stacks.md, Т13, Т16;
// docs/plan/62-slices/e3.md, Э3.3; docs/research/2026-11-site-stacks/joomla.md, §4). The file is a
// class `JConfig` with public properties, one `public $name = value;` each: strings in 3.x
// (`public $sef = '1';`), typed values since Registry 2.0 (`public $sef = true;`). It is read
// without running it; a value that is not one constant literal is no value.

/** The configuration of the site, in its root (`JPATH_CONFIGURATION`). */
export const JOOMLA_CONFIG = 'configuration.php'
/** A root with this file sets its own `JPATH_*`: the public folder of 5.x, or paths elsewhere. */
const DEFINES = 'defines.php'
/** The panel of Joomla: its name is set in `includes/defines.php`, no setting moves it. */
const ADMIN_PATH = '/administrator/'

const propertyOf = (names: string) =>
  new RegExp(`\\bpublic[ \\t\\r\\n]+\\$(?:${names})[ \\t\\r\\n]*=[ \\t\\r\\n]*`)
const statementEnd = /[ \t\r\n]*;/
/** The sample of configuration.php-dist 3.x: no secret, present in every copy of it. */
const sampleSecret = 'FBVtggIk5lAzEU9H'
const secretProperties =
  'password|secret|smtppass|proxy_pass|ftp_pass|redis_server_auth|session_redis_server_auth|smtp_oauth2_client_secret|smtp_oauth2_refresh_token'

/** The drivers of MySQL; `pgsql`, `postgresql`, `sqlsrv` and `sqlazure` are other engines. */
const mysqlDrivers = ['mysqli', 'mysql', 'pdomysql'] as const

/** The settings of the site that a copy has to show as production does (joomla.md, §4.4). */
export const joomlaFactsSchema = z
  .strictObject({
    // Т13: a recorded layout is never empty.
    dbtype: z.enum(mysqlDrivers),
    sitename: z
      .string()
      .max(128)
      .regex(/^[^\p{Cc}]*$/u),
    sitenamePagetitles: z.enum(['0', '1', '2']),
    metaDesc: z
      .string()
      .max(256)
      .regex(/^[^\p{Cc}]*$/u),
    offset: z
      .string()
      .max(64)
      .regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/),
    sef: z.enum(['0', '1']),
    sefRewrite: z.enum(['0', '1']),
    sefSuffix: z.enum(['0', '1']),
    unicodeslugs: z.enum(['0', '1']),
    listLimit: z.string().regex(/^\d{1,4}$/),
    feedLimit: z.string().regex(/^\d{1,4}$/),
  })
  .partial()
export type JoomlaFacts = z.infer<typeof joomlaFactsSchema>

/**
 * The property of `JConfig` behind each key of the facts but `dbtype`, and whether it may be a bare
 * literal: a switch or a number is `true` or `20` since Registry 2.0, a text is always a string.
 */
const factProperties: Record<Exclude<keyof JoomlaFacts, 'dbtype'>, [string, boolean]> = {
  sitename: ['sitename', false],
  sitenamePagetitles: ['sitename_pagetitles', true],
  metaDesc: ['MetaDesc', false],
  offset: ['offset', false],
  sef: ['sef', true],
  sefRewrite: ['sef_rewrite', true],
  sefSuffix: ['sef_suffix', true],
  unicodeslugs: ['unicodeslugs', true],
  listLimit: ['list_limit', true],
  feedLimit: ['feed_limit', true],
}

/** `true` is `'1'`, `false` is `'0'`; `null` is no value. */
const bareValue = (literal: string): string | null =>
  literal === 'true' ? '1' : literal === 'false' ? '0' : literal === 'null' ? null : literal

/** The value of a property set exactly once in the file, or null. */
function onlyValue(file: Uint8Array, property: string, bare: boolean): string | null {
  const before = propertyOf(property)
  const values = [
    ...phpStringsAfter(file, before, statementEnd),
    ...(bare ? phpBareAfter(file, before, statementEnd).map(bareValue) : []),
  ]
  return values.length === 1 ? values[0]! : null
}

/** The driver of the database, when the file names one driver of MySQL; null otherwise. */
function mysqlDriverOf(file: Uint8Array): (typeof mysqlDrivers)[number] | null {
  const parsed = z.enum(mysqlDrivers).safeParse(onlyValue(file, 'dbtype', false))
  return parsed.success ? parsed.data : null
}

/** Each fact on its own: a value that fails its field drops out, the others live (Т13). */
function factsOf(file: Uint8Array): Omit<JoomlaFacts, 'dbtype'> {
  const facts: Record<string, string> = {}
  for (const [key, [property, bare]] of Object.entries(factProperties)) {
    const value = onlyValue(file, property, bare)
    if (value === null) continue
    const field = joomlaFactsSchema.shape[key as keyof typeof factProperties]
    if (field.safeParse(value).success) facts[key] = value
  }
  return facts
}

async function readConfiguration(read: ConfigFileReader): Promise<Uint8Array | null> {
  const file = await read(JOOMLA_CONFIG)
  return file && file.byteLength <= siteImportLimits.configFileBytes ? file : null
}

/** The passwords and keys of `configuration.php`; the sample secret of 3.x is none. */
export async function joomlaConfigSecrets(read: ConfigFileReader): Promise<string[]> {
  const values = await phpConfigStrings(
    read,
    JOOMLA_CONFIG,
    propertyOf(secretProperties),
    statementEnd,
  )
  return secretValues(values.filter((value) => value !== sampleSecret))
}

/**
 * The prefix of the tables, from `$dbprefix`. The file names no encoding: the driver sets
 * `utf8mb4` itself, and the installer makes the tables `utf8mb4_unicode_ci` (joomla.md, §4.4).
 * null — not one driver of MySQL, not one prefix, or a prefix the schema refuses.
 */
export async function joomlaDatabaseSettings(
  read: ConfigFileReader,
): Promise<SiteDatabaseSettings | null> {
  const file = await readConfiguration(read)
  if (file === null || mysqlDriverOf(file) === null) return null
  const parsed = siteDatabaseSettingsSchema.safeParse({
    tablePrefix: onlyValue(file, 'dbprefix', false),
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
  })
  return parsed.success ? parsed.data : null
}

/**
 * A root the hosting did not show, or a configuration it listed and did not give: the layout is
 * unknown, not refused (Т13; Р9 of Э2). The reader of the stack lets it through: a fresh copy goes
 * on with the recorded layout, an import ends without writing a limit.
 */
const unreadRoot = () => new Error('The root of the site could not be read')

/**
 * The layout of the site, step by step: a root with `defines.php` or without `configuration.php`
 * is `outside_root`, a driver that is not one of MySQL is `other_engine`, and otherwise the panel
 * and the settings of the closed list, `dbtype` always among them. No secret leaves it. Both
 * refusals of the root stand on a listing that was read: a file that cannot be read is not a file
 * that is absent, so a hiccup of the hosting throws instead.
 */
export async function joomlaReadLayout(tree: SiteTree): Promise<SiteLayoutReading> {
  const root = await tree.list('')
  if (root === null) throw unreadRoot()
  const inRoot = (name: string) => root.some((entry) => entry.name === name)
  if (inRoot(DEFINES) || !inRoot(JOOMLA_CONFIG)) return { kind: 'refused', limit: 'outside_root' }
  const file = await tree.read(JOOMLA_CONFIG)
  if (file === null) throw unreadRoot()
  const dbtype = mysqlDriverOf(file)
  if (dbtype === null) return { kind: 'refused', limit: 'other_engine' }
  return { kind: 'read', extras: { ...factsOf(file), dbtype }, adminPath: ADMIN_PATH }
}

/** `extras` of the record of the site; a record of another shape reads as empty, `{ probe }` too. */
export function joomlaFactsOf(extras: Readonly<Record<string, string>>): JoomlaFacts {
  const parsed = joomlaFactsSchema.safeParse(extras)
  return parsed.success ? parsed.data : {}
}
