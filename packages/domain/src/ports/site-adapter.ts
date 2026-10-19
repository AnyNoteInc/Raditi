/**
 * Site adapter port — spec §13. Everything that depends on the CMS or framework hides
 * behind this interface; the core knows nothing about WordPress or Bitrix.
 */
import type { z } from 'zod'

import { badRequest } from '../errors.ts'
import type {
  DatabaseCopyPolicy,
  PreviewCopyTarget,
  PreviewRecipe,
  SiteDatabaseSettings,
} from '../preview/recipe.ts'
import type { AgentWorkingSet, MediaRules } from '../release/candidate.ts'
import type { DbSetting } from '../release/db-objects.ts'
import type { DbOperationKind } from '../release/db-plan.ts'
import type { SiteCodeCacheGateway } from './published-content.ts'
import type { SiteContentGateway } from './site-db.ts'

export const siteStacks = ['wordpress', 'bitrix', 'laravel', 'static', 'node', 'python'] as const
export type SiteStack = (typeof siteStacks)[number]

/** Read-only access to a site server during onboarding (SSH, FTP or the Радити plugin). */
export interface ServerProbe {
  exec(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  readFile(path: string): Promise<string | null>
  httpGet(path: string): Promise<{ status: number; body: string }>
}

export interface SiteFacts {
  stack: SiteStack
  url: string
  docroot: string
  version?: string
  runtimeVersion?: string
  /**
   * What the production configuration says about the database (`databaseSettings`); absent —
   * not read, and a stack with a database refuses `previewRecipe` and `databaseCopyPolicy`
   * rather than guess (`DatabaseCopyInput` takes the same values).
   */
  database?: SiteDatabaseSettings
  extras: Record<string, string>
}

export interface ImportRules {
  /** Lines of the repository .gitignore. */
  gitignore: string[]
  /** Never imported into git: uploads, caches, core files. */
  exclude: string[]
}

/** Variables for the shared deploy workflow; adapters never ship their own CI. */
export type DeployVars = Record<string, string>

export interface BackupPlan {
  paths: string[]
  database: boolean
}

export interface VerifyPlan {
  /** Paths below the site's origin (`/`, `/shop/`) that must answer 2xx or 3xx after a release. */
  pages: string[]
  logFiles: string[]
  screenshots: string[]
  /**
   * Text that, found in a page, means the site is broken although it answered (a fatal error
   * page of the stack's runtime). Compared byte for byte, case and all (R8c 17.10).
   */
  failureMarkers: string[]
  /**
   * Where a published record of each type is served, below the origin, with `{id}` for its
   * number on production (`page` → `/?page_id={id}`): a release checks every published record
   * it created there too (docs/plan/53, «Операции БД и миграции», critique S9). Absent — none.
   */
  recordPages?: Readonly<Record<string, string>>
}

export interface McpToolDescriptor {
  name: string
  description: string
  /** Needs request_approval before running (CLAUDE.md rule 4). */
  dangerous: boolean
}

/**
 * Kinds of access to a site kept in Vault (spec §15); each is one secret of the site and one
 * `credential_refs` row of the same kind.
 */
export const siteAccessKinds = ['ssh', 'ftp', 'wp', 'browser', 'git', 'db'] as const
export type SiteAccessKind = (typeof siteAccessKinds)[number]

const SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The only Vault path of one access of one site: `kv/sites/<siteId>/<kind>`. A reference in
 * the database is followed only when it equals this, so a changed row cannot point a reader
 * at another site's secret or at another mount.
 */
export function siteAccessPath(siteId: string, kind: SiteAccessKind): string {
  if (!SITE_ID.test(siteId) || !siteAccessKinds.includes(kind))
    throw badRequest('Invalid site access reference')
  return `kv/sites/${siteId}/${kind}`
}

/**
 * One HTTP exchange with a site. The adapter names its limits; the transport follows no
 * redirect (a 3xx is returned as it is) and rejects on a network failure, a timeout or a
 * response larger than `maxResponseBytes`.
 */
export interface SiteHttpRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Readonly<Record<string, string>>
  body?: string
  timeoutMs: number
  maxResponseBytes: number
}

export interface SiteHttpResponse {
  status: number
  body: Uint8Array
  /**
   * The `Location` of a 3xx, as the site sent it, where the transport reads it (R8c 17.10: the
   * check of a release follows a redirect within the site); absent otherwise.
   */
  location?: string
}

/** The composition root owns it: the place that decides which addresses a site may resolve to. */
export type SiteHttpTransport = (request: SiteHttpRequest) => Promise<SiteHttpResponse>

/** What every content access says besides its adapter's own fields: the origin it is valid for. */
export interface SiteContentAccess {
  origin: string
}

export interface SiteContentConnection<Access extends SiteContentAccess = SiteContentAccess> {
  siteId: string
  /** Origin of the site's address; the caller has checked that the access names the same one. */
  origin: string
  access: Access
  transport: SiteHttpTransport
  /** Plain http to a loopback name, for a disposable local site. Never in production. */
  allowLoopbackHttp: boolean
}

/**
 * Published content of one stack (spec §11, §13): which access of the site it needs, how that
 * secret looks, and the gateway built from it. The caller reads the secret and never learns
 * its CMS-specific fields.
 */
