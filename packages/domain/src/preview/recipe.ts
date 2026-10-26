import { z } from 'zod'

import { isPublicationPath } from '../git/publication.ts'
import { databaseEngines } from '../site-connection/kinds.ts'
import { isPreviewPath } from './hostname.ts'

/**
 * What a stack adapter says about previews (docs/plan/53-chat-preview-release.md, Р15, Р16):
 * how to run the full tree of a site (`SiteAdapter.previewRecipe`) and which rows its database
 * copy may hold (`SiteAdapter.databaseCopyPolicy`). Apart from the ports so that the port of the
 * site adapter can name them.
 */

const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(isPublicationPath, 'expected a relative path of the site tree')
const identifier = z.string().regex(/^[A-Za-z0-9_]{1,64}$/, 'expected an SQL identifier')
const runtimeVersion = z.string().regex(/^\d{1,2}\.\d{1,2}$/)
/** A path inside a container: absolute, plain segments, no `.` or `..`. */
const containerPath = z
  .string()
  .max(256)
  .regex(/^(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,63})+$/, 'expected an absolute path of a container')
  .refine((path) => !path.split('/').includes('..'), 'expected an absolute path of a container')

/**
 * What the production configuration of a site says about its database (Р15): the prefix of the
 * stack's tables and the character set and collation of its connection. Read by
 * `SiteAdapter.databaseSettings` from the configuration on the hosting; the seed is written in
 * that connection's encoding and the preview connects the same way.
 */
export const siteDatabaseSettingsSchema = z.strictObject({
  tablePrefix: z.string().regex(/^[A-Za-z0-9_]{0,32}$/),
  charset: identifier,
  /** null — the default collation of the character set. */
  collation: identifier.nullable(),
})
export type SiteDatabaseSettings = z.infer<typeof siteDatabaseSettingsSchema>

/**
 * How the web container serves the tree (Р18): unprivileged, on a port above 1023, read-only
 * root file system. The runtime starts `command` instead of the image's entrypoint.
 */
export const previewWebServerSchema = z.strictObject({
  /** argv of the server in the foreground; no shell. */
  command: z.array(z.string().min(1).max(1024)).min(1).max(16),
  /** Environment of the server process: never a secret (those are in the settings file). */
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(1024)),
  /** The port it listens on in the preview's network; the entry forwarder connects to it. */
  port: z.number().int().min(1024).max(65_535),
  /** `uid:gid` of the web and the CLI processes; the docroot volume belongs to it. */
  user: z.string().regex(/^[1-9]\d{0,5}:[1-9]\d{0,5}$/),
  /** Where the tree is mounted in the web and the CLI containers. */
  docroot: containerPath,
  /** Writable tmpfs folders the server needs besides the folder of the settings file. */
  tmpfs: z.array(containerPath).max(8),
  /**
   * Configuration of the server, written by name into the folder of the settings file
   * (`PREVIEW_SETTINGS_PATH`) on every `ensure`, never into the tree: `command` names it there.
   */
  configFiles: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
        content: z.string().max(64 * 1024),
      }),
    )
    .max(8)
    .refine(
      (files) => new Set(files.map((file) => file.name)).size === files.length,
      'each name once',
    ),
})
export type PreviewWebServer = z.infer<typeof previewWebServerSchema>

/** An argv of the CLI container: no shell; each argument as `PreviewExecInput` takes it. */
const cliArgv = z.array(z.string().min(1).max(4096)).min(1).max(16)

/**
 * How the platform reaches the content of a preview through the stack's own plugin
 * (docs/plan/53-chat-preview-release.md, Р15, Р20, Р24; R5c): commands of the CLI container,
 * each printing one JSON value on stdout and nothing else. The database of the preview is a copy
 * without the people of the site, so the platform makes its own account in it after every load.
 */
export const previewContentRecipeSchema = z.strictObject({
  /**
   * Creates the platform's account of the copy, or a new password of it, and prints its access:
   * a flat object of strings, the stack's content access (`SiteContentAdapter.accessSchema`)
   * without `origin`, which the platform adds — the origin of the preview.
   */
  access: cliArgv,
  /**
   * Prints the published objects of the copy the stack's plugin edits, as a JSON array of their
   * refs (`post:42`): what the platform compares with production after a seed (Р15).
   */
  objects: cliArgv,
  /**
   * The page of an object by the type of its ref, `{id}` its number: what the smoke check of a
   * candidate opens for the objects its database plan changes (Р20).
   */
  pages: z.record(
    z.string().regex(/^[a-z][a-z_]{0,31}$/),
    z
      .string()
      .max(256)
      .refine(
        (path) => path.includes('{id}') && isPreviewPath(path.replace('{id}', '1')),
        'expected a path of the preview with {id}',
      ),
  ),
})
export type PreviewContentRecipe = z.infer<typeof previewContentRecipeSchema>

/** A file the platform writes into the preview's tree: the stack's configuration and extensions. */
export const previewGeneratedFileSchema = z.strictObject({
  path: relativePath,
  /**
   * No secret: the file reads the preview's settings file (`PREVIEW_SETTINGS_PATH`). Up to
   * 192 KiB: the plugin «Радити» of version 2 is above the 64 KiB of version 1.
   */
  content: z.string().max(192 * 1024),
})
export type PreviewGeneratedFile = z.infer<typeof previewGeneratedFileSchema>

