import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import {
  badRequest,
  conflict,
  DomainError,
  envValueBytes,
  envValueInChange,
  forbidden,
  HIDDEN_FILE_STUB,
  HIDDEN_PATHS_LIMIT,
  isSecretFileName,
  isAgentBranch,
  isDomainError,
  mirrorLimits,
  notFound,
  publicationChangeOf,
  publicationForbidden,
  publicationLimits,
  publicationSecret,
  publicationShaSchema,
  publicationTooLarge,
  repoBranchSchema,
  repoChatRef,
  repoNotAllowed,
  repoProtectedBranch,
  repoPublicationSchema,
  repositoryTooLarge,
  repositoryUnsupported,
  snapshotHasCredential,
  snapshotLimits,
  turnOutputRejected,
  type IssuedGitAccess,
  type RepoPublication,
  type TurnBundleSource,
} from '@repo/domain'
import { BASE_BUNDLE_REF, bundleHead } from '@repo/local-turns'

import { directoryBytes } from '../git-worker/disk.ts'
import type { GitWorkerRequest } from '../git-worker/protocol.ts'
import { untrackedFiles } from './archive.ts'
import { assertBinaryPatchLimits } from './binary-limits.ts'
import { gitAuthEnvironment } from './git-auth.ts'
import {
  assertSharedDirectory,
  BundleCache,
  KeyedLock,
  mirrorPath,
  operationsDir,
  sharedDirectory,
  sharedFile,
} from './mirror-store.ts'
import type { GitCommandResult, GitRunner } from './worker-client.ts'

// The trusted git of the repositories of projects (docs/plan/84-projects.md, ПР12, ПР33, §4.3):
// returned from main without the site parts (Gitea, working sets, media, previews, releases).
// Core runs no git itself: every command goes to the git worker, which runs it with the fixed
// options of trusted-git.ts. Core keeps the order of the steps, the limits and the volume: a
// bare mirror per repository of a project, refreshed by `fetch --depth 1 --no-tags` into a
// directory of its own under a quota and moved in only once checked; for each operation a
// private repository that reads the mirror's objects and writes its own. No working tree is
// ever made on core's side: links and filters of a client's repository never reach a disk.

export interface GitWorkspaceOptions {
  runner: GitRunner
  /** GIT_MIRROR_DIR: the volume core shares with the worker. */
  mirrorDir: string
  /**
   * `https` — remotes of the providers, each pinned to the address core checked; `local-test` —
   * bare repositories of a fixture below `root`, only NODE_ENV=test.
   */
  transport: { kind: 'https' } | { kind: 'local-test'; root: string }
  gitleaks?: boolean
  /** Bytes one fetch may bring to disk; mirrorLimits.fetchBytes when absent (tests: small). */
  fetchBytes?: number
  /** Bytes the mirrors and bundles of the volume may hold together. */
  volumeBytes?: number
}

/** A remote of one operation: the adapter's clone URL, the checked address, the grant. */
export interface RepoRemote {
  /** `https://<host>/<path>.git`, built by the adapter from the host and the path (§4.6). */
  cloneUrl: string
  /** The address the host resolved to for this operation, checked by core (§4.6). */
  pin?: { host: string; address: string }
  access: IssuedGitAccess
}

export interface RepoFetchInput {
  projectRepositoryId: string
  remote: RepoRemote
  /** The main branch and, when it was pushed, the branch of a chat (ПР12). */
  branches: readonly string[]
  /** The size the provider names (GitLab `statistics.repository_size`, GitHub `size`); null — unknown. */
  sizeBytes: number | null
  /** What is left of the quota of the workspace on the volume (ПР12); absent — no own quota. */
  quotaBytes?: number
}

export interface RepoBundleInput {
  projectRepositoryId: string
  baseSha: string
  /** The branch the sandbox checks the base out on. */
  branch: string
  /** The trusted time of the turn: the root commit is the same for the same input. */
  committedAt: string
  /**
   * Files of `baseSha` the sandbox gets as a stub (docs/plan/84-projects.md, ПР35): those that
   * look like a secret. A path the tree has not, or not as a regular file, is left as it is.
   */
  hiddenPaths?: readonly string[]
}

export interface RepoPushInput {
  projectRepositoryId: string
  chatId: string
  /** The remote with an access to write, issued for this one push. */
  remote: RepoRemote
  /** `raditi/…` of the chat (isAgentBranch); never the main branch. */
  branch: string
  defaultBranch: string
  /** The commit of the chat in the mirror the client was shown (chatBranchHead). */
  head: string
  /**
   * What the branch at the client held after the last push: `remote` — its head, `mirror` — the
   * commit of the chat whose changes it carried. null — the branch was never sent.
   */
  sent: { remote: string; mirror: string } | null
  /** The trusted time of the press: a commit put on top is the same for the same input. */
  committedAt: string
}

export type RepoPushResult =
  /** Pushed: `rebased` — the client added commits, and the changes went on top of them. */
  | { kind: 'pushed'; sha: string; rebased: boolean }
  /** The branch never sent is there at the client already: another name is needed. */
  | { kind: 'name_taken' }
  /** The client changed the branch, and the changes do not go on top (ПР13). */
  | { kind: 'conflict' }
  /** The branch moved at the client between the check and the push: the press is tried again. */
  | { kind: 'raced' }

export interface RepoCandidate {
  baseSha: string
  headSha: string
  /** The complete patch of the candidate against `baseSha`, within the snapshot's patch limit. */
  patch: Uint8Array
  /** Changed paths of the build (CI files, `.gitmodules`): marked for the card of ПР16. */
  buildPaths: string[]
  /** Moves the commit into the mirror under the chat's ref by CAS, after `assertFence`. */
  publish(assertFence: () => Promise<void>): Promise<void>
  dispose(): Promise<void>
}

/** A private directory of one operation on the volume, and the repository in it, if any. */
interface Operation {
  root: string
  repo: string
}

interface Entry {
  mode: string
  oid: string
  path: string
}

interface RawChange {
  path: string
  oldMode: string
  newMode: string
  oldOid: string
  newOid: string
}

// The author of every commit of the platform in a client's repository (docs/plan/84, ПР13).
const BOT_NAME = 'Радити'
const BOT_EMAIL = 'noreply@raditi.ru'
const GITLEAKS_CONFIG = '[extend]\nuseDefault = true\n'
const GITLEAKS_FINDING_EXIT = 99
const ZERO_SHA = '0'.repeat(40)
/**
 * Gitleaks skips a file whose first bytes match an application type (archive, PDF, program).
 * Its detector tries image types first: behind this header it reads the content whatever it
 * starts with. Every copy gets it.
 */
const SCAN_PREFIX = Buffer.from('GIF89a\n')
export const scanCopy = (blob: Buffer): Buffer => Buffer.concat([SCAN_PREFIX, blob])

const failed = () =>
  new DomainError('GIT_OPERATION_FAILED', 'Trusted repository operation failed', 502)

/** The agent changed a file the sandbox held as a stub (ПР35): its change is never kept. */
const hiddenChanged = () =>
  publicationForbidden('Publication changes a file hidden from the sandbox')

