import { Buffer } from 'node:buffer'
import { statSync } from 'node:fs'
import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

import {
  INITIAL_SITE_TAG,
  isDomainError,
  isPublicationPath,
  publicationLimits,
  publicationShaSchema,
  siteImportLimits,
  type GitProvider,
  type RepoRef,
} from '@repo/domain'

import type { GitWorkspaceOptions } from '../git-workspace/git-workspace.service.ts'
import type { ProcessResult } from '../git-workspace/process.ts'
import {
  issueGitAuth,
  runTrustedGit,
  type TrustedGitContext,
} from '../git-workspace/trusted-git.ts'
import { hiccup, refuse } from './import-failure.ts'
import type { TakenFile } from './tree-walk.ts'

export type SiteGitTransport = GitWorkspaceOptions['transport']

export interface InitialVersionGitOptions {
  provider: Pick<GitProvider, 'issueCredentials'>
  /** As GitWorkspaceOptions: https to the origins of the configured Gitea, or a test fixture. */
  transport: SiteGitTransport
}

/** What the remote has at the two refs of the first version; null — no such ref. */
export interface RemoteRefs {
  main: string | null
  tag: string | null
}

export const MAIN_REF = 'refs/heads/main'
export const TAG_REF = `refs/tags/${INITIAL_SITE_TAG}`
const BOT_NAME = 'Raditi Bot'
const BOT_EMAIL = 'bot@raditi.ru'

const text = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw refuse('internal')
  }
}

/** Consecutive groups within the hash limits; a single larger file is a group of its own. */
function hashBatches(files: readonly TakenFile[]): TakenFile[][] {
  const groups: TakenFile[][] = []
  let bytes = 0
  for (const file of files) {
    const last = groups.at(-1)
    if (
      !last ||
      last.length >= siteImportLimits.hashBatchFiles ||
      bytes + file.bytes > siteImportLimits.hashBatchBytes
    ) {
      groups.push([file])
      bytes = file.bytes
    } else {
      last.push(file)
      bytes += file.bytes
    }
  }
  return groups
}

/** The commit message of every first version: the site it belongs to, nothing of the client's. */
export const initialCommitMessage = (siteId: string): string =>
  `Initial version of the site\n\nRaditi-Site: ${siteId}\n`

/**
 * The git half of the first version of a site (docs/plan/39-site-connection-wizard.md): a root
 * commit built from the downloaded copies in a private repository, its publication as `main`
 * and as the lightweight tag `v0.0.0` without `--force`, and the remote refs that tell a retry
 * what is already there. Every command is a trusted git (git-workspace/trusted-git.ts); a grant
 * travels only in its environment.
 */
export class InitialVersionGit {
  readonly #provider: Pick<GitProvider, 'issueCredentials'>
  readonly #transport: SiteGitTransport

  constructor(options: InitialVersionGitOptions) {
    const { transport } = options
    if (transport.kind === 'local-test' && process.env.NODE_ENV !== 'test')
      throw new Error('Local repository transport is restricted to tests')
    if (transport.kind === 'https') {
      const invalid = transport.allowedOrigins.some((origin) => {
        try {
          const url = new URL(origin)
          return url.protocol !== 'https:' || url.origin !== origin
        } catch {
          return true
        }
      })
      if (invalid) throw new Error('Invalid repository origin allowlist')
      if (transport.caFile !== undefined) {
        let regular = false
        try {
          regular = isAbsolute(transport.caFile) && statSync(transport.caFile).isFile()
        } catch {
          // A missing file fails here, at start, and not inside the first import.
        }
        if (!regular) throw new Error('Repository CA file must be an absolute path of a file')
      }
    }
    this.#provider = options.provider
    this.#transport = transport
  }

  context(home: string): TrustedGitContext {
    const transport = this.#transport
    return transport.kind === 'https'
      ? {
          home,
          protocol: 'https',
          ...(transport.caFile === undefined ? {} : { caFile: transport.caFile }),
        }
      : { home, protocol: 'file' }
  }

  /**
   * The address git pushes to: https at one of the configured origins without credentials, query
   * or fragment — or, in tests, a repository inside the fixture. Anything else is a Gitea that
   * is not ours: `repository_not_configured`.
   */
  async remoteUrl(cloneUrl: string): Promise<string> {
    const transport = this.#transport
    if (transport.kind === 'local-test') {
      try {
        const root = await realpath(transport.root)
        const path = await realpath(cloneUrl)
        const child = relative(root, path)
        if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error()
        return path
      } catch {
        throw refuse('repository_not_configured')
      }
    }
    try {
      const url = new URL(cloneUrl)
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
      throw refuse('repository_not_configured')
    }
  }

