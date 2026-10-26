import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createImportPathPolicy,
  isDomainError,
  resolvePinnedAddress,
  siteAccessPath,
  siteImportLimits,
  siteRepositoryName,
  SITE_REPOSITORY_OWNER,
  type AppEnv,
  type CodeSourceTarget,
  type DatabaseEngine,
  type DatabaseInspector,
  type DatabaseTarget,
  type FileSourceAdapter,
  type FileSourceSession,
  type HostLookup,
  type PinnedAddress,
  type ProvisioningStageSummary,
  type RepoRef,
  type RepositoryInfo,
  type SecretStore,
  type SiteAccessKind,
  type SiteAdapter,
  type SiteRepositoryProvisioner,
  type SiteSourceAdapter,
  type SiteSourceKind,
  type SiteStack,
} from '@repo/domain'

import { runProcess } from '../git-workspace/process.ts'
import { CLONE_PREFIX } from '../git-workspace/stale-clones.ts'
import { trustedGitEnvironment } from '../git-workspace/trusted-git.ts'
import { ExactValues } from './exact-values.ts'
import { connectionFailure, hiccup, LeaseLost, refuse, sessionFailure } from './import-failure.ts'
import { scanForSecrets } from './import-scan.ts'
import { fetchOriginal, publicOriginalsOf, type FetchOriginal } from './public-originals.ts'
import { MAIN_REF, TAG_REF, type InitialVersionGit, type RemoteRefs } from './initial-version.ts'
import type {
  ClaimedStage,
  InitialVersionPlan,
  SiteImportStore,
  StageLease,
  StoredAccess,
  StoredReference,
} from './stage-store.ts'
import { readRootFile, walkSiteTree, type SkipCounts, type TakenFile } from './tree-walk.ts'

/** What the import needs of the stack's adapter: no CMS name ever reaches this file. */
export type StackImportRules = Pick<
  SiteAdapter,
  'importRules' | 'rootMarkers' | 'configSecrets' | 'publicOriginals'
>

/** What the import needs of a database inspector: the access it checks and the values it hides. */
export type DatabaseAccessRules = Pick<
  DatabaseInspector,
  'accessKind' | 'accessSchema' | 'matchesTarget' | 'scanValues'
>

export interface SiteImportGit {
  versions: InitialVersionGit
  /** GITEA_URL: the web root git_repositories.url starts with. */
  webRoot: string
}

export interface SiteImportDeps {
  appEnv: AppEnv
  store: SiteImportStore
  secrets: Pick<SecretStore, 'kvRead'>
  sources: (kind: SiteSourceKind) => SiteSourceAdapter
  /** The inspectors of @repo/site-connections: the password of the site's database is a secret too. */
  databases: (engine: DatabaseEngine) => DatabaseAccessRules
  stacks: (stack: SiteStack) => StackImportRules
  lookup: HostLookup
  /** null — no provisioner token (or no git): the import refuses `repository_not_configured`. */
  provisioner: SiteRepositoryProvisioner | null
  /** null — CoreConfig.git is: the import refuses `repository_not_configured`. */
  git: SiteImportGit | null
  gitleaksBinary: string
  /** Downloads the published original of a flagged file (`publicOriginalsOf`); tests fake it. */
  fetchOriginal?: FetchOriginal
  /** The time of the first commit. */
  now?: () => Date
  /** The stall rule of the file walk; tests make the window short. */
  stall?: { windowMs: number; bytes: number }
}

export interface ImportedVersion {
  commitSha: string
}

interface CheckedAccess {
  adapter: FileSourceAdapter
  access: unknown
  /** What the database access of the site holds (scanValues); empty without a database row. */
  databaseValues: string[]
}

interface Repository {
  id: string
  ref: RepoRef
  url: string
}

/** What every step of one run shares. */
interface ImportRun {
  stage: ClaimedStage
  lease: StageLease
  repository: Repository
  root: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  deps: SiteImportDeps
  git: SiteImportGit
  /**
   * The plan as the run found it. A push of `main` cannot be interrupted: one that outlived the
   * run that recorded this plan may still land while this run walks the site.
   */
  previous: InitialVersionPlan | null
}

/** The commit `main` holds once the run has it there, and the tag as the remote showed it. */
interface Published {
  sha: string
  /** `<root>/repo` has the commit: this run built it. */
  local: boolean
  tag: string | null
}

