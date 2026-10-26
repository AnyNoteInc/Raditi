import { randomBytes } from 'node:crypto'

import type { Prisma, PrismaClient } from '@repo/db'
import { markStaleCandidates } from '@repo/db'
import {
  assertPreviewTransition,
  DB_CREATED_ID_BASE,
  DomainError,
  egressHostListSchema,
  envVarReachesPreview,
  isDatabaseCopyError,
  isDomainError,
  isSiteConnectionError,
  previewAccessPath,
  previewDatabaseSecretPath,
  previewDatabaseSecretSchema,
  previewOrigin,
  previewRuntimeMatch,
  siteEnvVarPath,
  siteEnvVarValueOf,
  type DatabaseCopier,
  type StagingDatabaseRuntime,
  type DbAccess,
  type ObjectStorage,
  type PreviewDatabasePasswords,
  type PreviewRecipe,
  type PreviewRuntime,
  type PreviewRuntimeSpec,
  type PreviewStatus,
  type PreviewUnavailableReason,
  type PreviewUpstream,
  type PublishedContentGateway,
  type RepoRef,
  type SecretStore,
  type SiteAdapter,
  type SiteContentAdapter,
  type SiteDatabaseSettings,
  type SiteFacts,
  type SiteContentGateway,
  type SiteDbCapabilities,
  type SiteRuntime,
  type SiteStack,
} from '@repo/domain'
import { previewContentGateway, textOnlyDbRuntime, type PreviewDbRuntime } from '@repo/site-content'

import type { PreviewsConfig } from '../config/config.ts'
import type { ExportedTree, TreeExportInput } from '../git-workspace/git-workspace.service.ts'
import { TAR_END } from '../git-workspace/tree-tar.ts'
import type { DbPlanValueReader } from '../site-content/db-plan-values.ts'
import { databaseSettingsFromCatalog, type CatalogTable } from './database-settings.ts'
import {
  previewContentAccess,
  previewContentObjects,
  replayDbPlan,
  seedMismatches,
} from './preview-content.ts'
import type { PreviewFacts } from './preview-facts.ts'
import type { PreviewHold } from './preview-lease.ts'
import { previewRecordSchema, type PreviewRecord } from './preview-record.ts'
import { openPreviewSeed, storePreviewSeed, type PreviewSeedRef } from './preview-seed.ts'
import type { PreviewSiteSources } from './site-sources.ts'

// One build of a preview (docs/plan/53-chat-preview-release.md, Р15–Р18, Р22): the preview is
// brought to the revision of the dialog's candidate — or to its base, revision 0 — files and
// database both; and its end — stopped when its time is up, destroyed with its dialog. Every
// write to its row names the hold's epoch; a hold another core took over writes nothing more.

/** The git of the site repository a preview reads; the workspace service of core provides it. */
export interface PreviewGit {
  readBranchHead(input: { repo: RepoRef; branch: string }): Promise<string | null>
  exportTree<T>(input: TreeExportInput, consume: (tree: ExportedTree) => Promise<T>): Promise<T>
  missingPaths(input: { repo: RepoRef; sha: string; paths: readonly string[] }): Promise<string[]>
  changedPaths(input: {
    repo: RepoRef
    fromSha: string
    toSha: string
    limit: number
  }): Promise<{ written: string[]; deleted: string[] } | null>
}

/** What the catalog of a site's database says of its tables (database-settings.ts). */
export interface PreviewDatabaseCatalog {
  tables(access: DbAccess, signal?: AbortSignal): Promise<CatalogTable[]>
}

/** The production gateway of a site's content, as the mcp role resolves it. */
export type ProductionContent = (scope: {
  workspaceId: string
  siteId: string
  stack: SiteStack
  url: string
}) => Promise<PublishedContentGateway>

export interface PreviewBuildDeps {
  db: PrismaClient
  config: PreviewsConfig
  /** null — this core runs no preview (PREVIEW_EXECUTOR=runner until M10). */
  runtime: PreviewRuntime | null
  copier: DatabaseCopier
  /**
   * The temporary database a site's SQL dump is loaded into before its copy (owner's decision of
   * 26.10.2026); null — this core loads none (PREVIEW_EXECUTOR=runner until M10).
   */
  staging?: StagingDatabaseRuntime | null
  /** The prefix and the encoding when the configuration on the hosting does not tell them. */
  catalog: PreviewDatabaseCatalog
  /** The file source and the database of the site as the connection wizard recorded them. */
  sources: PreviewSiteSources
  git: PreviewGit | null
  storage: Pick<ObjectStorage, 'put' | 'get' | 'delete'>
  secrets: Pick<
    SecretStore,
    'kvRead' | 'kvWrite' | 'kvList' | 'kvDestroyAll' | 'transitDataKey' | 'transitDecryptDataKey'
  >
  adapters: (stack: SiteStack) => SiteAdapter
  contentAdapters: (stack: SiteStack) => SiteContentAdapter
  production: ProductionContent
  values: DbPlanValueReader
  now?: () => Date
}

/** The resources of each container of a preview (Р18). */
export const previewContainerLimits = Object.freeze({ cpu: 1, memoryMiB: 1024, pids: 256 })
/** Files a rebuild writes as a difference; more and the whole tree is written. */
export const DIFF_REBUILD_FILES = 2_000
/** The longest a write of the mcp role into the preview may still land (R7: 15 s). */
const PREVIEW_WRITE_WAIT_MS = 15_000