/** A hidden path as the scan or the name rule gives it: relative, no `..`, no control bytes. */
const isPublicationPathLike = (path: string): boolean =>
  typeof path === 'string' &&
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.split('/').some((part) => part === '' || part === '.' || part === '..') &&
  ![...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

/** The platform's bot: the author and committer of every trusted commit, at a fixed instant. */
const botIdentity = (at: string) => {
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

const TREE_ROW = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t([^\0]+)$/
const INDEX_ROW = /^(100644|100755|120000|160000) ([a-f0-9]{40}) 0\t([^\0]+)$/
const RAW_CHANGE = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDT])$/
const listBytes = (files: number) => files * (64 + publicationLimits.pathBytes)

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

export class GitWorkspaceService {
  readonly #root: string
  readonly #mirrors = new KeyedLock()
  readonly #bundles: BundleCache
  readonly #runner: GitRunner
  #initialConfig: Promise<Buffer> | undefined

  constructor(private readonly options: GitWorkspaceOptions) {
    if (!isAbsolute(options.mirrorDir))
      throw badRequest('Repository mirror directory must be an absolute path')
    if (options.transport.kind === 'local-test' && process.env.NODE_ENV !== 'test')
      throw badRequest('Local repository transport is restricted to tests')
    this.#root = options.mirrorDir
    this.#runner = options.runner
    this.#bundles = new BundleCache(this.#root)
    assertSharedDirectory(this.#root)
  }

  /**
   * Brings the heads of `branches` into the mirror of the repository and returns them, null for
   * a branch the remote does not have. The size the provider names is checked first; the fetch
   * takes those heads only, without history or tags, into a directory of its own under a quota;
   * no object of it may exceed its limit. Only then are its pack and its shallow commits moved
   * into the mirror — a refused fetch leaves the volume as it was.
   */
  async fetch(input: RepoFetchInput): Promise<Map<string, string | null>> {
    const branches = [...new Set(input.branches)]
    if (
      !branches.length ||
      branches.length > 8 ||
      branches.some((branch) => !repoBranchSchema.safeParse(branch).success)
    )
      throw badRequest('Invalid repository branches')
    if (input.sizeBytes !== null && input.sizeBytes > mirrorLimits.repositoryBytes)
      throw repositoryTooLarge('The provider names a repository above its limit')
    const mirror = mirrorPath(this.#root, input.projectRepositoryId)
    const remote = await this.remote(input.remote)
    return this.#mirrors.run(mirror, () =>
      this.operation(async (op) => {
        await this.ensureMirror(op, mirror)
        const heads = await this.remoteHeads(op, remote, branches)
        const present = branches.filter((branch) => heads.has(branch))
        const known = await this.commitsIn(
          op,
          mirror,
          present.map((branch) => heads.get(branch)!),
        )
        await this.fetchInto(
          op,
          mirror,
          remote,
          present.filter((_, i) => !known[i]),
          heads,
          input.quotaBytes,
        )
        for (const branch of branches) {
          const sha = heads.get(branch) ?? null
          await this.git(
            op,
            sha
              ? ['update-ref', `refs/heads/${branch}`, sha]
              : ['update-ref', '-d', `refs/heads/${branch}`],
            { env: { GIT_DIR: mirror } },
          )
        }
        return new Map(branches.map((branch) => [branch, heads.get(branch) ?? null]))
      }),
    )
  }

  /** Whether the mirror of this repository holds the commit. */
  async hasCommit(projectRepositoryId: string, sha: string): Promise<boolean> {
    if (!publicationShaSchema.safeParse(sha).success) return false
    const mirror = mirrorPath(this.#root, projectRepositoryId)
    if (!(await this.isMirror(mirror))) return false
    return this.#mirrors.run(mirror, () =>
      this.operation(async (op) => (await this.commitsIn(op, mirror, [sha]))[0]!),
    )
  }

  /** The commit of a chat's ref in the mirror, null before its first publication. */
  async readChatRef(projectRepositoryId: string, chatId: string): Promise<string | null> {
    const mirror = mirrorPath(this.#root, projectRepositoryId)
    if (!(await this.isMirror(mirror))) return null
    return this.#mirrors.run(mirror, () =>
      this.operation(async (op) => (await this.refOf(op, mirror, repoChatRef(chatId))) || null),
    )
  }

  /**
   * The files of the tree of `sha` that look like a password or a key (ПР12, «Проверка при
   * подключении»): gitleaks over host-numbered copies, then halves of the ones it flagged until each
   * finding is one file. Paths only — never a value; at most `limit` of them. The tree is checked
   * against the limits of a turn first (REPOSITORY_TOO_LARGE). Nothing is blocked by a finding:
   * the client reads the list, and those files never reach a sandbox (ПР35, 84.18).
   */
  async findSecrets(projectRepositoryId: string, sha: string, limit = 20): Promise<string[]> {
    if (!publicationShaSchema.safeParse(sha).success) throw badRequest('Invalid repository head')
    const mirror = mirrorPath(this.#root, projectRepositoryId)
    return this.#mirrors.run(mirror, () =>
      this.operation(async (op) => {
        await this.privateRepository(op, mirror, sha)
        await this.checkTree(op, sha)
        const listing = await this.git(op, ['ls-tree', '-rz', '--full-tree', sha], {
          maxBytes: listBytes(publicationLimits.repositoryFiles),
        })
        const files: { path: string; oid: string }[] = []
        for (const row of text(listing.stdout).replace(/\0$/, '').split('\0')) {
          const match = TREE_ROW.exec(row)
          if (match && (match[1] === '100644' || match[1] === '100755'))
            files.push({ oid: match[3]!, path: match[4]! })
        }
        if (!files.length || this.options.gitleaks === false) return []
        const sizes = await this.blobSizes(
          op,
          files.map((file) => file.oid),
          repositoryTooLarge,
        )
        const all = join(op.root, 'scan')
        await sharedDirectory(all)
        // One copy per file: a blob shared by two paths is scanned under each of them.
        const byOid = new Map<string, number[]>()
        files.forEach((file, i) => byOid.set(file.oid, [...(byOid.get(file.oid) ?? []), i]))
        await this.readBlobs(
          op,
          new Map(
            [...byOid.keys()].map((oid) => [oid, sizes[files.findIndex((f) => f.oid === oid)]!]),
          ),
          async (oid, blob) => {
            for (const i of byOid.get(oid) ?? [])
              await sharedFile(join(all, String(i)), scanCopy(blob))
          },
        )
        let subsets = 0
        const flags = async (indices: readonly number[]): Promise<boolean> => {
          const directory = join(op.root, `scan-${subsets++}`)
          await sharedDirectory(directory)
          try {
            for (const i of indices) await link(join(all, String(i)), join(directory, String(i)))
            const scan = await this.#runner.run({
              tool: 'gitleaks',
              args: [directory, join(op.root, 'gitleaks.toml'), join(op.root, 'empty')],
              cwd: op.root,
              protocol: 'none',
            })
            if (scan.code === GITLEAKS_FINDING_EXIT) return true
            if (scan.code !== 0) throw failed()
            return false
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        }
        const found: string[] = []
        const search = async (indices: readonly number[]): Promise<void> => {
          if (found.length >= limit || !(await flags(indices))) return
          if (indices.length === 1) {
            found.push(files[indices[0]!]!.path)
            return
          }
          const half = Math.ceil(indices.length / 2)
          await search(indices.slice(0, half))
          await search(indices.slice(half))
        }
        await search(files.map((_, i) => i))
        return found.sort()
      }),
    )
  }

