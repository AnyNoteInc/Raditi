/**
 * Site adapter port — spec §13. Everything that depends on the CMS or framework hides
 * behind this interface; the core knows nothing about WordPress or Bitrix.
 */
import type { z } from 'zod'

import type {
  BrowserCheckpointRef,
  BrowserCommitAction,
  BrowserVerificationPlan,
} from '../browser/checkpoint.ts'
import type { BrowserController } from '../browser/session.ts'
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
import type { DatabaseEngine } from '../site-connection/kinds.ts'
import type { SiteLimit, SiteStack } from '../site-stack/stacks.ts'
import type { StackSupport } from '../site-stack/support.ts'
import type { SiteCodeCacheGateway } from './published-content.ts'
import type { SiteContentGateway } from './site-db.ts'

export * from '../site-stack/stacks.ts'

export interface SiteFacts {
  stack: SiteStack
  url: string
  docroot: string
  version?: string
  /**
   * The id of the row of the stack's table of generations (`sites.stack_facts.generation`): the
   * only thing of the site's version `stackGuide` reads (docs/plan/62-site-stacks.md, Т14, Р6 of
   * Э2). `version` is a string from the hosting and never reaches the instructions of a turn.
   */
  generation?: string
  runtimeVersion?: string
  /**
   * What the production configuration says about the database (`databaseSettings`); absent —
   * not read, and a stack with a database refuses `previewRecipe` and `databaseCopyPolicy`
   * rather than guess (`DatabaseCopyInput` takes the same values).
   */
  database?: SiteDatabaseSettings
  extras: Record<string, string>
}

/**
 * Copies of the stack's configuration left at any depth under its exact name (`old/configuration.php`):
 * the exclude lines cannot say it — `**` and `!` are not theirs, and a mask at any depth would cut
 * classes of the core with the same letters in another case (docs/plan/62-slices/e3.md, Э3.3).
 */
export interface ImportConfigCopies {
  /** Names of files, an exact match without regard to letter case. */
  names: readonly string[]
  /** Folders `a/b/` from the root where such a name is the stack's own code. */
  except: readonly string[]
  /** How many folders above the file are looked at; null — any depth. */
  maxDepth: number | null
}

export interface ImportRules {
  /** Lines of the repository .gitignore. */
  gitignore: string[]
  /** Never imported into git: uploads, caches, core files. */
  exclude: string[]
  /**
   * Folders whose documents are the client's own: `<path>/`, from the root, no `*`. A document
   * anywhere else stays out: visitors' files and code lie side by side in the trees of many
   * stacks, and no list of their folders is complete. Empty — no document is imported (plan 62,
   * Т57).
   */
  documentFolders: string[]
  /** Absent — none: a stack whose configuration has no name of its own to look for. */
  configCopies?: ImportConfigCopies
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
  /**
   * `X-Powered-By` as the site sent it, on any status (plan 62, Т18: the first guess at the
   * site's PHP). Untrusted: absent when the site sent none or the value does not pass
   * `poweredByOf`. A header the site repeats reaches both transports as one string joined with
   * ", " (Node and fetch join it so), e.g. `PleskLin, PHP/7.4.33`, and is kept whole when it
   * passes the rule: a reader looks for `PHP/` in every part, not only at the start.
   */
  poweredBy?: string
}

const poweredByLimit = 128

/**
 * A header value the platform may keep as `poweredBy`: one string of printable ASCII, at most
 * 128 characters, nothing empty; anything else is undefined. An array (the type Node gives some
 * headers) is not a string either; the transports never pass one for `X-Powered-By`.
 */
export function poweredByOf(value: string | string[] | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > poweredByLimit) return undefined
  return /^[\x20-\x7e]+$/.test(value) ? value : undefined
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

/** The longest file a `SiteRead` hands over (docs/plan/62-site-stacks.md, §2.3). */
export const siteReadBytes = 256 * 1024

/** The most entries of one folder a `SiteTree.list` hands over (question В1 of Э2). */
export const siteReadEntries = 4096

/**
 * One file from the site root, by its relative path (ASCII, `/` separators). Longer than
 * `siteReadBytes` or a failure to read — null; an expired deadline throws. `configSecrets` reads
 * as before: without the values of the secrets the import does not go on.
 *
 * In the check session of the wizard a failure of the connection throws: it is `transfer_failed`
 * with a retry, not `version_unknown` (Т26). null there means only «no such file», «too long»
 * or, by default (question В10 of Э2), «closed to this access»: no retry mends `access_denied`.
 */
export type SiteRead = (path: string) => Promise<Uint8Array | null>

