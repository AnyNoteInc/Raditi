import { createHash } from 'node:crypto'

import {
  createdRecordPage,
  dbPlanLimits,
  dbStateHashMaterial,
  hostingPathOf,
  isAbsentState,
  isDomainError,
  isHostingGuardError,
  isOptionState,
  isRecordState,
  isSiteConnectionError,
  optionNameOf,
  publicationLimits,
  recordTypeOf,
  releaseApiLimits,
  temporaryNameOf,
  type DbObjectState,
  type DbOptionState,
  type DeployDbOperation,
  type DbWriteChange,
  type DeployAccess,
  type DeployManifest,
  type DeployStepCode,
  type DeployValue,
  type DeployWrap,
  type HostingPath,
  type HostingSession,
  type PublishedContentState,
  type ReleasePresigned,
  type ReleaseStep,
  type ReleaseStepDetail,
  type ReleaseStepState,
  SITE_CODE_REFRESH_PATHS,
  type SiteCodeCacheGateway,
  type SiteContentGateway,
  type SiteDbGateway,
} from '@repo/domain'

import { openBackup, sealBackup } from './backup.ts'
import {
  absentHashOf,
  contentCallId,
  createdHashOf,
  fieldsOf,
  migratedHashOf,
  openOperationValue,
  optionHashOf,
  stateHashWith,
  tableHashOf,
  writeDbExact,
  writeExact,
  type WriteIdentity,
} from './content.ts'
import { ReleaseApiError, type ReleaseApi } from './release-api.ts'
import type { SiteCheckResult } from './site-check.ts'
import type { TreeSource } from './tree-source.ts'

// The deploy of one release attempt (docs/plan/53-chat-preview-release.md, Р29–Р31), with every
// way out of the world injected: the release API of core, the hosting, the site's plugin, the
// files of the approved commit, the check of the site. In order:
//
//   conflicts — the site passes its check as it is (a site that fails it already would fail after
//               the release too, and its rollback could prove nothing); the code cache of the
//               site's PHP lets a check see what a write changed (codeCachePlan); the hosting
//               holds the installed version of every path the release changes, none of the paths
//               it adds, and every record holds its base state; the approved files and the
//               values are read and checked against the manifest. Nothing is written.
//   backup    — exactly the overwritten and deleted files, the prior states of the records and
//               the folders the release will make, sealed with the attempt's key, uploaded and
//               confirmed by core.
//   files     — the deletions that free a name first (a file that becomes a folder, the files of a
//               folder that becomes a file), then each file under a temporary name renamed into
//               place, then the other deletions; a replaced or deleted file is read again right
//               before, and an edit made since the conflicts step stops the release (`conflict`).
//               Then the code it wrote is dropped from the site's code cache, where it can be.
//   db        — each object of the plan in the plan's one order (the structure, the settings,
//               the new records, the texts), byte for byte, its receipt checked against
//               `afterHash` — a new record's against the reference production gave it.
//   verify    — the pages of the plan answer and show no failure marker.
//   rollback  — after any failure behind a write, on a fresh connection to the hosting (the one
//               that broke is never trusted again): the files back in reverse order, the folders
//               the release made, then the records (the plugin answers only once the code of the
//               site works again), each only where production still holds what this release
//               wrote, and only what the attempt got to (an edit of a file it never reached is
//               not its business): a setting goes back, a new record goes to the trash only
//               while it holds what the release wrote — one changed since is left, and said —,
//               a table keeps its new structure; then `reverify`.
//
// An undo of a release (`manifest.kind === 'undo'`, docs/plan/53, «Отмена выпуска») goes the same
// way with what production held before that release: its writes are the plugin's mode `restore`
// (the exact bytes the site held), a record the release created goes to the trash (and back on a
// rollback); and a site that fails its check before the write does not stop it — the version it
// undoes may be what broke the site. If the site fails it after the write as well, nothing is put
// back (going back to a version that fails the same check mends nothing): the end is `unknown`.
//
// Every state read from the plugin is believed only once its hash is worked out again from its
// fields: what the backup keeps, and what a rollback restores in `restore`, is what the site held.
//
// A failure after the first write is reported as the failure of its step, never as `unknown`:
// the rollback reads what production holds and decides — what it cannot prove (a record without
// a receipt, a file changed by someone else meanwhile) ends the rollback `unknown`, and the
// operator decides. A rollback compares every path and record with what the release wrote
// before it restores it, so the same code serves an attempt «только возврат» (Р31) that has
// only the backup. Each step reports `started` and its end to core; a report is keyed by
// attempt, step and state, so a repeat is the same report — and a long step repeats its
// `started` every minute, so core hears the job is alive (the heartbeat). The end of the deploy
// is offered to core until it answers: a job that ends without core knowing would be taken for
// a silent one and rolled back by an attempt «только возврат».

export type DeployOutcome =
  /** The site runs the release. */
  | 'installed'
  /** Something failed after a write and everything was put back. */
  | 'rolled_back'
  /** It ended before the first write: the site is as it was. */
  | 'failed'
  /** Production may hold a part of the release: the operator decides. */
  | 'unknown'

export interface DeployResult {
  outcome: DeployOutcome
  /** core took the last report of the job; false — it never answered, or it refused it. */
  told: boolean
}

export const deployLimits = Object.freeze({
  /** The writing part of a deploy: past it the job stops and rolls back what it wrote. */
  forwardMs: 60 * 60_000,
  /** A rollback, on its own connections: past it what is left is `unknown`. */
  rollbackMs: 20 * 60_000,
  /** Silence after which a step repeats its `started`: core keeps the token for 30 min. */
  heartbeatMs: 60_000,
  /** How long the last report is offered to core: under the life of the attempt's token. */
  endReportMs: 25 * 60_000,
  endReportPauseMs: 30_000,
  /** Requests in flight to the hosting and to Gitea. */
  parallel: 4,
  /** Pauses between the tries of a connection of the rollback; their count is the retries. */
  reconnectPausesMs: [2_000, 5_000, 10_000, 20_000, 30_000],
  /** Connections a rollback may open after the first one broke. */
  reconnects: 5,
  /**
   * The check of the site after a write waits this long, checks, waits as long again and checks
   * once more: a hosting may serve the code it had for a moment after the write (PHP's opcache
   * looks at a file's time every 2 s by default). Measured by the release stand (R12): the
   * check right after the write passed on the old footer, and the site broke 2 s later. The
   * pause is the floor: a cache that looks at file times every N s makes it N s plus
   * `codeCacheMarginMs` (codeCachePlan), unless the plugin dropped the written files from it.
   */
  verifySettleMs: 5_000,
  codeCacheMarginMs: 3_000,
  /** A cache that looks at file times more rarely than this leaves no check to trust. */
  verifySettleMaxMs: 120_000,
})

/**
 * The check of the site once what was written is what it serves: twice, each after `settleMs`;
 * the first failure is the answer.
 */
async function settledCheck(
  ctx: DeployContext,
  verify: DeployManifest['verify'],
  settleMs: number,
) {
  await ctx.sleep(settleMs)
  const first = await ctx.checkSite(verify)
  if (!first.ok) return first
  await ctx.sleep(settleMs)
  return ctx.checkSite(verify)
}

/**
 * What the check after the writes asks for: the pages of the manifest, and the page of every
 * published record this attempt created (`verify.recordPages`; docs/plan/53, «Операции БД и
 * миграции», critique S9) — a new page that does not answer is a release that broke something,
 * and it is rolled back with the rest. A draft is served to nobody and is not asked for.
 */
export function verifyAfterWrites(
  verify: DeployManifest['verify'],
  created: ReadonlyMap<string, { productionRef: string; record: { status: string } | null }>,
): DeployManifest['verify'] {
  const pages = [...verify.pages]
  for (const { productionRef, record } of created.values()) {
    if (record?.status !== 'publish') continue
    const page = createdRecordPage(verify.recordPages ?? {}, productionRef)
    if (page !== null && !pages.includes(page)) pages.push(page)
  }
  return { ...verify, pages }
}

/** Files a code cache of PHP may hold compiled: what a write must drop from it. */
const CODE_PATH = /\.(?:php\d?|phtml|inc)$/i

/**
 * What the code cache of the site's PHP means for the checks of a release (stand R12), read
 * through the site's plugin before anything is written.
 */
export interface CodeCachePlan {
  /** The pause before each check after a write the cache was not told of. */
  settleMs: number
  /** Drops written files from the cache; null — the plugin cannot, or the site has no cache. */
  refresh: SiteCodeCacheGateway | null
  /** A write the cache was not told of is seen by a check after `settleMs`. */
  timesTrusted: boolean
}