/** A step that cannot go on now — the site's lease is busy: the row stays as it is. */
export class PreviewLater extends Error {
  constructor(readonly reason: string) {
    super(`Preview later: ${reason}`)
    this.name = 'PreviewLater'
  }
}

/** A cause the screen says in words (Р4, Р16): the preview is `unavailable`, not failed. */
export class PreviewUnavailable extends Error {
  constructor(readonly reason: PreviewUnavailableReason) {
    super(`Preview unavailable: ${reason}`)
    this.name = 'PreviewUnavailable'
  }
}

export const previewFailure = (code: string) =>
  new DomainError('PREVIEW_BUILD_FAILED', 'The preview could not be built', 502, { code })

/** The hold of the preview went to another core: nothing more is written. */
export const previewLeaseLost = () => previewFailure('lease_lost')

/** The code a failed preview keeps (`error_code`): a word of a fixed set, never a message. */
export function previewErrorCode(error: unknown): string {
  const code = (details: unknown) =>
    typeof (details as { code?: unknown } | null)?.code === 'string'
      ? (details as { code: string }).code
      : null
  if (isSiteConnectionError(error)) return `database_${error.reason}`.slice(0, 48)
  if (isDatabaseCopyError(error)) return `copy_${error.reason}`
  if (isDomainError(error)) {
    if (error.code === 'PREVIEW_BUILD_FAILED') return code(error.details) ?? 'build_failed'
    if (error.code === 'PREVIEW_CONTENT_FAILED') return `content_${code(error.details) ?? 'failed'}`
    if (error.code.startsWith('PREVIEW_SEED_'))
      return error.code.slice('PREVIEW_'.length).toLowerCase()
    if (error.code === 'PREVIEW_DB_VALUE_INVALID') return 'plan_value_invalid'
    if (error.code === 'PREVIEW_DB_VALUE_UNAVAILABLE') return 'plan_value_unavailable'
    if (error.code === 'REPOSITORY_TOO_LARGE') return 'tree_too_large'
    if (error.code === 'REPOSITORY_UNSUPPORTED') return 'tree_unsupported'
    if (error.code === 'SANDBOX_COMMAND_FAILED') return 'runtime_failed'
    if (error.code === 'GIT_OPERATION_FAILED') return 'git_failed'
  }
  return 'build_failed'
}

/**
 * The site's facts as core knows them, with the settings of its database once read and the
 * version of the runtime its server runs (its plugin tells it): the recipe takes the closest
 * runtime the host of previews has (Р2, Р18).
 */
export const previewSiteFacts = (
  site: { stack: SiteStack; url: string },
  database: SiteDatabaseSettings | null,
  runtimeVersion?: string | null,
): SiteFacts => ({
  stack: site.stack,
  url: site.url,
  docroot: '/',
  extras: {},
  ...(database ? { database } : {}),
  ...(runtimeVersion ? { runtimeVersion } : {}),
})

/** What a gateway's plugin says the server runs; null — it cannot tell or did not answer. */
async function runtimeOf(gateway: PublishedContentGateway | null): Promise<SiteRuntime | null> {
  if (!gateway?.runtime) return null
  try {
    return await gateway.runtime()
  } catch {
    return null
  }
}

/** What a gateway's plugin can write of a database plan; null — it did not answer. */
async function dbCapabilitiesOf(
  gateway: SiteContentGateway | null,
): Promise<SiteDbCapabilities | null> {
  if (!gateway?.db) return null
  try {
    return await gateway.db.capabilities()
  } catch {
    return null
  }
}

/**
 * What the agent may change in the preview's database (docs/plan/53, «Операции БД и миграции»):
 * the text of records always, as before; any other kind only where the stack's adapter, the
 * plugin of production and the plugin of the preview all have it — a release has to write it
 * on production —, the settings of the list both plugins keep, and created records only while
 * production's ids stay below DB_CREATED_ID_BASE. The preview's plugin runs the agent's code:
 * its word only ever narrows what production's allows.
 */
export function previewDbRuntime(
  adapter: Pick<SiteAdapter, 'dbOperationKinds' | 'dbSettings'>,
  site: Parameters<SiteAdapter['dbSettings']>[0],
  production: SiteDbCapabilities | null,
  preview: SiteDbCapabilities | null,
): PreviewDbRuntime {
  if (!production || !preview) return { ...textOnlyDbRuntime }
  let declared: readonly string[]
  let settings: readonly string[]
  try {
    declared = adapter.dbOperationKinds(site)
    settings = adapter.dbSettings(site).map((setting) => setting.option)
  } catch {
    return { ...textOnlyDbRuntime }
  }
  const kinds = textOnlyDbRuntime.kinds.concat(
    (['option_update', 'post_create', 'schema_migration'] as const).filter(
      (kind) =>
        declared.includes(kind) &&
        production.operations.includes(kind) &&
        preview.operations.includes(kind),
    ),
  )
  return {
    kinds,
    settings: kinds.includes('option_update')
      ? settings.filter(
          (option) => production.settings.includes(option) && preview.settings.includes(option),
        )
      : [],
    createdIds: kinds.includes('post_create') && production.maxRecordId < DB_CREATED_ID_BASE,
  }
}