const addCounts = (into: SkipCounts, reason: keyof SkipCounts, count: number) => {
  if (count > 0) into[reason] = (into[reason] ?? 0) + count
}

/**
 * The code_import of one site, for the run that holds its stage (docs/plan/39-site-connection-
 * wizard.md, «Импорт» and «Восстановление публикации»): the access from Vault, the pinned
 * address, the repository `sites/site-<siteId>`, what the remote already has, the walk and the
 * scans, the root commit, `main` and `v0.0.0` without force, and the remote read back. Throws an
 * ImportFailure with the code of the stage, or LeaseLost; the private directory is gone after.
 * A retry never makes a second repository, a second root commit or another `v0.0.0`: once
 * `main` has the recorded commit only the tag and the check are left — the plan an earlier run
 * recorded included, when its push lands while this run walks the site; anything else at either
 * ref is `repository_mismatch`.
 */
export async function importSite(
  stage: ClaimedStage,
  signal: AbortSignal,
  deps: SiteImportDeps,
): Promise<ImportedVersion> {
  const lease: StageLease = { siteId: stage.siteId, leaseEpoch: stage.leaseEpoch }
  const root = await mkdtemp(join(tmpdir(), CLONE_PREFIX))
  try {
    const { git, provisioner } = deps
    if (!git || !provisioner) throw refuse('repository_not_configured')
    const env = trustedGitEnvironment(git.versions.context(root))
    await assertScanner(deps.gitleaksBinary, root, env)
    signal.throwIfAborted()

    const access = await readAccess(stage, lease, deps)
    const repository = await ensureRepository(stage, lease, provisioner, git, deps.store)
    signal.throwIfAborted()

    const refs = await git.versions.remoteRefs(root, repository.url, repository.ref)
    const previous = await deps.store.readPlan(stage.siteId)
    const run: ImportRun = { stage, lease, repository, root, env, signal, deps, git, previous }
    let published: Published
    if (refs.main === null) {
      // A tag without `main`: not a state an import leaves behind.
      if (refs.tag !== null) throw refuse('repository_mismatch')
      published = await fetchAndPublish(run, access)
    } else {
      // `main` is there: it must be the commit this site recorded, never rebuilt over.
      if (!previous || previous.commitSha !== refs.main) throw refuse('repository_mismatch')
      await deps.store.setStep(lease, 'publish')
      published = { sha: previous.commitSha, local: false, tag: refs.tag }
    }
    const { sha } = published

    signal.throwIfAborted()
    // A tag that appeared since the read makes the push refused, and publishRef reads it back.
    if (published.tag !== sha) {
      if (published.tag !== null) throw refuse('repository_mismatch')
      // The recorded commit is on the remote only: the tag needs a local copy of it to push.
      if (!published.local)
        await git.versions.fetchCommit(root, repository.url, repository.ref, sha)
      await assertHeld(deps.store, lease)
      signal.throwIfAborted()
      await publishRef(git.versions, root, repository, sha, TAG_REF)
    }

    const final = await git.versions.remoteRefs(root, repository.url, repository.ref)
    if (final.main !== sha || final.tag !== sha) throw refuse('repository_mismatch')
    return { commitSha: sha }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** The scanner must run before anything is downloaded: an import is never published unscanned. */
async function assertScanner(binary: string, root: string, env: NodeJS.ProcessEnv): Promise<void> {
  let code: number
  try {
    ;({ code } = await runProcess(binary, ['version'], { cwd: root, env, maxBytes: 4096 }))
  } catch {
    throw refuse('repository_not_configured')
  }
  if (code !== 0) throw refuse('repository_not_configured')
}

/** A held run: the push that follows is still this run's. */
async function assertHeld(store: SiteImportStore, lease: StageLease): Promise<void> {
  if (!(await store.heartbeat(lease))) throw new LeaseLost()
}

/**
 * The access of the stage: the source row and its reference (kind of the adapter, the site's
 * workspace, the one canonical path), the secret at the version the reference names, valid for
 * the adapter and agreeing with the row on everything both hold — and, when the site has a
 * database row, its access by the same checks: its password is searched for like the others.
 * Read on every run, the one that only finishes the tag included: a site that is no longer being
 * connected is refused.
 */
async function readAccess(
  stage: ClaimedStage,
  lease: StageLease,
  deps: SiteImportDeps,
): Promise<CheckedAccess> {
  const stored: StoredAccess = await deps.store.readAccess(lease)
  if (stored.siteStatus !== 'onboarding') throw refuse('access_refused')
  const { source, reference } = stored
  if (!source || !reference) throw refuse('access_missing')
  let adapter: SiteSourceAdapter
  try {
    adapter = deps.sources(source.kind)
  } catch {
    throw refuse('unsupported')
  }
  // The adapter says how the tree is obtained; this slice fetches files only.
  if (adapter.transfer !== 'files') throw refuse('unsupported')
  const data = await readReferenced(stage, stored.workspaceId, reference, adapter.accessKind, deps)
  const parsed = adapter.accessSchema.safeParse(data)
  if (!parsed.success) throw refuse('access_mismatch')
  const target: CodeSourceTarget = {
    kind: source.kind,
    host: source.host,
    port: source.port,
    rootPath: source.rootPath,
    repositoryUrl: source.repositoryUrl,
    branch: source.branch,
    tls: source.tls,
    hostKey: source.hostKey,
  }
  if (!adapter.matchesTarget(parsed.data, target)) throw refuse('access_mismatch')
  return { adapter, access: parsed.data, databaseValues: await databaseValues(stage, stored, deps) }
}

/** The values the database access of the site holds; none without a database row. */
async function databaseValues(
  stage: ClaimedStage,
  stored: StoredAccess,
  deps: SiteImportDeps,
): Promise<string[]> {
  const database = stored.database
  if (!database) return []
  if (!database.reference) throw refuse('access_missing')
  let inspector: DatabaseAccessRules
  try {
    inspector = deps.databases(database.row.engine)
  } catch {
    throw refuse('unsupported')
  }
  const data = await readReferenced(
    stage,
    stored.workspaceId,
    database.reference,
    inspector.accessKind,
    deps,
  )
  const parsed = inspector.accessSchema.safeParse(data)
  if (!parsed.success) throw refuse('access_mismatch')
  const target: DatabaseTarget = {
    engine: database.row.engine,
    host: database.row.host,
    port: database.row.port,
    databaseName: database.row.databaseName,
    tls: database.row.tls,
  }
  if (!inspector.matchesTarget(parsed.data, target)) throw refuse('access_mismatch')
  return inspector.scanValues(parsed.data)
}

/**
 * The secret a reference names: of this kind, of the site and its workspace, at the one canonical
 * path, read at the version the reference names. A newer version that a request wrote before it
 * failed to move the reference is not this access and does not stand in for it.
 */
async function readReferenced(
  stage: ClaimedStage,
  workspaceId: string,
  reference: StoredReference,
  kind: SiteAccessKind,
  deps: SiteImportDeps,
): Promise<Record<string, string>> {
  let path: string
  try {
    path = siteAccessPath(stage.siteId, kind)
  } catch {
    throw refuse('access_mismatch')
  }
  if (
    reference.kind !== kind ||
    reference.siteId !== stage.siteId ||
    reference.workspaceId !== workspaceId ||
    reference.vaultPath !== path ||
    !Number.isSafeInteger(reference.keyVersion) ||
    reference.keyVersion < 1
  )
    throw refuse('access_mismatch')
  let secret: Awaited<ReturnType<SecretStore['kvRead']>>
  try {
    secret = await deps.secrets.kvRead(path, { version: reference.keyVersion })
  } catch {
    // Vault away: nothing about the access is known yet.
    throw hiccup('internal')
  }
  // Deleted, destroyed or never written at that version.
  if (!secret) throw refuse('access_missing')
  if (secret.version !== reference.keyVersion) throw refuse('access_mismatch')
  return secret.data
}

/** The address the secret names, by the rule of the wizard: the one literal every socket dials. */
async function pinAddress(
  checked: CheckedAccess,
  signal: AbortSignal,
  deps: SiteImportDeps,
): Promise<PinnedAddress> {
  const pinned = await resolvePinnedAddress(
    { lookup: deps.lookup, appEnv: deps.appEnv },
    checked.adapter.endpointOf(checked.access).host,
    signal,
  )
  if (!pinned.ok) throw connectionFailure(pinned.reason)
  return pinned.address
}

/**
 * The private, empty repository of the site (idempotent: an earlier run's repository is
 * confirmed, not made again) and its row. A refusal of Gitea is final, our Gitea away is not.
 */
async function ensureRepository(
  stage: ClaimedStage,
  lease: StageLease,
  provisioner: SiteRepositoryProvisioner,
  git: SiteImportGit,
  store: SiteImportStore,
): Promise<Repository> {
  const name = siteRepositoryName(stage.siteId)
  let info: RepositoryInfo
  try {
    info = await provisioner.ensureRepository(name)
  } catch (error) {
    if (isDomainError(error)) {
      if (error.code === 'GIT_PROVIDER_NOT_CONFIGURED') throw refuse('repository_not_configured')
      const reason = (error.details as { reason?: unknown } | undefined)?.reason
      // A refusal by its reason (unauthorized, forbidden, not_ours) or an invalid name.
      if (typeof reason === 'string' || error.code === 'BAD_REQUEST')
        throw refuse('repository_not_created')
    }
    throw hiccup('repository_not_created')
  }
  if (
    info.ref.owner !== SITE_REPOSITORY_OWNER ||
    info.ref.name !== name ||
    !info.private ||
    info.defaultBranch !== 'main'
  )
    throw refuse('repository_not_created')
  const url = await git.versions.remoteUrl(info.cloneUrl)
  const id = await store.recordRepository(lease, {
    provider: info.ref.provider,
    owner: info.ref.owner,
    name: info.ref.name,
    url: `${git.webRoot}/${info.ref.owner}/${info.ref.name}`,
  })
  return { id, ref: info.ref, url }
}

/**
 * Pushes the tag without force; a refusal is read back from the remote: the same commit there
 * is fine (an earlier push landed), another one is `repository_mismatch`.
 */
async function publishRef(
  versions: InitialVersionGit,
  root: string,
  repository: Repository,
  sha: string,
  target: typeof TAG_REF,
): Promise<void> {
  if (await versions.push(root, repository.url, repository.ref, sha, target)) return
  const refs = await versions.remoteRefs(root, repository.url, repository.ref)
  if (refs.tag === sha) return
  if (refs.tag !== null) throw refuse('repository_mismatch')
  throw hiccup('repository_push_failed')
}

/**
 * `main` already holds a commit this run did not push. Only the plan the run found is taken
 * over: the push of the run that recorded it outlived that run and landed. It is recorded again
 * under this lease — fenced, as every write — with what this walk left out, and the run goes on
 * to the tag. Any other commit there is `repository_mismatch`.
 */
async function adoptPrevious(
  run: ImportRun,
  refs: RemoteRefs,
  skipped: SkipCounts,
): Promise<Published> {
  const { previous } = run
  if (!previous || refs.main !== previous.commitSha) throw refuse('repository_mismatch')
  const { files, bytes } = previous
  await run.deps.store.recordPlan(
    run.lease,
    { gitRepositoryId: run.repository.id, commitSha: previous.commitSha, files, bytes },
    { files, bytes, skipped },
  )
  return { sha: previous.commitSha, local: false, tag: refs.tag }
}

/**
 * The walk through the file session, the exact secrets and gitleaks, the root commit, its plan
 * in site_initial_versions (before any push: a retry knows what may already be there) and `main`
 * — unless the plan the run found reached `main` meanwhile (adoptPrevious).
 */
async function fetchAndPublish(run: ImportRun, checked: CheckedAccess): Promise<Published> {
  const { lease, repository, root, signal, deps, git } = run
  const { taken, skipped } = await fetchTree(run, checked)

  signal.throwIfAborted()
  await deps.store.setStep(lease, 'publish')
  const built = await git.versions.buildCommit(
    root,
    taken,
    run.stage.siteId,
    (deps.now ?? (() => new Date()))(),
  )
  addCounts(skipped, 'unsupported_path', built.dropped)
  const bytes = built.files.reduce((total, file) => total + file.bytes, 0)
  // The last look before the plan is replaced: a late push of the plan found is taken over.
  const late = await git.versions.remoteRefs(root, repository.url, repository.ref)
  if (late.main !== null) return adoptPrevious(run, late, skipped)
  if (late.tag !== null) throw refuse('repository_mismatch')
  const summary: ProvisioningStageSummary = { files: built.files.length, bytes, skipped }
  await deps.store.recordPlan(
    lease,
    { gitRepositoryId: repository.id, commitSha: built.sha, files: built.files.length, bytes },
    summary,
  )
  // The copies are in the repository now; the disk of core keeps one of them, not two.
  await rm(join(root, 'blobs'), { recursive: true, force: true })
  signal.throwIfAborted()
  // Without force: the server refuses a `main` that would not fast-forward.
  if (await git.versions.push(root, repository.url, repository.ref, built.sha, MAIN_REF))
    return { sha: built.sha, local: true, tag: null }
  const refs = await git.versions.remoteRefs(root, repository.url, repository.ref)
  // An earlier push of this commit landed.
  if (refs.main === built.sha) return { sha: built.sha, local: true, tag: refs.tag }
  // The plan found landed after the last look: taken over all the same.
  if (refs.main !== null) return adoptPrevious(run, refs, skipped)
  throw hiccup('repository_push_failed')
}

/** The walk and the scans: the files the import takes, and what it left out. */
async function fetchTree(
  run: ImportRun,
  checked: CheckedAccess,
): Promise<{ taken: TakenFile[]; skipped: SkipCounts }> {
  const { stage, root, env, signal, deps } = run
  const rules = deps.stacks(stage.stack)
  const policy = createImportPathPolicy(
    rules.importRules({ stack: stage.stack, url: stage.url, docroot: '/', extras: {} }).exclude,
  )
  // Only now, and only this way: a run that just finishes the tag never dials the client.
  const address = await pinAddress(checked, signal, deps)
  const blobs = join(root, 'blobs')
  await mkdir(blobs, { mode: 0o700 })

  // The stall rule: a walk that does less than stallBytes of work in a full window has stalled.
  // A listing counts its work only once it is complete, and the adapters bound its silence
  // themselves: a window in which one ran is never a stalled one.
  const stall = deps.stall ?? {
    windowMs: siteImportLimits.stallWindowMs,
    bytes: siteImportLimits.stallBytes,
  }
  const stalled = new AbortController()
  const walkSignal = AbortSignal.any([signal, stalled.signal])
  let work = 0
  let mark = 0
  let listing = 0
  let listedInWindow = false
  const watch = setInterval(() => {
    const listed = listing > 0 || listedInWindow
    listedInWindow = false
    if (!listed && work - mark < stall.bytes) stalled.abort()
    mark = work
  }, stall.windowMs)
  watch.unref()

  let walk
  try {
    let opened: FileSourceSession
    try {
      opened = await checked.adapter.open(checked.access, { address, signal: walkSignal })
    } catch (error) {
      throw sessionFailure(error)
    }
    const session: FileSourceSession = {
      concurrency: opened.concurrency,
      list: async (directory, maxEntries) => {
        listing += 1
        listedInWindow = true
        try {
          return await opened.list(directory, maxEntries)
        } finally {
          listing -= 1
          listedInWindow = true
        }
      },
      read: (path, sink, maxBytes) => opened.read(path, sink, maxBytes),
      close: () => opened.close(),
    }
    try {
      let configValues: string[]
      try {
        configValues = await rules.configSecrets((path) => readRootFile(session, path, walkSignal))
      } catch (error) {
        throw sessionFailure(error)
      }
      const values = new ExactValues([
        ...checked.adapter.scanValues(checked.access),
        ...checked.databaseValues,
        ...configValues,
      ])
      walk = await walkSiteTree({
        session,
        policy,
        markers: rules.rootMarkers(),
        blobs,
        values,
        signal: walkSignal,
        onWork: (done) => {
          work += done
        },
      })
    } finally {
      await session.close().catch(() => {})
    }
  } catch (error) {
    // Ours to say: the stall, not whatever the session made of its destroyed sockets.
    if (stalled.signal.aborted && !signal.aborted) throw hiccup('transfer_failed')
    throw error
  } finally {
    clearInterval(watch)
  }
  signal.throwIfAborted()
  if (walk.files.length === 0) throw refuse('source_empty')

  const flagged = await scanForSecrets({
    files: walk.files,
    root,
    gitleaksBinary: deps.gitleaksBinary,
    env,
    signal,
  })
  // Public code the scan mistook for a secret — a release file of a plugin, a theme or the core
  // — is taken when it is its published original byte for byte (owner's decision of 26.10.2026).
  const vouched = await publicOriginalsOf({
    rules,
    files: walk.files,
    flagged,
    signal,
    fetch: deps.fetchOriginal ?? fetchOriginal,
  })
  const taken = walk.files.filter((_, index) => !flagged.has(index) || vouched.has(index))
  const skipped: SkipCounts = { ...walk.skipped }
  addCounts(skipped, 'secret', flagged.size - vouched.size)
  if (taken.length === 0) throw refuse('source_empty')
  return { taken, skipped }
}