  /** A short grant; the test transport has none. Our Gitea away is a hiccup, a bad grant is not. */
  async #auth(ref: RepoRef, access: 'read' | 'write'): Promise<NodeJS.ProcessEnv> {
    if (this.#transport.kind === 'local-test') return {}
    try {
      return await issueGitAuth(this.#provider, ref, access)
    } catch (error) {
      if (isDomainError(error) && error.code === 'GIT_OPERATION_FAILED')
        throw hiccup('repository_push_failed')
      throw refuse('repository_push_failed')
    }
  }

  async #git(
    home: string,
    cwd: string,
    args: string[],
    run: { input?: Uint8Array; maxBytes?: number; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ): Promise<ProcessResult> {
    try {
      return await runTrustedGit(this.context(home), args, { cwd, ...run })
    } catch {
      throw refuse('internal')
    }
  }

  async #local(
    home: string,
    cwd: string,
    args: string[],
    run: { input?: Uint8Array; maxBytes?: number; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ): Promise<ProcessResult> {
    const result = await this.#git(home, cwd, args, run)
    if (result.code !== 0) throw refuse('internal')
    return result
  }

  /**
   * `main` and `v0.0.0` of the remote, with a read grant, from the empty directory `home`.
   * `--refs` leaves out peeled tags: an annotated tag shows its own object, never the commit.
   * A ref the remote shows beyond the two asked for (`ls-remote` matches by the tail) means the
   * repository holds something else than an import: `repository_mismatch`.
   */
  async remoteRefs(home: string, url: string, ref: RepoRef): Promise<RemoteRefs> {
    const auth = await this.#auth(ref, 'read')
    let result: ProcessResult
    try {
      result = await runTrustedGit(
        this.context(home),
        ['ls-remote', '--refs', url, MAIN_REF, TAG_REF],
        { cwd: home, env: auth, maxBytes: 4096 },
      )
    } catch {
      // A command past its deadline, or a grant that ran out on the way: our Gitea was slow.
      throw hiccup('repository_push_failed')
    }
    if (result.code !== 0) throw hiccup('repository_push_failed')
    const refs: RemoteRefs = { main: null, tag: null }
    const output = text(result.stdout)
    for (const line of output.split('\n')) {
      if (line === '') continue
      const match = /^([a-f0-9]{40})\t(.+)$/.exec(line)
      if (!match) throw refuse('repository_mismatch')
      const [, sha, name] = match
      if (name === MAIN_REF && refs.main === null) refs.main = sha!
      else if (name === TAG_REF && refs.tag === null) refs.tag = sha!
      else throw refuse('repository_mismatch')
    }
    return refs
  }

  /**
   * The root commit of the taken files in a new private repository at `<root>/repo`: blobs from
   * the numbered copies (no filters), an index of `100644` entries checked back, a tree, a commit
   * without parent by the bot at `now`, `fsck --strict`, and the bundle of it within its limit.
   * Returns the commit and the files the index kept: git leaves out a path it refuses
   * (core.protectNTFS, core.protectHFS) and still exits 0 — such a path is counted, not imported.
   */
  async buildCommit(
    root: string,
    files: readonly TakenFile[],
    siteId: string,
    now: Date,
  ): Promise<{ sha: string; files: TakenFile[]; dropped: number }> {
    const template = join(root, 'git-template')
    const repo = join(root, 'repo')
    await mkdir(template, { mode: 0o700 })
    await this.#local(root, root, [
      'init',
      '--quiet',
      `--template=${template}`,
      '--object-format=sha1',
      '--initial-branch=main',
      repo,
    ])
    const oids = new Map<string, string>()
    for (const batch of hashBatches(files)) {
      const output = await this.#local(
        root,
        repo,
        ['hash-object', '-w', '--no-filters', '--stdin-paths'],
        {
          input: Buffer.from(batch.map((file) => `${file.blob}\n`).join('')),
          maxBytes: batch.length * 41,
        },
      )
      const lines = text(output.stdout).split('\n')
      if (lines.pop() !== '' || lines.length !== batch.length) throw refuse('internal')
      for (const [index, oid] of lines.entries()) {
        if (!publicationShaSchema.safeParse(oid).success) throw refuse('internal')
        oids.set(batch[index]!.path, oid)
      }
    }
    for (const file of files) if (!isPublicationPath(file.path)) throw refuse('internal')
    await this.#local(root, repo, ['update-index', '--add', '-z', '--index-info'], {
      input: Buffer.from(
        files.map((file) => `100644 ${oids.get(file.path)}\t${file.path}\0`).join(''),
      ),
    })
    const listing = await this.#local(root, repo, ['ls-files', '--stage', '-z'], {
      maxBytes: Math.max(1, files.length) * (64 + publicationLimits.pathBytes),
    })
    const raw = text(listing.stdout)
    if (raw && !raw.endsWith('\0')) throw refuse('internal')
    const indexed = new Map<string, string>()
    for (const row of raw ? raw.slice(0, -1).split('\0') : []) {
      const match = /^100644 ([a-f0-9]{40}) 0\t([^\0]+)$/.exec(row)
      if (!match || indexed.has(match[2]!) || oids.get(match[2]!) !== match[1])
        throw refuse('internal')
      indexed.set(match[2]!, match[1]!)
    }
    const kept = files.filter((file) => indexed.has(file.path))
    if (kept.length !== indexed.size) throw refuse('internal')
    if (kept.length === 0) throw refuse('source_empty')
    const tree = this.#sha((await this.#local(root, repo, ['write-tree'])).stdout)
    const date = `${Math.floor(now.getTime() / 1000)} +0000`
    const sha = this.#sha(
      (
        await this.#local(root, repo, ['commit-tree', tree], {
          input: Buffer.from(initialCommitMessage(siteId)),
          env: {
            GIT_AUTHOR_NAME: BOT_NAME,
            GIT_AUTHOR_EMAIL: BOT_EMAIL,
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_NAME: BOT_NAME,
            GIT_COMMITTER_EMAIL: BOT_EMAIL,
            GIT_COMMITTER_DATE: date,
          },
        })
      ).stdout,
    )
    await this.#local(root, repo, ['fsck', '--strict', '--no-reflogs', '--no-dangling', sha])
    // The bundle of this ref must fit the repository's limit; a turn takes only its working set.
    await this.#local(root, repo, ['update-ref', MAIN_REF, sha])
    const bundle = join(root, 'initial.bundle')
    await this.#local(root, repo, ['bundle', 'create', bundle, MAIN_REF])
    const size = (await stat(bundle)).size
    await rm(bundle, { force: true })
    if (size > siteImportLimits.bundleBytes) throw refuse('source_too_large')
    return { sha, files: kept, dropped: files.length - kept.length }
  }

  /**
   * A retry that finds `main` at the recorded commit has no copy of it: fetches that one commit
   * (a root commit: depth 1 is all of it) into a new private repository at `<root>/repo`, so the
   * tag can be pushed. `main` that moved since it was read is `repository_mismatch`. A run that
   * built a commit of its own and then took over an earlier one replaces its repository.
   */
  async fetchCommit(root: string, url: string, ref: RepoRef, sha: string): Promise<void> {
    const template = join(root, 'git-template')
    const repo = join(root, 'repo')
    await rm(repo, { recursive: true, force: true })
    await rm(template, { recursive: true, force: true })
    await mkdir(template, { mode: 0o700 })
    await this.#local(root, root, [
      'init',
      '--quiet',
      `--template=${template}`,
      '--object-format=sha1',
      '--initial-branch=main',
      repo,
    ])
    const auth = await this.#auth(ref, 'read')
    let fetched: ProcessResult
    try {
      fetched = await runTrustedGit(
        this.context(root),
        ['fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules', url, MAIN_REF],
        { cwd: repo, env: auth, maxBytes: 16 * 1024 },
      )
    } catch {
      throw hiccup('repository_push_failed')
    }
    if (fetched.code !== 0) throw hiccup('repository_push_failed')
    const head = this.#sha(
      (await this.#local(root, repo, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).stdout,
    )
    if (head !== sha) throw refuse('repository_mismatch')
  }

  /**
   * Pushes `sha` from `<root>/repo` to one of the two refs with a write grant, never forced: the
   * server refuses a `main` that would not fast-forward and a tag that exists. true — the server
   * took it (or had it already); false — it did not, and the caller reads the remote to see why.
   */
  async push(
    root: string,
    url: string,
    ref: RepoRef,
    sha: string,
    target: typeof MAIN_REF | typeof TAG_REF,
  ): Promise<boolean> {
    const auth = await this.#auth(ref, 'write')
    try {
      const result = await runTrustedGit(
        this.context(root),
        ['push', '--porcelain', '--no-recurse-submodules', url, `${sha}:${target}`],
        { cwd: join(root, 'repo'), env: auth, maxBytes: 16 * 1024 },
      )
      return result.code === 0
    } catch {
      // Past its deadline the push may still have landed: the remote refs tell.
      return false
    }
  }

  /**
   * The copy of the first version for raditi-backups (initial-backup.ts): `sha`, fetched alone
   * into `<root>/repo` (fetchCommit), written as a tar.gz to `file` by `git archive` — the tree
   * as the commit has it, without the history or the `.git` folder.
   */
  async archiveCommit(
    root: string,
    url: string,
    ref: RepoRef,
    sha: string,
    file: string,
  ): Promise<void> {
    if (!publicationShaSchema.safeParse(sha).success) throw refuse('internal')
    await this.fetchCommit(root, url, ref, sha)
    await this.#local(
      root,
      join(root, 'repo'),
      ['archive', '--format=tar.gz', `--output=${file}`, sha],
      { timeoutMs: 60_000 },
    )
  }

  #sha(output: Uint8Array): string {
    const value = text(output).trim()
    if (!publicationShaSchema.safeParse(value).success) throw refuse('internal')
    return value
  }
}