const defaultPlan = (): CodeCachePlan => ({
  settleMs: deployLimits.verifySettleMs,
  refresh: null,
  timesTrusted: true,
})

/**
 * The code cache as the plugin reports it: off — the floor pause; one that looks at file times
 * every N s — N s plus a margin, or not trusted past `verifySettleMaxMs`; one the plugin drops
 * files from — told of each write. A site whose plugin does not say (no access, an older
 * plugin) keeps the floor pause, as before the plugin could say. The caller refuses a forward
 * write when the plan neither trusts the times nor refreshes (`code_cache`).
 */
export async function codeCachePlan(
  ctx: DeployContext,
  access: DeployAccess,
  manifest: DeployManifest,
): Promise<CodeCachePlan> {
  if (access.content === null || !ctx.codeCache) return defaultPlan()
  let gateway: SiteCodeCacheGateway
  let state
  try {
    gateway = ctx.codeCache(access.content, manifest)
    state = await gateway.codeCache()
  } catch {
    ctx.log('deploy-step: the code cache of the site is not known; the checks wait the usual pause')
    return defaultPlan()
  }
  if (!state.enabled) return defaultPlan()
  const byTimes = state.revalidateSeconds * 1000 + deployLimits.codeCacheMarginMs
  const plan: CodeCachePlan = {
    settleMs: Math.max(deployLimits.verifySettleMs, byTimes),
    refresh: state.refresh ? gateway : null,
    timesTrusted: state.validateTimestamps && byTimes <= deployLimits.verifySettleMaxMs,
  }
  ctx.log(
    `deploy-step: code cache on, ${state.validateTimestamps ? `file times every ${state.revalidateSeconds} s` : 'file times never looked at'}, ${plan.refresh ? 'refreshed by the plugin' : 'not refreshed by the plugin'}`,
  )
  return plan
}

/**
 * Drops the code among `paths` from the cache; true — the cache now runs what the hosting holds
 * (or there is nothing to drop), false — the plugin could not tell it.
 */
async function refreshCode(
  ctx: DeployContext,
  plan: CodeCachePlan,
  paths: Iterable<string>,
): Promise<boolean> {
  const code = [...paths].filter((path) => CODE_PATH.test(path)).sort()
  if (code.length === 0) return true
  if (plan.refresh === null) return false
  let refreshed = 0
  try {
    for (let from = 0; from < code.length; from += SITE_CODE_REFRESH_PATHS) {
      const batch = code.slice(from, from + SITE_CODE_REFRESH_PATHS)
      const result = await plan.refresh.refreshCode(batch)
      if (result.failed > 0) throw new Error('refused')
      refreshed += result.refreshed
    }
  } catch {
    ctx.log('deploy-step: the code cache was not refreshed')
    return false
  }
  ctx.log(`deploy-step: code cache refreshed for ${refreshed} of ${code.length} files`)
  return true
}

/** The pause of the checks after a write: the floor once the cache was told, else the plan's. */
const settleAfter = (plan: CodeCachePlan, refreshed: boolean) =>
  refreshed && plan.refresh !== null ? deployLimits.verifySettleMs : plan.settleMs

export interface DeployContext {
  wrap: DeployWrap
  api: ReleaseApi
  /** The data key of the wrapping: seals the backup, opens the values. */
  backupKey: Uint8Array
  tree: TreeSource
  /** A session of the hosting; `signal` ends it (every request then fails at once). */
  openHosting(hosting: DeployAccess['hosting'], signal: AbortSignal): Promise<HostingSession>
  /** The site's content gateway; throws when the access cannot build one. */
  contentGateway(
    content: NonNullable<DeployAccess['content']>,
    manifest: DeployManifest,
  ): SiteContentGateway
  /**
   * The code cache of the site's PHP through its plugin (stand R12); throws when the access
   * cannot reach one. Absent — the job knows of no code cache and waits the floor pause.
   */
  codeCache?(
    content: NonNullable<DeployAccess['content']>,
    manifest: DeployManifest,
  ): SiteCodeCacheGateway
  download(presigned: ReleasePresigned, maxBytes: number): Promise<Uint8Array>
  upload(presigned: ReleasePresigned, body: Uint8Array): Promise<void>
  checkSite(verify: DeployManifest['verify']): Promise<SiteCheckResult>
  /** Fixed lines for the job log: counts and words, never a path, a host or a value. */
  log(line: string): void
  /** Aborted when the job is cancelled: what was written is rolled back. */
  signal: AbortSignal
  now(): number
  sleep(ms: number): Promise<void>
}

/** Thrown inside a step: the step ends `failed` with this code, the run goes on from there. */
class StepFailed extends Error {
  readonly code: DeployStepCode

  constructor(code: DeployStepCode) {
    super(`Step failed: ${code}`)
    this.name = 'StepFailed'
    this.code = code
  }
}

/** core answered `proceed: false` (or refused the report): nothing more is written. */
class Stopped extends Error {
  constructor() {
    super('The release API stopped the deploy')
    this.name = 'Stopped'
  }
}