/** The files of a site root as `readLayout` reads them: one file, or the entries of a folder. */
export interface SiteTree {
  read: SiteRead
  /** At most `siteReadEntries` entries; null — no such folder, or it cannot be read. */
  list(
    path: string,
  ): Promise<readonly { name: string; type: 'file' | 'directory' | 'link' }[] | null>
}

/** Other products of the same vendor a version file may name: a closed list. */
export const otherProducts = ['modx_evolution', 'bitrix24'] as const
export type OtherProduct = (typeof otherProducts)[number]

export type SiteVersionReading =
  /** Only a value that passes `siteVersionSchema`. */
  | { kind: 'read'; version: string }
  | { kind: 'other_product'; product: OtherProduct }
  | { kind: 'unknown' }

export type SiteLayoutReading =
  /** The values are checked by the adapter. */
  | { kind: 'read'; extras: Record<string, string>; adminPath: string | null }
  | {
      kind: 'refused'
      limit: Extract<
        SiteLimit,
        'outside_root' | 'renamed_folder' | 'other_engine' | 'encoding_unsupported'
      >
    }

/** What tells that the site on the hosting moved away from `main`. */
export interface SiteDriftProbe {
  /** Compared with `main` byte for byte. */
  versionFile: string
  /** The names of their folders are compared. */
  extensionRoots: readonly string[]
}

/** One public page of the site as the wizard read it: its path below the origin and its text. */
export interface PublicPage {
  /**
   * The path the wizard asked for, not where a redirect within the site led: `GET /` gives `/` after
   * a redirect to `/ru/` too. Adapters judge «the home page» and their own addresses by it.
   */
  path: string
  html: string
}

/** How a site of the stack is recognised: every adapter has it, a closed panel too. */
export interface StackRecognition {
  /** Addresses of the signs below the origin, each read once. */
  publicPaths: readonly string[]
  /**
   * `yes` only on the stack's own signs. A page of a bot check, an error 503 or a stub of the
   * hosting says nothing, and is `unknown`: a working site behind a guard is not «another site»
   * (Т26).
   */
  fingerprint(pages: readonly PublicPage[]): 'yes' | 'no' | 'unknown'
  /** The generation by the public signs; null — unknown, and that is no refusal. */
  publicGeneration(pages: readonly PublicPage[]): string | null
  /** A closed list of screens: the stack is taken only on its own `yes` (Т29). */
  needsOwnYes: boolean
  /** The names of the root tell a layout the markers do not pass (MODX without `core`). */
  rootHint(names: readonly string[]): SiteLimit | null
  /**
   * Names in the folder of the core: a copy moved without the files of the root (Р17). Read for a
   * stack with `files: 'off'` too.
   */
  coreFolder: readonly string[] | null
}

/** What the wizard asks and says. Without it the screens would know the stacks (rule 8). */
export interface StackConnection {
  /** The engines the step of the database offers. */
  databaseEngines: readonly DatabaseEngine[]
  /** «MODX Revolution» of `other_product`; the word `product` of the limit texts. */
  fullName: string
  /** The default of the field «Адрес панели управления»; null — the field is not shown. */
  adminPathDefault: string | null
  shops: readonly { folder: string; products: 'open' | 'closed' }[]
  /** OpenCart — `open`: the site is a shop whatever its folders say. */
  alwaysShop: 'open' | 'closed' | null
  /** The guard of prices stands: the words of prices in the text of a shop are true (Э9.6). */
  pricesGuarded: boolean
  /** The name of the file in the hint of the step of the database (Т28). */
  configFile: string | null
  /**
   * The lines of the summary panel and of the block «Что мы умеем» (Т27, Т32), shown as they are;
   * null — the stack is not connected. The contract wants lines that are not empty, «в течение 7
   * дней» in `copy` and «отменить это мы не сможем» in `live` (question В14 of Э2).
   */
  terms: {
    /** «В копии»: the phrase of the agreement. */
    copy: string
    /** What exactly. */
    copyDetail: string
    /** «Сразу на сайте»: the phrase of the agreement. */
    live: string
    /** What exactly. */
    liveDetail: string
    /** «Закрыто для агента», a line a paragraph; checked by the journal of Э8.16 and Т64. */
    closed: readonly string[]
  } | null
}

