import { z } from 'zod'

import { envVarLimits, envVarNameSchema, envVarValueSchema } from '../release/env-vars.ts'
import type { SiteBrowserRequest } from '../ports/site-adapter.ts'
import type { DbAccess } from '../site-connection/access.ts'
import { databaseEngines } from '../site-connection/kinds.ts'
import { isPreviewPath } from './hostname.ts'
import { previewImageSchema, previewRuntimes, type PreviewRuntimeKind } from './preview-config.ts'
import {
  databaseCopyPolicySchema,
  previewRecipeSchema,
  type DatabaseCopyPolicy,
  type PreviewGeneratedFile,
} from './recipe.ts'

/**
 * Ports of previews (docs/plan/53-chat-preview-release.md, Р15, Р18–Р24): where a preview runs
 * (`PreviewRuntime`), how its database copy is made (`DatabaseCopier`) and how the agent's
 * browser acts on it (`PageBrowser`). What a stack adapter says about them (`PreviewRecipe`,
 * `DatabaseCopyPolicy`) is in recipe.ts. Neutral to the provider, the CMS and the shell
 * (CLAUDE.md rule 8): a WordPress recipe and a Docker runtime are adapters.
 */

const identifier = z.string().regex(/^[A-Za-z0-9_]{1,64}$/, 'expected an SQL identifier')

/** `scheme://host[:port]` in its canonical spelling: no path, credentials, query or fragment. */
const originSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    const url = URL.parse(value)
    return (url?.protocol === 'http:' || url?.protocol === 'https:') && url.origin === value
  }, 'expected an origin: scheme://host[:port]')
const hostnameSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/, 'expected a lower-case host name')

// ---------------------------------------------------------------------------------------------
// DatabaseCopier: the seed of a preview's database
// ---------------------------------------------------------------------------------------------

export interface DatabaseCopyInput {
  /** The site's database access (Vault `kv/sites/<siteId>/db`); never logged. */
  access: DbAccess
  /** Table prefix of the site, from its configuration. */
  tablePrefix: string
  /** Character set and collation of the production connection (Р15). */
  charset: string
  collation: string | null
  /**
   * `SiteAdapter.databaseCopyPolicy(site, { previewId })`: the policy of this preview, its
   * overrides binding the stack's own state in the copy to the preview.
   */
  policy: DatabaseCopyPolicy
}

export const databaseCopyInputSchema = z.strictObject({
  tablePrefix: z.string().regex(/^[A-Za-z0-9_]{0,32}$/),
  charset: identifier,
  collation: identifier.nullable(),
  policy: databaseCopyPolicySchema,
})

export interface DatabaseCopySummary {
  tables: number
  /** Tables copied as structure only. */
  structureOnly: number
  rows: number
  bytes: number
  /** SHA-256 of the seed as written, hex. */
  sha256: string
  /**
   * What the source server answered to `VERSION()`, cut and without control characters: the
   * preview's database should be of the same family. null — no answer.
   */
  serverVersion: string | null
}

/** Limits of one copy (Р15). Domain constants: no variable changes them. */
export const databaseCopyLimits = Object.freeze({
  /** Tables of the site (its table prefix) in the copy. */
  tables: 1_000,
  /** Rows of all copied tables together. */
  rows: 1_000_000,
  /** One row as the server sends it: its INSERT stays loadable at the default packet size. */
  rowBytes: 4 * 1024 * 1024,
  /** The seed as written, before compression. */
  seedBytes: 512 * 1024 * 1024,
  /** Everything the server may send during one copy, TLS included. */
  receivedBytes: 1024 * 1024 * 1024,
  /** One `SHOW CREATE TABLE`. */
  createTableBytes: 64 * 1024,
  /** Rows of one SELECT, paged by the primary key. */
  batchRows: 500,
  /** Rows are grouped into one INSERT up to this size. */
  statementBytes: 1024 * 1024,
  connectMs: 15_000,
  /** One query with its answer. */
  queryMs: 120_000,
  /** The whole copy. */
  copyMs: 30 * 60_000,
})