  /**
   * The files of the tree of `sha` a sandbox never gets (ПР35): those whose name looks like a
   * secret (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`) and those gitleaks flags. Paths only. A
   * tree with more of them than one sandbox may hide is refused (REPOSITORY_UNSUPPORTED).
   */
  async hiddenFiles(projectRepositoryId: string, sha: string): Promise<string[]> {
    if (!publicationShaSchema.safeParse(sha).success) throw badRequest('Invalid repository head')
    const mirror = mirrorPath(this.#root, projectRepositoryId)
    const named = await this.#mirrors.run(mirror, () =>
      this.operation(async (op) => {
        await this.privateRepository(op, mirror, sha)
        const listing = await this.git(op, ['ls-tree', '-rz', '--full-tree', '--name-only', sha], {
          maxBytes: listBytes(publicationLimits.repositoryFiles),
        })
        return text(listing.stdout)
          .replace(/\0$/, '')
          .split('\0')
          .filter((path) => path !== '' && isSecretFileName(path))
      }),
    )
    const found = await this.findSecrets(projectRepositoryId, sha, HIDDEN_PATHS_LIMIT)
    const hidden = [...new Set([...named, ...found])].sort()
    if (hidden.length > HIDDEN_PATHS_LIMIT)
      throw repositoryUnsupported('Too many files of the repository look like secrets')
    return hidden
  }

  /**
   * The change of build settings between two commits of the mirror (ПР16, slice 84.20): the paths
   * `git diff-tree` names between them that `isBuildPath` takes, their diff — null above
   * `maxBytes`: what cannot be shown is not sent — and, when asked, the file of the configuration
   * at `to` for CI Lint (null when the tree has none or it is above `configBytes`). Nothing is
   * written to the mirror.
   */
  async buildSettingsChange(input: {
    projectRepositoryId: string
    from: string
    to: string
    isBuildPath: (path: string) => boolean
    maxBytes: number
    configPath?: string | null
    configBytes?: number
  }): Promise<{ paths: string[]; patch: Buffer | null; config: Buffer | null }> {
    if (
      !publicationShaSchema.safeParse(input.from).success ||
      !publicationShaSchema.safeParse(input.to).success
    )
      throw badRequest('Invalid commits of a change')
    const mirror = mirrorPath(this.#root, input.projectRepositoryId)
    return this.#mirrors.run(mirror, () =>
      this.operation(async (op) => {
        await this.privateRepository(op, mirror, input.to)
        if (!(await this.commitsIn(op, mirror, [input.from]))[0])
          throw notFound('The commit is not in the repository of this project')
        const listing = await this.git(
          op,
          ['diff-tree', '-r', '-z', '--no-renames', '--name-only', input.from, input.to],
          { maxBytes: listBytes(publicationLimits.repositoryFiles) },
        )
        const paths = text(listing.stdout)
          .split('\0')
          .filter((path) => path !== '' && input.isBuildPath(path))
          .sort()
        let patch: Buffer | null = Buffer.alloc(0)
        if (paths.length) {
          try {
            patch = (
              await this.git(
                op,
                [
                  'diff',
                  '--no-color',
                  '--binary',
                  '--full-index',
                  '--no-renames',
                  '--no-ext-diff',
                  '--no-textconv',
                  input.from,
                  input.to,
                  '--',
                  // The worker reads every pathspec literally (GIT_LITERAL_PATHSPECS).
                  ...paths,
                ],
                { maxBytes: input.maxBytes },
              )
            ).stdout
          } catch (error) {
            if (!isDomainError(error) || error.code !== 'PROCESS_OUTPUT_LIMIT') throw error
            patch = null
          }
        }
        let config: Buffer | null = null
        if (input.configPath) {
          const entry = await this.git(op, ['ls-tree', '-z', input.to, '--', input.configPath])
          const match = TREE_ROW.exec(text(entry.stdout).replace(/\0$/, ''))
          if (match && (match[1] === '100644' || match[1] === '100755')) {
            const oid = match[3]!
            // A file above the limit of a file is not linted either: CI Lint is a help, not a gate.
            const [size] = await this.blobSizes(op, [oid], repositoryTooLarge).catch(() => [])
            if (size !== undefined && size <= (input.configBytes ?? 256 * 1024))
              await this.readBlobs(op, new Map([[oid, size]]), (_, blob) => {
                config = Buffer.from(blob)
              })
          }
        }
        return { paths, patch, config }
      }),
    )
  }

  /**
   * The base of a turn (ПР12): one root commit of the tree of `baseSha`, without a parent, made by
   * the bot at `committedAt`, in a bundle with the single ref `refs/heads/raditi-base`. The commit
   * must be in the mirror of this very repository — the mirror is checked before the cache, and
   * the cache is keyed by the repository too, so a commit of another project never comes out.
   */
  async buildBaseBundle(input: RepoBundleInput): Promise<TurnBundleSource> {
    if (
      !publicationShaSchema.safeParse(input.baseSha).success ||
      !repoBranchSchema.safeParse(input.branch).success ||
      !Number.isFinite(Date.parse(input.committedAt))
    )
      throw badRequest('Invalid repository base')
    const mirror = mirrorPath(this.#root, input.projectRepositoryId)
    const bundle = await this.#mirrors.run(mirror, () =>
      this.operation(async (op) => {
        await this.privateRepository(op, mirror, input.baseSha)
        await this.checkTree(op, input.baseSha)
        const tree = await this.sandboxTree(op, input.baseSha, input.hiddenPaths ?? [])
        const head = this.sha(
          (
            await this.git(op, ['commit-tree', tree], {
              input: Buffer.from(`Raditi base of ${input.baseSha}\n`),
              env: botIdentity(input.committedAt),
            })
          ).stdout,
        )
        const cached = await this.#bundles.get(input.projectRepositoryId, head)
        if (
          cached &&
          cached.byteLength <= publicationLimits.bundleBytes &&
          bundleHead(cached) === head
        )
          return { head, bytes: cached }
        await this.git(op, ['update-ref', `refs/heads/${BASE_BUNDLE_REF}`, head])
        const path = join(op.root, 'base.bundle')
        await this.git(op, ['bundle', 'create', '--quiet', path, `refs/heads/${BASE_BUNDLE_REF}`])
        if ((await stat(path)).size > publicationLimits.bundleBytes)
          throw repositoryTooLarge('Repository bundle is too large')
        const bytes = await readFile(path)
        if (bundleHead(bytes) !== head) throw failed()
        await this.#bundles.put(input.projectRepositoryId, head, bytes)
        return { head, bytes }
      }),
    )
    const { head, bytes } = bundle
    return {
      baseSha: input.baseSha,
      sandboxBaseSha: head,
      branch: input.branch,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      // Each reader gets its own copy; the importer checks the hash of what it read.
      read: async function* () {
        yield Buffer.from(bytes)
      },
    }
  }