/** A rollback found a path not as this release left it: it is left alone. */
class ChangedMeanwhile extends Error {
  constructor() {
    super('Changed meanwhile')
    this.name = 'ChangedMeanwhile'
  }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** A failure of the hosting or of its guards: never a message, only a code. */
function hostingCode(error: unknown): DeployStepCode {
  if (error instanceof StepFailed) return error.code
  if (isHostingGuardError(error))
    return error.guard === 'exists' || error.guard === 'not_empty' ? 'conflict' : 'write_failed'
  if (isSiteConnectionError(error)) return 'hosting_unavailable'
  return 'write_failed'
}

/** The connection broke or did not answer in time: a fresh one may do better. */
const connectionLost = (error: unknown): boolean =>
  isSiteConnectionError(error) &&
  (error.reason === 'transfer_failed' || error.reason === 'unreachable')

type WriteEntry = DeployManifest['files']['write'][number]
type DeleteEntry = DeployManifest['files']['delete'][number]

/**
 * What the release puts back: the prior files by path, the prior states of the records and the
 * settings it changes, the folders it made.
 */
interface Restorable {
  files: Map<string, { bytes: Uint8Array; mode: number | null }>
  records: Map<string, PublishedContentState | DbOptionState>
  /** Folders absent before the release that its additions need: outermost first. */
  folders: string[]
}

/** The files (paths) and the objects of the plan an attempt sent a change of. */
interface Attempted {
  files: Set<string>
  /** By the object of the plan: the identity its write was sent with (a text change: null). */
  records: Map<string, WriteIdentity | null>
}

/** A value of the plan, opened: what the write of its operation carries. */
type OperationValue = DeployValue<DeployDbOperation['kind']>

interface Prepared {
  writes: { entry: WriteEntry; bytes: Uint8Array; mode: number }[]
  values: Map<string, OperationValue>
}

/** A record the attempt created: the reference production gave it, and its state then. */
interface Created {
  productionRef: string
  stateHash: string
}

/**
 * A state the plugin answered with, believed only when its hash is the hash of its own fields:
 * a filter of the site between the plugin and the job (a mu-plugin, a JSON rewrite for a CDN)
 * cannot hand the backup and a rollback in `restore` a text the site never held.
 */
function proven<State extends DbObjectState>(state: State): State {
  if (createHash('sha256').update(dbStateHashMaterial(state)).digest('hex') !== state.stateHash)
    throw new StepFailed('content_unavailable')
  return state
}

/** The state hash an operation's write must leave, worked out from its value and the prior state. */
function afterHashOf(
  operation: DeployDbOperation,
  value: OperationValue,
  prior: PublishedContentState | DbOptionState | undefined,
): string {
  const ref = operation.objectRef
  switch (operation.kind) {
    case 'content_update':
      if (!prior || !isRecordState(prior)) throw new Error('No prior state')
      return stateHashWith(prior, (value as DeployValue<'content_update'>).fields)
    case 'option_update':
      return optionHashOf(ref, (value as DeployValue<'option_update'>).value)
    case 'post_create':
      return createdHashOf(ref, (value as DeployValue<'post_create'>).record)
    case 'schema_migration':
      return migratedHashOf(ref, (value as DeployValue<'schema_migration'>).definition)
    case 'post_trash':
      return absentHashOf(ref)
  }
}

/** What the write of an operation other than a text change sends to the plugin. */
function changeOf(
  operation: DeployDbOperation,
  value: OperationValue,
  callId: string,
): DbWriteChange {
  switch (operation.kind) {
    case 'option_update':
      return { kind: 'option_update', value: (value as DeployValue<'option_update'>).value }
    case 'post_create':
      // The mark of the record is the call that created it: only that record goes to the trash.
      return {
        kind: 'post_create',
        record: (value as DeployValue<'post_create'>).record,
        createCallId: callId,
      }
    case 'schema_migration': {
      const table = value as DeployValue<'schema_migration'>
      return { kind: 'schema_migration', before: table.before, definition: table.definition }
    }
    case 'post_trash': {
      const trash = value as DeployValue<'post_trash'>
      return { kind: 'post_trash', expectedSlug: trash.slug, createCallId: trash.createCallId }
    }
    case 'content_update':
      throw new Error('A text change is written as published content')
  }
}

/** The capability of the plugin a kind of write needs: the trash of a record comes with creation. */
const capabilityOf = (kind: DeployDbOperation['kind']) =>
  kind === 'post_trash' ? 'post_create' : kind

/**
 * The plugin of production can write every kind of the plan, and every setting of it; a plan of
 * text changes alone is written by any version of it. `plugin_outdated` otherwise — nothing
 * written.
 */
async function checkPlugin(
  gateway: SiteContentGateway | null,
  manifest: DeployManifest,
): Promise<void> {
  const kinds = new Set(manifest.db.map(({ operation }) => operation.kind))
  if ([...kinds].every((kind) => kind === 'content_update')) return
  if (!gateway?.db) throw new StepFailed('plugin_outdated')
  let capabilities
  try {
    capabilities = await gateway.db.capabilities()
  } catch {
    throw new StepFailed('content_unavailable')
  }
  const settings = manifest.db.flatMap(({ operation }) =>
    operation.kind === 'option_update' ? [optionNameOf(operation.objectRef)] : [],
  )
  if (
    [...kinds].some((kind) => !capabilities.operations.includes(capabilityOf(kind))) ||
    settings.some((setting) => !capabilities.settings.includes(setting))
  )
    throw new StepFailed('plugin_outdated')
}

/**
 * An attempt «только возврат» (Р31) first moves the fence of the plugin to its own epoch — above
 * the one of the attempt it rolls back (core took the lease over in between) —, so that no write
 * of that attempt still on its way can land after this one read what production holds: the
 * absence of a receipt then means the write never happened. A plugin before version 2 has no
 * fence; its plan holds text changes alone, as before it.
 */
async function raiseFence(gateway: SiteContentGateway, manifest: DeployManifest): Promise<void> {
  const db = gateway.db
  if (!db) return
  try {
    if ((await db.capabilities()).plugin < 2) return
    await db.fence({ siteId: manifest.siteId, epoch: manifest.contentEpoch })
  } catch {
    throw new StepFailed('content_unavailable')
  }
}

/** The mode of a written file: the prior one's permission bits, or 0644, with `x` as approved. */
export const fileMode = (executable: boolean, prior: number | null): number => {
  const base = prior === null ? 0o644 : prior & 0o777
  return executable ? base | 0o111 : base & ~0o111
}

/**
 * The key of the temporary name of a write (`HostingWriteOptions.temporaryKey`): the same for the
 * same file of the same attempt on every connection, so the rollback finds and removes a
 * temporary a broken connection left behind.
 */
export const temporaryKeyOf = (
  releaseId: string,
  deployAttempt: number,
  path: string,
  direction: 'apply' | 'undo',
): string =>
  createHash('sha256')
    .update(
      `raditi-deploy-temporary-v1|${releaseId.toLowerCase()}|${deployAttempt}|${direction}|${path}`,
    )
    .digest('hex')
    .slice(0, 32)

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))
const depthOf = (path: string): number => path.split('/').length
/** Every folder a path passes through, outermost first. */
const foldersOf = (path: string): string[] =>
  path
    .split('/')
    .slice(0, -1)
    .map((_, index, all) => all.slice(0, index + 1).join('/'))
const below = (path: string, folder: string): boolean => path.startsWith(`${folder}/`)

/** The order of the writes of a manifest (Р30), checked before anything is asked of the hosting. */
export interface DeployLayout {
  /**
   * Deletions that free a name a write needs — a file that becomes a folder, and the files of a
   * folder that becomes a file: before the writes, put back last.
   */
  freeing: DeleteEntry[]
  /** Folders that become files, emptied by `freeing`: removed deepest first before the writes. */
  emptied: string[]
  /** Files that are folders before the release. */
  folderToFile: Set<string>
  /** Deleted files whose path becomes a folder. */
  fileToFolder: Set<string>
  writes: WriteEntry[]
  /** The other deletions: after the writes, so the new files are in place first. */
  later: DeleteEntry[]
}

/**
 * The layout of a manifest, or `source_mismatch` for one no commit can describe (a path written
 * and deleted, a file below another file) and for one that replaces or deletes a file of a folder
 * where a release only adds (`addOnlyPaths`, Р12).
 */
export function layoutOf(manifest: DeployManifest): DeployLayout {
  const writes = [...manifest.files.write].sort((a, b) => (a.path < b.path ? -1 : 1))
  const deletes = manifest.files.delete
  const written = new Set(writes.map((entry) => entry.path))
  const refused = () => new StepFailed('source_mismatch')
  if (written.size !== writes.length) throw refused()
  const deleted = new Set(deletes.map((entry) => entry.path))
  if (deleted.size !== deletes.length || deletes.some((entry) => written.has(entry.path)))
    throw refused()
  for (const entry of writes)
    if (foldersOf(entry.path).some((folder) => written.has(folder))) throw refused()
  for (const entry of deletes)
    if (foldersOf(entry.path).some((folder) => deleted.has(folder))) throw refused()
  for (const folder of manifest.addOnlyPaths) {
    if (writes.some((entry) => entry.before !== null && entry.path.startsWith(folder)))
      throw refused()
    if (deletes.some((entry) => entry.path.startsWith(folder))) throw refused()
  }

  const fileToFolder = new Set(
    deletes
      .filter((entry) => writes.some((write) => below(write.path, entry.path)))
      .map((entry) => entry.path),
  )
  const folderToFile = new Set<string>()
  const emptied = new Set<string>()
  for (const entry of deletes)
    for (const write of writes)
      if (below(entry.path, write.path)) {
        // A path that is a folder now cannot hold an installed file of the same name.
        if (write.before !== null) throw refused()
        folderToFile.add(write.path)
        for (const folder of foldersOf(entry.path))
          if (folder === write.path || below(folder, write.path)) emptied.add(folder)
      }
  const freeing = deletes.filter(
    (entry) =>
      fileToFolder.has(entry.path) || [...folderToFile].some((path) => below(entry.path, path)),
  )
  return {
    freeing,
    emptied: [...emptied].sort((a, b) => depthOf(b) - depthOf(a) || (a < b ? -1 : 1)),
    folderToFile,
    fileToFolder,
    writes,
    later: deletes.filter((entry) => !freeing.includes(entry)),
  }
}

/**
 * Runs `work` for each item with at most `limit` in flight. The first failure stops new items;
 * every item already started settles before it is rethrown, so nothing is still writing when
 * the rollback reads.
 */