/**
 * How to run the full tree of a site of this stack. The platform picks the images by
 * `runtimeVersions` (PREVIEW_SITE_IMAGES) and writes `generatedFiles` over the tree every time it
 * writes the tree (`PreviewRuntime.writeFiles`); the agent's diff never touches them.
 */
export const previewRecipeSchema = z.strictObject({
  /** The language of the web container. */
  runtime: z.literal('php'),
  /** Versions the stack runs on, the preferred one first. */
  runtimeVersions: z.array(runtimeVersion).min(1).max(8),
  /** Engine of the database copy; null — the stack runs without a database. */
  database: z.enum(databaseEngines).nullable(),
  /** Entries the tree must have to run; without one the preview is unavailable (`no_core`). */
  requiredPaths: z.array(relativePath).max(64),
  /**
   * Files the platform writes per preview: the configuration and its own extensions. They are
   * the same for every preview of the stack — what differs per preview (its address, the
   * production address, the database the runtime created, the client's variables) they read
   * from the settings file the runtime writes (`previewSettingsSchema`).
   */
  generatedFiles: z
    .array(previewGeneratedFileSchema)
    .max(16)
    .refine(
      (files) => new Set(files.map((file) => file.path)).size === files.length,
      'each path once',
    ),
  /**
   * Settings of the generated configuration by name, passed in the settings file. The address of
   * the preview, the database credentials and the client's variables have their own fields
   * there, never one here.
   */
  settings: z.record(
    z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    z.union([z.string().max(1024), z.boolean(), z.number()]),
  ),
  /** A page that answers when the preview is up. */
  healthPath: z.string().max(256).refine(isPreviewPath, 'expected a path of the preview'),
  web: previewWebServerSchema,
  /** How the platform reaches the preview's content (R5c); absent or null — it does not. */
  content: previewContentRecipeSchema.nullable().optional(),
})
export type PreviewRecipe = z.infer<typeof previewRecipeSchema>

/** A row filter, applied in the `SELECT` at the source; conditions of a rule are ANDed. */
export const databaseCopyConditionSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('in'),
    column: identifier,
    values: z.array(z.string().max(256)).min(1).max(256),
  }),
  /**
   * `LIKE` one of the patterns: names and prefixes of an allow list. `%` and `_` are the
   * wildcards of SQL; `\` makes the next character literal (`theme\_mods\_%`).
   */
  z.strictObject({
    op: z.literal('like'),
    column: identifier,
    patterns: z.array(z.string().max(256)).min(1).max(256),
  }),
  /** `NOT LIKE` every pattern: keys with signs of a secret, transients. */
  z.strictObject({
    op: z.literal('notLike'),
    column: identifier,
    patterns: z.array(z.string().max(256)).min(1).max(256),
  }),
  /** Only rows that belong to rows copied from another table (meta of copied records). */
  z.strictObject({
    op: z.literal('inCopied'),
    column: identifier,
    table: identifier,
    key: identifier,
  }),
])
export type DatabaseCopyCondition = z.infer<typeof databaseCopyConditionSchema>

/**
 * What becomes of a column of a copied row; an unlisted column is kept as it is. The synthetic
 * values are made of the row's primary key `<id>` (a table with one numeric key column only):
 * `user<id>`, `user<id>@preview.invalid` and «Пользователь <id>»; the password hash is a
 * random value no password matches.
 */
export const databaseColumnTreatments = [
  'keep',
  'empty',
  'null',
  'synthetic_email',
  'synthetic_login',
  'synthetic_name',
  'random_password_hash',
  // The string under every key that names a secret (`api_key`, `secret`, `token`, `password`,
  // `webhook`…) of a value in PHP's serialization or JSON is blanked, at any depth (Р14, Р15).
  'scrub_secrets',
] as const
export type DatabaseColumnTreatment = (typeof databaseColumnTreatments)[number]

/**
 * The preview a database copy is made for (`SiteAdapter.databaseCopyPolicy`): the stack binds
 * its own state in the copy to it — the platform plugin to the preview, not to the site (Р15).
 * The seed is made once and loaded again by every rebuild, so nothing here changes per build.
 */
export interface PreviewCopyTarget {
  previewId: string
}

export const databaseCopyPolicySchema = z.strictObject({
  engine: z.enum(databaseEngines),
  /**
   * Tables whose rows are copied, named without the site's table prefix. Every other table is
   * copied as structure only: an allow list, never a deny list (Р15).
   */
  tables: z
    .array(
      z.strictObject({
        table: identifier,
        where: z.array(databaseCopyConditionSchema).max(8),
        columns: z.record(identifier, z.enum(databaseColumnTreatments)).optional(),
      }),
    )
    .max(64)
    .refine(
      (tables) => new Set(tables.map((rule) => rule.table)).size === tables.length,
      'one rule per table',
    ),
  /**
   * Rows of the copy the stack sets itself, e.g. the platform plugin's own state: the copied row
   * that matches gets `set`, and without one a row of `match` and `set` is added; null in `set`
   * — the copy holds no such row.
   */
  overrides: z
    .array(
      z.strictObject({
        table: identifier,
        match: z.strictObject({ column: identifier, value: z.string().max(256) }),
        /** null in `set` deletes the matched rows instead of changing them. */
        set: z.record(identifier, z.union([z.string().max(1024), z.number()])).nullable(),
      }),
    )
    .max(32),
})
export type DatabaseCopyPolicy = z.infer<typeof databaseCopyPolicySchema>