  /**
   * Moves the chat's ref of the mirror to `to` (null — removes it) while it is `from` (ПР25:
   * `/undo` and `/redo` take the chat's commits back and forth; the client's branch moves only by
   * a button). false — the ref was not `from`.
   */
  async moveChatRef(
    projectRepositoryId: string,
    chatId: string,
    from: string | null,
    to: string | null,
  ): Promise<boolean> {
    for (const sha of [from, to])
      if (sha !== null && !publicationShaSchema.safeParse(sha).success)
        throw badRequest('Invalid chat ref')
    const mirror = mirrorPath(this.#root, projectRepositoryId)
    if (!(await this.isMirror(mirror))) return false
    const ref = repoChatRef(chatId)
    return this.#mirrors.run(mirror, () =>
      this.operation(async (op) => {
        if ((await this.refOf(op, mirror, ref)) !== (from ?? '')) return false
        if (from === to) return true
        if (to !== null && !(await this.commitsIn(op, mirror, [to]))[0])
          throw notFound('The commit is not in the repository of this project')
        const result = await this.command(
          op,
          to === null
            ? ['update-ref', '-d', ref, from ?? ZERO_SHA]
            : ['update-ref', ref, to, from ?? ZERO_SHA],
          { env: { GIT_DIR: mirror } },
        )
        return result.code === 0
      }),
    )
  }

  /**
   * Sends the chat's branch to the client (ПР13), only after a button: the head of the chat
   * fast-forwards the branch when the branch at the client is one of its commits; when the client
   * added commits (or the chat went back by `/undo`) the change since the last push goes on top of
   * the branch at the client by a three-way merge without a working tree, as one commit of the
   * platform; one that does not go on top is a conflict, and nothing is sent. Every push carries the
   * head it expects at the client (`--force-with-lease`); never a tag, never another branch.
   */
  async pushChatBranch(input: RepoPushInput): Promise<RepoPushResult> {
    if (
      !isAgentBranch(input.branch, input.defaultBranch) ||
      !publicationShaSchema.safeParse(input.head).success ||
      (input.sent !== null &&
        (!publicationShaSchema.safeParse(input.sent.remote).success ||
          !publicationShaSchema.safeParse(input.sent.mirror).success)) ||
      !Number.isFinite(Date.parse(input.committedAt))
    )
      throw repoProtectedBranch()
    const mirror = mirrorPath(this.#root, input.projectRepositoryId)
    const remote = await this.remote(input.remote)
    return this.#mirrors.run(mirror, () =>
      this.operation(async (op) => {
        await this.privateRepository(op, mirror, input.head)
        const heads = await this.remoteHeads(op, remote, [input.branch])
        const there = heads.get(input.branch) ?? null
        if (input.sent === null && there !== null) return { kind: 'name_taken' }
        let sha = input.head
        let rebased = false
        if (there !== null && there !== input.head) {
          if (!(await this.commitsIn(op, mirror, [there]))[0])
            await this.fetchInto(op, mirror, remote, [input.branch], heads, undefined)
          const ahead = await this.command(op, ['merge-base', '--is-ancestor', there, input.head])
          if (ahead.code !== 0) {
            if (ahead.code !== 1) throw failed()
            const merged = await this.mergeOnTop(op, {
              base: input.sent?.mirror ?? input.head,
              theirs: there,
              ours: input.head,
              chatId: input.chatId,
              committedAt: input.committedAt,
            })
            if (merged === null) return { kind: 'conflict' }
            if (merged === there) return { kind: 'pushed', sha: there, rebased: true }
            sha = merged
            rebased = true
          }
        }
        const pushed = await this.command(
          op,
          [
            'push',
            '--porcelain',
            '--quiet',
            '--no-verify',
            '--no-recurse-submodules',
            `--force-with-lease=refs/heads/${input.branch}:${there ?? ''}`,
            '--',
            remote.url,
            `${sha}:refs/heads/${input.branch}`,
          ],
          { env: remote.auth, remote, maxBytes: 64 * 1024 },
        )
        if (pushed.code !== 0) {
          const now = (await this.remoteHeads(op, remote, [input.branch])).get(input.branch) ?? null
          if (now !== there) return { kind: 'raced' }
          throw repoNotAllowed('push')
        }
        if (rebased) {
          // The commit put on top goes into the mirror too: the next turn may start from it.
          const out = join(op.root, 'pushed')
          await sharedDirectory(out)
          await this.git(op, ['pack-objects', '--revs', '--quiet', join(out, 'pack')], {
            input: Buffer.from(`${sha}\n^${input.head}\n^${there}\n`),
            maxBytes: 1024,
          })
          await this.movePacks(out, join(mirror, 'objects', 'pack'))
        }
        await this.git(op, ['update-ref', `refs/heads/${input.branch}`, sha], {
          env: { GIT_DIR: mirror },
        })
        return { kind: 'pushed', sha, rebased }
      }),
    )
  }

  /**
   * The changes from `base` to `ours`, on top of `theirs`: `git merge-tree --write-tree` in the
   * repository of the operation, one commit of the platform with the parent `theirs`. null — they
   * conflict; `theirs` itself — nothing is left to put on top.
   */
  private async mergeOnTop(
    op: Operation,
    input: { base: string; theirs: string; ours: string; chatId: string; committedAt: string },
  ): Promise<string | null> {
    const merged = await this.command(
      op,
      [
        'merge-tree',
        '--write-tree',
        '--no-messages',
        '--name-only',
        `--merge-base=${input.base}`,
        input.theirs,
        input.ours,
      ],
      { maxBytes: listBytes(publicationLimits.files) },
    )
    if (merged.code === 1) return null
    if (merged.code !== 0) throw failed()
    const tree = this.sha(Buffer.from(text(merged.stdout).split('\n')[0] ?? ''))
    const theirsTree = this.sha(
      (await this.git(op, ['rev-parse', '--verify', `${input.theirs}^{tree}`])).stdout,
    )
    if (tree === theirsTree) return input.theirs
    const message = `Raditi chat ${input.chatId}\n\nRaditi-Chat: ${input.chatId}\n`
    return this.sha(
      (
        await this.git(op, ['commit-tree', tree, '-p', input.theirs], {
          input: Buffer.from(message),
          env: botIdentity(input.committedAt),
        })
      ).stdout,
    )
  }