/**
 * Why a copy stopped besides the connection (`SiteConnectionError`): a limit of
 * `databaseCopyLimits` (`too_large`), an encoding the seed cannot be written in, a table the
 * policy cannot be applied to, the deadline.
 */
export const databaseCopyFailures = [
  'too_large',
  'encoding_unsupported',
  'structure_unsupported',
  'timed_out',
] as const
export type DatabaseCopyFailure = (typeof databaseCopyFailures)[number]

export class DatabaseCopyError extends Error {
  readonly reason: DatabaseCopyFailure

  constructor(reason: DatabaseCopyFailure) {
    super(`Database copy: ${reason}`)
    this.name = 'DatabaseCopyError'
    this.reason = reason
  }
}

/** Checks the name, not `instanceof`: works across duplicated module instances. */
export function isDatabaseCopyError(error: unknown): error is DatabaseCopyError {
  return error instanceof Error && error.name === 'DatabaseCopyError'
}

export interface DatabaseCopier {
  /**
   * Streams an SQL seed into `write`, filtered at the source: rows the policy does not name are
   * never read, and nothing lands on a disk or in memory as a raw dump. Rejects with
   * `SiteConnectionError` (the connection) or `DatabaseCopyError` (the copy); what was written
   * by then is no seed.
   */
  copy(
    input: DatabaseCopyInput,
    write: (chunk: Uint8Array) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<DatabaseCopySummary>
}

/**
 * A temporary database a SQL dump of the site is loaded into before the copy (owner's decision of
 * 26.10.2026: a dump on the site's file source when its database answers only on the hosting).
 * The copy then reads it with `DatabaseCopier` like a live database. The runtime owns nothing of
 * the platform's state: one database per `stagingId`, removed by `remove`.
 */
export interface StagingDatabaseRuntime {
  /**
   * Starts a database from `image` (the preview's database image, by digest), loads `dump` into
   * it as a user without administrative rights — no client command of the dump runs, no file is
   * read or written by the server for it — and answers the access the copier connects with.
   * Fails with `SANDBOX_COMMAND_FAILED` when the dump does not load; what it started is removed.
   */
  load(input: StagingDatabaseInput): Promise<StagedDatabase>
  /** Removes the container and its data. Idempotent. */
  remove(stagingId: string): Promise<void>
  /** Staging databases this runtime holds and when each was made, for the garbage collector. */
  list(): Promise<Array<{ stagingId: string; createdAt: number }>>
}

export interface StagingDatabaseInput {
  stagingId: string
  image: string
  dump: AsyncIterable<Uint8Array>
  signal?: AbortSignal
}

export interface StagedDatabase {
  /** Where the copier connects: a loopback address of the host, a password made for this load. */
  access: DbAccess
}

// ---------------------------------------------------------------------------------------------
// PreviewRuntime: containers, networks and volumes of one preview
// ---------------------------------------------------------------------------------------------

export const previewRuntimeSpecSchema = z
  .strictObject({
    previewId: z.uuid(),
    siteId: z.uuid(),
    taskId: z.uuid(),
    runtime: z.enum(previewRuntimes),
    images: z.strictObject({
      /**
       * The preview itself (docs/plan/58): one container with the site's server, its database and
       * its entry gateway — the image of the recipe's runtime version (PREVIEW_SITE_IMAGES).
       */
      preview: previewImageSchema,
      /** The platform's tools (PREVIEW_FORWARDER_IMAGE): the files helper and the lease. */
      tools: previewImageSchema,
    }),
    /** The preview runs the recipe's database (`recipe.database`) in its container. */
    database: z.boolean(),
    recipe: previewRecipeSchema,
    limits: z.strictObject({
      cpu: z.number().positive().max(4),
      memoryMiB: z.number().int().min(256).max(8192),
      pids: z.number().int().min(64).max(4096),
    }),
    /** Where the entry gateway of the preview publishes (PREVIEW_UPSTREAM_HOST). */
    upstreamHost: z.string().min(1).max(253),
    /** `preview_environments.hostname`: the host the gateway serves the preview at (Р17). */
    hostname: hostnameSchema,
    /** `previewOrigin(hostname, …)`: what the preview answers as its own address (Р15). */
    origin: originSchema,
    /**
     * The origin of the site on production. Its database keeps this address (Р15): the stack's
     * generated files put `origin` in its place when the preview answers.
     */
    productionOrigin: originSchema,
    /**
     * `preview_environments.expires_at` in epoch milliseconds, still ahead: every container,
     * network and volume of the preview is labelled with it plus the runtime's fixed grace, and
     * the host's watchdog removes them all once that passed without core (Р18) — core stops or
     * destroys an expired preview itself. A later value (`ensure`, `extend`) moves it on, an
     * earlier one never back.
     */
    expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
  })
  .refine((spec) => URL.parse(spec.origin)?.hostname === spec.hostname, {
    message: 'the origin must be of the hostname',
    path: ['origin'],
  })
  .refine((spec) => !spec.database || spec.recipe.database !== null, {
    message: 'a database needs the engine of the recipe',
    path: ['database'],
  })
export type PreviewRuntimeSpec = z.output<typeof previewRuntimeSpecSchema>

/**
 * What a preview gets that must never be logged, apart from the spec. The runtime writes it
 * into the settings file and nowhere else: not a label, an argument, the environment of a
 * process, the docroot volume or a log.
 */
export interface PreviewRuntimeSecrets {
  /**
   * The client's variables the preview gets, values from Vault (Р13): only those
   * `envVarReachesPreview` lets through — the preview runs the agent's code, so it gets nothing
   * the agent may not see.
   */
  env: Readonly<Record<string, string>>
  /**
   * The passwords of the preview's database, from Vault `kv/previews/<previewId>/db`
   * (`previewDatabaseSecretSchema`), which `core` writes once and removes with the preview; null
   * — the recipe runs without a database. The same on every call: the users of the database live
   * in its volume.
   */
  database: PreviewDatabasePasswords | null
}

/** A password of a preview's database: random, URL-safe, never chosen by anyone. */
export const previewDatabasePasswordSchema = z.string().regex(/^[A-Za-z0-9_-]{24,128}$/)

export const previewDatabasePasswordsSchema = z.strictObject({
  /** The preview's own user (`PreviewDatabaseConnection.user`), the one PHP connects as. */
  user: previewDatabasePasswordSchema,
  /** Root on the database container's own socket only. */
  root: previewDatabasePasswordSchema,
})
export type PreviewDatabasePasswords = z.infer<typeof previewDatabasePasswordsSchema>

export const previewRuntimeSecretsSchema = z.strictObject({
  env: z
    .record(envVarNameSchema, envVarValueSchema)
    .refine((env) => Object.keys(env).length <= envVarLimits.perSite, 'too many variables'),
  database: previewDatabasePasswordsSchema.nullable(),
})

/**
 * Where the web and the CLI containers of a preview read its settings: a tmpfs file, readable
 * by the PHP user only. The stack's generated files read it; the docroot volume — which a sync
 * of the agent's tree writes into (Р23) — never holds a secret.
 */
export const PREVIEW_SETTINGS_PATH = '/run/raditi/preview/settings.json'

/**
 * The database the runtime created for the preview, as PHP connects to it: the password of
 * `PreviewRuntimeSecrets.database`, here and in Vault only.
 */
export const previewDatabaseConnectionSchema = z.strictObject({
  engine: z.enum(databaseEngines),
  /** The database in the preview's own container: its loopback (docs/plan/58). */
  host: hostnameSchema,
  port: z.number().int().min(1).max(65_535),
  name: identifier,
  user: identifier,
  password: previewDatabasePasswordSchema,
})
export type PreviewDatabaseConnection = z.infer<typeof previewDatabaseConnectionSchema>

/**
 * The settings file (`PREVIEW_SETTINGS_PATH`), written by the runtime on every `ensure`: the
 * addresses of the spec, the database it created, the recipe's settings and the variables of
 * `PreviewRuntimeSecrets`. The only per-preview input of the stack's generated files.
 */
export const previewSettingsSchema = z.strictObject({
  /**
   * 2 since the preview of one container (docs/plan/58): its internet is open, so the settings no
   * longer name an egress proxy and the hosts it lets through.
   */
  v: z.literal(2),
  hostname: hostnameSchema,
  origin: originSchema,
  productionOrigin: originSchema,
  /** null — the recipe runs without a database, or the preview has none (Р4). */
  database: previewDatabaseConnectionSchema.nullable(),
  settings: previewRecipeSchema.shape.settings,
  env: previewRuntimeSecretsSchema.shape.env,
})
export type PreviewSettings = z.infer<typeof previewSettingsSchema>

/**
 * Where the gateway of the `preview` role (and the mcp role) sends the requests of this preview,
 * each with `Host` of the preview's hostname: the upstream answers 421 to any other. Valid only
 * while the preview runs: once it stops, its port may be another preview's.
 */
export interface PreviewUpstream {
  host: string
  port: number
}

export interface PreviewRuntimeState {
  previewId: string
  runtime: PreviewRuntimeKind
  running: boolean
  upstream: PreviewUpstream | null
}

/** A tree or an overlay of files: validated by the caller like `untracked.tar.zst`. */
export interface PreviewFilesInput {
  /** A tar of regular files and directories only. */
  archive: AsyncIterable<Uint8Array>
  /** Paths removed after the archive is written. */
  deletes: readonly string[]
  /** true — the archive is the whole tree, the docroot is emptied first. */
  replace: boolean
  /**
   * The recipe's `generatedFiles`, written after the archive and the deletes as the platform's
   * (R5b, R5c): root's with mode 0444, every folder on their way — the root of the tree
   * included — root's with the group of the PHP user and mode 1775. That user keeps creating and
   * removing its own files there, never the platform's. Absent — the tree is written alone.
   */
  platform?: readonly PreviewGeneratedFile[]
}

export const previewExecInputSchema = z.strictObject({
  /** No shell: an argv of the CLI container. */
  argv: z.array(z.string().max(4096)).min(1).max(64),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(10 * 60_000),
})
export type PreviewExecInput = z.infer<typeof previewExecInputSchema> & {
  stdin?: Uint8Array | AsyncIterable<Uint8Array>
}

export interface PreviewExecResult {
  code: number
  stdout: Uint8Array
  stderr: Uint8Array
}

export const previewBrowserInputSchema = z.strictObject({
  image: previewImageSchema,
  /** The hostname of the preview: the only host the browser's forwarder reaches. */
  hostname: z.string().min(1).max(253),
})
export type PreviewBrowserInput = z.infer<typeof previewBrowserInputSchema>

/** The control endpoint of a browser: loopback only, its path is a secret (Vault). */
export interface PreviewBrowserEndpoint {
  wsEndpoint: string
}

/**
 * The containers of one preview: PHP, its database, the CLI, the entry and egress forwarders,
 * and on request a browser — each on the preview's own internal networks (Р18). Every method is
 * idempotent by `previewId`; nothing here reads PostgreSQL, the caller holds the state.
 */
export interface PreviewRuntime {
  /**
   * Creates what is missing and starts it; answers where the entry forwarder listens. Writes
   * the settings file (`previewSettingsSchema`) on every call — the spec's addresses, the
   * database it created and `secrets` — so a changed variable reaches the preview by the next
   * call. The database passwords are the caller's (`secrets.database`, from Vault): the database
   * container gets them as files of its tmpfs, never in its environment, a label or an argument,
   * and nothing reads them back from Docker. A database that holds other passwords is a CONFLICT.
   */
  ensure(
    spec: PreviewRuntimeSpec,
    secrets: PreviewRuntimeSecrets,
    signal?: AbortSignal,
  ): Promise<PreviewUpstream>
  /**
   * Moves the preview's deadline on to `expiresAt` (`preview_environments.expires_at`) without a
   * build and without its secrets; an earlier one changes nothing. Core calls it whenever it
   * moves `expires_at` on without an `ensure`.
   */
  extend(previewId: string, expiresAt: number): Promise<void>
  inspect(previewId: string): Promise<PreviewRuntimeState | null>
  /**
   * Throws when what keeps a running preview from the host and the platform is not whole — the
   * rules of its network (docs/plan/58), which a reload of the host's firewall would take until
   * the next build; a preview not running here passes. Its caller asks again and again.
   */
  checkBoundary(previewId: string): Promise<void>
  /**
   * Writes files into the docroot through a helper that mounts that volume alone. The caller
   * writes the recipe's `generatedFiles` over every tree it writes.
   */
  writeFiles(previewId: string, input: PreviewFilesInput, signal?: AbortSignal): Promise<void>
  /**
   * Loads a seed into the preview's database, replacing what was there, as its user: the
   * passwords are those `ensure` was given (Vault), never read back from Docker.
   */
  loadDatabase(
    previewId: string,
    seed: AsyncIterable<Uint8Array>,
    passwords: PreviewDatabasePasswords,
    signal?: AbortSignal,
  ): Promise<void>
  exec(previewId: string, input: PreviewExecInput, signal?: AbortSignal): Promise<PreviewExecResult>
  startBrowser(previewId: string, input: PreviewBrowserInput): Promise<PreviewBrowserEndpoint>
  stopBrowser(previewId: string): Promise<void>
  /** Stops the containers and keeps the volumes (an expired preview). */
  stop(previewId: string): Promise<void>
  /** Removes containers, networks and volumes. */
  destroy(previewId: string): Promise<void>
  /** Previews this runtime holds anything of, for the garbage collector. */
  list(): Promise<string[]>
}

// ---------------------------------------------------------------------------------------------
// PageBrowser: the agent's browser on a preview (Р21)
// ---------------------------------------------------------------------------------------------

const oneLine = (value: string) => !/\p{Cc}/u.test(value)
/** A Playwright selector (CSS, `text=`, `role=`…), one line. */
const selector = z.string().min(1).max(1024).refine(oneLine, 'expected one line')
const timeoutMs = z.number().int().positive().max(30_000)
/** An ARIA role (`button`, `link`, `textbox`…) and the accessible name of the element. */
const ariaRole = z.string().regex(/^[a-z]{2,32}$/)
const accessibleName = z.string().min(1).max(256).refine(oneLine, 'expected one line')

export const pageNavigateInputSchema = z.strictObject({
  path: z.string().refine(isPreviewPath, 'expected a path of the preview'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
})
/** The element to click: by a selector, or by its role and accessible name. */
export const pageClickInputSchema = z.union([
  z.strictObject({ selector, timeoutMs: timeoutMs.optional() }),
  z.strictObject({
    role: ariaRole,
    name: accessibleName.optional(),
    timeoutMs: timeoutMs.optional(),
  }),
])
export const pageFillInputSchema = z.strictObject({
  selector,
  value: z.string().max(10_000),
  timeoutMs: timeoutMs.optional(),
})
/** One expectation: the state of the element (`visible` when neither is given) or its text. */
export const pageExpectInputSchema = z
  .strictObject({
    selector,
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
    text: z.string().min(1).max(1000).optional(),
    timeoutMs: timeoutMs.optional(),
  })
  .refine((input) => input.state === undefined || input.text === undefined, {
    message: 'expected a state or a text, not both',
  })
export const pageSnapshotInputSchema = z.strictObject({
  maxChars: z.number().int().positive().max(100_000).optional(),
})
export type PageNavigateInput = z.infer<typeof pageNavigateInputSchema>
export type PageClickInput = z.infer<typeof pageClickInputSchema>
export type PageFillInput = z.infer<typeof pageFillInputSchema>
export type PageExpectInput = z.infer<typeof pageExpectInputSchema>
export type PageSnapshotInput = z.infer<typeof pageSnapshotInputSchema>

/** Where the page is after an action: a path of the preview, never an origin. */
export interface PageLocation {
  path: string
  title: string
  /** Of the document the last navigation loaded; null — the action loaded none. */
  status: number | null
}

/** Text of the page for the model; the caller masks it before it leaves the platform. */
export interface PageSnapshot extends PageLocation {
  /** The accessibility tree of the page as text (roles, names, values). */
  text: string
  /** Links of the page to the preview itself: their text and path. */
  links: { text: string; path: string }[]
}

/** Pixels stay with the platform (N22): the model gets the id of the stored artifact. */
export interface PageScreenshot {
  bytes: Uint8Array
  contentType: 'image/png'
  width: number
  height: number
}

export interface PageConsoleEntry {
  level: 'log' | 'info' | 'warning' | 'error'
  text: string
}

/** A request of the page: to the preview by its path, elsewhere by its origin only. */
export interface PageNetworkEntry {
  method: string
  /** The path and query of a request to the preview; null — another origin (never sent). */
  path: string | null
  /** null — the request failed or was refused before an answer. */
  status: number | null
  resourceType: string
}

/** A request of a page as the stack's policy reads it (`SiteAdapter.browserRequestDenied`). */
export type PageRequest = SiteBrowserRequest

/**
 * Text of a page cut to at most `limit` characters where a cut leaves no part of a contact
 * behind (spec §11): the word the bound runs through goes, and so does a run of what a phone
 * number is written with right before it. A part of an address or of a number is no longer
 * found by the contact search and would reach the model unmasked; a whole one before the cut is
 * masked by the caller. The caller masks whole texts and cuts what it masked with this too.
 */
export function clipPageText(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text
    .slice(0, Math.max(0, limit) + 1)
    .replace(/\S*$/u, '')
    .replace(/[\s\d()+\-.]*$/u, '')
}

/** Raised by an adapter for what the caller turns into a fixed code; never a page's message. */
export const pageBrowserFailures = [
  /** The element is not there, or the expectation did not come true in time. */
  'timeout',
  /** The page went to another origin, or the policy refused where it went. */
  'denied',
  /** The browser or its connection is gone. */
  'closed',
] as const
export type PageBrowserFailure = (typeof pageBrowserFailures)[number]

export class PageBrowserError extends Error {
  readonly reason: PageBrowserFailure

  constructor(reason: PageBrowserFailure) {
    super(`Page browser: ${reason}`)
    this.name = 'PageBrowserError'
    this.reason = reason
  }
}

/** Checks the name, not `instanceof`: works across duplicated module instances. */
export function isPageBrowserError(error: unknown): error is PageBrowserError {
  return error instanceof Error && error.name === 'PageBrowserError'
}

export interface PageBrowser {
  navigate(input: PageNavigateInput): Promise<PageLocation>
  click(input: PageClickInput): Promise<PageLocation>
  fill(input: PageFillInput): Promise<PageLocation>
  expect(input: PageExpectInput): Promise<{ passed: boolean }>
  snapshot(input: PageSnapshotInput): Promise<PageSnapshot>
  screenshot(): Promise<PageScreenshot>
  /** Messages since the last call. */
  console(): Promise<PageConsoleEntry[]>
  /** Requests since the last call. */
  network(): Promise<PageNetworkEntry[]>
  /** false once the browser or its connection is gone: the caller opens a new one. */
  isConnected(): boolean
  close(): Promise<void>
}

export interface PageBrowserConnection {
  /** The control socket (`ws://127.0.0.1:<port>/<secret path>`, Vault): never logged. */
  endpoint: PreviewBrowserEndpoint
  /** The origin of the preview: the only one its pages may load. */
  origin: string
  /**
   * The one-time entry link of the gateway with a browser ticket (`previewEnterUrl`): the new
   * context opens it first and gets its own session; no profile, no cookie of anyone else.
   */
  enterUrl: string
  /** The stack's policy, checked on every request of a page to the preview. */
  denyRequest: (request: PageRequest) => boolean
}

export interface PageBrowserFactory {
  connect(connection: PageBrowserConnection, signal?: AbortSignal): Promise<PageBrowser>
}