/** Where the preview answers: its origin. */
export const previewOriginOf = (config: PreviewsConfig, hostname: string): string =>
  previewOrigin(hostname, config.address)

/**
 * The settings the stack's recipe and copy are made with, read once per seed (Р15). First the
 * configuration on the hosting, as `SiteAdapter.databaseSettings(read)` reads it through the file
 * source the connection wizard recorded (plan 39); a site without one, a hosting that cannot be
 * read now, or a configuration that does not state them as constants falls back to the catalog
 * of the production database: the tables of the stack's copy policy under one prefix, and the
 * collation they share is the encoding of the copy (database-settings.ts).
 */
async function databaseSettings(
  deps: PreviewBuildDeps,
  adapter: SiteAdapter,
  site: { id: string; stack: SiteStack; url: string },
  previewId: string,
  access: () => Promise<DbAccess>,
  signal: AbortSignal,
): Promise<SiteDatabaseSettings> {
  const configured = await deps.sources.withRoot(site.id, signal, (read) =>
    adapter.databaseSettings(read),
  )
  if (configured) return configured
  let named
  try {
    // The tables a copy policy names do not depend on the prefix: any settings name them.
    named = adapter.databaseCopyPolicy(
      previewSiteFacts(site, { tablePrefix: '', charset: 'utf8mb4', collation: null }),
      { previewId },
    )
  } catch {
    throw new PreviewUnavailable('not_supported')
  }
  const settings = databaseSettingsFromCatalog(
    named,
    await deps.catalog.tables(await access(), signal),
  )
  if (!settings) throw new PreviewUnavailable('not_supported')
  return settings
}

/** The site's database access from Vault, at the version its reference names (spec §15). */
async function databaseAccess(deps: PreviewBuildDeps, siteId: string): Promise<DbAccess> {
  const found = await deps.sources.databaseAccess(siteId)
  if (!found.ok) throw previewFailure(found.code)
  return found.access
}

/** The client's variables the preview gets (Р13, `envVarReachesPreview`) and their hosts. */
async function previewVariables(
  deps: PreviewBuildDeps,
  siteId: string,
  dataClass: 'synthetic' | 'client',
): Promise<{ env: Record<string, string>; hosts: string[] }> {
  const rows = await deps.db.siteEnvVar.findMany({
    where: { siteId },
    select: {
      name: true,
      hosts: true,
      toAgent: true,
      toPreview: true,
      agentConsentAt: true,
      keyVersion: true,
    },
    orderBy: { name: 'asc' },
  })
  const env: Record<string, string> = {}
  const hosts = new Set<string>()
  for (const row of rows) {
    if (!envVarReachesPreview(row, dataClass)) continue
    const stored = await deps.secrets.kvRead(siteEnvVarPath(siteId, row.name))
    // Written in Vault first, the row second: until both agree the variable waits.
    if (!stored || stored.version !== row.keyVersion) continue
    const value = siteEnvVarValueOf(stored.data)
    if (value === null) continue
    env[row.name] = value
    const listed = egressHostListSchema.safeParse(row.hosts)
    if (listed.success) for (const host of listed.data) hosts.add(host)
  }
  return { env, hosts: [...hosts].sort() }
}

/** The web image of the first runtime version the recipe takes that this host has (Р18). */
function webImage(config: PreviewsConfig, recipe: PreviewRecipe): string {
  for (const version of recipe.runtimeVersions) {
    const image = config.webImages[version]
    if (image) return image
  }
  if (Object.keys(config.webImages).length === 0) throw previewFailure('not_configured')
  throw new PreviewUnavailable('not_supported')
}

type RowUpdate = Prisma.PreviewEnvironmentUncheckedUpdateManyInput
type Db = PrismaClient | Prisma.TransactionClient

/** A fenced change of the row: throws when the hold was lost or the status moved meanwhile. */
export async function updatePreview(
  db: Db,
  hold: PreviewHold,
  from: readonly PreviewStatus[],
  data: RowUpdate,
): Promise<void> {
  hold.assert()
  const { count } = await db.previewEnvironment.updateMany({
    where: { id: hold.fence.previewId, leaseEpoch: hold.fence.epoch, status: { in: [...from] } },
    data,
  })
  if (count !== 1) throw previewLeaseLost()
}

/** A status change of the hold, checked against the life of a preview. */
export async function movePreview(
  db: Db,
  hold: PreviewHold,
  from: PreviewStatus,
  to: PreviewStatus,
  data: RowUpdate = {},
): Promise<void> {
  assertPreviewTransition(from, to)
  await updatePreview(db, hold, [from], { ...data, status: to })
}

export const previewRecordJson = (record: PreviewRecord): Prisma.InputJsonValue =>
  previewRecordSchema.parse(record) as unknown as Prisma.InputJsonValue

/**
 * A seed is not taken while a release holds the site, or an operator does (Р15): the lease of a
 * deploy or a revert, the barrier of a release in work. Read under a share lock of the lease row,
 * in the order of locks of the mcp role (site_leases, then preview_environments).
 */