export interface SiteContentAdapter<Access extends SiteContentAccess = SiteContentAccess> {
  readonly stack: SiteStack
  /** `credential_refs.kind` of the access and the last segment of its Vault path. */
  readonly accessKind: SiteAccessKind
  /** The secret as Vault keeps it: a flat record of strings. */
  readonly accessSchema: z.ZodType<Access>
  createGateway(connection: SiteContentConnection<Access>): SiteContentGateway
  /**
   * The code cache of the site's server through the same access (stand R12): what a release
   * reads before it writes and refreshes after. A stack without one has no method.
   */
  createCodeCache?(connection: SiteContentConnection<Access>): SiteCodeCacheGateway
}

export interface SiteAdapter {
  readonly stack: SiteStack
  detect(probe: ServerProbe): Promise<SiteFacts | null>
  importRules(site: SiteFacts): ImportRules
  deployVars(site: SiteFacts): DeployVars
  backup(site: SiteFacts): BackupPlan
  verify(site: SiteFacts): VerifyPlan
  mcpTools(site: SiteFacts): McpToolDescriptor[]
  /** Draft of the site AGENTS.md. */
  agentGuide(site: SiteFacts): string
  /** Paths an agent diff may not touch, e.g. wp-config.php or /bitrix/. */
  protectedPaths(site: SiteFacts): string[]
  /** Heavy or generated paths excluded from turn snapshots. */
  snapshotExcludes(site: SiteFacts): string[]
  /**
   * Entries that the root folder of a site of this stack always has. The wizard refuses a folder
   * without them and the import does not enter a nested folder that has them all.
   */
  rootMarkers(): string[]
  /**
   * Secrets the site keeps in its own configuration files, e.g. `DB_PASSWORD` and the keys and
   * salts of wp-config.php — the passwords and keys most likely to be copied into forgotten
   * files next to the code. `read` returns a file of the site root by its relative path (ASCII,
   * `/` separators), or null when it is absent or larger than `siteImportLimits.configFileBytes`.
   * The values join the exact values of the import scan; they are never stored, logged or
   * returned to anyone.
   */
  configSecrets(read: (path: string) => Promise<Uint8Array | null>): Promise<string[]>
  /**
   * The part of the full tree the agent works on (docs/plan/53-chat-preview-release.md, Р11);
   * checked with `agentWorkingSetSchema`.
   */
  agentWorkingSet(site: SiteFacts): AgentWorkingSet
  /** Where and what media the agent may add (Р12); checked with `mediaRulesSchema`. */
  mediaRules(site: SiteFacts): MediaRules
  /**
   * The table prefix and the connection encoding of the production database, read from the
   * site's configuration like `configSecrets` reads it (Р15): what the database copy and the
   * preview's configuration use (`DatabaseCopyInput`, `SiteFacts.database`). null — the
   * configuration does not state them as constants, or the stack's database cannot be copied
   * (the preview is `unavailable`, `not_supported`). Never a secret.
   */
  databaseSettings(
    read: (path: string) => Promise<Uint8Array | null>,
  ): Promise<SiteDatabaseSettings | null>
  /** How a preview runs the full tree (Р16, Р18); checked with `previewRecipeSchema`. */
  previewRecipe(site: SiteFacts): PreviewRecipe
  /**
   * Which rows the database copy of `preview` may hold, and what of the stack's own state in it
   * is bound to the preview (Р15); checked with `databaseCopyPolicySchema`.
   */
  databaseCopyPolicy(site: SiteFacts, preview: PreviewCopyTarget): DatabaseCopyPolicy
  /** Kinds of database operations a release of this stack may replay (Р3); empty — none. */
  dbOperationKinds(site: SiteFacts): readonly DbOperationKind[]
  /**
   * The settings of the site a plan may change (`option_update`), checked with `dbSettingSchema`:
   * a closed list that allows — the stack's address, theme, plugins, users, mail and payments
   * are never in it (CLAUDE.md rule 4). Empty — none.
   */
  dbSettings(site: SiteFacts): readonly DbSetting[]
  /**
   * What the platform rules tell the agent of the database changes a release of this stack
   * carries (Р3): the calls of the platform's tools that make each kind `dbOperationKinds`
   * declares, and how the stack's code names a table of the platform. Lines of Markdown in
   * English, each a list item; empty — the stack carries no change of its database.
   */
  dbPlanGuide(site: SiteFacts): string
  /**
   * Whether the agent's browser on a preview must not open or send `request` (Р21, spec §11,
   * CLAUDE.md rule 4): the stack's admin pages and actions beyond the agent's work — users,
   * orders, payments, plugins, themes, settings. Checked on every navigation and on every
   * request a page makes; true for anything the adapter cannot read. Pure, no I/O.
   */
  browserRequestDenied(request: SiteBrowserRequest): boolean
}

/** One request of the agent's browser to its preview, as the stack's policy sees it. */
export interface SiteBrowserRequest {
  /** Path with its query, relative to the site: `/wp-admin/users.php?action=delete`. */
  path: string
  method: string
  /** The body of a form or XHR as the page sends it; null — none or not text. */
  postData: string | null
}