  /**
   * The candidate of a turn: the agent's patch (against the root commit of the base, the same
   * tree) and new files on the index of `baseSha`, every changed entry checked, the contents of
   * changed files against the turn's credentials, the values of the workspace's variables and
   * gitleaks, then a deterministic commit of the bot with `baseSha` as its parent.
   */
  async preparePublication(
    input: RepoPublication & {
      patch: Uint8Array
      untracked: Uint8Array
      credentials: readonly string[]
      refusedValues?: readonly string[]
      /** The files the sandbox held as a stub (ПР35): a change of one is refused. */
      hiddenPaths?: readonly string[]
    },
  ): Promise<RepoCandidate> {
    const {
      patch: rawPatch,
      untracked: rawUntracked,
      credentials: rawCredentials,
      refusedValues = [],
      hiddenPaths = [],
      ...rest
    } = input
    const hidden = new Set(hiddenPaths)
    const parsed = repoPublicationSchema.safeParse(rest)
    if (!parsed.success) throw badRequest('Invalid publication metadata')
    const metadata = parsed.data
    if (
      !(rawPatch instanceof Uint8Array) ||
      !(rawUntracked instanceof Uint8Array) ||
      rawCredentials.some((value) => typeof value !== 'string') ||
      refusedValues.some((value) => typeof value !== 'string')
    )
      throw badRequest('Invalid publication input')
    if (
      rawPatch.byteLength > publicationLimits.patchBytes ||
      rawUntracked.byteLength > snapshotLimits.archiveBytes
    )
      throw publicationTooLarge()
    const credentials = rawCredentials.filter(Boolean).map((value) => Buffer.from(value, 'utf8'))
    const refused = envValueBytes(refusedValues).map((value) => Buffer.from(value))
    const patch = Buffer.from(rawPatch)
    assertBinaryPatchLimits(patch)
    const files = await untrackedFiles(Buffer.from(rawUntracked))
    if (files.length > publicationLimits.files)
      throw publicationTooLarge('Publication changes too many files')
    for (const file of files) {
      publicationChangeOf({
        path: file.path,
        oldMode: '000000',
        newMode: file.mode,
        sizeBytes: file.bytes.byteLength,
      })
      if (hidden.has(file.path)) throw hiddenChanged()
    }
    const mirror = mirrorPath(this.#root, metadata.projectRepositoryId)
    const op = await this.#mirrors.run(mirror, async () => {
      const created = await this.newOperation()
      try {
        await this.privateRepository(created, mirror, metadata.baseSha)
        return created
      } catch (error) {
        await rm(created.root, { recursive: true, force: true })
        throw error
      }
    })
    try {
      await this.git(op, ['read-tree', metadata.baseSha])
      if (patch.byteLength) {
        const summary = await this.apply(op, ['--summary'], patch)
        const headers = text(summary.stdout, () => turnOutputRejected('Invalid patch summary'))
        if (/\b(?:120000|160000)\b|mode change |^ (?:copy|rename) /m.test(headers))
          throw turnOutputRejected('Publication contains a link, submodule or permission change')
        const stats = await this.apply(op, ['--numstat', '-z'], patch)
        const patchedPaths = this.checkNumstat(stats.stdout)
        if ([...patchedPaths].some((path) => hidden.has(path))) throw hiddenChanged()
        const patched = patchedPaths.size
        if (patched + files.length > publicationLimits.files)
          throw publicationTooLarge('Publication changes too many files')
        await this.checkPostimages(op, patch)
        // Atomic without --reject: on failure the index is unchanged and the operation discarded.
        await this.apply(op, ['--cached', '--whitespace=nowarn'], patch)
      }
      if (files.length) {
        const index = await this.index(op)
        for (const file of files)
          if (index.has(file.path))
            throw turnOutputRejected('Untracked publication file collides with the repository')
        const oids = await this.hashBlobs(
          op,
          files.map((file) => file.bytes),
        )
        await this.git(op, ['update-index', '-z', '--index-info'], {
          input: Buffer.from(
            files.map((file, i) => `${file.mode} ${oids[i]}\t${file.path}\0`).join(''),
          ),
        })
        // update-index skips a path Git refuses (core.protectNTFS: `git~1`, `.git.`) and exits 0.
        const candidate = await this.index(op)
        for (const [i, file] of files.entries()) {
          const entry = candidate.get(file.path)
          if (!entry || entry.oid !== oids[i] || entry.mode !== file.mode)
            throw turnOutputRejected('Untracked publication file is missing from the candidate')
        }
      }
      const fullPatch = await this.boundedPatch(op, metadata.baseSha)
      const buildPaths = await this.checkChanges(op, metadata.baseSha, credentials, refused)
      const tree = this.sha((await this.git(op, ['write-tree'])).stdout)
      const message = `Raditi chat ${metadata.chatId}, turn ${metadata.turn}\n\nRaditi-Chat: ${metadata.chatId}\nRaditi-Turn: ${metadata.turn}\n`
      const headSha = this.sha(
        (
          await this.git(op, ['commit-tree', tree, '-p', metadata.baseSha], {
            input: Buffer.from(message),
            env: botIdentity(metadata.createdAt),
          })
        ).stdout,
      )
      await this.git(op, [
        'fsck',
        '--no-full',
        '--strict',
        '--no-reflogs',
        '--no-progress',
        headSha,
      ])
      let disposed = false
      let publishing: Promise<void> | undefined
      return {
        baseSha: metadata.baseSha,
        headSha,
        patch: Uint8Array.from(fullPatch),
        buildPaths,
        publish: async (assertFence) => {
          if (disposed) throw conflict('Publication workspace was disposed')
          if (typeof assertFence !== 'function') throw badRequest('A publication fence is required')
          publishing ??= this.#mirrors
            .run(mirror, () => this.publish(op, mirror, metadata, headSha, assertFence))
            .finally(() => {
              publishing = undefined
            })
          return publishing
        },
        dispose: async () => {
          disposed = true
          if (publishing) await publishing.catch(() => {})
          await rm(op.root, { recursive: true, force: true })
        },
      }
    } catch (error) {
      await rm(op.root, { recursive: true, force: true })
      if (isDomainError(error)) throw error
      throw failed()
    }
  }

  // --- the steps -------------------------------------------------------------------------

  /**
   * The tree a sandbox gets of `baseSha` (ПР35): the same, but each hidden file a regular file of
   * HIDDEN_FILE_STUB. Built in the index of the operation, never on a disk.
   */
  private async sandboxTree(
    op: Operation,
    baseSha: string,
    hiddenPaths: readonly string[],
  ): Promise<string> {
    if (!hiddenPaths.length)
      return this.sha((await this.git(op, ['rev-parse', '--verify', `${baseSha}^{tree}`])).stdout)
    if (hiddenPaths.length > publicationLimits.files || !hiddenPaths.every(isPublicationPathLike))
      throw badRequest('Invalid hidden paths')
    await this.git(op, ['read-tree', baseSha])
    const index = await this.index(op)
    const hidden = [...new Set(hiddenPaths)].filter((path) => {
      const entry = index.get(path)
      return entry !== undefined && (entry.mode === '100644' || entry.mode === '100755')
    })
    if (hidden.length) {
      const [stub] = await this.hashBlobs(op, [Buffer.from(HIDDEN_FILE_STUB)])
      await this.git(op, ['update-index', '-z', '--index-info'], {
        input: Buffer.from(hidden.map((path) => `100644 ${stub}\t${path}\0`).join('')),
      })
    }
    return this.sha((await this.git(op, ['write-tree'])).stdout)
  }

  /** The commit in the mirror under the chat's ref: by CAS against `expectedRef`, after the fence. */
  private async publish(
    op: Operation,
    mirror: string,
    metadata: { chatId: string; baseSha: string; expectedRef: string | null },
    headSha: string,
    assertFence: () => Promise<void>,
  ): Promise<void> {
    const ref = repoChatRef(metadata.chatId)
    const current = await this.refOf(op, mirror, ref)
    if (current === headSha) return
    if (current !== (metadata.expectedRef ?? ''))
      throw conflict('The ref of the chat moved before publication')
    await assertFence()
    const out = join(op.root, 'out')
    await sharedDirectory(out)
    await this.git(op, ['pack-objects', '--revs', '--quiet', join(out, 'pack')], {
      input: Buffer.from(`${headSha}\n^${metadata.baseSha}\n`),
      maxBytes: 1024,
    })
    await this.movePacks(out, join(mirror, 'objects', 'pack'))
    await this.git(op, ['update-ref', ref, headSha, metadata.expectedRef ?? ZERO_SHA], {
      env: { GIT_DIR: mirror },
    })
  }

  private async fetchInto(
    op: Operation,
    mirror: string,
    remote: Remote,
    missing: readonly string[],
    heads: Map<string, string>,
    quotaBytes: number | undefined,
  ): Promise<void> {
    if (!missing.length) return
    const used =
      (await directoryBytes(join(this.#root, 'repos'))) +
      (await directoryBytes(join(this.#root, 'bundles')))
    const quota = Math.min(
      this.options.fetchBytes ?? mirrorLimits.fetchBytes,
      quotaBytes ?? Number.MAX_SAFE_INTEGER,
      (this.options.volumeBytes ?? mirrorLimits.volumeBytes) - used,
    )
    if (quota <= 0) throw repositoryTooLarge('The volume of the mirrors is full')
    const incoming = join(op.root, 'incoming.git')
    await this.initBare(op, incoming)
    await this.git(
      op,
      [
        'fetch',
        '--depth=1',
        '--no-tags',
        '--quiet',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--no-auto-maintenance',
        '--',
        remote.url,
        ...missing.map((branch) => `+refs/heads/${branch}:refs/heads/${branch}`),
      ],
      {
        env: { ...remote.auth, GIT_DIR: incoming },
        remote,
        quota: { path: incoming, bytes: quota },
      },
    )
    // A branch that moved between ls-remote and fetch: the fetched head is the one we keep.
    for (const branch of missing) {
      const sha = await this.refOf(op, incoming, `refs/heads/${branch}`)
      if (!sha) throw failed()
      heads.set(branch, sha)
    }
    await this.checkObjects(op, incoming)
    await this.movePacks(join(incoming, 'objects', 'pack'), join(mirror, 'objects', 'pack'))
    await this.mergeShallow(join(incoming, 'shallow'), join(mirror, 'shallow'))
  }

  /** No object of a fetch above its limit (ПР12: `cat-file --batch-check`). */
  private async checkObjects(op: Operation, repo: string): Promise<void> {
    const listing = await this.git(
      op,
      ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectsize)'],
      { env: { GIT_DIR: repo }, maxBytes: 64 * 1024 * 1024 },
    )
    for (const row of text(listing.stdout).split('\n')) {
      if (!row) continue
      const size = Number(row.split(' ')[1])
      if (!Number.isSafeInteger(size)) throw failed()
      if (size > mirrorLimits.objectBytes)
        throw repositoryTooLarge('A file of the repository exceeds its limit')
    }
  }

  /** Packs (and their reverse indexes) first, indexes last: a reader never sees half a pack. */
  private async movePacks(from: string, to: string): Promise<void> {
    const names = await readdir(from).catch(() => [] as string[])
    const order = (name: string) => (name.endsWith('.idx') ? 1 : 0)
    for (const name of names
      .filter((n) => /^pack-[a-f0-9]{40,64}\.(?:pack|rev|idx)$/.test(n))
      .sort((a, b) => order(a) - order(b))) {
      const source = join(from, name)
      if (!(await lstat(source)).isFile()) throw failed()
      await rename(source, join(to, name))
    }
  }

  private async mergeShallow(from: string, to: string): Promise<void> {
    const read = async (path: string) =>
      (await readFile(path, 'latin1').catch(() => ''))
        .split('\n')
        .filter((line) => /^[a-f0-9]{40}$/.test(line))
    const rows = [...new Set([...(await read(to)), ...(await read(from))])].sort()
    if (!rows.length) return
    const temporary = `${to}.${randomBytes(6).toString('hex')}.tmp`
    await sharedFile(temporary, rows.map((row) => `${row}\n`).join(''))
    await rename(temporary, to)
  }

  /** The heads of `branches` on the remote; a branch it lacks is absent from the map. */
  private async remoteHeads(
    op: Operation,
    remote: Remote,
    branches: readonly string[],
  ): Promise<Map<string, string>> {
    const listed = await this.git(
      op,
      [
        'ls-remote',
        '--heads',
        '--',
        remote.url,
        ...branches.map((branch) => `refs/heads/${branch}`),
      ],
      { env: remote.auth, remote, maxBytes: 64 * 1024, repository: false },
    )
    const heads = new Map<string, string>()
    for (const row of text(listed.stdout).split('\n')) {
      if (!row) continue
      const match = /^([a-f0-9]{40})\trefs\/heads\/(.+)$/.exec(row)
      if (!match) throw failed()
      if (branches.includes(match[2]!)) heads.set(match[2]!, match[1]!)
    }
    return heads
  }

  /**
   * The base tree of a sandbox within the limits of §4.7: regular files, links and submodules
   * (as entries — nothing is ever checked out here), up to `repositoryFiles` files and `treeBytes`.
   */
  private async checkTree(op: Operation, sha: string): Promise<void> {
    let listing: GitCommandResult
    try {
      listing = await this.git(op, ['ls-tree', '-rz', '--full-tree', sha], {
        maxBytes: listBytes(publicationLimits.repositoryFiles),
      })
    } catch (error) {
      if (isDomainError(error) && error.code === 'PROCESS_OUTPUT_LIMIT')
        throw repositoryTooLarge('Repository has too many files')
      throw error
    }
    const raw = text(listing.stdout, () =>
      repositoryUnsupported('Tree contains a path that is not UTF-8'),
    )
    const blobs: string[] = []
    let files = 0
    for (const row of raw ? raw.replace(/\0$/, '').split('\0') : []) {
      const match = TREE_ROW.exec(row)
      if (!match) throw repositoryUnsupported('Tree contains an unsupported entry')
      if (++files > publicationLimits.repositoryFiles)
        throw repositoryTooLarge('Repository has too many files')
      if (match[2] === 'blob') blobs.push(match[3]!)
    }
    const sizes = await this.blobSizes(op, blobs, repositoryTooLarge)
    const total = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0)
    if (total > publicationLimits.treeBytes)
      throw repositoryTooLarge('Repository tree exceeds its limit')
  }

  /**
   * Every changed entry of the index against `baseSha`: modes and sizes (publicationChangeOf),
   * the paths and the whole contents against the credentials and the values, then one gitleaks
   * run over host-numbered copies. Returns the changed paths of the build.
   */
  private async checkChanges(
    op: Operation,
    baseSha: string,
    credentials: readonly Buffer[],
    refused: readonly Buffer[],
  ): Promise<string[]> {
    const changes = await this.rawChanges(op, baseSha)
    if (changes.length > publicationLimits.files)
      throw publicationTooLarge('Publication changes too many files')
    if (changes.some((change) => refused.some((value) => Buffer.from(change.path).includes(value))))
      throw envValueInChange()
    const added = changes.filter((change) => change.newMode !== '000000')
    const sizes = await this.blobSizes(
      op,
      added.map((change) => change.newOid),
      publicationTooLarge,
    )
    const bySize = new Map(added.map((change, i) => [change.path, sizes[i] ?? 0]))
    const build: string[] = []
    const blobs = new Map<string, number>()
    for (const change of changes) {
      const verdict = publicationChangeOf({
        path: change.path,
        oldMode: change.oldMode,
        newMode: change.newMode,
        sizeBytes: bySize.get(change.path) ?? 0,
      })
      if (verdict.build) build.push(change.path)
      if (change.newMode !== '000000') blobs.set(change.newOid, bySize.get(change.path) ?? 0)
    }
    await this.scanBlobs(op, blobs, credentials, refused)
    return build
  }

  private async rawChanges(op: Operation, baseSha: string): Promise<RawChange[]> {
    let output: Uint8Array
    try {
      output = (
        await this.git(
          op,
          ['diff-index', '--cached', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', baseSha],
          {
            maxBytes: (publicationLimits.files + 1) * (128 + publicationLimits.pathBytes),
          },
        )
      ).stdout
    } catch (error) {
      if (isDomainError(error) && error.code === 'PROCESS_OUTPUT_LIMIT')
        throw publicationTooLarge('Candidate changes too many files')
      throw error
    }
    const fields = text(output).split('\0')
    if (fields.pop() !== '' || fields.length % 2 !== 0) throw failed()
    const changes: RawChange[] = []
    for (let i = 0; i < fields.length; i += 2) {
      const match = RAW_CHANGE.exec(fields[i]!)
      const path = fields[i + 1]!
      if (!match) throw failed()
      changes.push({
        path,
        oldMode: match[1]!,
        newMode: match[2]!,
        oldOid: match[3]!,
        newOid: match[4]!,
      })
    }
    return changes
  }

  /** Sizes by OID, each within the per-file limit; a missing one is undefined when allowed. */
  private async blobSizes(
    op: Operation,
    oids: readonly string[],
    tooLarge: (message: string) => Error,
    allowMissing = false,
  ): Promise<(number | undefined)[]> {
    if (!oids.length) return []
    const output = await this.git(
      op,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      {
        input: Buffer.from(oids.join('\n') + '\n'),
        maxBytes: oids.length * 128,
      },
    )
    const rows = text(output.stdout).trimEnd().split('\n')
    if (rows.length !== oids.length) throw failed()
    return oids.map((oid, i) => {
      if (allowMissing && rows[i] === `${oid} missing`) return undefined
      const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(rows[i]!)
      const size = Number(match?.[2])
      if (!match || match[1] !== oid || !Number.isSafeInteger(size))
        throw turnOutputRejected('Not a regular blob')
      if (size > publicationLimits.fileBytes) throw tooLarge('A file exceeds its size limit')
      return size
    })
  }

  /** Returns the paths the patch changes. */
  private checkNumstat(output: Uint8Array): Set<string> {
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
      publicationChangeOf({ path: match[1]!, oldMode: '000000', newMode: '000000', sizeBytes: 0 })
    }
    return paths
  }

  /**
   * Git can take a binary postimage straight from its object store instead of inflating the
   * supplied payload: bound those historical blobs too, before native apply allocates them.
   */
  private async checkPostimages(op: Operation, patch: Uint8Array): Promise<void> {
    const oids: string[] = []
    for (const line of Buffer.from(patch).toString('latin1').split('\n')) {
      if (!line.startsWith('index ')) continue
      const match = /^index [a-f0-9]{4,40}\.\.([a-f0-9]{4,40})(?: [0-7]{6})?$/.exec(line)
      if (!match) throw turnOutputRejected('Invalid publication object header')
      if (match[1]!.length === 40 && !/^0+$/.test(match[1]!)) oids.push(match[1]!)
    }
    if (oids.length > publicationLimits.files)
      throw publicationTooLarge('Publication changes too many files')
    await this.blobSizes(op, oids, publicationTooLarge, true)
  }

  /** The candidate's patch against its base, within the snapshot's patch limit. */
  private async boundedPatch(op: Operation, baseSha: string): Promise<Buffer> {
    try {
      return (
        await this.git(
          op,
          [
            'diff',
            '--binary',
            '--full-index',
            '--no-renames',
            '--no-ext-diff',
            '--no-textconv',
            '--cached',
            baseSha,
            '--',
          ],
          { maxBytes: publicationLimits.patchBytes },
        )
      ).stdout
    } catch (error) {
      if (isDomainError(error) && error.code === 'PROCESS_OUTPUT_LIMIT') throw publicationTooLarge()
      throw error
    }
  }

  private async index(op: Operation): Promise<Map<string, Entry>> {
    const files = publicationLimits.repositoryFiles + publicationLimits.files
    let output: GitCommandResult
    try {
      output = await this.git(op, ['ls-files', '--stage', '-z'], { maxBytes: listBytes(files) })
    } catch (error) {
      if (isDomainError(error) && error.code === 'PROCESS_OUTPUT_LIMIT')
        throw publicationTooLarge('File list exceeds its limit')
      throw error
    }
    const raw = text(output.stdout, () => turnOutputRejected('Index has a path that is not UTF-8'))
    const entries = new Map<string, Entry>()
    for (const row of raw ? raw.replace(/\0$/, '').split('\0') : []) {
      const match = INDEX_ROW.exec(row)
      if (!match) throw turnOutputRejected('Unsupported index entry')
      entries.set(match[3]!, { mode: match[1]!, oid: match[2]!, path: match[3]! })
    }
    return entries
  }

  /** New files as blobs with one hash-object; the copies are numbered by the host. */
  private async hashBlobs(op: Operation, blobs: readonly Uint8Array[]): Promise<string[]> {
    const directory = join(op.root, 'new')
    await sharedDirectory(directory)
    try {
      const paths = blobs.map((_, i) => join(directory, String(i)))
      for (const [i, blob] of blobs.entries()) await sharedFile(paths[i]!, blob)
      const output = await this.git(op, ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
        input: Buffer.from(paths.map((path) => `${path}\n`).join('')),
        maxBytes: blobs.length * 41,
      })
      const oids = text(output.stdout).split('\n')
      if (oids.pop() !== '' || oids.length !== blobs.length) throw failed()
      for (const oid of oids) if (!publicationShaSchema.safeParse(oid).success) throw failed()
      return oids
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  /** Each blob in full, a few `cat-file --batch` reads of at most one file limit each. */
  private async readBlobs(
    op: Operation,
    blobs: Map<string, number>,
    visit: (oid: string, blob: Buffer) => void | Promise<void>,
  ): Promise<void> {
    for (const batch of batches([...blobs], publicationLimits.fileBytes)) {
      const headers = batch.map(([oid, size]) => `${oid} blob ${size}\n`)
      const expected = batch.reduce(
        (total, [, size], i) => total + headers[i]!.length + size + 1,
        0,
      )
      const output = (
        await this.git(op, ['cat-file', '--batch'], {
          input: Buffer.from(batch.map(([oid]) => `${oid}\n`).join('')),
          maxBytes: expected,
        })
      ).stdout
      if (output.byteLength !== expected) throw failed()
      let at = 0
      for (const [i, [oid, size]] of batch.entries()) {
        const header = headers[i]!
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
   * The turn's exact credentials and the values of the variables in memory, then one gitleaks
   * run over host-numbered copies: agent paths never name a file, `gitleaks:allow` is off.
   */
  private async scanBlobs(
    op: Operation,
    blobs: Map<string, number>,
    credentials: readonly Buffer[],
    refused: readonly Buffer[],
  ): Promise<void> {
    if (!blobs.size) return
    const directory = join(op.root, 'scan')
    await sharedDirectory(directory)
    try {
      let written = 0
      await this.readBlobs(op, blobs, async (_, blob) => {
        if (credentials.some((value) => blob.includes(value))) throw snapshotHasCredential()
        if (refused.some((value) => blob.includes(value))) throw envValueInChange()
        await sharedFile(join(directory, String(written++)), scanCopy(blob))
      })
      if (this.options.gitleaks === false) return
      const scan = await this.#runner.run({
        tool: 'gitleaks',
        args: [directory, join(op.root, 'gitleaks.toml'), join(op.root, 'empty')],
        cwd: op.root,
        protocol: 'none',
      })
      if (scan.code === GITLEAKS_FINDING_EXIT) throw publicationSecret()
      if (scan.code !== 0) throw failed()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  // --- repositories and commands ---------------------------------------------------------

  /** Runs `body` in a new operation directory, removed afterwards whatever happens. */
  private async operation<T>(body: (op: Operation) => Promise<T>): Promise<T> {
    const op = await this.newOperation()
    try {
      return await body(op)
    } catch (error) {
      if (isDomainError(error)) throw error
      throw failed()
    } finally {
      await rm(op.root, { recursive: true, force: true })
    }
  }

  private async newOperation(): Promise<Operation> {
    const dir = operationsDir(this.#root)
    await sharedDirectory(dir, true)
    const root = join(dir, randomBytes(12).toString('hex'))
    await sharedDirectory(root)
    await sharedDirectory(join(root, 'empty'))
    await sharedDirectory(join(root, 'template'))
    await sharedFile(join(root, 'gitleaks.toml'), GITLEAKS_CONFIG)
    await sharedFile(join(root, 'empty', '.gitleaksignore'), '')
    return { root, repo: join(root, 'repo.git') }
  }

  /**
   * The private repository of an operation over the mirror: `git init --bare` without a template,
   * the mirror's objects as an alternate and its shallow commits, nothing else — no remote, no
   * refs, no working tree. `sha` must be a commit of this mirror.
   */
  private async privateRepository(op: Operation, mirror: string, sha: string): Promise<void> {
    if (!(await this.isMirror(mirror)) || !(await this.commitsIn(op, mirror, [sha]))[0])
      throw notFound('The commit is not in the repository of this project')
    await this.initBare(op, op.repo)
    await sharedFile(join(op.repo, 'objects', 'info', 'alternates'), `${join(mirror, 'objects')}\n`)
    const shallow = await readFile(join(mirror, 'shallow')).catch(() => null)
    if (shallow) await sharedFile(join(op.repo, 'shallow'), shallow)
  }

  private async initBare(op: Operation, target: string): Promise<void> {
    await this.git(
      op,
      [
        'init',
        '--bare',
        '--quiet',
        '--initial-branch=raditi',
        `--template=${join(op.root, 'template')}`,
        target,
      ],
      {
        cwd: op.root,
        repository: false,
      },
    )
  }

  private async isMirror(path: string): Promise<boolean> {
    try {
      return (
        (await stat(join(path, 'HEAD'))).isFile() &&
        (await stat(join(path, 'objects'))).isDirectory()
      )
    } catch {
      return false
    }
  }

  /**
   * The bare mirror as `git init --bare` makes it on this volume: one whose configuration is not
   * that, or which borrows objects elsewhere, is made again — git reads them in fetch and cat-file.
   * Made under a temporary name and renamed: a mirror is never seen half made.
   */
  private async ensureMirror(op: Operation, path: string): Promise<void> {
    if (await this.isPristineMirror(op, path)) return
    await sharedDirectory(join(this.#root, 'repos'), true)
    await rm(path, { recursive: true, force: true })
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await this.initBare(op, temporary)
      await rename(temporary, path)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  private async isPristineMirror(op: Operation, path: string): Promise<boolean> {
    if (!(await this.isMirror(path))) return false
    if (await stat(join(path, 'objects', 'info', 'alternates')).catch(() => null)) return false
    const config = await readFile(join(path, 'config')).catch(() => null)
    return config !== null && config.equals(await this.initialConfig(op))
  }

  private initialConfig(op: Operation): Promise<Buffer> {
    this.#initialConfig ??= (async () => {
      const scratch = join(op.root, 'initial.git')
      try {
        await this.initBare(op, scratch)
        return await readFile(join(scratch, 'config'))
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    })()
    this.#initialConfig.catch(() => {
      this.#initialConfig = undefined
    })
    return this.#initialConfig
  }

  private async commitsIn(
    op: Operation,
    repo: string,
    shas: readonly string[],
  ): Promise<boolean[]> {
    if (!shas.length) return []
    const result = await this.git(op, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
      env: { GIT_DIR: repo },
      input: Buffer.from(shas.map((sha) => `${sha}^{commit}\n`).join('')),
      maxBytes: shas.length * 128,
    })
    const rows = text(result.stdout).trimEnd().split('\n')
    if (rows.length !== shas.length) throw failed()
    return shas.map((sha, i) => rows[i] === `${sha} commit`)
  }

  /** The commit a ref of `repo` points at; empty when it does not exist. */
  private async refOf(op: Operation, repo: string, ref: string): Promise<string> {
    const result = await this.command(op, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      env: { GIT_DIR: repo },
    })
    if (result.code !== 0) return ''
    return this.sha(result.stdout)
  }

  /** The checked remote of one operation: its URL, protocol, pin and grant. */
  private async remote(remote: RepoRemote): Promise<Remote> {
    const auth = gitAuthEnvironment(remote.access)
    const transport = this.options.transport
    if (transport.kind === 'local-test') {
      try {
        const root = await realpath(transport.root)
        const path = await realpath(remote.cloneUrl)
        const child = relative(root, path)
        if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error()
        return { url: path, protocol: 'file', auth }
      } catch {
        throw forbidden('Local test repository is outside its fixture')
      }
    }
    let url: URL
    try {
      url = new URL(remote.cloneUrl)
    } catch {
      throw forbidden('Invalid repository address')
    }
    if (
      url.protocol !== 'https:' ||
      url.port !== '' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !remote.pin ||
      remote.pin.host !== url.hostname
    )
      throw forbidden('A repository address must be https on 443 with its pinned address')
    return { url: url.href, protocol: 'https', pin: remote.pin, auth }
  }

  private sha(output: Uint8Array): string {
    const value = text(output).trim()
    if (!publicationShaSchema.safeParse(value).success) throw failed()
    return value
  }

  /** Git refusing the agent's patch is its output's fault; a failed or timed-out run is ours. */
  private async apply(op: Operation, args: string[], patch: Buffer): Promise<GitCommandResult> {
    const result = await this.command(op, ['apply', ...args, '-'], { input: patch })
    if (result.code !== 0) throw turnOutputRejected('Invalid publication patch')
    return result
  }

  private async git(
    op: Operation,
    args: string[],
    run: CommandRun = {},
  ): Promise<GitCommandResult> {
    const result = await this.command(op, args, run)
    if (result.code !== 0) throw failed()
    return result
  }

  /** One git subcommand in the worker, in the operation's directory, on its repository. */
  private command(op: Operation, args: string[], run: CommandRun = {}): Promise<GitCommandResult> {
    const env = { ...(run.repository === false ? {} : { GIT_DIR: op.repo }), ...run.env }
    const request: GitWorkerRequest = {
      tool: 'git',
      args,
      cwd: run.cwd ?? op.root,
      protocol: run.remote?.protocol ?? 'none',
      ...(run.remote?.pin ? { pin: run.remote.pin } : {}),
      env,
      ...(run.input === undefined ? {} : { input: Buffer.from(run.input).toString('base64') }),
      ...(run.maxBytes === undefined ? {} : { maxBytes: run.maxBytes }),
      ...(run.quota ? { quota: run.quota } : {}),
    }
    return this.#runner.run(request)
  }
}

interface Remote {
  url: string
  protocol: 'https' | 'file'
  pin?: { host: string; address: string }
  auth: Record<string, string>
}

interface CommandRun {
  cwd?: string
  input?: Uint8Array
  maxBytes?: number
  env?: Record<string, string>
  remote?: Remote
  quota?: { path: string; bytes: number }
  /** false — no GIT_DIR of the operation (init). */
  repository?: false
}