async function siteIsFree(tx: Prisma.TransactionClient, siteId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<
    Array<{ busy: boolean | null; held_for_operator: boolean; inflight_release_id: string | null }>
  >`
    SELECT (operation IN ('deploy', 'revert') AND expires_at > now()) AS busy,
      held_for_operator, inflight_release_id
    FROM site_leases WHERE site_id = ${siteId}::uuid FOR SHARE`
  const lease = rows[0]
  return !(lease && (lease.busy === true || lease.held_for_operator || lease.inflight_release_id))
}

/**
 * The copy that began at `since` (the database's clock) is a state of production no release
 * touched (Р15): the site is free now, the release it holds is the one the seed names, and no
 * release wrote its database meanwhile — a step `db` or `rollback` reported, or a lease of a
 * deploy or a revert taken — even one that ended, or rolled back, before the copy did.
 */
async function copyStillTrue(
  tx: Prisma.TransactionClient,
  input: { siteId: string; releaseId: string | null; since: Date },
): Promise<boolean> {
  if (!(await siteIsFree(tx, input.siteId))) return false
  const [row] = await tx.$queryRaw<Array<{ installed: string | null; touched: boolean }>>`
    SELECT s.installed_release_id AS installed,
      (EXISTS (SELECT 1 FROM release_steps rs JOIN site_releases r ON r.id = rs.release_id
          WHERE r.site_id = s.id AND rs.step IN ('db', 'rollback')
            AND rs.created_at >= ${input.since})
        OR EXISTS (SELECT 1 FROM site_leases l WHERE l.site_id = s.id
          AND l.operation IN ('deploy', 'revert') AND l.acquired_at >= ${input.since})) AS touched
    FROM sites s WHERE s.id = ${input.siteId}::uuid`
  return row !== undefined && row.installed === input.releaseId && !row.touched
}

/**
 * The start of a build: a new seed is allowed now (when one is due), and the row leaves what it
 * was for `building` — its upstream cleared, since the port may become another preview's once
 * the containers are touched, its write fence raised (R7: the copy is about to be replaced) and
 * its time to live counted from now.
 */
