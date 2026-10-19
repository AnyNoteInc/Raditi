import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'

import {
  addOnlyPathOf,
  addOnlyPathSchema,
  assertCandidateChange,
  assertCandidateMedia,
  assertCandidatePath,
  badRequest,
  candidateRulesOf,
  conflict,
  DomainError,
  envValueBytes,
  envValueInChange,
  forbidden,
  isDomainError,
  isPublicationPath,
  mediaLimits,
  notFound,
  publicationForbidden,
  publicationLimits,
  publicationMetadataSchema,
  publicationRulesHold,
  publicationShaSchema,
  publicationSourceSchema,
  publicationSecret,
  publicationTooLarge,
  repositoryTooLarge,
  repositoryUnsupported,
  snapshotHasCredential,
  snapshotLimits,
  turnOutputRejected,
  workingSetCommitMessage,
  workingSetMatcher,
  workingSetTooLarge,
  type AgentWorkingSet,
  type CandidateRules,
  type GitCredentials,
  type GitProvider,
  type PublicationMetadata,
  type PublicationSource,
  type RepoRef,
  type TurnBundleSource,
  type TurnPublication,
  type TurnWorkspace,
  withTimeout,
} from '@repo/domain'
import { z } from 'zod'

import { emptyUntrackedArchive, untrackedFiles } from './archive.ts'
import { BASE_BUNDLE_REF, bundleHead } from './base-bundle.ts'
import { assertBinaryPatchLimits } from './binary-limits.ts'
import {
  assertPrivateDirectory,
  BundleCache,
  defaultMirrorDir,
  KeyedLock,
  mirrorPath,
} from './mirror-store.ts'
import { PROCESS_OUTPUT_LIMIT, runProcess, type ProcessResult } from './process.ts'
import { CLONE_PREFIX } from './stale-clones.ts'
import { TAR_END, tarFileHeader, tarPadding } from './tree-tar.ts'

export interface GitWorkspaceOptions {
  transport:
    | {
        kind: 'https'
        allowedOrigins: readonly string[]
        /**
         * Absolute path of a PEM bundle git also trusts (GIT_SSL_CAINFO): the CA of our own
         * Gitea. It adds trust and removes none: with the libcurl of the orchestrator image the
         * system store stays trusted. HTTPS and certificate checks stay on either way.
         */
        caFile?: string
      }
    | { kind: 'local-test'; root: string }
  gitleaksBinary?: string
  /**
   * Absolute directory of the repository mirrors and the bundle cache (GIT_MIRROR_DIR, plan 53,
   * Р10); `<tmpdir>/raditi-mirrors` when absent.
   */
  mirrorDir?: string
}

/**
 * One operation's private repository: no checkout, objects of the site read from the mirror
 * (`objects/info/alternates`), its own objects and index. Nothing of it outlives dispose().
 */
interface Workspace {
  root: string
  repo: string
  url: string
  ref: RepoRef
}
interface Entry {
  mode: string
  oid: string
  path: string
}
/**
 * The tree of `expectedBaseSha`. With a working set, `slice` is the part the agent gets, held to
 * the strict rules of a repository (regular files within the limits); the rest of the tree may
 * hold what the agent never sees — links, submodules, a media library above the tree limit.
 */
interface BaseTree {
  entries: Map<string, Entry>
  slice: {
    set: AgentWorkingSet
    /** In the working set and not below an add-only directory: what the sandbox gets. */
    has: (path: string) => boolean
    entries: Map<string, Entry>
    sizes: Map<string, number>
    bytes: number
  } | null
}
/** One changed path of a `diff-tree --raw`: modes and objects before and after. */
interface RawChange {
  path: string
  status: 'A' | 'M' | 'D' | 'T'
  oldMode: string
  newMode: string
  oldOid: string
  newOid: string
}
/** Who asks for the rebase of a candidate onto a new base (plan 53, Р27, «Обновить»). */
export interface CandidateRebaseInput {
  repo: RepoRef
  /** `agent/<taskId>`, whose head is `branchHead` (`head` unless named). */
  branch: string
  /** The base the candidate stands on: an ancestor of `head`. */
  fromBase: string
  /** The new base, the head of `main` now. */
  toBase: string
  /** The commit whose change is carried. */
  head: string
  /**
   * Where the branch stands, when it is not `head`: a turn the platform refused published past
   * the candidate (docs/plan/53, «Попробовать ещё (18.10)»). The update replaces it — the push is
   * leased on it — and does not carry it.
   */
  branchHead?: string
  /** The trusted instant of the update: the same input gives the same commit. */
  committedAt: string
  /**
   * The rules of the site's workspace (`siteWorkspaceRules`), as the turns of the task had them:
   * every path the result changes against `toBase` is held to them, as publication held the
   * candidate. Absent — the result is still held to the paths the candidate itself changed.
   */
  rules?: Pick<PublicationSource, 'protectedPaths' | 'workingSet' | 'addOnlyPaths' | 'media'>
}
export type CandidateRebase =
  | { status: 'rebased'; headSha: string; treeSha: string }
  /**
   * The change does not carry over as it is: both sides changed these paths, or the merge would
   * change a path the candidate never did. Nothing was written.
   */
  | { status: 'conflict'; paths: string[] }
/** What a candidate of a dialog needs to know about its commits (plan 53, R3: CandidateGit). */
export interface CommitComparisonInput {
  repo: RepoRef
  baseSha: string
  headSha: string
  /** `SiteAdapter.mediaRules().addOnlyPaths`: the bytes of files added below are returned. */
  addOnlyPaths: readonly string[]
}
export interface CommitComparison {
  baseTree: string
  headTree: string
  /** `git diff --binary --full-index --no-renames base head`, as candidatePatch writes it. */
  patch: Uint8Array
  files: Array<{
    path: string
    change: 'added' | 'modified' | 'deleted'
    /** After the change; 0 for a deleted file. */
    sizeBytes: number
    executable: boolean
  }>
  /** The files added below `addOnlyPaths`, with their content (each at most 8 MiB). */
  added: Array<{ path: string; bytes: Uint8Array }>
}
/** The files of a commit for the docroot of a preview (plan 53, Р16, Р22: R5c). */
export interface TreeExportInput {
  repo: RepoRef
  sha: string
  /** Only these files of the tree; absent — the whole tree, empty — none (an empty archive). */
  paths?: readonly string[]
  /** Files of the tree left out of the archive (the platform's own files of a preview). */
  exclude?: readonly string[]
}
export interface ExportedTree {
  /** A tar of the regular files (`tree-tar.ts`): what infra/preview/files.mjs writes. */
  archive: AsyncIterable<Uint8Array>
  files: number
  bytes: number
}
/** How much of a tree a preview takes: the limits of infra/preview/files.mjs. */
export const treeExportLimits = Object.freeze({
  files: 200_000,
  bytes: 4 * 1024 ** 3,
  /** Blobs read by one `cat-file --batch`, unless a single blob is larger. */
  batchBytes: 64 * 1024 * 1024,
})
const CREDENTIAL_TTL_SECONDS = 120
const BOT_NAME = 'Raditi Bot'
const BOT_EMAIL = 'bot@raditi.ru'
const GITLEAKS_CONFIG = '[extend]\nuseDefault = true\n'
/** Gitleaks exits 1 on its own errors too: `--exit-code` changes only the code of a finding. */
const GITLEAKS_FINDING_EXIT = 99
/**
 * Gitleaks skips a file whose first bytes match an application type (archive, PDF, program),
 * some at offsets 128, 257 or 32769, so a newline alone would only shift them. Its detector
 * tries image types first: behind this header it reads the content whatever it starts with.
 * Every copy gets it: one invalid UTF-8 byte must not turn a text file into a skipped one.
 */
const SCAN_PREFIX = Buffer.from('GIF89a\n')
export const scanCopy = (blob: Buffer): Buffer => Buffer.concat([SCAN_PREFIX, blob])
const failed = () =>
  new DomainError('GIT_OPERATION_FAILED', 'Trusted repository operation failed', 502)
/** The platform's bot: the author and committer of every trusted commit, at a fixed instant. */
const botIdentity = (at: string): NodeJS.ProcessEnv => {
  const date = `${Math.floor(Date.parse(at) / 1000)} +0000`
  return {
    GIT_AUTHOR_NAME: BOT_NAME,
    GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: BOT_NAME,
    GIT_COMMITTER_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_DATE: date,
  }
}
const instantSchema = z.iso.datetime().refine((value) => Number.isFinite(Date.parse(value)))
const rebaseSchema = z
  .object({
    repo: publicationSourceSchema.shape.repo,
    branch: publicationSourceSchema.shape.branch,
    fromBase: publicationShaSchema,
    toBase: publicationShaSchema,
    head: publicationShaSchema,
    branchHead: publicationShaSchema.optional(),
    committedAt: instantSchema,
    rules: publicationSourceSchema
      .pick({ protectedPaths: true, workingSet: true, addOnlyPaths: true, media: true })
      .strict()
      .refine(publicationRulesHold)
      .optional(),
  })
  .strict()
const treeExportSchema = z
  .object({
    repo: publicationSourceSchema.shape.repo,
    sha: publicationShaSchema,
    paths: z.array(z.string().refine(isPublicationPath)).max(treeExportLimits.files).optional(),
    exclude: z.array(z.string().refine(isPublicationPath)).max(64).optional(),
  })
  .strict()
const changedPathsSchema = z
  .object({
    repo: publicationSourceSchema.shape.repo,
    fromSha: publicationShaSchema,
    toSha: publicationShaSchema,
    limit: z.number().int().min(1).max(publicationLimits.files),
  })
  .strict()
const comparisonSchema = z
  .object({
    repo: publicationSourceSchema.shape.repo,
    baseSha: publicationShaSchema,
    headSha: publicationShaSchema,
    addOnlyPaths: z.array(addOnlyPathSchema).max(8),
  })
  .strict()
/** Any branch of the site, not only `agent/<taskId>`: the default branch is read too. */
const branchHeadSchema = z
  .object({
    repo: publicationSourceSchema.shape.repo,
    branch: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
      .refine((value) => !/\.\.|\/\/|\/$|\.$|\.lock$/.test(value)),
  })
  .strict()
/**
 * A commit of the platform on a branch of the site (plan 53, Р27): the release commit and its
 * revert. The bot is its author and committer at `committedAt`, so the same input is the same SHA.
 */