async function eachBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  let failure: { error: unknown } | null = null
  const worker = async () => {
    while (failure === null && next < items.length) {
      const item = items[next]!
      next += 1
      try {
        await work(item)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure !== null) throw (failure as { error: unknown }).error
}

/** What a path of the hosting holds: absent, not a file (or too large to read), or its SHA-256. */
async function contentOf(session: HostingSession, path: HostingPath): Promise<string> {
  const stat = await session.stat(path)
  if (stat === null) return 'absent'
  if (stat.type !== 'file' || stat.size > publicationLimits.fileBytes) return 'other'
  return sha256(await session.read(path, publicationLimits.fileBytes))
}

const logLine = (step: ReleaseStep, state: ReleaseStepState, detail: ReleaseStepDetail) =>
  `deploy-step: ${step} ${state}${detail.code ? ` (${detail.code})` : ''}`

/** core answered a request and refused it: no later try will be taken either. */
const refusedByCore = (error: unknown): boolean =>
  error instanceof ReleaseApiError && error.status !== null

/** The reports of one attempt to core. */
interface Reporter {
  /** The step a failure is reported for: the last one that started. */
  readonly current: ReleaseStep
  /** A report whose answer decides whether the job goes on: `Stopped` otherwise. */
  report(step: ReleaseStep, state: ReleaseStepState, detail?: ReleaseStepDetail): Promise<void>
  /** A report after which nothing depends on the answer; one round of the client's retries. */
  tell(step: ReleaseStep, state: ReleaseStepState, detail: ReleaseStepDetail): Promise<void>
  /**
   * The last report of the job, offered to core until it answers (`deployLimits.endReportMs`):
   * true — taken; false — refused (core has moved on) or never answered.
   */
  finish(step: ReleaseStep, state: ReleaseStepState, detail: ReleaseStepDetail): Promise<boolean>
  /**
   * The heartbeat: after a minute without a report, the `started` of the current step again (the
   * same key, so the same report). `Stopped` when core refuses it; no answer is not a refusal.
   */
  beat(): Promise<void>
}

function reporterOf(ctx: DeployContext): Reporter {
  let current: ReleaseStep = 'conflicts'
  let lastAt = ctx.now()
  let beating: Promise<void> | null = null
  const send = (step: ReleaseStep, state: ReleaseStepState, detail: ReleaseStepDetail) => {
    lastAt = ctx.now()
    return ctx.api.report(step, state, detail)
  }
  return {
    get current() {
      return current
    },
    async report(step, state, detail = {}) {
      if (state === 'started') current = step
      ctx.log(logLine(step, state, detail))
      let answer
      try {
        answer = await send(step, state, detail)
      } catch {
        throw new Stopped()
      }
      if (!answer.accepted || !answer.proceed) throw new Stopped()
    },
    async tell(step, state, detail) {
      ctx.log(logLine(step, state, detail))
      await send(step, state, detail).catch(() => {})
    },
    async finish(step, state, detail) {
      ctx.log(logLine(step, state, detail))
      const until = ctx.now() + deployLimits.endReportMs
      for (;;) {
        try {
          return (await send(step, state, detail)).accepted
        } catch (error) {
          if (refusedByCore(error) || ctx.now() >= until) return false
          await ctx.sleep(deployLimits.endReportPauseMs)
        }
      }
    },
    beat() {
      if (beating) return beating
      if (ctx.now() - lastAt < deployLimits.heartbeatMs) return Promise.resolve()
      beating = (async () => {
        try {
          const answer = await send(current, 'started', {})
          if (!answer.accepted || !answer.proceed) throw new Stopped()
        } catch (error) {
          if (error instanceof Stopped || refusedByCore(error)) throw new Stopped()
          // No answer: the next beat tries again.
        }
      })().finally(() => {
        beating = null
      })
      return beating
    },
  }
}

/** What a writing step checks before each request: the job is alive and core goes on. */
interface Guard {
  assertLive(): void
  beat(): Promise<void>
}

export async function runDeploy(ctx: DeployContext): Promise<DeployResult> {
  const { api, wrap } = ctx
  const reporter = reporterOf(ctx)

  const manifest = await api.manifest()
  if (
    manifest.releaseId.toLowerCase() !== wrap.releaseId.toLowerCase() ||
    manifest.deployAttempt !== wrap.attempt ||
    manifest.tag !== wrap.tag ||
    manifest.approvedSha !== wrap.sha
  ) {
    // core's manifest is not of this run: nothing is asked for and nothing is written.
    const told = await reporter.finish(manifest.rollbackOf ? 'rollback' : 'conflicts', 'failed', {
      code: 'source_mismatch',
    })
    return { outcome: manifest.rollbackOf ? 'unknown' : 'failed', told }
  }
  if (manifest.rollbackOf) return rollbackOnly(ctx, manifest, reporter)

  const deadline = ctx.now() + deployLimits.forwardMs
  const guard: Guard = {
    assertLive() {
      if (ctx.signal.aborted || ctx.now() >= deadline) throw new StepFailed('stopped')
    },
    beat: () => reporter.beat(),
  }
  /** A writing step reported `started`: from here a failure needs the rollback. */
  let wrote = false
  /** An undo: the site failed its check before anything was written. */
  let brokenBefore = false
  let access: DeployAccess | null = null
  let session: HostingSession | null = null
  let gateway: SiteContentGateway | null = null
  let layout: DeployLayout | null = null
  let cache = defaultPlan()
  const restorable: Restorable = { files: new Map(), records: new Map(), folders: [] }
  /** What the attempt sent a change of: only these can hold a write of it. */
  const attempted: Attempted = { files: new Set(), records: new Map() }
  /** The records the attempt created, by the reference of the plan. */
  const created = new Map<string, Created>()
  let prepared: Prepared | null = null
  try {
    // --- conflicts ------------------------------------------------------------------------------
    await reporter.report('conflicts', 'started')
    layout = layoutOf(manifest)
    // The site as it is must pass the check the release will be held to: a site that fails it
    // already is not written to — after the release nothing could tell whose failure it is. An
    // undo goes on: the version it undoes may be what broke the site.
    if (!(await ctx.checkSite(manifest.verify)).ok) {
      if (manifest.kind !== 'undo') throw new StepFailed('site_broken_before')
      brokenBefore = true
      ctx.log('deploy-step: the site fails its check before the undo; the undo goes on')
    }
    try {
      access = await api.access()
    } catch {
      throw new StepFailed('stopped')
    }
    if (access.hosting.method !== manifest.method) throw new StepFailed('hosting_unavailable')
    if (manifest.db.length > 0) {
      if (access.content === null) throw new StepFailed('content_unavailable')
      try {
        gateway = ctx.contentGateway(access.content, manifest)
      } catch {
        throw new StepFailed('content_unavailable')
      }
    }
    await checkPlugin(gateway, manifest)
    cache = await codeCachePlan(ctx, access, manifest)
    // A cache that never looks at file times and cannot be told of a write: no check after the
    // write could tell the release's code from the old one.
    if (!cache.timesTrusted && cache.refresh === null) throw new StepFailed('code_cache')
    try {
      // The forward session ends with a cancel of the job; its deadline is checked between
      // requests (`assertLive`), so a slow deploy still has its connection for the rollback.
      session = await ctx.openHosting(access.hosting, ctx.signal)
    } catch {
      throw new StepFailed('hosting_unavailable')
    }
    prepared = await preflight(ctx, manifest, layout, session, gateway, restorable, guard)
    await reporter.report('conflicts', 'succeeded', {
      files: manifest.files.write.length + manifest.files.delete.length,
      objects: manifest.db.length,
      ...(brokenBefore ? { brokenBefore } : {}),
    })

    // --- backup ---------------------------------------------------------------------------------
    await reporter.report('backup', 'started')
    const backedUp = await backup(ctx, manifest, restorable)
    await reporter.report('backup', 'succeeded', backedUp)

    // --- files ----------------------------------------------------------------------------------
    guard.assertLive()
    // Before the report: once core keeps `files started`, it counts the attempt as written, so a
    // lost answer must lead to the rollback too — which finds nothing to put back.
    wrote = true
    await reporter.report('files', 'started')
    const written = await writeFiles(manifest, layout, session, prepared, guard, attempted.files)
    // The cache was told of every code file written.
    const refreshed = await refreshCode(ctx, cache, attempted.files)
    // Not told, and the times prove nothing: the check could pass on the old code.
    if (!refreshed && !cache.timesTrusted) throw new StepFailed('code_cache')
    await reporter.report('files', 'succeeded', {
      files: prepared.writes.length + manifest.files.delete.length,
      bytes: written,
    })

    // --- db -------------------------------------------------------------------------------------
    if (manifest.db.length > 0 && gateway) {
      await reporter.report('db', 'started')
      for (const { operation } of manifest.db) {
        guard.assertLive()
        await guard.beat()
        await applyOperation(ctx, manifest, gateway, operation, prepared, attempted, created)
      }
      await reporter.report('db', 'succeeded', { objects: manifest.db.length })
    }

    // --- verify ---------------------------------------------------------------------------------
    await reporter.report('verify', 'started')
    const createdPages = new Map(
      [...created].map(([ref, entry]) => {
        const value = prepared?.values.get(ref) as DeployValue<'post_create'> | undefined
        return [ref, { productionRef: entry.productionRef, record: value?.record ?? null }]
      }),
    )
    const checked = await settledCheck(
      ctx,
      verifyAfterWrites(manifest.verify, createdPages),
      settleAfter(cache, refreshed),
    )
    if (!checked.ok && brokenBefore) {
      // The version the undo would go back to failed the same check: nothing is put back, the
      // operator decides.
      const told = await reporter.finish('verify', 'unknown', {
        pages: checked.pages,
        code: 'site_broken_both',
      })
      return { outcome: 'unknown', told }
    }
    if (!checked.ok) throw new StepFailed('site_broken')
    const told = await reporter.finish('verify', 'succeeded', { pages: checked.pages })
    return { outcome: 'installed', told }
  } catch (error) {
    // Stopped by core: nothing to report. Anything else ends its step `failed`.
    let told = true
    if (!(error instanceof Stopped)) {
      const code = ctx.signal.aborted ? 'stopped' : hostingCode(error)
      if (wrote) await reporter.tell(reporter.current, 'failed', { code })
      else told = await reporter.finish(reporter.current, 'failed', { code })
    }
    if (!wrote || !access || !layout) return { outcome: 'failed', told }
    // The forward connection may be what broke: the rollback opens its own.
    await session?.close().catch(() => {})
    session = null
    return await restore(ctx, manifest, layout, access.hosting, gateway, restorable, reporter, {
      writingAttempt: manifest.deployAttempt,
      attempted,
      created,
      values: prepared?.values ?? new Map(),
      cache,
      brokenBefore,
    })
  } finally {
    await session?.close().catch(() => {})
  }
}

/**
 * Reads what a write needs before any write: the hosting's files against the installed version,
 * the folders the additions need, the records against their base, the approved files and the
 * values against the manifest.
 */
async function preflight(
  ctx: DeployContext,
  manifest: DeployManifest,
  layout: DeployLayout,
  session: HostingSession,
  gateway: SiteContentGateway | null,
  restorable: Restorable,
  guard: Guard,
): Promise<Prepared> {
  let differ = 0
  let changedRecords = 0
  let backupBytes = 0
  const modes = new Map<string, number | null>()
  const keep = (path: string, bytes: Uint8Array, mode: number | null) => {
    backupBytes += bytes.byteLength
    if (backupBytes > releaseApiLimits.backupBytes) throw new StepFailed('backup_too_large')
    restorable.files.set(path, { bytes, mode })
  }
  const step = async (work: () => Promise<void>) => {
    guard.assertLive()
    await guard.beat()
    await work()
  }
  try {
    // The files the release replaces or deletes: each must be the installed version.
    const replaced: { path: string; before: string }[] = [
      ...layout.writes.flatMap((entry) =>
        entry.before === null ? [] : [{ path: entry.path, before: entry.before }],
      ),
      ...manifest.files.delete,
    ]
    await eachBounded(replaced, deployLimits.parallel, (entry) =>
      step(async () => {
        const path = hostingPathOf(entry.path)
        const stat = await session.stat(path)
        if (stat?.type !== 'file' || stat.size > publicationLimits.fileBytes) {
          differ += 1
          return
        }
        const bytes = await session.read(path, publicationLimits.fileBytes)
        if (sha256(bytes) !== entry.before) {
          differ += 1
          return
        }
        modes.set(entry.path, stat.mode)
        keep(entry.path, bytes, stat.mode)
      }),
    )

    // A file that becomes a folder is a folder now, emptied by the release's own deletions.
    for (const path of layout.folderToFile)
      await step(async () => {
        if ((await session.stat(hostingPathOf(path)))?.type !== 'directory') differ += 1
      })

    // The folders the additions need, outermost first: each one is a folder now, or absent — and
    // then the release makes it and everything below it (as it does a file it deletes first).
    const additions = layout.writes.filter(
      (entry) => entry.before === null && !layout.folderToFile.has(entry.path),
    )
    const folders = [...new Set(additions.flatMap((entry) => foldersOf(entry.path)))].sort(
      (a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : 1),
    )
    const absent = new Set<string>()
    for (const folder of folders) {
      if (absent.has(parentOf(folder)) || layout.fileToFolder.has(folder)) {
        absent.add(folder)
        continue
      }
      await step(async () => {
        const entry = await session.stat(hostingPathOf(folder))
        if (entry === null) absent.add(folder)
        else if (entry.type !== 'directory') differ += 1
      })
    }
    restorable.folders = folders.filter((folder) => absent.has(folder))
    // An addition in a folder that exists must find its name free.
    await eachBounded(
      additions.filter((entry) => !absent.has(parentOf(entry.path))),
      deployLimits.parallel,
      (entry) =>
        step(async () => {
          if ((await session.stat(hostingPathOf(entry.path))) !== null) differ += 1
        }),
    )
  } catch (error) {
    if (error instanceof StepFailed || error instanceof Stopped) throw error
    // A link where a file or a folder must be is a conflict of the hosting, not a broken transfer.
    if (isHostingGuardError(error)) throw new StepFailed('conflict')
    throw new StepFailed('hosting_unavailable')
  }
  // Each object of the plan holds its base: a record or a setting its prior state (kept for the
  // rollback), a table its prior definition or already the one the release gives it (a repeat).
  // A new record has no base; its address is asked once its value is open. A record an undo takes
  // to the trash holds what the release wrote, and nothing of the site stands on it.
  for (const { operation } of manifest.db) {
    if (operation.kind === 'post_create') continue
    guard.assertLive()
    await guard.beat()
    let state
    let dependents = 0
    try {
      state = proven(
        operation.kind === 'content_update'
          ? await gateway!.read(operation.objectRef)
          : await gateway!.db!.readObject(operation.objectRef),
      )
      if (operation.kind === 'post_trash' && state.stateHash === operation.beforeHash)
        dependents = await gateway!.db!.dependents(operation.objectRef)
    } catch {
      throw new StepFailed('content_unavailable')
    }
    const fits =
      (state.stateHash === operation.beforeHash && dependents === 0) ||
      (operation.kind === 'schema_migration' && state.stateHash === operation.afterHash)
    if (!fits) {
      changedRecords += 1
      continue
    }
    if (isRecordState(state) || isOptionState(state))
      restorable.records.set(operation.objectRef, state)
  }
  if (differ > 0 || changedRecords > 0) {
    ctx.log(
      `deploy-step: ${differ} files and ${changedRecords} records differ from the installed version`,
    )
    throw new StepFailed('conflict')
  }

  const files = new Map<string, Uint8Array>()
  const values = new Map<string, OperationValue>()
  let moved = 0
  try {
    await eachBounded(layout.writes, deployLimits.parallel, async (entry) => {
      guard.assertLive()
      await guard.beat()
      files.set(
        entry.path,
        await ctx.tree.file(entry.path, { sha256: entry.after, sizeBytes: entry.sizeBytes }),
      )
    })
    for (const { operation, after } of manifest.db) {
      guard.assertLive()
      await guard.beat()
      const sealed = await ctx.download(after, dbPlanLimits.valueBytes * 2 + 1024)
      const value = openOperationValue(
        sealed,
        ctx.backupKey,
        manifest.releaseId,
        operation,
        manifest.kind,
      )
      // What production holds plus this value must be exactly the state of the preview — or, for
      // an undo, the state before the release: core sealed it from that state, and the job checks
      // it before anything is written.
      const prior = restorable.records.get(operation.objectRef)
      if (afterHashOf(operation, value, prior) !== operation.afterHash) throw new Error('value')
      // A setting without a row is what an undo may put back, never what a release writes.
      if (
        operation.kind === 'option_update' &&
        manifest.kind !== 'undo' &&
        (value as DeployValue<'option_update'>).value === null
      )
        throw new Error('value')
      // The trash names the record at its address: the one production holds now. Another
      // address is a change of the page since the release — its hash leaves the address out —
      // and the page stays, as any record changed meanwhile.
      if (operation.kind === 'post_trash') {
        if (!prior || !isRecordState(prior)) throw new Error('value')
        if (prior.slug !== (value as DeployValue<'post_trash'>).slug) {
          moved += 1
          continue
        }
      }
      if (
        operation.kind === 'schema_migration' &&
        tableHashOf(operation.objectRef, (value as DeployValue<'schema_migration'>).before) !==
          operation.beforeHash
      )
        throw new Error('value')
      values.set(operation.objectRef, value)
    }
  } catch (error) {
    if (error instanceof StepFailed || error instanceof Stopped) throw error
    throw new StepFailed('source_mismatch')
  }
  if (moved > 0) {
    ctx.log(`deploy-step: ${moved} records differ from the installed version`)
    throw new StepFailed('conflict')
  }
  // A new record needs its address free: production gives it its own id, never its address.
  let taken = 0
  for (const { operation } of manifest.db) {
    if (operation.kind !== 'post_create') continue
    guard.assertLive()
    const { slug } = (values.get(operation.objectRef) as DeployValue<'post_create'>).record
    try {
      if (await gateway!.db!.slugTaken(recordTypeOf(operation.objectRef), slug)) taken += 1
    } catch {
      throw new StepFailed('content_unavailable')
    }
  }
  if (taken > 0) {
    ctx.log(`deploy-step: ${taken} addresses of new records are taken on the site`)
    throw new StepFailed('conflict')
  }
  const writes = layout.writes.map((entry) => ({
    entry,
    bytes: files.get(entry.path)!,
    mode: fileMode(entry.executable, modes.get(entry.path) ?? null),
  }))
  return { writes, values }
}

async function backup(
  ctx: DeployContext,
  manifest: DeployManifest,
  restorable: Restorable,
): Promise<ReleaseStepDetail> {
  const {
    sealed,
    sha256: digest,
    sizeBytes,
  } = await sealBackup(
    {
      releaseId: manifest.releaseId,
      deployAttempt: manifest.deployAttempt,
      files: [...restorable.files].map(([path, file]) => ({ path, ...file })),
      records: [...restorable.records.values()],
      folders: restorable.folders,
    },
    ctx.backupKey,
  ).catch(() => {
    throw new StepFailed('backup_too_large')
  })
  if (sizeBytes > releaseApiLimits.backupBytes) throw new StepFailed('backup_too_large')
  try {
    const put = await ctx.api.backupPut({ sha256: digest, sizeBytes })
    await ctx.upload(put, sealed)
    if (!(await ctx.api.backupVerify({ sha256: digest, sizeBytes })))
      throw new StepFailed('backup_refused')
  } catch (error) {
    if (error instanceof StepFailed) throw error
    throw new StepFailed('backup_refused')
  }
  return { files: restorable.files.size, objects: restorable.records.size, bytes: sizeBytes }
}

/**
 * The write of one operation of the plan on production, in the plugin's mode `release`: a text
 * change as published content, every other kind as an object of the plan. Its receipt must say
 * the state the plan names — a new record's, under the reference production gave it. A refusal
 * changed nothing (`conflict` for a precondition that no longer holds); a receipt of another state
 * or no proof at all is put right by the rollback, which reads what production holds.
 */
async function applyOperation(
  ctx: DeployContext,
  manifest: DeployManifest,
  gateway: SiteContentGateway,
  operation: DeployDbOperation,
  prepared: Prepared,
  attempted: Attempted,
  created: Map<string, Created>,
): Promise<void> {
  const ref = operation.objectRef
  const value = prepared.values.get(ref)!
  const write = {
    releaseId: manifest.releaseId,
    deployAttempt: manifest.deployAttempt,
    siteId: manifest.siteId,
    epoch: manifest.contentEpoch,
    objectRef: ref,
    direction: 'apply' as const,
    expectedStateHash: operation.beforeHash,
    // An undo puts back what the site held before the release: exact bytes, as a rollback does.
    mode: manifest.kind === 'undo' ? ('restore' as const) : ('release' as const),
  }
  let result
  let createdRef: string | undefined
  if (operation.kind === 'content_update') {
    attempted.records.set(ref, null)
    result = await writeExact(
      gateway,
      { ...write, fields: (value as DeployValue<'content_update'>).fields },
      ctx,
    )
  } else {
    if (!gateway.db) throw new StepFailed('plugin_outdated')
    const callId = contentCallId(manifest.releaseId, manifest.deployAttempt, ref, 'apply')
    // Sent: whatever the answer, the rollback looks for what it may have written.
    attempted.records.set(ref, null)
    const sent = await writeDbExact(
      gateway.db,
      { ...write, change: changeOf(operation, value, callId) },
      ctx,
    )
    attempted.records.set(ref, sent.identity)
    result = sent.result
    if (result.kind === 'committed') createdRef = result.createdRef
  }
  if (result.kind === 'committed') {
    if (operation.kind !== 'post_create') {
      if (result.stateHash === operation.afterHash) return
    } else if (
      createdRef !== undefined &&
      recordTypeOf(createdRef) === recordTypeOf(ref) &&
      result.stateHash === createdHashOf(createdRef, (value as DeployValue<'post_create'>).record)
    ) {
      created.set(ref, { productionRef: createdRef, stateHash: result.stateHash })
      return
    }
  }
  throw new StepFailed(
    result.kind === 'refused' && result.code === 'conflict' ? 'conflict' : 'write_failed',
  )
}

/**
 * The files of the release (Р30): the deletions that free a name, the folders that become
 * files, the writes, the other deletions. Each replaced or deleted file is read again right
 * before: an edit of the owner made after the conflicts step is never overwritten — it stops
 * the release with `conflict`, and the rollback leaves that file as the owner made it. Every
 * path a change is sent for goes to `attempted` first.
 */
async function writeFiles(
  manifest: DeployManifest,
  layout: DeployLayout,
  session: HostingSession,
  prepared: Prepared,
  guard: Guard,
  attempted: Set<string>,
): Promise<number> {
  let written = 0
  const unchanged = async (path: HostingPath, before: string) => {
    if ((await contentOf(session, path)) !== before) throw new StepFailed('conflict')
  }
  const remove = async (entry: DeleteEntry) => {
    guard.assertLive()
    await guard.beat()
    const path = hostingPathOf(entry.path)
    await unchanged(path, entry.before)
    attempted.add(entry.path)
    await session.remove(path)
  }
  try {
    for (const entry of layout.freeing) await remove(entry)
    // A folder removed here comes back with the first file the rollback puts in it.
    for (const folder of layout.emptied) {
      guard.assertLive()
      await session.removeEmptyDirectory(hostingPathOf(folder))
    }
    await eachBounded(prepared.writes, deployLimits.parallel, async ({ entry, bytes, mode }) => {
      guard.assertLive()
      await guard.beat()
      const path = hostingPathOf(entry.path)
      if (entry.before !== null) await unchanged(path, entry.before)
      attempted.add(entry.path)
      if (path.length > 1) await session.mkdirp(path.slice(0, -1))
      await session.writeAtomic(path, bytes, {
        replace: entry.before !== null,
        mode,
        temporaryKey: temporaryKeyOf(
          manifest.releaseId,
          manifest.deployAttempt,
          entry.path,
          'apply',
        ),
      })
      written += bytes.byteLength
    })
    await eachBounded(layout.later, deployLimits.parallel, remove)
  } catch (error) {
    if (error instanceof Stopped) throw error
    throw new StepFailed(hostingCode(error))
  }
  return written
}

/**
 * The hosting of a rollback: a session of its own, opened again — a bounded number of times —
 * when a connection breaks or does not answer; a work that failed that way is run again from
 * its start, and each work first reads what the hosting holds, so running it twice is safe.
 */
function rollbackHosting(ctx: DeployContext, hosting: DeployAccess['hosting'], deadline: number) {
  let session: HostingSession | null = null
  let reconnects = 0
  let dead = false
  const open = async (): Promise<HostingSession> => {
    const pauses = deployLimits.reconnectPausesMs
    for (let attempt = 0; ; attempt += 1) {
      const left = deadline - ctx.now()
      try {
        if (left <= 0) throw new Error('The rollback is out of time')
        return await ctx.openHosting(hosting, AbortSignal.timeout(left))
      } catch (error) {
        if (attempt >= pauses.length || left <= 0) {
          dead = true
          throw error
        }
        await ctx.sleep(pauses[attempt]!)
      }
    }
  }
  return {
    async use(work: (session: HostingSession) => Promise<void>): Promise<void> {
      for (;;) {
        if (dead) throw new Error('The hosting does not answer the rollback')
        session ??= await open()
        try {
          return await work(session)
        } catch (error) {
          if (!connectionLost(error) || reconnects >= deployLimits.reconnects) throw error
          reconnects += 1
          await session.close().catch(() => {})
          session = null
        }
      }
    },
    async close(): Promise<void> {
      await session?.close().catch(() => {})
      session = null
    },
  }
}

/** What returning the objects of a plan came to. */
interface Undone {
  /** Put back: a text, a setting, a new record in the trash. */
  restored: number
  /** Changed by someone else since: left as they are, the end is `unknown`. */
  changed: number
  /** No proof either way. */
  failed: boolean
  /** New records someone changed since the release: left, and said — the end is still known. */
  keptRecords: number
  /** Tables the release made or extended: their structure stays (no inverse). */
  keptTables: number
}

/**
 * The objects of the plan back, in the reverse of the plan's order, each only where production
 * holds what this release wrote: a text and a setting by their prior state (`restore`), a new
 * record to the trash at its own address and only with its mark — production's own records and
 * those someone changed since stay («новые записи прода сохраняются»); a table keeps the structure
 * the release added: the version before does not use it, and a removal would take what the site
 * wrote into it since. A new record the job holds no receipt of is looked for: the reconcile of
 * its write, or — an attempt «только возврат», whose fence is above the writing attempt's — the
 * receipt the plugin keeps under its call id; none means it never landed.
 */
async function undoOperations(
  ctx: DeployContext,
  manifest: DeployManifest,
  gateway: SiteContentGateway | null,
  restorable: Restorable,
  options: {
    writingAttempt: number
    attempted: Attempted | null
    created: Map<string, Created>
    values: Map<string, OperationValue>
  },
  reporter?: Reporter,
): Promise<Undone> {
  const undone: Undone = { restored: 0, changed: 0, failed: false, keptRecords: 0, keptTables: 0 }
  const { attempted } = options
  const undo = (objectRef: string, expectedStateHash: string) => ({
    releaseId: manifest.releaseId,
    deployAttempt: manifest.deployAttempt,
    siteId: manifest.siteId,
    epoch: manifest.contentEpoch,
    objectRef,
    direction: 'undo' as const,
    expectedStateHash,
  })
  for (const { operation } of [...manifest.db].reverse()) {
    const ref = operation.objectRef
    if (attempted !== null && !attempted.records.has(ref)) continue
    await reporter?.beat().catch(() => {})
    if (!gateway) {
      undone.failed = true
      continue
    }
    const db = gateway.db
    try {
      switch (operation.kind) {
        case 'content_update': {
          const prior = restorable.records.get(ref)
          if (!prior || !isRecordState(prior)) {
            undone.failed = true
            break
          }
          const current = proven(await gateway.read(ref))
          if (current.stateHash === operation.beforeHash) break
          if (current.stateHash !== operation.afterHash) {
            undone.changed += 1
            break
          }
          const result = await writeExact(
            gateway,
            { ...undo(ref, operation.afterHash), fields: fieldsOf(prior, operation) },
            ctx,
          )
          if (result.kind === 'committed' && result.stateHash === operation.beforeHash)
            undone.restored += 1
          else if (result.kind === 'refused' && result.code === 'conflict') undone.changed += 1
          else undone.failed = true
          break
        }
        case 'option_update': {
          const prior = restorable.records.get(ref)
          if (!db || !prior || !isOptionState(prior)) {
            undone.failed = true
            break
          }
          const current = proven(await db.readObject(ref))
          if (current.stateHash === operation.beforeHash) break
          if (current.stateHash !== operation.afterHash) {
            undone.changed += 1
            break
          }
          const { result } = await writeDbExact(
            db,
            {
              ...undo(ref, operation.afterHash),
              change: { kind: 'option_update', value: prior.value },
            },
            ctx,
          )
          if (result.kind === 'committed' && result.stateHash === operation.beforeHash)
            undone.restored += 1
          else if (result.kind === 'refused' && result.code === 'conflict') undone.changed += 1
          else undone.failed = true
          break
        }
        case 'post_create': {
          if (!db) {
            undone.failed = true
            break
          }
          const outcome = await trashCreated(ctx, manifest, db, operation, options, undo)
          if (outcome === 'trashed') undone.restored += 1
          else if (outcome === 'kept') undone.keptRecords += 1
          else if (outcome === 'unknown') undone.failed = true
          break
        }
        case 'post_trash': {
          // An undo took a record of the release to the trash: it comes back from there, as it
          // was, while it is still in the trash of that mark (`post_untrash`).
          const prior = restorable.records.get(ref)
          const value = options.values.get(ref) as DeployValue<'post_trash'> | undefined
          if (!db || !prior || !isRecordState(prior) || !value) {
            undone.failed = true
            break
          }
          const current = proven(await db.readObject(ref))
          if (current.stateHash === operation.beforeHash) break
          if (current.stateHash !== operation.afterHash) {
            undone.changed += 1
            break
          }
          const { result } = await writeDbExact(
            db,
            {
              ...undo(ref, operation.afterHash),
              change: {
                kind: 'post_untrash',
                expectedSlug: value.slug,
                createCallId: value.createCallId,
              },
            },
            ctx,
          )
          if (result.kind === 'committed' && result.stateHash === operation.beforeHash)
            undone.restored += 1
          else if (result.kind === 'refused' && result.code === 'conflict') undone.changed += 1
          else undone.failed = true
          break
        }
        case 'schema_migration': {
          // The structure stays; whether it is there to keep, the table says.
          let added = true
          if (db)
            try {
              added = (await db.readObject(ref)).stateHash !== operation.beforeHash
            } catch {
              // Not known: said as kept, which it is if the release got to it.
            }
          if (added) undone.keptTables += 1
          break
        }
      }
    } catch {
      undone.failed = true
    }
  }
  return undone
}

/**
 * A record the release created goes to the trash — only the one its receipt names, only while it
 * holds what the release wrote, at the address it was given, with the mark of its creation.
 * `none` — it was never created, or is gone already; `kept` — someone changed it since, it stays.
 */
async function trashCreated(
  ctx: DeployContext,
  manifest: DeployManifest,
  db: SiteDbGateway,
  operation: Extract<DeployDbOperation, { kind: 'post_create' }>,
  options: {
    writingAttempt: number
    attempted: Attempted | null
    created: Map<string, Created>
    values: Map<string, OperationValue>
  },
  undo: (
    objectRef: string,
    expectedStateHash: string,
  ) => Omit<Parameters<typeof writeDbExact>[1], 'change'>,
): Promise<'trashed' | 'kept' | 'none' | 'unknown'> {
  const ref = operation.objectRef
  const callId = contentCallId(manifest.releaseId, options.writingAttempt, ref, 'apply')
  let created = options.created.get(ref) ?? null
  if (created === null) {
    const identity = options.attempted?.records.get(ref) ?? null
    const proof = identity
      ? await db.reconcile({ ...identity, ttlMs: identity.deadlineAt - ctx.now() })
      : await db.operation(callId)
    if (proof === null || proof.kind === 'not_committed') return 'none'
    if (proof.kind === 'unknown' || !proof.createdRef || proof.objectRef !== ref) return 'unknown'
    created = { productionRef: proof.createdRef, stateHash: proof.stateHash }
  }
  const value = options.values.get(ref) as DeployValue<'post_create'> | undefined
  if (!value || recordTypeOf(created.productionRef) !== recordTypeOf(ref)) return 'unknown'
  let current
  try {
    current = proven(await db.readObject(created.productionRef))
  } catch (error) {
    // A record of the release that is no longer a page or a post anyone may read here: changed.
    if (isDomainError(error) && error.code === 'CONTENT_OBJECT_UNAVAILABLE') return 'kept'
    throw error
  }
  if (isAbsentState(current)) return 'none'
  if (
    !isRecordState(current) ||
    current.stateHash !== created.stateHash ||
    current.slug !== value.record.slug
  )
    return 'kept'
  const { result } = await writeDbExact(
    db,
    {
      ...undo(created.productionRef, created.stateHash),
      change: { kind: 'post_trash', expectedSlug: value.record.slug, createCallId: callId },
    },
    ctx,
  )
  if (result.kind === 'committed' && result.stateHash === absentHashOf(created.productionRef))
    return 'trashed'
  if (result.kind === 'refused' && result.code === 'conflict') return 'kept'
  return 'unknown'
}

/**
 * Р31: on its own connection, the files back in the reverse order of their writes — the other
 * deletions, the writes, the folders the release made, the deletions that freed a name — then
 * the objects of the plan in reverse order (`undoOperations`), each only where production holds
 * what this release wrote; a path, a record or a setting someone changed meanwhile is left alone
 * and makes the end `unknown` — a new record someone changed is left too, and said, but known.
 * Then the site is checked again.
 */
async function restore(
  ctx: DeployContext,
  manifest: DeployManifest,
  layout: DeployLayout,
  hosting: DeployAccess['hosting'],
  gateway: SiteContentGateway | null,
  restorable: Restorable,
  reporter: Reporter,
  options: {
    writingAttempt: number
    /** What the attempt sent a change of; null — not known (an attempt «только возврат»). */
    attempted: Attempted | null
    /** The records the writing attempt created, as far as this job knows. */
    created: Map<string, Created>
    /** The values of the plan opened: a new record goes to the trash at its own address. */
    values: Map<string, OperationValue>
    /** The code cache of the site, as the attempt read it. */
    cache: CodeCachePlan
    started?: boolean
    /**
     * The site failed its check before an undo wrote (Ж7): one that fails after the rollback too
     * is `site_broken_both` — going back mends nothing, the operator decides at once.
     */
    brokenBefore?: boolean
  },
): Promise<DeployResult> {
  if (!options.started)
    try {
      await reporter.report('rollback', 'started')
    } catch {
      // core no longer takes reports of this release; the hosting is put back all the same.
    }
  const deadline = ctx.now() + deployLimits.rollbackMs
  const link = rollbackHosting(ctx, hosting, deadline)
  let changed = 0
  let failed = false
  let restoredFiles = 0
  let restoredRecords = 0
  /** Paths the rollback wrote or removed: the code among them leaves the cache. */
  const restoredPaths = new Set<string>()
  const differs = (): never => {
    throw new ChangedMeanwhile()
  }
  const step = async (work: (session: HostingSession) => Promise<void>) => {
    // The rollback goes on whatever core answers its heartbeat.
    await reporter.beat().catch(() => {})
    if (ctx.now() > deadline) {
      failed = true
      return
    }
    try {
      await link.use(work)
    } catch (error) {
      if (error instanceof ChangedMeanwhile || isHostingGuardError(error)) changed += 1
      else failed = true
    }
  }
  const put = async (session: HostingSession, path: string, replace: boolean) => {
    const prior = restorable.files.get(path)
    if (!prior) throw new Error('not backed up')
    const segments = hostingPathOf(path)
    if (segments.length > 1) await session.mkdirp(segments.slice(0, -1))
    await session.writeAtomic(segments, prior.bytes, {
      replace,
      mode: prior.mode === null ? 0o644 : prior.mode & 0o777,
      temporaryKey: temporaryKeyOf(manifest.releaseId, manifest.deployAttempt, path, 'undo'),
    })
    restoredFiles += 1
    restoredPaths.add(path)
  }
  const { attempted } = options
  const reached = (path: string) => attempted === null || attempted.files.has(path)
  /** A folder the release made is removed only when the attempt wrote below it. */
  const madeBelow = (folder: string) =>
    attempted === null || [...attempted.files].some((path) => below(path, folder))
  const putBack = (entry: DeleteEntry) =>
    step(async (session) => {
      const now = await contentOf(session, hostingPathOf(entry.path))
      if (now === entry.before) return
      if (now === 'absent') await put(session, entry.path, false)
      else differs()
    })

  try {
    for (const entry of [...layout.later].reverse()) if (reached(entry.path)) await putBack(entry)
    for (const entry of [...layout.writes].reverse()) {
      if (!reached(entry.path)) continue
      await step(async (session) => {
        const segments = hostingPathOf(entry.path)
        // A temporary of this write that a broken connection left behind.
        await session.remove([
          ...segments.slice(0, -1),
          temporaryNameOf(
            temporaryKeyOf(manifest.releaseId, options.writingAttempt, entry.path, 'apply'),
          ),
        ])
        const now = await contentOf(session, segments)
        if (now === (entry.before ?? 'absent')) return
        if (now !== entry.after) differs()
        if (entry.before !== null) await put(session, entry.path, true)
        else {
          await session.remove(segments)
          restoredFiles += 1
          restoredPaths.add(entry.path)
        }
      })
    }
    for (const folder of [...restorable.folders].reverse())
      if (madeBelow(folder))
        await step((session) => session.removeEmptyDirectory(hostingPathOf(folder)))
    for (const entry of [...layout.freeing].reverse()) if (reached(entry.path)) await putBack(entry)
  } finally {
    await link.close()
  }
  // The code the rollback put back leaves the cache before the plugin is asked for the records:
  // it answers with the code the site runs.
  const { cache } = options
  const refreshed = await refreshCode(ctx, cache, restoredPaths)

  const undone = await undoOperations(ctx, manifest, gateway, restorable, options, reporter)
  changed += undone.changed
  failed ||= undone.failed
  restoredRecords += undone.restored
  const detail = {
    files: restoredFiles,
    objects: restoredRecords,
    ...(undone.keptRecords > 0 ? { keptRecords: undone.keptRecords } : {}),
    ...(undone.keptTables > 0 ? { keptTables: undone.keptTables } : {}),
  }
  if (changed > 0 || failed) {
    const told = await reporter.finish('rollback', 'unknown', {
      ...detail,
      code: changed > 0 ? 'changed_meanwhile' : 'hosting_unavailable',
    })
    return { outcome: 'unknown', told }
  }
  await reporter.tell('rollback', 'succeeded', detail)
  try {
    await reporter.report('reverify', 'started')
  } catch {
    // The site is checked even when core no longer listens.
  }
  // The cache was not told of what the rollback put back, and its file times prove nothing: no
  // check can say the site runs the restored code. The operator decides.
  if (!refreshed && !cache.timesTrusted)
    return {
      outcome: 'unknown',
      told: await reporter.finish('reverify', 'failed', { pages: 0, code: 'code_cache' }),
    }
  const checked = await settledCheck(ctx, manifest.verify, settleAfter(cache, refreshed))
  const broken = options.brokenBefore ? ('site_broken_both' as const) : ('site_broken' as const)
  const told = await reporter.finish('reverify', checked.ok ? 'succeeded' : 'failed', {
    pages: checked.pages,
    ...(checked.ok ? {} : { code: broken }),
  })
  return { outcome: checked.ok ? 'rolled_back' : 'unknown', told }
}

/**
 * Р31, an attempt «только возврат»: the release of an earlier attempt ended `unknown`; this one
 * restores from that attempt's backup what production still holds of it, and writes nothing new.
 */
async function rollbackOnly(
  ctx: DeployContext,
  manifest: DeployManifest,
  reporter: Reporter,
): Promise<DeployResult> {
  const from = manifest.rollbackOf!
  try {
    await reporter.report('rollback', 'started')
    const layout = layoutOf(manifest)
    let access: DeployAccess
    try {
      access = await ctx.api.access()
    } catch {
      throw new StepFailed('stopped')
    }
    let gateway: SiteContentGateway | null = null
    if (manifest.db.length > 0) {
      if (access.content === null) throw new StepFailed('content_unavailable')
      try {
        gateway = ctx.contentGateway(access.content, manifest)
      } catch {
        throw new StepFailed('content_unavailable')
      }
      // Before anything is read: no write of the attempt rolled back can land after it.
      await raiseFence(gateway, manifest)
    }
    let restorable: Restorable
    try {
      const sealed = await ctx.download(from.backup, from.sizeBytes)
      if (sealed.byteLength !== from.sizeBytes || sha256(sealed) !== from.sha256)
        throw new Error('backup')
      const contents = await openBackup(
        sealed,
        ctx.backupKey,
        manifest.releaseId,
        from.deployAttempt,
      )
      restorable = {
        files: new Map(contents.files.map((file) => [file.path, file])),
        records: new Map(contents.records.map((record) => [record.objectRef, record])),
        folders: contents.folders,
      }
    } catch {
      throw new StepFailed('source_mismatch')
    }
    // A new record goes to the trash at the address it was given — a record an undo trashed
    // comes back from there —: its value says which.
    const values = new Map<string, OperationValue>()
    try {
      for (const { operation, after } of manifest.db) {
        if (operation.kind !== 'post_create' && operation.kind !== 'post_trash') continue
        const sealed = await ctx.download(after, dbPlanLimits.valueBytes * 2 + 1024)
        values.set(
          operation.objectRef,
          openOperationValue(sealed, ctx.backupKey, manifest.releaseId, operation, manifest.kind),
        )
      }
    } catch {
      throw new StepFailed('source_mismatch')
    }
    // A cache it cannot trust does not stop a rollback: what it put back is restored all the
    // same, and the end is `unknown` (restore).
    const cache = await codeCachePlan(ctx, access, manifest)
    // The rollback's own `started` was the first report: it is not sent twice.
    return await restore(ctx, manifest, layout, access.hosting, gateway, restorable, reporter, {
      writingAttempt: from.deployAttempt,
      attempted: null,
      created: new Map(),
      values,
      cache,
      started: true,
    })
  } catch (error) {
    if (error instanceof Stopped) return { outcome: 'unknown', told: true }
    const told = await reporter.finish('rollback', 'unknown', {
      code: error instanceof StepFailed ? error.code : 'hosting_unavailable',
    })
    return { outcome: 'unknown', told }
  }
}