export interface SiteAdapter {
  readonly stack: SiteStack
  /** What the platform may do with a site of the stack (`siteSupportOf` judges it). */
  readonly support: StackSupport
  readonly recognition: StackRecognition
  readonly connection: StackConnection
  /**
   * Only the files of the release, no secret, at most two reads. Runs in the check session of the
   * wizard and over git in core. null — the stack's files are closed.
   */
  readVersion: ((read: SiteRead) => Promise<SiteVersionReading>) | null
  /** Only core: the layout and the settings of the copy. May read the configuration, gives no secret. */
  readLayout: ((tree: SiteTree) => Promise<SiteLayoutReading>) | null
  driftProbe: SiteDriftProbe | null
  /** Pure: the paths of the copies the site runs instead of this file (OCMOD). */
  derivedCopyOf: ((path: string) => readonly string[]) | null
  /**
   * How the stack is built and its traps: Markdown in English, list items, at most 6 000 characters.
   * Reads no version from the site: only `site.generation` (Т14).
   */
  stackGuide(site: SiteFacts): string
  importRules(site: SiteFacts): ImportRules
  verify(site: SiteFacts): VerifyPlan
  /** Paths an agent diff may not touch, e.g. wp-config.php or /bitrix/. */
  protectedPaths(site: SiteFacts): string[]
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
   * Where the published original of each of `paths` lives — files the secret scan of the import
   * flagged (owner's decision of 26.10.2026). A file of a plugin, a theme or the core of the
   * stack that is byte for byte its published release is public code, not a secret of the
   * client: the import takes it when the original it downloads from the answer is the same
   * bytes. `read` as for `configSecrets` (any path of the tree, at most
   * `siteImportLimits.configFileBytes`), for the files that name a version. A path without an
   * answer stays out as before. Absent — the stack publishes nothing to compare with.
   */
  publicOriginals?(
    paths: readonly string[],
    read: (path: string) => Promise<Uint8Array | null>,
  ): Promise<ReadonlyMap<string, string>>
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
  /**
   * The policy of a task's browser on the site itself (docs/plan/57-browser-tasks.md, Б21): not
   * the preview's — the agent works in the stack's own admin pages there, and uploads media. The
   * stack's users, plugins, themes, settings, tools, comments, orders, forms and deletions stay
   * closed (CLAUDE.md rule 4, spec §11), for the agent and for the client's input alike. Pure.
   */
  browserTaskPolicy(site: BrowserTaskSite): BrowserTaskPolicy
  /**
   * The object an address of the stack's editor edits (`/wp-admin/post.php?post=12&action=edit`),
   * with the address that opens it again on the same origin; null for any other address (Б22).
   */
  browserCheckpointOf(url: string): BrowserCheckpointRef | null
  /**
   * What a click on the element of this role and accessible name does in the stack's editor:
   * publishes or saves the object it edits, or neither (null). The agent's click is judged by
   * the element its observation names (Б22).
   */
  browserCommitAction(role: string, name: string): BrowserCommitAction | null
  /**
   * The trusted read of an object through the session's own sign-in (Б22): GET requests only,
   * checked with `isBrowserVerificationPlan`, and their pure reading.
   */
  browserVerification(ref: BrowserCheckpointRef): BrowserVerificationPlan
  /**
   * What the agent is told about working in the stack's admin pages through the `web` tools:
   * Markdown in English, list items, nothing of a particular site (Б20).
   */
  browserGuide(): string
}

/** What the policy of a task's browser knows of the site: its address. */
export interface BrowserTaskSite {
  url: string
}

/**
 * Where a task's browser starts and what of the site it may not open or send (Б21). `pageDenied`
 * is checked on every navigation of a page, `requestDenied` on every request it makes (a form, an
 * XHR of the editor); both answer true for anything the adapter cannot read. `by` — who holds the
 * browser: the client at the controls may do a little more than the agent (owner's decision of
 * 28.10.2026, Б37: move a post or a page to the trash); absent — the agent.
 */
export interface BrowserTaskPolicy {
  /** Below the site's origin, with one leading `/`: `/wp-admin/`. */
  startPath: string
  /** Hosts the stack's admin pages load from besides the site: `host` or `host:port`. */
  extraHosts: readonly string[]
  requestDenied(request: SiteBrowserRequest, by?: BrowserController): boolean
  pageDenied(path: string, by?: BrowserController): boolean
  /** The stack's sign-in form, which the browser fills with the site's saved sign-in (Б36). */
  signIn?: BrowserSignInForm
}

/**
 * The page and the fields of a stack's sign-in form (Б36): the browser of a task fills them
 * with the site's saved sign-in (`siteSignInEnvVars`) and sends them, never the agent. Selectors
 * are CSS of the page's own form.
 */
export interface BrowserSignInForm {
  /** The path with its query of a page that shows the form for a login and a password. */
  isSignInPage(path: string): boolean
  login: string
  password: string
  submit: string
}

/** One request of the agent's browser to its preview, as the stack's policy sees it. */
export interface SiteBrowserRequest {
  /** Path with its query, relative to the site: `/wp-admin/users.php?action=delete`. */
  path: string
  method: string
  /** The body of a form or XHR as the page sends it; null — none or not text. */
  postData: string | null
}