export interface TrustedCommitInput {
  repo: RepoRef
  /** The commit whose tree the new commit has. */
  treeOf: string
  /**
   * Paths whose entries come from another commit instead (plan 53, «Отмена выпуска»: the undo of
   * a release has the tree of the version before it and the media the release added). Each must
   * be a regular file of `from`.
   */
  overlay?: TreeOverlay
  /** Its only parent. */
  parent: string
  /** UTF-8 text without NUL, at most 4 KiB. */
  message: string
  committedAt: string
}
export interface TreeOverlay {
  from: string
  paths: readonly string[]
}
export type TrustedCommitPush =
  /** Pushed now, or the branch already stood at the commit. */
  | { status: 'pushed' | 'present'; sha: string }
  /** The branch stood neither at `expected` nor at the commit: nothing was pushed. */
  | { status: 'moved'; sha: string; remote: string | null }
/** One path a commit changes against another, with the SHA-256 of its content on each side. */
export interface ChangeDigest {
  path: string
  change: 'added' | 'modified' | 'deleted'
  /** Of the content before; null for an added path. */
  before: string | null
  /** Of the content after; null for a deleted path. */
  after: string | null
  /** After the change; 0 for a deleted path. */
  sizeBytes: number
  executable: boolean
}
const trustedCommitSchema = z
  .object({
    repo: publicationSourceSchema.shape.repo,
    treeOf: publicationShaSchema,
    parent: publicationShaSchema,
    message: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0')),
    committedAt: instantSchema,
    overlay: z
      .object({
        from: publicationShaSchema,
        paths: z
          .array(z.string().refine(isPublicationPath))
          .max(publicationLimits.repositoryFiles)
          .refine((paths) => new Set(paths).size === paths.length),
      })
      .strict()
      .optional(),
  })
  .strict()
/** Never a task branch — those are publication's (`agent/<taskId>`) — nor a name like a ref. */
const trustedPushSchema = trustedCommitSchema
  .extend({
    branch: branchHeadSchema.shape.branch.refine(
      (value) => !value.startsWith('agent/') && !value.startsWith('refs/'),
    ),
    expected: publicationShaSchema,
  })
  .strict()
/** The commits a trusted commit is made of: its tree, its parent and an overlay's source. */
const trustedCommitShas = (commit: z.infer<typeof trustedCommitSchema>): string[] => [
  commit.treeOf,
  commit.parent,
  ...(commit.overlay && commit.overlay.paths.length > 0 ? [commit.overlay.from] : []),
]
const digestSchema = z
  .object({
    repo: publicationSourceSchema.shape.repo,
    baseSha: publicationShaSchema,
    headSha: publicationShaSchema,
  })
  .strict()
type Refusal = (message: string) => Error
/** Who answers for a listed entry or blob that cannot be published. */
interface Scope {
  tooLarge: Refusal
  /** A link, submodule or other entry that is not a regular file. */
  entry: Refusal
  /** A path that is not valid UTF-8 or fails isPublicationPath. */
  path: Refusal
  /** An object listed as a blob that is not one. */
  blob: Refusal
}
/** The site's own repository: what the agent cannot work with is the site's, not the agent's. */
const REPOSITORY: Scope = {
  tooLarge: repositoryTooLarge,
  entry: repositoryUnsupported,
  path: repositoryUnsupported,
  blob: () => failed(),
}
/** The agent's part of the site: what the sandbox cannot take is a working set too large. */
const WORKING_SET: Scope = {
  tooLarge: workingSetTooLarge,
  entry: repositoryUnsupported,
  path: repositoryUnsupported,
  blob: () => failed(),
}
/** The candidate adds only the agent's changes to that checked tree. */
const CANDIDATE: Scope = {
  tooLarge: publicationTooLarge,
  entry: publicationForbidden,
  path: turnOutputRejected,
  blob: turnOutputRejected,
}
/** Rows of the full tree outside the working set: links and submodules the agent never sees. */
const ANY_TREE_ROW = /^(100644|100755|120000|160000) (?:blob|commit) ([a-f0-9]{40})\t([^\0]+)$/
const ANY_INDEX_ROW = /^(100644|100755|120000|160000) ([a-f0-9]{40}) 0\t([^\0]+)$/
/** At most one `ls-tree -z` or `ls-files --stage -z` row per file: mode, type, OID, path, NUL. */
const listBytes = (files: number) => files * (64 + publicationLimits.pathBytes)
/** The client's base tree plus at most the agent's changed files. */
const CANDIDATE_FILES = publicationLimits.repositoryFiles + publicationLimits.files
/**
 * The full tree of a site whose agent gets a working set: with the core and the media library in
 * git (plan 39, Р16) its size is the site's, not the agent's — the working set alone keeps
 * `repositoryFiles` and the byte limits. The listing is still read whole into memory, once per
 * operation, so it keeps limits of its own.
 */
const FULL_TREE_FILES = 500_000
const FULL_TREE_LIST_BYTES = 128 * 1024 * 1024
/** `diff-tree --raw -z` of a candidate: `:<mode> <mode> <oid> <oid> <status>`, NUL, the path, NUL. */
const RAW_CHANGE = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDT])$/
const text = (bytes: Uint8Array, invalid: () => Error = failed) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalid()
  }
}

/** Consecutive groups of blobs, each within `limit` bytes unless a single blob is larger. */
function batches(blobs: [string, number][], limit: number): [string, number][][] {
  const groups: [string, number][][] = []
  let bytes = 0
  for (const blob of blobs) {
    if (!groups.length || bytes + blob[1] > limit) {
      groups.push([])
      bytes = 0
    }
    groups.at(-1)!.push(blob)
    bytes += blob[1]
  }
  return groups
}

/**
 * Git data is used only in host-owned repositories, never in the agent's .git directory: a bare
 * mirror per site repository, refreshed by fetch, and for each operation a private repository
 * that reads the mirror's objects and writes its own (plan 53, Р10).
 */
export class GitWorkspaceService implements TurnWorkspace {
  readonly #mirrorDir: string
  readonly #mirrors = new KeyedLock()
  readonly #bundles: BundleCache
  #initialConfig: Promise<Buffer> | undefined