async function startBuild(
  deps: PreviewBuildDeps,
  hold: PreviewHold,
  facts: PreviewFacts,
  freshSeed: boolean,
): Promise<{ writeEpoch: number; expiresAt: Date; startedAt: Date }> {
  const now = (deps.now ?? (() => new Date()))()
  const { preview } = facts
  const expiresAt = new Date(
    Math.max(preview.expiresAt.getTime(), now.getTime() + deps.config.ttlHours * 3_600_000),
  )
  return deps.db.$transaction(
    async (tx) => {
      if (freshSeed && !(await siteIsFree(tx, facts.site.id))) throw new PreviewLater('site_busy')
      const data: RowUpdate = {
        upstreamHost: null,
        upstreamPort: null,
        errorCode: null,
        unavailableReason: null,
        dbMode: 'copy',
        writeEpoch: { increment: 1 },
        expiresAt,
      }
      if (preview.status === 'building') await updatePreview(tx, hold, ['building'], data)
      else
        await movePreview(tx, hold, preview.status, 'building', {
          ...data,
          attempt: { increment: 1 },
        })
      const [row] = await tx.$queryRaw<Array<{ write_epoch: number; started_at: Date }>>`
        SELECT write_epoch, now() AS started_at FROM preview_environments
        WHERE id = ${preview.id}::uuid`
      if (!row) throw previewLeaseLost()
      return { writeEpoch: row.write_epoch, expiresAt, startedAt: row.started_at }
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/**
 * Waits until every write of the mcp role into the preview that may still land has passed its
 * deadline (R7): the copy is replaced only once nothing of the old fence can reach it.
 */
async function awaitPreviewWrites(
  db: PrismaClient,
  previewId: string,
  signal: AbortSignal,
): Promise<void> {
  const [row] = await db.$queryRaw<Array<{ wait_ms: number | null }>>`
    SELECT (EXTRACT(EPOCH FROM max(write_deadline_at) - clock_timestamp()) * 1000)::float8
      AS wait_ms
    FROM mcp_calls
    WHERE preview_id = ${previewId}::uuid AND result IS NULL AND write_started_at IS NOT NULL`
  const wait = Math.min(Math.max(0, Math.ceil(row?.wait_ms ?? 0)), PREVIEW_WRITE_WAIT_MS)
  if (wait > 0) await delay(wait, signal)
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason as Error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface BuiltPreview {
  upstream: PreviewUpstream
  revision: number
  recipe: PreviewRecipe
}

/**
 * Brings the preview to the candidate of its dialog (or to its base) and leaves it `ready`.
 * Throws PreviewLater before it touched the row when the site's lease keeps a new seed from being
 * taken now; every other failure leaves the row `building` for `failBuild`.
 */
export async function buildPreview(
  deps: PreviewBuildDeps,
  hold: PreviewHold,
  facts: PreviewFacts,
): Promise<BuiltPreview> {
  const staging = dumpStaging(deps, facts, hold.signal)
  try {
    return await buildPreviewOn(deps, hold, facts, staging)
  } finally {
    await staging.release()
  }
}

/**
 * The database a site's dump is loaded into, made at the first call of `access` and removed by
 * `release` — after the seed, and whatever the build ends with (owner's decision of 26.10.2026).
 * The dump streams from the site's file source into the temporary database: no raw copy of it
 * lands on a disk of core.
 */
export function dumpStaging(deps: PreviewBuildDeps, facts: PreviewFacts, signal: AbortSignal) {
  const path = facts.databaseDump
  const stagingId = facts.preview.id
  let staged: Promise<DbAccess> | null = null
  return {
    fromDump: path !== null,
    access(): Promise<DbAccess> {
      if (path === null) return databaseAccess(deps, facts.site.id)
      staged ??= (async () => {
        const image = deps.config.images.db
        if (!deps.staging || !image) throw previewFailure('not_configured')
        const runtime = deps.staging
        const read = await deps.sources.withDump(facts.site.id, path, signal, (dump) =>
          runtime.load({ stagingId, image, dump, signal }),
        )
        if (!read.ok) throw previewFailure(read.code)
        return read.value.access
      })()
      return staged
    },
    async release(): Promise<void> {
      if (staged === null) return
      staged = null
      await deps.staging?.remove(stagingId).catch(() => {})
    },
  }
}

async function buildPreviewOn(
  deps: PreviewBuildDeps,
  hold: PreviewHold,
  facts: PreviewFacts,
  staging: ReturnType<typeof dumpStaging>,
): Promise<BuiltPreview> {
  const { preview, site, task, candidate } = facts
  const freshSeed = !preview.seed || preview.seed.releaseId !== site.installedReleaseId
  const { writeEpoch, expiresAt, startedAt } = await startBuild(deps, hold, facts, freshSeed)
  const signal = hold.signal
  const runtime = deps.runtime
  const git = deps.git
  if (!facts.hasDatabase) throw new PreviewUnavailable('no_database')
  if (!runtime || !git) throw previewFailure('not_configured')
  if (!facts.repo) throw previewFailure('no_repository')
  // A plan that does not read back is never replayed as an empty one: the preview would claim a
  // revision whose database changes it does not hold.
  if (candidate?.invalid) throw previewFailure('plan_invalid')
  const repo: RepoRef = {
    provider: facts.repo.provider,
    owner: facts.repo.owner,
    name: facts.repo.name,
  }

  // Revision 0 is the dialog's base: the head of `main` now.
  const revision = candidate?.revision ?? 0
  const headSha =
    candidate?.headSha ?? (await git.readBranchHead({ repo, branch: facts.repo.defaultBranch }))
  if (!headSha) throw previewFailure('no_base')

  const adapter = deps.adapters(site.stack)
  let access: DbAccess | null = null
  // The site's database, or the temporary one its dump was loaded into.
  const accessOf = async () => (access ??= await staging.access())
  const database =
    (!freshSeed && preview.record.database) ||
    (await databaseSettings(deps, adapter, site, preview.id, accessOf, signal))
  // Production, through its plugin: what its server runs, and the state of its objects for the
  // seed. One that cannot be asked now leaves the defaults and asks again at the next build.
  let production: PublishedContentGateway | null = null
  try {
    production = await deps.production({
      workspaceId: task.workspaceId,
      siteId: site.id,
      stack: site.stack,
      url: site.url,
    })
  } catch {
    // Nothing of the copy is known equal, nothing is editable, the runtime is the default.
  }
  const siteRuntime = await runtimeOf(production)
  const productionDb = await dbCapabilitiesOf(production)
  const siteFacts = previewSiteFacts(site, database, siteRuntime?.runtimeVersion)
  let recipe: PreviewRecipe
  try {
    recipe = adapter.previewRecipe(siteFacts)
  } catch {
    throw new PreviewUnavailable('not_supported')
  }
  const missing = await git.missingPaths({ repo, sha: headSha, paths: recipe.requiredPaths })
  if (missing.length) throw new PreviewUnavailable('no_core')
  const web = webImage(deps.config, recipe)
  const images = deps.config.images
  if (!images.cli || !images.forwarder || (recipe.database !== null && !images.db))
    throw previewFailure('not_configured')

  // The seed: a copy of the site's database, filtered at the source (Р15). The objects that
  // differ from production are written with the outcome of the build.
  const seedRef: PreviewSeedRef = {
    workspaceId: task.workspaceId,
    siteId: site.id,
    previewId: preview.id,
    releaseId: freshSeed ? site.installedReleaseId : (preview.seed?.releaseId ?? null),
  }
  let seed = preview.seed
  let record: PreviewRecord = { ...preview.record, database, web, sync: null }
  if (freshSeed) {
    const stored = await storePreviewSeed(
      deps,
      seedRef,
      {
        access: await accessOf(),
        tablePrefix: database.tablePrefix,
        charset: database.charset,
        collation: database.collation,
        policy: adapter.databaseCopyPolicy(siteFacts, { previewId: preview.id }),
      },
      signal,
    )
    seed = { key: stored.key, sha256: stored.sha256, releaseId: seedRef.releaseId }
    record = { ...record, seedChecked: false }
    // Kept at once — a build that fails later loads it again instead of copying the site again —
    // with the objects of the old seed forgotten: the rows of this one are written with `ready`,
    // and the mcp role writes into nothing else (R7). A release that took the site during the
    // copy makes it a mix of two states: it is thrown away — the object replaced the old seed's,
    // so the row forgets that one too — and the build waits for the site.
    const kept = await deps.db.$transaction(
      async (tx) => {
        const fresh = await copyStillTrue(tx, {
          siteId: site.id,
          releaseId: seedRef.releaseId,
          since: startedAt,
        })
        await updatePreview(tx, hold, ['building'], {
          seedObjectKey: fresh ? stored.key : null,
          seedSha256: fresh ? stored.sha256 : null,
          seedReleaseId: fresh ? seedRef.releaseId : null,
          runtime: previewRecordJson(record),
        })
        await tx.previewSeedMismatch.deleteMany({ where: { previewId: preview.id } })
        return fresh
      },
      { isolationLevel: 'ReadCommitted' },
    )
    if (!kept) {
      await deps.storage.delete('artifacts', stored.key)
      throw new PreviewLater('site_busy')
    }
  }
  // The copy is taken: the temporary database of a dump is not kept for the rest of the build.
  await staging.release()
  if (!seed) throw previewFailure('seed_missing')

  // The containers (Р18) with the variables of the client that reach a preview (Р13).
  const variables = await previewVariables(deps, site.id, task.dataClass)
  const egress = variables.hosts.length > 0 && images.egress !== null
  const origin = previewOriginOf(deps.config, preview.hostname)
  const spec: PreviewRuntimeSpec = {
    previewId: preview.id,
    siteId: site.id,
    taskId: preview.taskId,
    runtime: deps.config.runtime,
    images: {
      web,
      db: recipe.database === null ? null : images.db,
      cli: images.cli,
      forwarder: images.forwarder,
      egress: egress ? images.egress : null,
    },
    recipe,
    limits: previewContainerLimits,
    egress: egress ? variables.hosts : [],
    upstreamHost: deps.config.upstreamHost,
    hostname: preview.hostname,
    origin,
    productionOrigin: new URL(site.url).origin,
    expiresAt: expiresAt.getTime(),
  }
  // What the docroot holds is known only while the preview's containers — and so its volume —
  // were kept: a stopped or served preview whose browser wrote nothing since its build.
  let kept =
    (preview.status === 'ready' || preview.status === 'expired') &&
    !preview.dirty &&
    (await runtime.inspect(preview.id)) !== null
  // The passwords of its database live in Vault, not in Docker (owner's answer of 19.10.2026).
  const passwords =
    recipe.database === null ? null : await previewDatabasePasswords(deps, preview.id)
  const secrets = { env: variables.env, database: passwords }
  let upstream: PreviewUpstream
  try {
    upstream = await runtime.ensure(spec, secrets, signal)
  } catch (error) {
    // What is left of it cannot be taken over (a database volume without its container or made
    // with other passwords, a docroot of another user, R5a): it is destroyed and built anew from
    // the seed, with the passwords Vault holds.
    if (!isDomainError(error) || error.code !== 'CONFLICT') throw error
    await runtime.destroy(preview.id)
    kept = false
    upstream = await runtime.ensure(spec, secrets, signal)
  }
  const target = { upstream, hostname: preview.hostname }

  // The files: the whole tree, or what differs from the commit the docroot holds (Р22).
  const synced = preview.record.sync
  await writePreviewTree(runtime, git, {
    repo,
    previewId: preview.id,
    from: !kept || synced?.paths === null ? null : (synced?.baseSha ?? preview.filesSha),
    synced: synced?.paths ?? [],
    to: headSha,
    recipe,
    signal,
  })

  // The database: the seed, then the candidate's plan (Р22), once no write of the old fence
  // can land any more (R7).
  if (recipe.database !== null) {
    await awaitPreviewWrites(deps.db, preview.id, signal)
    await runtime.loadDatabase(
      preview.id,
      await openPreviewSeed(deps, seedRef, { key: seed.key, sha256: seed.sha256 }),
      passwords!,
      signal,
    )
  }
  let mismatches: string[] | null = null
  if (recipe.content) {
    const contentAdapter = deps.contentAdapters(site.stack)
    const contentAccess = await previewContentAccess(
      { runtime, previewId: preview.id, recipe: recipe.content, adapter: contentAdapter, origin },
      signal,
    )
    await storePreviewAccess(
      deps,
      previewAccessPath(preview.id, contentAdapter.accessKind),
      contentAccess,
    )
    const gateway = previewContentGateway({
      adapter: contentAdapter,
      previewId: preview.id,
      origin,
      access: contentAccess,
      target,
    })
    // What the preview's own server runs, told against the site's in «Проверки». The preview
    // runs the agent's code, so this is a hint to the client, never a check of anything.
    record = { ...record, runtimeMatch: previewRuntimeMatch(siteRuntime, await runtimeOf(gateway)) }
    const db = previewDbRuntime(adapter, siteFacts, productionDb, await dbCapabilitiesOf(gateway))
    record = { ...record, db }
    if (freshSeed || !record.seedChecked) {
      // The settings of the list are compared with the records: a setting the seed holds other
      // than production is not one a release could change from there.
      const objects = [
        ...(await previewContentObjects(
          { runtime, previewId: preview.id, recipe: recipe.content },
          signal,
        )),
        ...db.settings.map((option) => `option:${option}`),
      ]
      mismatches = production
        ? await seedMismatches({ production, preview: gateway, objects }, signal)
        : objects
      record = { ...record, seedChecked: production !== null }
    }
    if (candidate?.dbPlan.length)
      await replayDbPlan(
        {
          gateway,
          plan: candidate.dbPlan,
          values: deps.values,
          owner: { workspaceId: task.workspaceId, taskId: preview.taskId },
          previewId: preview.id,
          // The fence of the mcp role's writes is the row's own write epoch (R7).
          epoch: writeEpoch,
        },
        signal,
      )
  } else if (candidate?.dbPlan.length) throw previewFailure('content_unsupported')

  hold.assert()
  await deps.db.$transaction(
    async (tx) => {
      await movePreview(tx, hold, 'building', 'ready', {
        upstreamHost: upstream.host,
        upstreamPort: upstream.port,
        revision,
        candidateId: candidate?.id ?? null,
        filesSha: headSha,
        dirty: false,
        runtime: previewRecordJson(record),
      })
      if (mismatches !== null) {
        await tx.previewSeedMismatch.deleteMany({ where: { previewId: preview.id } })
        if (mismatches.length)
          await tx.previewSeedMismatch.createMany({
            data: mismatches.map((objectRef) => ({ previewId: preview.id, objectRef })),
            skipDuplicates: true,
          })
      }
      // A seed older than the release the site holds makes the dialog's candidate stale (Р15).
      await markStaleCandidates(tx, { siteId: site.id })
    },
    { isolationLevel: 'ReadCommitted' },
  )
  return { upstream, revision, recipe }
}

/** Ends a build that threw: `unavailable` with its cause, or `failed` with its code. */
export async function failBuild(
  db: PrismaClient,
  hold: PreviewHold,
  error: unknown,
): Promise<void> {
  if (error instanceof PreviewUnavailable)
    await movePreview(db, hold, 'building', 'unavailable', {
      unavailableReason: error.reason,
      ...(error.reason === 'no_database' ? { dbMode: 'none' as const } : {}),
      upstreamHost: null,
      upstreamPort: null,
    })
  else
    await movePreview(db, hold, 'building', 'failed', {
      errorCode: previewErrorCode(error),
      upstreamHost: null,
      upstreamPort: null,
      // A seed that is gone or does not verify is never loaded again: the next build copies.
      ...(isSeedLost(error) ? { seedObjectKey: null, seedSha256: null, seedReleaseId: null } : {}),
    })
}

const isSeedLost = (error: unknown) =>
  isDomainError(error) && ['PREVIEW_SEED_MISSING', 'PREVIEW_SEED_INVALID'].includes(error.code)

/**
 * The passwords of the preview's database, `kv/previews/<previewId>/db`: made once — the first
 * build with a database — and the same for every build after it, since the users of the database
 * live in its volume; removed with the preview (`forgetPreviewSecrets`). The mcp role never reads
 * them. A secret that does not parse is replaced: the runtime then finds a database made with
 * other passwords and the build starts it over (CONFLICT).
 */
export async function previewDatabasePasswords(
  deps: Pick<PreviewBuildDeps, 'secrets'>,
  previewId: string,
): Promise<PreviewDatabasePasswords> {
  const path = previewDatabaseSecretPath(previewId)
  const current = await deps.secrets.kvRead(path)
  const stored = previewDatabaseSecretSchema.safeParse(current?.data)
  if (stored.success) return { user: stored.data.user, root: stored.data.root }
  const made = {
    user: randomBytes(24).toString('base64url'),
    root: randomBytes(24).toString('base64url'),
  }
  await deps.secrets.kvWrite(path, { v: '1', ...made }, { cas: current?.version ?? 0 })
  return made
}

/** The platform's account of the preview for the mcp role: `kv/previews/<previewId>/<kind>`. */
async function storePreviewAccess(
  deps: PreviewBuildDeps,
  path: string,
  access: Record<string, string>,
): Promise<void> {
  const current = await deps.secrets.kvRead(path)
  await deps.secrets.kvWrite(path, access, { cas: current?.version ?? 0 })
}

/**
 * The tree of `to` into the docroot: as a difference from `from` when the docroot holds that
 * commit — with the paths a sync of a turn wrote over it — and the difference is small; whole
 * otherwise. The platform's files of the recipe go over it each time (`PreviewFilesInput.platform`)
 * and never come from the repository, whatever copy of them it holds. A difference the docroot
 * refuses — a path that turned from a folder into a file — is written again as the whole tree.
 */
export async function writePreviewTree(
  runtime: Pick<PreviewRuntime, 'writeFiles'>,
  git: PreviewGit,
  input: {
    repo: RepoRef
    previewId: string
    /** The commit the docroot holds; null — unknown, the whole tree is written. */
    from: string | null
    /** Paths written over `from` since it was written (syncs of a turn). */
    synced: readonly string[]
    to: string
    recipe: Pick<PreviewRecipe, 'generatedFiles'>
    signal: AbortSignal
  },
): Promise<void> {
  const platform = input.recipe.generatedFiles
  const platformPaths = new Set(platform.map((file) => file.path))
  const own = (path: string) => !platformPaths.has(path)
  let difference: { written: string[]; deleted: string[] } | null = null
  if (input.from !== null) {
    const changed =
      input.from === input.to
        ? { written: [], deleted: [] }
        : await git.changedPaths({
            repo: input.repo,
            fromSha: input.from,
            toSha: input.to,
            limit: DIFF_REBUILD_FILES,
          })
    if (changed && changed.written.length + input.synced.length <= DIFF_REBUILD_FILES) {
      // A synced path comes back as `to` has it, or goes when `to` has none.
      const absent = new Set(
        input.synced.length
          ? await git.missingPaths({ repo: input.repo, sha: input.to, paths: input.synced })
          : [],
      )
      const written = new Set(changed.written)
      const deleted = new Set(changed.deleted)
      for (const path of input.synced)
        if (absent.has(path)) deleted.add(path)
        else written.add(path)
      for (const path of written) deleted.delete(path)
      difference = {
        written: [...written].filter(own).sort(),
        deleted: [...deleted].filter(own).sort(),
      }
    }
  }
  const whole = () =>
    git.exportTree({ repo: input.repo, sha: input.to, exclude: [...platformPaths] }, async (tree) =>
      runtime.writeFiles(
        input.previewId,
        { archive: tree.archive, deletes: [], replace: true, platform },
        input.signal,
      ),
    )
  if (difference === null) return whole()
  const { written, deleted } = difference
  try {
    // Nothing of the tree changed: no export at all, the platform's files still go over it.
    if (!written.length)
      await runtime.writeFiles(
        input.previewId,
        { archive: emptyArchive(), deletes: deleted, replace: false, platform },
        input.signal,
      )
    else
      await git.exportTree({ repo: input.repo, sha: input.to, paths: written }, async (tree) =>
        runtime.writeFiles(
          input.previewId,
          { archive: tree.archive, deletes: deleted, replace: false, platform },
          input.signal,
        ),
      )
  } catch (error) {
    if (input.signal.aborted || !isRefusedDifference(error)) throw error
    await whole()
  }
}

/** The docroot refused the input of a difference (infra/preview/files.mjs, exit 3). */
const isRefusedDifference = (error: unknown) => isDomainError(error) && error.code === 'BAD_REQUEST'

async function* emptyArchive(): AsyncIterable<Uint8Array> {
  yield TAR_END
}

/** The secrets of the preview in Vault (`kv/previews/<previewId>/*`): all versions removed. */
async function forgetPreviewSecrets(deps: PreviewBuildDeps, previewId: string): Promise<void> {
  const prefix = `kv/previews/${previewId}/`
  for (const name of await deps.secrets.kvList(prefix))
    if (/^[a-z]{2,16}$/.test(name)) await deps.secrets.kvDestroyAll(`${prefix}${name}`)
}

/**
 * The end of a preview with its dialog (Р22: revision 0 of a closed task): its containers,
 * networks and volumes, its secrets and its seed go; every session of the gateway ends (the
 * access epoch), its browser requests are closed, and a sync request is answered no more.
 */
export async function destroyPreview(
  deps: PreviewBuildDeps,
  hold: PreviewHold,
  facts: PreviewFacts,
): Promise<void> {
  const { preview } = facts
  if (deps.runtime) await deps.runtime.destroy(preview.id)
  await forgetPreviewSecrets(deps, preview.id)
  if (preview.seed) await deps.storage.delete('artifacts', preview.seed.key)
  hold.assert()
  const now = new Date()
  await deps.db.$transaction(
    async (tx) => {
      await movePreview(tx, hold, preview.status, 'destroyed', {
        upstreamHost: null,
        upstreamPort: null,
        unavailableReason: null,
        errorCode: null,
        accessEpoch: { increment: 1 },
        writeEpoch: { increment: 1 },
        seedObjectKey: null,
        seedSha256: null,
        dirty: false,
        runtime: previewRecordJson({ ...preview.record, sync: null }),
      })
      await tx.previewBrowserRequest.updateMany({
        where: { previewId: preview.id, stoppedAt: null },
        data: { stoppedAt: now },
      })
      await tx.previewSyncRequest.updateMany({
        where: { previewId: preview.id, completedAt: null },
        data: { completedAt: now, errorCode: 'preview_destroyed' },
      })
    },
    { isolationLevel: 'ReadCommitted' },
  )
}

/**
 * A preview whose time to live is over while its dialog waits (Р22): its containers stop and its
 * volumes stay; opened again, it is built from its seed and its candidate.
 */
export async function expirePreview(
  deps: PreviewBuildDeps,
  hold: PreviewHold,
  facts: PreviewFacts,
): Promise<void> {
  const { preview } = facts
  if (deps.runtime) await deps.runtime.stop(preview.id)
  hold.assert()
  await deps.db.$transaction(
    async (tx) => {
      await movePreview(tx, hold, preview.status, 'expired', {
        upstreamHost: null,
        upstreamPort: null,
        unavailableReason: null,
        errorCode: null,
      })
      await tx.previewBrowserRequest.updateMany({
        where: { previewId: preview.id, stoppedAt: null },
        data: { stoppedAt: new Date() },
      })
    },
    { isolationLevel: 'ReadCommitted' },
  )
}