  constructor(
    private readonly provider: GitProvider,
    private readonly options: GitWorkspaceOptions,
  ) {
    if (options.mirrorDir !== undefined && !isAbsolute(options.mirrorDir))
      throw badRequest('Repository mirror directory must be an absolute path')
    this.#mirrorDir = options.mirrorDir ?? defaultMirrorDir()
    this.#bundles = new BundleCache(this.#mirrorDir)
    if (options.transport.kind === 'local-test' && process.env.NODE_ENV !== 'test') {
      throw badRequest('Local repository transport is restricted to tests')
    }
    if (
      options.transport.kind === 'https' &&
      options.transport.allowedOrigins.some((origin) => {
        try {
          const url = new URL(origin)
          return url.protocol !== 'https:' || url.origin !== origin
        } catch {
          return true
        }
      })
    )
      throw badRequest('Invalid repository origin allowlist')
    if (options.transport.kind === 'https' && options.transport.caFile !== undefined) {
      const { caFile } = options.transport
      let regular = false
      try {
        regular = typeof caFile === 'string' && isAbsolute(caFile) && statSync(caFile).isFile()
      } catch {
        // A missing file fails here, at start, and not inside the first turn's clone.
      }
      if (!regular) throw badRequest('Repository CA file must be an absolute path of a file')
    }
    assertPrivateDirectory(this.#mirrorDir)
  }

  /**
   * The commit a branch of the site points at, or null when the branch does not exist: read
   * with a short read-only credential and without a clone. The planner takes a turn's
   * `expectedBaseSha` from it.
   */
  async readBranchHead(input: { repo: RepoRef; branch: string }): Promise<string | null> {
    const parsed = branchHeadSchema.safeParse(input)
    if (!parsed.success || parsed.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid repository branch')
    const { repo, branch } = parsed.data
    const url = await this.repositoryUrl(repo)
    const root = await mkdtemp(join(tmpdir(), CLONE_PREFIX))
    // No clone: ls-remote runs in the empty private directory.
    const workspace = { root, repo: root, url, ref: repo }
    try {
      const auth = await this.auth(repo, 'read')
      return (await this.remoteHead(workspace, `refs/heads/${branch}`, auth)) || null
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /**
   * A trusted bundle carries objects and one ref, with no remote credentials, config or hooks.
   * With a working set the ref points at its root commit (`sandboxBaseSha`), made at
   * `committedAt`, and the bundle holds that part of the tree only (plan 53, Р11).
   */
  async buildBaseBundle(input: PublicationSource, committedAt?: string): Promise<TurnBundleSource> {
    const source = this.source(input)
    const at = this.workingSetInstant(source, committedAt)
    const workspace = await this.workspace(source.repo, [source.expectedBaseSha])
    try {
      const base = await this.baseTree(workspace, source)
      const sandboxBaseSha = base.slice
        ? await this.workingSetCommit(workspace, source, base, at!)
        : undefined
      const head = sandboxBaseSha ?? source.expectedBaseSha
      const bundle =
        (await this.cachedBundle(head)) ?? (await this.bundle(workspace, head, base.slice !== null))
      return {
        baseSha: source.expectedBaseSha,
        ...(sandboxBaseSha ? { sandboxBaseSha } : {}),
        branch: source.branch,
        sha256: createHash('sha256').update(bundle).digest('hex'),
        sizeBytes: bundle.byteLength,
        // Each reader gets its own copy; the importer checks the hash of what it read.
        read: async function* () {
          yield Buffer.from(bundle)
        },
      }
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /**
   * The working-set commit of the source at `committedAt` — the one buildBaseBundle bundles —
   * or null without a working set. Recovery derives it again here instead of storing it.
   */
  async sandboxBase(input: PublicationSource, committedAt: string): Promise<string | null> {
    const source = this.source(input)
    if (!source.workingSet) return null
    const at = this.workingSetInstant(source, committedAt)!
    const workspace = await this.workspace(source.repo, [source.expectedBaseSha])
    try {
      return await this.workingSetCommit(
        workspace,
        source,
        await this.baseTree(workspace, source),
        at,
      )
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /** The tree a commit of the site points at (plan 53: release readiness compares trees). */
  async treeOf(input: { repo: RepoRef; sha: string }): Promise<string> {
    const parsed = z
      .object({ repo: publicationSourceSchema.shape.repo, sha: publicationShaSchema })
      .strict()
      .safeParse(input)
    if (!parsed.success || parsed.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid repository commit')
    const { repo, sha } = parsed.data
    const workspace = await this.workspace(repo, [sha])
    try {
      return this.sha(
        (await this.git(workspace, ['rev-parse', '--verify', `${sha}^{tree}`])).stdout,
      )
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /**
   * «Обновить» (plan 53, Р27): the candidate's changes since `fromBase` carried onto `toBase` by
   * a three-way merge of trees, without a model and without rename detection — a change stays at
   * its own path and never follows a file `main` moved, into a folder the candidate may not
   * touch, say. The result may change against `toBase` only paths the candidate changed against
   * `fromBase`, each held to `rules` when given; anything else is a conflict. It is one commit of
   * the bot on `toBase` at `committedAt`, so a retry makes the same SHA, and it replaces the task
   * branch by CAS — the branch must still be at `head` (or already at the result). A conflict
   * writes nothing. `assertFence` — the site lease of the update — runs right before the push
   * and is required, as for publish().
   */
  async rebaseCandidate(
    input: CandidateRebaseInput,
    // Optional in the type only for the port of the dialogs (CandidateGit); refused when absent.
    assertFence?: () => Promise<void>,
  ): Promise<CandidateRebase> {
    if (typeof assertFence !== 'function') throw badRequest('A rebase fence is required')
    const parsed = rebaseSchema.safeParse(input)
    if (!parsed.success || parsed.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid candidate rebase')
    const { repo, branch, fromBase, toBase, head, committedAt, rules } = parsed.data
    const branchHead = parsed.data.branchHead ?? head
    const taskId = branch.slice('agent/'.length)
    const workspace = await this.workspace(
      repo,
      branchHead === head ? [fromBase, toBase, head] : [fromBase, toBase, head, branchHead],
    )
    try {
      const ancestor = await this.command(workspace, [
        'merge-base',
        '--is-ancestor',
        fromBase,
        head,
      ])
      if (ancestor.code === 1) throw conflict('The candidate does not stand on its base')
      if (ancestor.code !== 0) throw failed()
      const merged = await this.command(
        workspace,
        [
          'merge-tree',
          '--write-tree',
          '-X',
          'no-renames',
          '-z',
          '--name-only',
          '--no-messages',
          `--merge-base=${fromBase}`,
          toBase,
          head,
        ],
        undefined,
        listBytes(publicationLimits.files),
      )
      if (merged.code !== 0 && merged.code !== 1) throw failed()
      const fields = text(merged.stdout).split('\0')
      if (fields.at(-1) !== '') throw failed()
      const tree = this.sha(Buffer.from(fields[0] ?? ''))
      if (merged.code === 1) return { status: 'conflict', paths: fields.slice(1, -1).slice(0, 100) }
      // What the result changes is the candidate's change and nothing else.
      const own = new Set((await this.rawChanges(workspace, fromBase, head)).map((c) => c.path))
      const changes = await this.rawChanges(workspace, toBase, tree)
      const foreign = changes.filter((change) => !own.has(change.path))
      if (foreign.length)
        return { status: 'conflict', paths: foreign.slice(0, 100).map((change) => change.path) }
      if (rules)
        await this.checkChanges(
          workspace,
          changes,
          candidateRulesOf({ repo, branch, expectedBaseSha: toBase, ...rules }),
        )
      const message = `Raditi task ${taskId}, updated onto ${toBase}\n\nRaditi-Task: ${taskId}\nRaditi-Base: ${toBase}\n`
      const headSha = this.sha(
        (
          await this.git(
            workspace,
            ['commit-tree', tree, '-p', toBase],
            Buffer.from(message),
            undefined,
            botIdentity(committedAt),
          )
        ).stdout,
      )
      await this.fsck(workspace, headSha)
      const auth = await this.auth(repo, 'write')
      const ref = `refs/heads/${branch}`
      const remote = await this.remoteHead(workspace, ref, auth)
      if (remote !== branchHead && remote !== headSha)
        throw conflict('Task branch changed before the update')
      await assertFence()
      if (remote !== headSha)
        await this.git(
          workspace,
          [
            'push',
            '--porcelain',
            `--force-with-lease=${ref}:${branchHead}`,
            workspace.url,
            `${headSha}:${ref}`,
          ],
          undefined,
          16 * 1024,
          auth,
        )
      return { status: 'rebased', headSha, treeSha: tree }
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /**
   * The change of `headSha` against `baseSha` for the candidate of a dialog (plan 53, Р5, R3):
   * both trees, the patch publication would have written, each changed path, and the bytes of
   * the files added below `addOnlyPaths` (the media of Р12). Reads the mirror only.
   */
  async compareCommits(input: CommitComparisonInput): Promise<CommitComparison> {
    const parsed = comparisonSchema.safeParse(input)
    if (!parsed.success || parsed.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid commit comparison')
    const { repo, baseSha, headSha, addOnlyPaths } = parsed.data
    const workspace = await this.workspace(repo, [baseSha, headSha])
    try {
      const treeOf = async (sha: string) =>
        this.sha((await this.git(workspace, ['rev-parse', '--verify', `${sha}^{tree}`])).stdout)
      const baseTree = await treeOf(baseSha)
      const headTree = await treeOf(headSha)
      // Bounded before anything is sized: the patch is longer than the list of its paths.
      const patch = await this.boundedPatch(workspace, [baseSha, headSha])
      const changes = await this.rawChanges(workspace, baseSha, headSha)
      // A candidate holds regular files only: publication refused links and submodules.
      const regular = new Set(['000000', '100644', '100755'])
      if (changes.some((change) => !regular.has(change.oldMode) || !regular.has(change.newMode)))
        throw failed()
      const kept = changes.filter((change) => change.status !== 'D')
      const blobs = await this.blobSizes(
        workspace,
        kept.map((change) => change.newOid),
        CANDIDATE,
      )
      const sizes = new Map(kept.map((change, i) => [change.path, blobs[i] ?? 0]))
      const media = kept.filter(
        (change) => change.status === 'A' && addOnlyPathOf(change.path, addOnlyPaths),
      )
      if (media.some((change) => (sizes.get(change.path) ?? 0) > mediaLimits.fileBytes))
        throw publicationTooLarge('Media file exceeds its size limit')
      const contents = new Map<string, Buffer>()
      await this.readBlobs(
        workspace,
        new Map(media.map((change) => [change.newOid, sizes.get(change.path) ?? 0])),
        (oid, blob) => {
          contents.set(oid, Buffer.from(blob))
        },
      )
      return {
        baseTree,
        headTree,
        patch: Uint8Array.from(patch),
        files: changes.map((change) => ({
          path: change.path,
          change: change.status === 'A' ? 'added' : change.status === 'D' ? 'deleted' : 'modified',
          sizeBytes: sizes.get(change.path) ?? 0,
          executable: change.newMode === '100755',
        })),
        added: media.map((change) => ({
          path: change.path,
          bytes: Uint8Array.from(contents.get(change.newOid)!),
        })),
      }
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /**
   * The commit of the bot whose tree is the tree of `treeOf` and whose only parent is `parent`,
   * at `committedAt` (plan 53, Р27: the release commit and its revert on `main`). The same
   * input is the same SHA, so a release stores it before the push and a retry finds it again.
   * Pushes nothing; the objects stay in the mirror of the site.
   */
  async trustedCommit(input: TrustedCommitInput): Promise<string> {
    const parsed = trustedCommitSchema.safeParse(input)
    if (!parsed.success || parsed.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid trusted commit')
    const commit = parsed.data
    const workspace = await this.workspace(commit.repo, trustedCommitShas(commit))
    try {
      return await this.trustedCommitOf(workspace, commit)
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /**
   * trustedCommit() pushed to `refs/heads/<branch>` by CAS: the branch must stand at `expected`
   * (a fast-forward, since `expected` is the parent) or at the commit already (`present`);
   * anywhere else nothing is pushed (`moved`). `assertFence` — the lease of the release — runs
   * right before the push and is required. A push whose answer is lost throws: the caller reads
   * the branch again (readBranchHead) instead of guessing.
   */
  async pushTrustedCommit(
    input: TrustedCommitInput & { branch: string; expected: string },
    assertFence: () => Promise<void>,
  ): Promise<TrustedCommitPush> {
    if (typeof assertFence !== 'function') throw badRequest('A push fence is required')
    const parsed = trustedPushSchema.safeParse(input)
    if (!parsed.success || parsed.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid trusted push')
    const { branch, expected, ...commit } = parsed.data
    const workspace = await this.workspace(commit.repo, trustedCommitShas(commit))
    try {
      const sha = await this.trustedCommitOf(workspace, commit)
      await this.fsck(workspace, sha)
      const auth = await this.auth(commit.repo, 'write')
      const ref = `refs/heads/${branch}`
      const remote = await this.remoteHead(workspace, ref, auth)
      if (remote === sha) return { status: 'present', sha }
      if (remote !== expected) return { status: 'moved', sha, remote: remote || null }
      await assertFence()
      await this.git(
        workspace,
        [
          'push',
          '--porcelain',
          `--force-with-lease=${ref}:${expected}`,
          workspace.url,
          `${sha}:${ref}`,
        ],
        undefined,
        16 * 1024,
        auth,
      )
      return { status: 'pushed', sha }
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /**
   * What `headSha` changes against `baseSha`, path by path without rename detection, with the
   * SHA-256 of the content on each side (plan 53, Р30: the manifest of a release — what the
   * deploy job finds on the hosting before it writes, and what it writes). Regular files only;
   * reads the mirror only.
   */
  async changeDigests(input: {
    repo: RepoRef
    baseSha: string
    headSha: string
  }): Promise<ChangeDigest[]> {
    const parsed = digestSchema.safeParse(input)
    if (!parsed.success || parsed.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid change digests')
    const { repo, baseSha, headSha } = parsed.data
    const workspace = await this.workspace(repo, [baseSha, headSha])
    try {
      const changes = await this.rawChanges(workspace, baseSha, headSha)
      const regular = new Set(['000000', '100644', '100755'])
      if (changes.some((change) => !regular.has(change.oldMode) || !regular.has(change.newMode)))
        throw repositoryUnsupported('A release changes a link or a submodule')
      const oids = [
        ...new Set(
          changes.flatMap((change) => [
            ...(change.status === 'A' ? [] : [change.oldOid]),
            ...(change.status === 'D' ? [] : [change.newOid]),
          ]),
        ),
      ]
      const sizes = await this.blobSizes(workspace, oids, REPOSITORY)
      const sizeOf = new Map(oids.map((oid, i) => [oid, sizes[i] ?? 0]))
      const digests = new Map<string, string>()
      await this.readBlobs(workspace, sizeOf, (oid, blob) => {
        digests.set(oid, createHash('sha256').update(blob).digest('hex'))
      })
      const digest = (oid: string) => {
        const value = digests.get(oid)
        if (value === undefined) throw failed()
        return value
      }
      return changes.map((change) => ({
        path: change.path,
        change: change.status === 'A' ? 'added' : change.status === 'D' ? 'deleted' : 'modified',
        before: change.status === 'A' ? null : digest(change.oldOid),
        after: change.status === 'D' ? null : digest(change.newOid),
        sizeBytes: change.status === 'D' ? 0 : (sizeOf.get(change.newOid) ?? 0),
        executable: change.newMode === '100755',
      }))
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /**
   * The tree of `treeOf` with the entries of `overlay.paths` taken from `overlay.from` (plan 53,
   * «Отмена выпуска»): what the undo commit of a release holds — the version before the release
   * and the media the release added. Reads the mirror only; the same input is the same tree.
   */
  async treeWith(input: { repo: RepoRef; treeOf: string; overlay: TreeOverlay }): Promise<string> {
    const parsed = trustedCommitSchema
      .pick({ repo: true, treeOf: true, overlay: true })
      .required({ overlay: true })
      .safeParse(input)
    if (!parsed.success || parsed.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid tree overlay')
    const { repo, treeOf, overlay } = parsed.data
    const workspace = await this.workspace(repo, [treeOf, overlay.from])
    try {
      return await this.overlayTree(workspace, treeOf, overlay)
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /**
   * The tree of `treeOf` read into the operation's private index, each path of the overlay set
   * to its entry in `from` — a regular file there, or the overlay is refused —, written back.
   */
  private async overlayTree(
    workspace: Workspace,
    treeOf: string,
    overlay: TreeOverlay,
  ): Promise<string> {
    const base = this.sha(
      (await this.git(workspace, ['rev-parse', '--verify', `${treeOf}^{tree}`])).stdout,
    )
    if (overlay.paths.length === 0) return base
    const wanted = new Set(overlay.paths)
    const listed = await this.list(
      workspace,
      ['ls-tree', '-rz', '--full-tree', overlay.from],
      publicationLimits.repositoryFiles,
      REPOSITORY,
    )
    const rows = text(listed, () => repositoryUnsupported('Tree has a path that is not UTF-8'))
    const lines: string[] = []
    for (const row of rows ? rows.replace(/\0$/, '').split('\0') : []) {
      const match = /^([0-7]{6}) (\w+) ([a-f0-9]{40})\t([^\0]+)$/.exec(row)
      if (!match) throw failed()
      const [, mode, type, oid, path] = match
      if (!wanted.has(path!)) continue
      if (type !== 'blob' || (mode !== '100644' && mode !== '100755'))
        throw repositoryUnsupported('An overlay path is a link or a submodule')
      lines.push(`${mode} ${oid}\t${path}`)
      wanted.delete(path!)
    }
    if (wanted.size > 0) throw failed()
    await this.git(workspace, ['read-tree', base])
    await this.git(
      workspace,
      ['update-index', '-z', '--index-info'],
      Buffer.from(lines.map((line) => `${line}\0`).join('')),
    )
    return this.sha((await this.git(workspace, ['write-tree'])).stdout)
  }

  /** The bot's commit of a trusted input in the operation's private repository. */
  private async trustedCommitOf(
    workspace: Workspace,
    commit: z.infer<typeof trustedCommitSchema>,
  ): Promise<string> {
    const tree = commit.overlay
      ? await this.overlayTree(workspace, commit.treeOf, commit.overlay)
      : this.sha(
          (await this.git(workspace, ['rev-parse', '--verify', `${commit.treeOf}^{tree}`])).stdout,
        )
    const message = commit.message.endsWith('\n') ? commit.message : `${commit.message}\n`
    return this.sha(
      (
        await this.git(
          workspace,
          ['commit-tree', tree, '-p', commit.parent],
          Buffer.from(message),
          undefined,
          botIdentity(commit.committedAt),
        )
      ).stdout,
    )
  }

  /**
   * The regular files of a commit — or of `paths` of it — as a tar, for the docroot of a preview
   * (plan 53, Р16, Р22). Links and submodules are left out: a docroot holds regular files and
   * directories only. Only the mirror is read; attributes of the tree (`export-ignore`,
   * `export-subst`) change nothing, unlike `git archive`. The archive lives in the operation's
   * private directory while `consume` reads it, and goes with it.
   */
  async exportTree<T>(
    input: TreeExportInput,
    consume: (tree: ExportedTree) => Promise<T>,
  ): Promise<T> {
    const parsed = treeExportSchema.safeParse(input)
    if (!parsed.success || parsed.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid tree export')
    const { repo, sha, paths } = parsed.data
    // No path asked: no listing — `ls-tree` without a pathspec would list the whole tree.
    if (paths?.length === 0)
      return consume({
        archive: (async function* () {
          yield TAR_END
        })(),
        files: 0,
        bytes: 0,
      })
    const excluded = new Set(parsed.data.exclude ?? [])
    const workspace = await this.workspace(repo, [sha])
    try {
      const listed = await this.list(
        workspace,
        ['ls-tree', '-rz', '--full-tree', sha, ...(paths ? ['--', ...paths] : [])],
        treeExportLimits.files,
        REPOSITORY,
      )
      const rows = text(listed, () => repositoryUnsupported('Tree has a path that is not UTF-8'))
      if (rows && !rows.endsWith('\0')) throw failed()
      const files: Array<{ path: string; oid: string; executable: boolean }> = []
      for (const row of rows ? rows.slice(0, -1).split('\0') : []) {
        const match = ANY_TREE_ROW.exec(row)
        if (!match || !isPublicationPath(match[3]!)) throw failed()
        if ((match[1] === '100644' || match[1] === '100755') && !excluded.has(match[3]!))
          files.push({ path: match[3]!, oid: match[2]!, executable: match[1] === '100755' })
      }
      if (files.length > treeExportLimits.files) throw repositoryTooLarge('Tree has too many files')
      const sizes = await this.treeBlobSizes(
        workspace,
        files.map((file) => file.oid),
      )
      const total = sizes.reduce((sum, size) => sum + size, 0)
      if (total > treeExportLimits.bytes) throw repositoryTooLarge('Tree exceeds its size limit')
      const archive = join(workspace.root, 'tree.tar')
      const out = await open(archive, 'wx', 0o600)
      try {
        const byOid = new Map<string, Buffer>()
        let at = 0
        for (const batch of batches(
          files.map((file, index) => [file.oid, sizes[index]!] as [string, number]),
          treeExportLimits.batchBytes,
        )) {
          byOid.clear()
          await this.readBlobs(workspace, new Map(batch), (oid, blob) => {
            byOid.set(oid, blob)
          })
          for (const [oid] of batch) {
            const file = files[at++]!
            const blob = byOid.get(oid)
            if (!blob || file.oid !== oid) throw failed()
            await out.write(tarFileHeader(file.path, blob.byteLength, file.executable))
            await out.write(blob)
            await out.write(tarPadding(blob.byteLength))
          }
        }
        await out.write(TAR_END)
      } finally {
        await out.close()
      }
      return await consume({
        archive: createReadStream(archive, { highWaterMark: 1024 * 1024 }),
        files: files.length,
        bytes: total,
      })
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /** Of `paths`, those that are not regular files of the commit's tree (plan 53, Р16: `no_core`). */
  async missingPaths(input: {
    repo: RepoRef
    sha: string
    paths: readonly string[]
  }): Promise<string[]> {
    const parsed = treeExportSchema.safeParse(input)
    if (!parsed.success || !parsed.data.paths || parsed.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid tree paths')
    const { repo, sha, paths } = parsed.data
    if (!paths.length) return []
    const workspace = await this.workspace(repo, [sha])
    try {
      const listed = await this.list(
        workspace,
        ['ls-tree', '-rz', '--full-tree', sha, '--', ...paths],
        paths.length,
        REPOSITORY,
      )
      const present = new Set<string>()
      for (const row of text(listed).split('\0')) {
        const match = ANY_TREE_ROW.exec(row)
        if (match && (match[1] === '100644' || match[1] === '100755')) present.add(match[3]!)
      }
      return paths.filter((path) => !present.has(path))
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  /**
   * What the files of `toSha` differ in from those of `fromSha`: the paths to write and the
   * paths to delete, links and submodules counted as gone. null — more than `limit` paths
   * changed, and a whole tree is cheaper than the difference (plan 53, Р22).
   */
  async changedPaths(input: {
    repo: RepoRef
    fromSha: string
    toSha: string
    limit: number
  }): Promise<{ written: string[]; deleted: string[] } | null> {
    const parsed = changedPathsSchema.safeParse(input)
    if (!parsed.success || parsed.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid commit difference')
    const { repo, fromSha, toSha, limit } = parsed.data
    const workspace = await this.workspace(repo, [fromSha, toSha])
    try {
      let output: Uint8Array
      try {
        output = (
          await this.git(
            workspace,
            ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', fromSha, toSha],
            undefined,
            (limit + 1) * (128 + publicationLimits.pathBytes),
          )
        ).stdout
      } catch (error) {
        if (isDomainError(error) && error.code === PROCESS_OUTPUT_LIMIT) return null
        throw error
      }
      const fields = text(output).split('\0')
      if (fields.pop() !== '' || fields.length % 2 !== 0) throw failed()
      if (fields.length / 2 > limit) return null
      const written: string[] = []
      const deleted: string[] = []
      for (let i = 0; i < fields.length; i += 2) {
        const match = RAW_CHANGE.exec(fields[i]!)
        const path = fields[i + 1]!
        if (!match || !isPublicationPath(path)) throw failed()
        const regular = match[2] === '100644' || match[2] === '100755'
        if (match[5] !== 'D' && regular) written.push(path)
        else deleted.push(path)
      }
      return { written, deleted }
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await this.dispose(workspace)
    }
  }

  async preparePublication(
    input: PublicationMetadata & {
      patch: Uint8Array
      untracked: Uint8Array
      credentials: readonly string[]
      refusedValues?: readonly string[]
    },
  ): Promise<TurnPublication> {
    const {
      patch: rawPatch,
      untracked: rawUntracked,
      credentials: rawCredentials,
      refusedValues: rawRefused = [],
      ...rawMetadata
    } = input
    const parsed = publicationMetadataSchema.safeParse(rawMetadata)
    if (!parsed.success) throw badRequest('Invalid publication metadata')
    const metadata = parsed.data
    if (
      !(rawPatch instanceof Uint8Array) ||
      !(rawUntracked instanceof Uint8Array) ||
      !Array.isArray(rawCredentials) ||
      rawCredentials.some((value) => typeof value !== 'string') ||
      !Array.isArray(rawRefused) ||
      rawRefused.some((value) => typeof value !== 'string')
    )
      throw badRequest('Invalid publication input')
    const credentials = rawCredentials
      .filter((value) => value.length > 0)
      .map((value) => Buffer.from(value, 'utf8'))
    // The client's variables the turn's commands got (plan 53, Р13), in every spelling.
    const refused = envValueBytes(rawRefused).map((value) => Buffer.from(value))
    if (
      rawPatch.byteLength > publicationLimits.patchBytes ||
      rawUntracked.byteLength > snapshotLimits.archiveBytes
    )
      throw publicationTooLarge()
    const patch = Buffer.from(rawPatch)
    const untracked = Buffer.from(rawUntracked)
    assertBinaryPatchLimits(patch)
    const rules = candidateRulesOf(metadata)
    const files = await untrackedFiles(untracked)
    if (files.length > publicationLimits.files)
      throw publicationTooLarge('Publication changes too many files')
    for (const file of files)
      assertCandidateChange(
        {
          path: file.path,
          oldMode: '000000',
          newMode: file.mode,
          sizeBytes: file.bytes.byteLength,
        },
        rules,
      )
    const workspace = await this.workspace(metadata.repo, [metadata.expectedBaseSha])
    try {
      const base = await this.baseTree(workspace, metadata)
      const original = base.entries
      // The working set of the base, derived again: the turn compares it with its sandbox's.
      const sandboxBaseSha = base.slice
        ? await this.workingSetCommit(workspace, metadata, base, metadata.createdAt)
        : undefined
      await this.git(workspace, ['read-tree', metadata.expectedBaseSha])
      if (patch.byteLength) {
        const summary = await this.apply(workspace, ['--summary'], patch)
        // Fail closed on extended mode headers; final index checks do not depend on this text.
        // Before numstat: a file replaced by a link lists its path twice there.
        const headers = text(summary.stdout, () => turnOutputRejected('Invalid patch summary'))
        if (/\b(?:120000|160000)\b|mode change |^ (?:copy|rename) /m.test(headers))
          throw publicationForbidden('Publication contains a link, submodule or permission change')
        const stats = await this.apply(workspace, ['--numstat', '-z'], patch)
        // The agent's changes, not the site's size: patched and new files count together.
        const patched = this.checkNumstat(stats.stdout, rules)
        if (patched + files.length > publicationLimits.files)
          throw publicationTooLarge('Publication changes too many files')
        await this.checkPostimages(workspace, patch)
        // Atomic without --reject: on failure the index is unchanged and the clone is discarded.
        await this.apply(workspace, ['--cached', '--whitespace=nowarn'], patch)
      }
      const afterPatch = await this.index(workspace, base.slice !== null)
      for (const file of files)
        if (original.has(file.path) || afterPatch.has(file.path))
          throw turnOutputRejected('Untracked publication file collides with the repository')
      const oids = files.length
        ? await this.hashBlobs(
            workspace,
            files.map((file) => file.bytes),
          )
        : []
      if (files.length)
        await this.git(
          workspace,
          ['update-index', '-z', '--index-info'],
          Buffer.from(files.map((file, i) => `${file.mode} ${oids[i]}\t${file.path}\0`).join('')),
        )
      const candidate = await this.index(workspace, base.slice !== null)
      // update-index skips a path Git refuses (core.protectNTFS: `git~1`, `.git.`) and exits 0.
      for (const [i, file] of files.entries()) {
        const entry = candidate.get(file.path)
        if (!entry || entry.oid !== oids[i] || entry.mode !== file.mode)
          throw turnOutputRejected('Untracked publication file is missing from the candidate')
      }
      // Bounded before any scan: the complete patch is longer than any per-path summary.
      const fullPatch = await this.boundedPatch(workspace, ['--cached', metadata.expectedBaseSha])
      await this.validateIndex(workspace, base, candidate, rules, credentials, refused)
      const tree = this.sha((await this.git(workspace, ['write-tree'])).stdout)
      const message = `Raditi task ${metadata.taskId}, turn ${metadata.turn}\n\nRaditi-Task: ${metadata.taskId}\nRaditi-Turn: ${metadata.turn}\n`
      const headSha = this.sha(
        (
          await this.git(
            workspace,
            ['commit-tree', tree, '-p', metadata.expectedBaseSha],
            Buffer.from(message),
            undefined,
            botIdentity(metadata.createdAt),
          )
        ).stdout,
      )
      await this.fsck(workspace, headSha)
      let disposed = false
      let publishing: Promise<void> | undefined
      return {
        baseSha: metadata.expectedBaseSha,
        ...(sandboxBaseSha ? { sandboxBaseSha } : {}),
        headSha,
        patch: Uint8Array.from(fullPatch),
        untracked: emptyUntrackedArchive(),
        publish: async (assertFence) => {
          if (disposed) throw conflict('Publication workspace was disposed')
          if (typeof assertFence !== 'function') throw badRequest('A publication fence is required')
          publishing ??= this.publish(workspace, metadata, headSha, assertFence).finally(() => {
            publishing = undefined
          })
          return publishing
        },
        dispose: async () => {
          disposed = true
          if (publishing) await publishing.catch(() => {})
          await this.dispose(workspace)
        },
      }
    } catch (error) {
      await this.dispose(workspace)
      if (isDomainError(error)) throw error
      throw failed()
    }
  }

  /**
   * The candidate's patch: of the index against its base (`--cached <base>`) or of one commit
   * against another. The snapshot stores it, so it shares the snapshot's patch limit.
   */
  private async boundedPatch(workspace: Workspace, sides: string[]): Promise<Buffer> {
    try {
      const diff = await this.git(
        workspace,
        [
          'diff',
          '--binary',
          '--full-index',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          ...sides,
          '--',
        ],
        undefined,
        publicationLimits.patchBytes,
      )
      return diff.stdout
    } catch (error) {
      if (isDomainError(error) && error.code === PROCESS_OUTPUT_LIMIT) throw publicationTooLarge()
      throw error
    }
  }

  /**
   * The new objects of an operation in full, and their links through the mirror. The mirror's
   * own objects were checked when they were fetched (transfer.fsckObjects): `--no-full` keeps a
   * mirror of gigabytes from being hashed again by every publication.
   */
  private async fsck(workspace: Workspace, headSha: string): Promise<void> {
    await this.git(workspace, ['fsck', '--no-full', '--strict', '--no-reflogs', headSha])
  }

  /** The paths `to` changes against `from`, without rename detection: modes and objects. */
  private async rawChanges(workspace: Workspace, from: string, to: string): Promise<RawChange[]> {
    let output: Uint8Array
    try {
      output = (
        await this.git(
          workspace,
          ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', from, to],
          undefined,
          CANDIDATE_FILES * (128 + publicationLimits.pathBytes),
        )
      ).stdout
    } catch (error) {
      if (isDomainError(error) && error.code === PROCESS_OUTPUT_LIMIT)
        throw publicationTooLarge('Candidate changes too many files')
      throw error
    }
    const fields = text(output).split('\0')
    if (fields.pop() !== '' || fields.length % 2 !== 0) throw failed()
    const changes: RawChange[] = []
    for (let i = 0; i < fields.length; i += 2) {
      const match = RAW_CHANGE.exec(fields[i]!)
      const path = fields[i + 1]!
      if (!match || !isPublicationPath(path)) throw failed()
      changes.push({
        path,
        oldMode: match[1]!,
        newMode: match[2]!,
        oldOid: match[3]!,
        newOid: match[4]!,
        status: match[5] as RawChange['status'],
      })
    }
    return changes
  }

  /** Changed entries against the rules of a candidate: modes, sizes and the bytes of media. */
  private async checkChanges(
    workspace: Workspace,
    changes: readonly RawChange[],
    rules: CandidateRules,
  ): Promise<void> {
    const files = changes.filter((change) => ['100644', '100755'].includes(change.newMode))
    const blobs = await this.blobSizes(
      workspace,
      files.map((change) => change.newOid),
      CANDIDATE,
    )
    const sizes = new Map(files.map((change, i) => [change.path, blobs[i] ?? 0]))
    const media = new Map<string, string[]>()
    for (const change of changes) {
      assertCandidateChange(
        {
          path: change.path,
          oldMode: change.oldMode,
          newMode: change.newMode,
          sizeBytes: sizes.get(change.path) ?? 0,
        },
        rules,
      )
      if (change.status === 'A' && addOnlyPathOf(change.path, rules.addOnlyPaths))
        media.set(change.newOid, [...(media.get(change.newOid) ?? []), change.path])
    }
    const mediaBlobs = new Map<string, number>()
    for (const change of files)
      if (media.has(change.newOid)) mediaBlobs.set(change.newOid, sizes.get(change.path) ?? 0)
    await this.readBlobs(workspace, mediaBlobs, (oid, blob) => {
      for (const path of media.get(oid) ?? []) assertCandidateMedia(path, blob, rules)
    })
  }

  private source(input: PublicationSource) {
    const result = publicationSourceSchema.safeParse(input)
    if (
      !result.success ||
      result.data.repo.provider !== this.provider.kind ||
      !publicationRulesHold(result.data)
    )
      throw badRequest('Invalid repository source')
    return result.data
  }

  /** The instant of a working-set commit: required with a working set, unused without one. */
  private workingSetInstant(
    source: { workingSet?: AgentWorkingSet },
    committedAt: string | undefined,
  ): string | undefined {
    if (!source.workingSet) return undefined
    if (committedAt === undefined || !instantSchema.safeParse(committedAt).success)
      throw badRequest('A working set requires the trusted time of the turn')
    return committedAt
  }

  /** The checked address of exactly the repository that was asked for. */
  private async repositoryUrl(repo: RepoRef): Promise<string> {
    let info
    try {
      // A late answer is discarded: nothing from it is used or cached.
      info = await withTimeout(
        this.provider.getRepository(repo),
        publicationLimits.commandMs,
        'Repository lookup timed out',
      )
    } catch {
      throw failed()
    }
    if (!info) throw notFound('Repository does not exist')
    if (
      info.ref.provider !== repo.provider ||
      info.ref.owner !== repo.owner ||
      info.ref.name !== repo.name
    )
      throw forbidden('Repository scope mismatch')
    return this.cloneUrl(info.cloneUrl)
  }

  /**
   * A private repository of one operation over the site's mirror: `git init` without a template,
   * the mirror's objects as an alternate, nothing else — no remote, no refs of the site, no
   * checkout. Every commit of `shas` must be in the mirror, fetched there if it is not yet.
   */
  private async workspace(repo: RepoRef, shas: readonly string[]): Promise<Workspace> {
    const url = await this.repositoryUrl(repo)
    const root = await mkdtemp(join(tmpdir(), CLONE_PREFIX))
    const workspace = { root, repo: join(root, 'repo'), url, ref: repo }
    try {
      await mkdir(join(root, 'empty'))
      await writeFile(join(root, 'gitleaks.toml'), GITLEAKS_CONFIG, { mode: 0o600 })
      await writeFile(join(root, 'empty', '.gitleaksignore'), '', { mode: 0o600 })
      const mirror = await this.mirror(workspace, shas)
      const created = await this.command(
        workspace,
        [
          'init',
          '--quiet',
          '--initial-branch=raditi',
          `--template=${join(root, 'empty')}`,
          workspace.repo,
        ],
        undefined,
        undefined,
        {},
        root,
      )
      if (created.code !== 0) throw failed()
      await mkdir(join(workspace.repo, '.git', 'objects', 'info'), { recursive: true })
      await writeFile(
        join(workspace.repo, '.git', 'objects', 'info', 'alternates'),
        `${join(mirror, 'objects')}\n`,
        { mode: 0o600 },
      )
      for (const sha of shas) {
        const actual = this.sha(
          (await this.git(workspace, ['rev-parse', '--verify', `${sha}^{commit}`])).stdout,
        )
        if (actual !== sha) throw conflict('Repository base does not match the expected commit')
      }
      return workspace
    } catch (error) {
      await this.dispose(workspace)
      if (isDomainError(error)) throw error
      throw failed()
    }
  }

  /**
   * The bare mirror of the workspace's repository, holding every commit of `shas`. A commit is
   * named by its content, so one the mirror has is the one asked for and costs no network; a
   * missing one is fetched — all branches and tags, under a short read grant, with every
   * received object checked (transfer.fsckObjects). One operation per mirror at a time. A mirror
   * whose configuration is not the one `git init` writes, or which borrows objects elsewhere, is
   * made again: git reads that configuration in fetch and cat-file.
   */
  private async mirror(workspace: Workspace, shas: readonly string[]): Promise<string> {
    const path = mirrorPath(this.#mirrorDir, workspace.ref, workspace.url)
    return this.#mirrors.run(path, async () => {
      if (!(await this.isPristineMirror(workspace, path))) await this.createMirror(workspace, path)
      if (await this.hasCommits(workspace, path, shas)) return path
      const auth = await this.auth(workspace.ref, 'read')
      // Quiet: a line per updated ref on stderr would fail the command past its 64 KiB on a
      // repository with a few hundred task branches and tags.
      const fetched = await this.command(
        workspace,
        [
          'fetch',
          '--quiet',
          '--no-tags',
          '--prune',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          '--no-auto-maintenance',
          workspace.url,
          '+refs/heads/*:refs/heads/*',
          '+refs/tags/*:refs/tags/*',
        ],
        undefined,
        undefined,
        { ...auth, GIT_DIR: path },
        workspace.root,
      ).catch(() => null)
      // A fetch that failed after its pack was in place still brought the commits it was for.
      if (!(await this.hasCommits(workspace, path, shas)))
        throw fetched?.code === 0
          ? conflict('Repository base does not match the expected commit')
          : failed()
      return path
    })
  }

  /** A mirror as createMirror made it: its HEAD and objects, the configuration of `git init`. */
  private async isPristineMirror(workspace: Workspace, path: string): Promise<boolean> {
    try {
      if (
        !(await stat(join(path, 'HEAD'))).isFile() ||
        !(await stat(join(path, 'objects'))).isDirectory()
      )
        return false
      if (await stat(join(path, 'objects', 'info', 'alternates')).catch(() => null)) return false
      const config = await readFile(join(path, 'config'))
      return config.equals(await this.initialConfig(workspace, dirname(path)))
    } catch {
      return false
    }
  }

  /**
   * What `git init --bare` writes into `config` next to the mirrors — on their file system, so
   * with the same letter case and Unicode settings — read once from a scratch repository.
   */
  private initialConfig(workspace: Workspace, directory: string): Promise<Buffer> {
    this.#initialConfig ??= (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const scratch = join(directory, `.initial.${randomBytes(6).toString('hex')}.tmp`)
      try {
        await this.initBare(workspace, scratch)
        return await readFile(join(scratch, 'config'))
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    })()
    // A failed read is asked again by the next operation.
    this.#initialConfig.catch(() => {
      this.#initialConfig = undefined
    })
    return this.#initialConfig
  }

  /** A bare repository without hooks or other template files: a mirror or a scratch one. */
  private async initBare(workspace: Workspace, target: string): Promise<void> {
    const created = await this.command(
      workspace,
      [
        'init',
        '--bare',
        '--quiet',
        '--initial-branch=raditi',
        `--template=${join(workspace.root, 'empty')}`,
        target,
      ],
      undefined,
      undefined,
      {},
      workspace.root,
    )
    if (created.code !== 0) throw failed()
  }

  /** Made under a temporary name and renamed: a mirror is never seen half made. */
  private async createMirror(workspace: Workspace, path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await rm(path, { recursive: true, force: true })
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await this.initBare(workspace, temporary)
      await rename(temporary, path)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  private async hasCommits(
    workspace: Workspace,
    mirror: string,
    shas: readonly string[],
  ): Promise<boolean> {
    const result = await this.command(
      workspace,
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      Buffer.from(shas.map((sha) => `${sha}^{commit}\n`).join('')),
      shas.length * 128,
      { GIT_DIR: mirror },
      workspace.root,
    )
    if (result.code !== 0) throw failed()
    const rows = text(result.stdout).trimEnd().split('\n')
    return rows.length === shas.length && shas.every((sha, i) => rows[i] === `${sha} commit`)
  }

  private async cloneUrl(value: string): Promise<string> {
    const transport = this.options.transport
    if (transport.kind === 'local-test') {
      try {
        const root = await realpath(transport.root)
        const path = await realpath(value)
        const child = relative(root, path)
        if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error()
        return path
      } catch {
        throw forbidden('Local test repository is outside its fixture')
      }
    }
    try {
      const url = new URL(value)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !transport.allowedOrigins.includes(url.origin)
      )
        throw new Error()
      return url.href
    } catch {
      throw forbidden('Repository URL is outside the configured HTTPS origins')
    }
  }

  private async auth(ref: RepoRef, access: 'read' | 'write'): Promise<NodeJS.ProcessEnv> {
    if (this.options.transport.kind === 'local-test') return {}
    let credentials: GitCredentials
    try {
      credentials = await withTimeout(
        this.provider.issueCredentials(ref, access, CREDENTIAL_TTL_SECONDS),
        publicationLimits.commandMs,
        'Repository credentials timed out',
      )
    } catch {
      throw failed()
    }
    const ttl =
      credentials.expiresAt instanceof Date ? credentials.expiresAt.getTime() - Date.now() : 0
    const control = (value: string) =>
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    if (
      !Number.isFinite(ttl) ||
      ttl < 5000 ||
      ttl > (CREDENTIAL_TTL_SECONDS + 5) * 1000 ||
      typeof credentials.username !== 'string' ||
      typeof credentials.token !== 'string' ||
      !credentials.username ||
      credentials.username.length > 1024 ||
      !credentials.token ||
      credentials.token.length > 4096 ||
      credentials.username.includes(':') ||
      control(credentials.username) ||
      control(credentials.token)
    )
      throw forbidden('Repository credentials are not a valid short-lived grant')
    return {
      RADITI_GIT_AUTH: `Authorization: Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64')}`,
      RADITI_GIT_AUTH_EXPIRES: String(credentials.expiresAt.getTime()),
    }
  }

  private environment(workspace: Workspace): NodeJS.ProcessEnv {
    const { transport } = this.options
    return {
      // One more trusted CA when set; nothing here can switch certificate checks off.
      ...(transport.kind === 'https' && transport.caFile !== undefined
        ? { GIT_SSL_CAINFO: transport.caFile }
        : {}),
      PATH: process.env.PATH,
      HOME: workspace.root,
      XDG_CONFIG_HOME: workspace.root,
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_LITERAL_PATHSPECS: '1',
    }
  }

  private async command(
    workspace: Workspace,
    args: string[],
    input?: Uint8Array,
    maxBytes?: number,
    env: NodeJS.ProcessEnv = {},
    cwd = workspace.repo,
  ): Promise<ProcessResult> {
    const options = [
      '--no-pager',
      '--no-replace-objects',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'submodule.recurse=false',
      '-c',
      'credential.helper=',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'protocol.allow=never',
      '-c',
      `protocol.${this.options.transport.kind === 'https' ? 'https' : 'file'}.allow=always`,
      '-c',
      'http.followRedirects=false',
      '-c',
      'transfer.fsckObjects=true',
      '-c',
      'fetch.fsckObjects=true',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'gc.auto=0',
    ]
    if (env.RADITI_GIT_AUTH) {
      if (Number(env.RADITI_GIT_AUTH_EXPIRES) <= Date.now())
        throw forbidden('Repository credential expired before use')
      options.push('--config-env=http.extraHeader=RADITI_GIT_AUTH')
    }
    return runProcess('git', [...options, ...args], {
      cwd,
      input,
      maxBytes,
      env: { ...this.environment(workspace), ...env },
    })
  }

  private async git(
    workspace: Workspace,
    args: string[],
    input?: Uint8Array,
    maxBytes?: number,
    env?: NodeJS.ProcessEnv,
  ): Promise<ProcessResult> {
    const result = await this.command(workspace, args, input, maxBytes, env)
    if (result.code !== 0) throw failed()
    return result
  }

  /** Git refusing the agent's patch is its output's fault; a failed or timed-out run is ours. */
  private async apply(workspace: Workspace, args: string[], patch: Buffer): Promise<ProcessResult> {
    const result = await this.command(workspace, ['apply', ...args, '-'], patch)
    if (result.code !== 0) throw turnOutputRejected('Invalid publication patch')
    return result
  }

  private sha(output: Uint8Array): string {
    const value = text(output).trim()
    if (!publicationShaSchema.safeParse(value).success) throw failed()
    return value
  }

  /** The client's own base tree: its limits are the repository's, not the agent's. */
  private async tree(workspace: Workspace, sha: string): Promise<Map<string, Entry>> {
    const output = await this.list(
      workspace,
      ['ls-tree', '-rz', '--full-tree', sha],
      publicationLimits.repositoryFiles,
      REPOSITORY,
    )
    const entries = this.entries(
      output,
      /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/,
      publicationLimits.repositoryFiles,
      REPOSITORY,
    )
    await this.blobSizes(
      workspace,
      [...entries.values()].map((entry) => entry.oid),
      REPOSITORY,
    )
    return entries
  }

  /**
   * The full base tree; with a working set its part for the agent is held to the rules `tree`
   * holds the whole tree to, plus the set's own limit, and the rest only to valid paths.
   */
  private async baseTree(
    workspace: Workspace,
    source: {
      expectedBaseSha: string
      workingSet?: AgentWorkingSet
      addOnlyPaths?: readonly string[]
    },
  ): Promise<BaseTree> {
    const set = source.workingSet
    if (!set) return { entries: await this.tree(workspace, source.expectedBaseSha), slice: null }
    const entries = this.entries(
      await this.list(
        workspace,
        ['ls-tree', '-rz', '--full-tree', source.expectedBaseSha],
        FULL_TREE_FILES,
        REPOSITORY,
        FULL_TREE_LIST_BYTES,
      ),
      ANY_TREE_ROW,
      FULL_TREE_FILES,
      REPOSITORY,
    )
    // The add-only directories stay out even when the set names them: they only grow, and in
    // the sandbox they would one day exceed its limit for good.
    const inSet = workingSetMatcher(set)
    const has = (path: string) =>
      inSet(path) && addOnlyPathOf(path, source.addOnlyPaths) === undefined
    const slice = new Map<string, Entry>()
    for (const entry of entries.values()) {
      if (!has(entry.path)) continue
      if (entry.mode !== '100644' && entry.mode !== '100755')
        throw repositoryUnsupported('Working set contains a link or submodule')
      if (slice.size >= publicationLimits.repositoryFiles)
        throw workingSetTooLarge('Working set has too many files')
      slice.set(entry.path, entry)
    }
    const list = [...slice.values()]
    const blobs = await this.blobSizes(
      workspace,
      list.map((entry) => entry.oid),
      WORKING_SET,
    )
    const sizes = new Map(list.map((entry, i) => [entry.path, blobs[i] ?? 0]))
    const bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0)
    if (bytes > set.maxBytes) throw workingSetTooLarge()
    return { entries, slice: { set, has, entries: slice, sizes, bytes } }
  }

  /**
   * The root commit of the working set: its entries in an index of their own, the tree of it, a
   * commit of the bot without a parent at `committedAt`. Deterministic, so recovery derives the
   * same SHA; one the plan names must be this one.
   */
  private async workingSetCommit(
    workspace: Workspace,
    source: { expectedBaseSha: string; sandboxBaseSha?: string },
    base: BaseTree,
    committedAt: string,
  ): Promise<string> {
    if (!base.slice) throw failed()
    const env = { GIT_INDEX_FILE: join(workspace.root, 'working-set.index') }
    await rm(env.GIT_INDEX_FILE, { force: true })
    const rows = [...base.slice.entries.values()]
      .map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`)
      .join('')
    if (rows)
      await this.git(
        workspace,
        ['update-index', '-z', '--index-info'],
        Buffer.from(rows),
        undefined,
        env,
      )
    const tree = this.sha(
      (await this.git(workspace, ['write-tree'], undefined, undefined, env)).stdout,
    )
    const sha = this.sha(
      (
        await this.git(
          workspace,
          ['commit-tree', tree],
          Buffer.from(workingSetCommitMessage(source.expectedBaseSha)),
          undefined,
          botIdentity(committedAt),
        )
      ).stdout,
    )
    if (source.sandboxBaseSha !== undefined && source.sandboxBaseSha !== sha)
      throw conflict('Working set commit differs from the planned one')
    return sha
  }

  /** A bundle of an earlier turn whose single ref is still `head`. */
  private async cachedBundle(head: string): Promise<Buffer | null> {
    const bytes = await this.#bundles.get(head)
    if (!bytes || bytes.byteLength > publicationLimits.bundleBytes || bundleHead(bytes) !== head)
      return null
    return bytes
  }

  private async bundle(workspace: Workspace, head: string, workingSet: boolean): Promise<Buffer> {
    await this.git(workspace, ['update-ref', `refs/heads/${BASE_BUNDLE_REF}`, head])
    const bundlePath = join(workspace.root, 'base.bundle')
    await this.git(workspace, ['bundle', 'create', bundlePath, `refs/heads/${BASE_BUNDLE_REF}`])
    // Bundle can include ancestry, so cap it separately from the current checked tree.
    if ((await stat(bundlePath)).size > publicationLimits.bundleBytes)
      throw workingSet
        ? workingSetTooLarge('Working set bundle is too large')
        : repositoryTooLarge('Repository bundle is too large')
    const bytes = await readFile(bundlePath)
    if (bundleHead(bytes) !== head) throw failed()
    await this.#bundles.put(head, bytes)
    return bytes
  }

  /**
   * The candidate index. With a working set it is the site's full tree plus the agent's files,
   * whose untouched rest may hold links and submodules.
   */
  private async index(workspace: Workspace, fullTree: boolean): Promise<Map<string, Entry>> {
    const files = fullTree ? FULL_TREE_FILES + publicationLimits.files : CANDIDATE_FILES
    return this.entries(
      await this.list(
        workspace,
        ['ls-files', '--stage', '-z'],
        files,
        CANDIDATE,
        fullTree ? FULL_TREE_LIST_BYTES + listBytes(publicationLimits.files) : undefined,
      ),
      fullTree ? ANY_INDEX_ROW : /^(100644|100755) ([a-f0-9]{40}) 0\t([^\0]+)$/,
      files,
      CANDIDATE,
    )
  }

  /** A file list bounded by its file limit: a larger listing is a 413, not a failed command. */
  private async list(
    workspace: Workspace,
    args: string[],
    files: number,
    scope: Scope,
    bytes = listBytes(files),
  ): Promise<Uint8Array> {
    try {
      return (await this.git(workspace, args, undefined, bytes)).stdout
    } catch (error) {
      if (isDomainError(error) && error.code === PROCESS_OUTPUT_LIMIT)
        throw scope.tooLarge('File list exceeds its limit')
      throw error
    }
  }

  private entries(
    bytes: Uint8Array,
    format: RegExp,
    limit: number,
    scope: Scope,
  ): Map<string, Entry> {
    const raw = text(bytes, () => scope.path('File list has a path that is not UTF-8'))
    if (raw && !raw.endsWith('\0')) throw failed()
    const entries = new Map<string, Entry>()
    for (const row of raw ? raw.slice(0, -1).split('\0') : []) {
      const match = format.exec(row)
      if (!match) throw scope.entry('Tree contains a link, submodule or unsupported index entry')
      const mode = match[1]!
      const oid = match[2]!
      const path = match[3]!
      if (!isPublicationPath(path)) throw scope.path('Tree contains an unsupported path')
      if (entries.has(path)) throw failed()
      if (entries.size >= limit) throw scope.tooLarge('File count exceeds its limit')
      entries.set(path, { path, mode, oid })
    }
    return entries
  }

  /** Sizes by OID, within the per-blob and total limits. Only postimages may be missing. */
  private async blobSizes(
    workspace: Workspace,
    oids: string[],
    scope: Scope,
    allowMissing = false,
  ): Promise<(number | undefined)[]> {
    if (!oids.length) return []
    const output = await this.git(
      workspace,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      Buffer.from(oids.join('\n') + '\n'),
    )
    const rows = text(output.stdout).trimEnd().split('\n')
    if (rows.length !== oids.length) throw failed()
    const subject = allowMissing ? 'Publication historical blob' : 'Repository blob'
    let total = 0
    return oids.map((oid, index) => {
      if (allowMissing && rows[index] === `${oid} missing`) return undefined
      const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(rows[index]!)
      const size = Number(match?.[2])
      if (!match || match[1] !== oid || !Number.isSafeInteger(size))
        throw scope.blob(`${subject} is not a regular blob`)
      if (size > publicationLimits.fileBytes) throw scope.tooLarge(`${subject} exceeds its limit`)
      total += size
      if (total > publicationLimits.treeBytes)
        throw scope.tooLarge(`${subject}s exceed the tree limit`)
      return size
    })
  }

  /** Sizes of the blobs of a tree a preview takes: its own limits, not those of a turn. */
  private async treeBlobSizes(workspace: Workspace, oids: string[]): Promise<number[]> {
    if (!oids.length) return []
    const output = await this.git(
      workspace,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      Buffer.from(oids.join('\n') + '\n'),
      oids.length * 128,
    )
    const rows = text(output.stdout).trimEnd().split('\n')
    if (rows.length !== oids.length) throw failed()
    return oids.map((oid, index) => {
      const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(rows[index]!)
      const size = Number(match?.[2])
      if (!match || match[1] !== oid || !Number.isSafeInteger(size)) throw failed()
      if (size > treeExportLimits.bytes) throw repositoryTooLarge('A file exceeds its size limit')
      return size
    })
  }

  /** Returns the number of paths the patch changes. */
  private checkNumstat(output: Uint8Array, rules: CandidateRules): number {
    const raw = text(output, () => turnOutputRejected('Invalid patch statistics'))
    if (raw && !raw.endsWith('\0')) throw turnOutputRejected('Invalid patch statistics')
    const paths = new Set<string>()
    for (const row of raw ? raw.slice(0, -1).split('\0') : []) {
      const match = /^(?:[0-9]+|-)\t(?:[0-9]+|-)\t(.+)$/.exec(row)
      if (!match) throw turnOutputRejected('Unsupported or ambiguous patch paths')
      if (paths.has(match[1]!)) throw turnOutputRejected('Publication has repeated paths')
      if (paths.size >= publicationLimits.files)
        throw publicationTooLarge('Publication changes too many files')
      paths.add(match[1]!)
      // Modes come with the index: here the path alone, add-only directories included.
      assertCandidatePath(match[1]!, rules)
    }
    return paths.size
  }

  private async checkPostimages(workspace: Workspace, patch: Uint8Array): Promise<void> {
    // Git can take a binary postimage straight from its object store instead of inflating
    // the supplied payload. Bound historical blobs too, before native apply allocates them.
    // Keep duplicate OIDs: several distinct paths can each allocate the same object.
    const oids: string[] = []
    for (const line of Buffer.from(patch).toString('latin1').split('\n')) {
      if (!line.startsWith('index ')) continue
      const match = /^index [a-f0-9]{4,40}\.\.([a-f0-9]{4,40})(?: [0-7]{6})?$/.exec(line)
      if (!match) throw turnOutputRejected('Invalid publication object header')
      if (match[1]!.length === 40 && !/^0+$/.test(match[1]!)) oids.push(match[1]!)
    }
    if (!oids.length) return
    if (oids.length > publicationLimits.files)
      throw publicationTooLarge('Publication changes too many files')
    await this.blobSizes(workspace, oids, CANDIDATE, true)
  }

  /**
   * Every changed entry against the rules of the candidate. Without a working set the whole
   * candidate tree keeps the tree limit, as before; with one only what changed is sized, and the
   * working set of the candidate keeps the set's limit — the next turn's sandbox gets it.
   */
  private async validateIndex(
    workspace: Workspace,
    base: BaseTree,
    candidate: Map<string, Entry>,
    rules: CandidateRules,
    credentials: readonly Buffer[],
    refused: readonly Buffer[] = [],
  ): Promise<void> {
    const paths = [...new Set([...base.entries.keys(), ...candidate.keys()])].filter((path) => {
      const before = base.entries.get(path)
      const after = candidate.get(path)
      return before?.oid !== after?.oid || before?.mode !== after?.mode
    })
    if (paths.some((path) => refused.some((value) => Buffer.from(path).includes(value))))
      throw envValueInChange()
    const sized = base.slice
      ? paths.flatMap((path) => {
          const after = candidate.get(path)
          return after ? [after] : []
        })
      : [...candidate.values()]
    const blobs = await this.blobSizes(
      workspace,
      sized.map((entry) => entry.oid),
      CANDIDATE,
    )
    const sizes = new Map(sized.map((entry, index) => [entry.path, blobs[index] ?? 0]))
    // Each distinct content once, however many changed paths share it.
    const changed = new Map<string, number>()
    const media = new Map<string, string[]>()
    let sliceBytes = base.slice?.bytes ?? 0
    for (const path of paths) {
      const before = base.entries.get(path)
      const after = candidate.get(path)
      assertCandidateChange(
        {
          path,
          oldMode: before?.mode ?? '000000',
          newMode: after?.mode ?? '000000',
          sizeBytes: sizes.get(path) ?? 0,
        },
        rules,
      )
      // New media below an add-only directory are outside the set: not the sandbox's bytes.
      if (base.slice?.has(path))
        sliceBytes += (sizes.get(path) ?? 0) - (base.slice.sizes.get(path) ?? 0)
      if (!after) continue
      changed.set(after.oid, sizes.get(path) ?? 0)
      if (addOnlyPathOf(path, rules.addOnlyPaths))
        media.set(after.oid, [...(media.get(after.oid) ?? []), path])
    }
    if (base.slice && sliceBytes > base.slice.set.maxBytes)
      throw workingSetTooLarge('The candidate working set exceeds its limit')
    await this.scanBlobs(
      workspace,
      changed,
      credentials,
      (oid, blob) => {
        for (const path of media.get(oid) ?? []) assertCandidateMedia(path, blob, rules)
      },
      refused,
    )
  }

  /**
   * Writes the new files as blobs with one hash-object. The copies are numbered by the host:
   * an agent's path never names a file on the host.
   */
  private async hashBlobs(workspace: Workspace, blobs: readonly Uint8Array[]): Promise<string[]> {
    const directory = join(workspace.root, 'new')
    await mkdir(directory, { mode: 0o700 })
    try {
      const paths = blobs.map((_, index) => join(directory, String(index)))
      for (const [index, blob] of blobs.entries())
        await writeFile(paths[index]!, blob, { mode: 0o600, flag: 'wx' })
      const output = await this.git(
        workspace,
        ['hash-object', '-w', '--no-filters', '--stdin-paths'],
        Buffer.from(paths.map((path) => `${path}\n`).join('')),
        blobs.length * 41,
      )
      const oids = text(output.stdout).split('\n')
      if (oids.pop() !== '' || oids.length !== blobs.length) throw failed()
      for (const oid of oids) if (!publicationShaSchema.safeParse(oid).success) throw failed()
      return oids
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  /**
   * Each blob of `blobs` (OID → size) in full, in order: a few `cat-file --batch` reads of at
   * most one blob limit each. `visit` gets a view into the batch: it copies what it keeps.
   */
  private async readBlobs(
    workspace: Workspace,
    blobs: Map<string, number>,
    visit: (oid: string, blob: Buffer) => void | Promise<void>,
  ): Promise<void> {
    for (const batch of batches([...blobs], publicationLimits.fileBytes)) {
      const headers = batch.map(([oid, size]) => `${oid} blob ${size}\n`)
      const expected = batch.reduce(
        (total, [, size], index) => total + headers[index]!.length + size + 1,
        0,
      )
      const output = (
        await this.git(
          workspace,
          ['cat-file', '--batch'],
          Buffer.from(batch.map(([oid]) => `${oid}\n`).join('')),
          expected,
        )
      ).stdout
      if (output.byteLength !== expected) throw failed()
      let at = 0
      for (const [index, [oid, size]] of batch.entries()) {
        const header = headers[index]!
        if (output.toString('latin1', at, at + header.length) !== header) throw failed()
        at += header.length
        const blob = output.subarray(at, at + size)
        at += size
        if (output[at++] !== 0x0a) throw failed()
        await visit(oid, blob)
      }
    }
  }

  /**
   * Every changed blob in full (readBlobs), the turn's exact credentials in memory, then one
   * Gitleaks run over host-numbered private copies. Numbered names keep agent paths out of the
   * scan (a `.gitleaksignore` of the scanned directory, path allowlists), as with stdin; the
   * config is the host's, `gitleaks:allow` is off.
   */
  private async scanBlobs(
    workspace: Workspace,
    blobs: Map<string, number>,
    credentials: readonly Buffer[],
    inspect: (oid: string, blob: Buffer) => void = () => {},
    refused: readonly Buffer[] = [],
  ): Promise<void> {
    if (!blobs.size) return
    const directory = join(workspace.root, 'scan')
    await mkdir(directory, { mode: 0o700 })
    try {
      let written = 0
      await this.readBlobs(workspace, blobs, async (oid, blob) => {
        // Binary changes are compressed in the captured patch: only here is their content whole.
        if (credentials.some((value) => blob.includes(value))) throw snapshotHasCredential()
        // A value of a client's variable, media included: their bytes are whole only here.
        if (refused.some((value) => blob.includes(value))) throw envValueInChange()
        // The media the candidate adds: their bytes, whole here, must be what their names say.
        inspect(oid, blob)
        await writeFile(join(directory, String(written++)), scanCopy(blob), {
          mode: 0o600,
          flag: 'wx',
        })
      })
      const scan = await runProcess(
        this.options.gitleaksBinary ?? 'gitleaks',
        [
          'dir',
          '.',
          '--config',
          join(workspace.root, 'gitleaks.toml'),
          '--gitleaks-ignore-path',
          join(workspace.root, 'empty'),
          '--ignore-gitleaks-allow',
          '--redact=100',
          '--no-banner',
          '--no-color',
          '--log-level=error',
          `--exit-code=${GITLEAKS_FINDING_EXIT}`,
        ],
        {
          cwd: directory,
          env: this.environment(workspace),
          maxBytes: 64 * 1024,
        },
      )
      if (scan.code === GITLEAKS_FINDING_EXIT) throw publicationSecret()
      if (scan.code !== 0) throw failed()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async publish(
    workspace: Workspace,
    metadata: PublicationMetadata,
    headSha: string,
    assertFence: () => Promise<void>,
  ): Promise<void> {
    const auth = await this.auth(metadata.repo, 'write')
    const ref = `refs/heads/${metadata.branch}`
    const expected = await this.remoteHead(workspace, ref, auth)
    const permitted =
      metadata.expectedBranchSha !== undefined
        ? expected === (metadata.expectedBranchSha ?? '')
        : expected === metadata.expectedBaseSha || (expected === '' && metadata.turn === 1)
    if (expected !== headSha && !permitted) throw conflict('Task branch changed before publication')
    await assertFence()
    if (expected === headSha) return
    await this.git(
      workspace,
      [
        'push',
        '--porcelain',
        `--force-with-lease=${ref}:${expected}`,
        workspace.url,
        `${headSha}:${ref}`,
      ],
      undefined,
      16 * 1024,
      auth,
    )
  }

  /** The commit a remote ref points at; empty when the ref does not exist. */
  private async remoteHead(
    workspace: Workspace,
    ref: string,
    auth: NodeJS.ProcessEnv,
  ): Promise<string> {
    const existing = (
      await this.git(workspace, ['ls-remote', '--refs', workspace.url, ref], undefined, 1024, auth)
    ).stdout
    const remote = text(existing).trim()
    const match = remote ? /^([a-f0-9]{40})\t([^\n]+)$/.exec(remote) : null
    if (remote && (!match || match[2] !== ref)) throw failed()
    return match?.[1] ?? ''
  }

  private async dispose(workspace: Workspace): Promise<void> {
    await rm(workspace.root, { recursive: true, force: true })
  }
}
