import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

import {
  assertPublicationChange,
  assertPublicationPath,
  badRequest,
  conflict,
  DomainError,
  forbidden,
  isDomainError,
  notFound,
  publicationLimits,
  publicationMetadataSchema,
  publicationShaSchema,
  publicationSourceSchema,
  snapshotLimits,
  type GitCredentials,
  type GitProvider,
  type PublicationMetadata,
  type PublicationSource,
  type RepoRef,
  type Sandbox,
} from '@repo/domain'

import { emptyUntrackedArchive, untrackedFiles } from './archive.ts'
import { assertBinaryPatchLimits } from './binary-limits.ts'
import { runProcess, type ProcessResult } from './process.ts'

export interface GitWorkspaceOptions {
  transport:
    { kind: 'https'; allowedOrigins: readonly string[] } | { kind: 'local-test'; root: string }
  gitBinary?: string
  gitleaksBinary?: string
}

export interface PreparePublicationInput extends PublicationMetadata {
  patch: Uint8Array
  untracked: Uint8Array
}

export interface PreparedPublication {
  readonly baseSha: string
  readonly headSha: string
  /** Canonical, complete patch, including new files; persists in the snapshot for retry. */
  readonly patch: Uint8Array
  readonly untracked: Uint8Array
  publish(assertFence: () => Promise<void>): Promise<void>
  dispose(): Promise<void>
}

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
const CREDENTIAL_TTL_SECONDS = 120
const BOT_NAME = 'Raditi Bot'
const BOT_EMAIL = 'bot@raditi.ru'
const GITLEAKS_CONFIG = '[extend]\nuseDefault = true\n'
const failed = () =>
  new DomainError('GIT_OPERATION_FAILED', 'Trusted repository operation failed', 502)
const text = (bytes: Uint8Array) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw badRequest('Invalid repository output')
  }
}

/** Git data is used only in a fresh host-owned clone, never in the agent's .git directory. */
export class GitWorkspaceService {
  constructor(
    private readonly provider: GitProvider,
    private readonly options: GitWorkspaceOptions,
  ) {
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
  }

  /** A trusted bundle carries objects and one ref, with no remote credentials, config or hooks. */
  async prepareWorkspace(sandbox: Sandbox, input: PublicationSource): Promise<void> {
    const source = this.source(input)
    const workspace = await this.clone(source)
    try {
      await this.tree(workspace, source.expectedBaseSha)
      await this.git(workspace, ['update-ref', 'refs/heads/raditi-base', source.expectedBaseSha])
      const bundlePath = join(workspace.root, 'base.bundle')
      await this.git(workspace, ['bundle', 'create', bundlePath, 'refs/heads/raditi-base'])
      // Bundle can include ancestry, so cap it separately from the current checked tree.
      if ((await stat(bundlePath)).size > publicationLimits.bundleBytes)
        throw badRequest('Repository bundle is too large')
      const bundle = await readFile(bundlePath)
      const destination = '/tmp/raditi-base.bundle'
      await this.sandboxExec(sandbox, ['test', '!', '-L', '/workspace'])
      // The runtime may already have made an empty work directory. Git clone itself rejects
      // existing nonempty directories; explicitly reject links before it touches the path.
      await this.sandboxExec(sandbox, ['test', '!', '-L', '/workspace/repo'])
      await this.sandboxExec(sandbox, ['test', '!', '-e', destination])
      await this.sandboxExec(
        sandbox,
        ['dd', `of=${destination}`, 'status=none', 'conv=excl'],
        bundle,
      )
      try {
        await this.sandboxExec(sandbox, [
          'git',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'submodule.recurse=false',
          '-c',
          'protocol.file.allow=always',
          'clone',
          '--no-hardlinks',
          '--no-recurse-submodules',
          '--template=',
          '--branch',
          'raditi-base',
          destination,
          '/workspace/repo',
        ])
        await this.sandboxExec(sandbox, [
          'git',
          '-C',
          '/workspace/repo',
          'remote',
          'remove',
          'origin',
        ])
        await this.sandboxExec(sandbox, [
          'git',
          '-C',
          '/workspace/repo',
          'checkout',
          '-b',
          source.branch,
          source.expectedBaseSha,
        ])
      } finally {
        await this.sandboxExec(sandbox, ['rm', '-f', '--', destination])
      }
    } finally {
      await this.dispose(workspace)
    }
  }

  async preparePublication(input: PreparePublicationInput): Promise<PreparedPublication> {
    const { patch: rawPatch, untracked: rawUntracked, ...rawMetadata } = input
    const parsed = publicationMetadataSchema.safeParse(rawMetadata)
    if (!parsed.success) throw badRequest('Invalid publication metadata')
    const metadata = parsed.data
    if (
      !(rawPatch instanceof Uint8Array) ||
      rawPatch.byteLength > publicationLimits.patchBytes ||
      !(rawUntracked instanceof Uint8Array) ||
      rawUntracked.byteLength > snapshotLimits.archiveBytes
    ) {
      throw badRequest('Publication input exceeds its size limit')
    }
    const patch = Buffer.from(rawPatch)
    const untracked = Buffer.from(rawUntracked)
    assertBinaryPatchLimits(patch)
    const files = await untrackedFiles(untracked)
    for (const file of files)
      assertPublicationChange(
        {
          path: file.path,
          oldMode: '000000',
          newMode: file.mode,
          sizeBytes: file.bytes.byteLength,
        },
        metadata.protectedPaths,
      )
    const workspace = await this.clone({
      repo: metadata.repo,
      branch: metadata.branch,
      expectedBaseSha: metadata.expectedBaseSha,
      protectedPaths: metadata.protectedPaths,
    })
    try {
      const original = await this.tree(workspace, metadata.expectedBaseSha)
      await this.git(workspace, ['read-tree', metadata.expectedBaseSha])
      if (patch.byteLength) {
        const stats = await this.git(workspace, ['apply', '--numstat', '-z', '-'], patch)
        this.checkNumstat(stats.stdout, metadata.protectedPaths)
        const summary = await this.git(workspace, ['apply', '--summary', '-'], patch)
        // Fail closed on extended mode headers; final index checks do not depend on this text.
        if (/\b(?:120000|160000)\b|mode change |^ (?:copy|rename) /m.test(text(summary.stdout)))
          throw forbidden('Publication contains a link, submodule or permission change')
        await this.checkPostimages(workspace, patch)
        await this.git(
          workspace,
          ['apply', '--cached', '--check', '--whitespace=nowarn', '-'],
          patch,
        )
        await this.git(workspace, ['apply', '--cached', '--whitespace=nowarn', '-'], patch)
      }
      const afterPatch = await this.index(workspace)
      for (const file of files) {
        if (original.has(file.path) || afterPatch.has(file.path))
          throw badRequest('Untracked publication file collides with the repository')
        const oid = this.sha(
          (await this.git(workspace, ['hash-object', '-w', '--stdin', '--no-filters'], file.bytes))
            .stdout,
        )
        await this.git(
          workspace,
          ['update-index', '-z', '--index-info'],
          Buffer.from(`${file.mode} ${oid}\t${file.path}\0`),
        )
      }
      const candidate = await this.index(workspace)
      await this.validateIndex(workspace, original, candidate, metadata)
      const fullPatch = (
        await this.git(
          workspace,
          [
            'diff',
            '--cached',
            '--binary',
            '--full-index',
            '--no-renames',
            '--no-ext-diff',
            '--no-textconv',
            metadata.expectedBaseSha,
            '--',
          ],
          undefined,
          publicationLimits.patchBytes,
        )
      ).stdout
      const tree = this.sha((await this.git(workspace, ['write-tree'])).stdout)
      const message = `Raditi task ${metadata.taskId}, turn ${metadata.turn}\n\nRaditi-Task: ${metadata.taskId}\nRaditi-Turn: ${metadata.turn}\n`
      const date = `${Math.floor(Date.parse(metadata.createdAt) / 1000)} +0000`
      const headSha = this.sha(
        (
          await this.git(
            workspace,
            ['commit-tree', tree, '-p', metadata.expectedBaseSha],
            Buffer.from(message),
            undefined,
            {
              GIT_AUTHOR_NAME: BOT_NAME,
              GIT_AUTHOR_EMAIL: BOT_EMAIL,
              GIT_AUTHOR_DATE: date,
              GIT_COMMITTER_NAME: BOT_NAME,
              GIT_COMMITTER_EMAIL: BOT_EMAIL,
              GIT_COMMITTER_DATE: date,
            },
          )
        ).stdout,
      )
      await this.git(workspace, ['fsck', '--strict', '--no-reflogs', headSha])
      let disposed = false
      let publishing: Promise<void> | undefined
      return {
        baseSha: metadata.expectedBaseSha,
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

  private source(input: PublicationSource) {
    const result = publicationSourceSchema.safeParse(input)
    if (!result.success || result.data.repo.provider !== this.provider.kind)
      throw badRequest('Invalid repository source')
    return result.data
  }

  private async clone(input: PublicationSource): Promise<Workspace> {
    const source = this.source(input)
    let info
    try {
      info = await this.provider.getRepository(source.repo)
    } catch {
      throw failed()
    }
    if (!info) throw notFound('Repository does not exist')
    if (
      info.ref.provider !== source.repo.provider ||
      info.ref.owner !== source.repo.owner ||
      info.ref.name !== source.repo.name
    )
      throw forbidden('Repository scope mismatch')
    const url = await this.cloneUrl(info.cloneUrl)
    const root = await mkdtemp(join(tmpdir(), 'raditi-git-'))
    const workspace = { root, repo: join(root, 'repo'), url, ref: source.repo }
    try {
      await mkdir(join(root, 'empty'))
      await writeFile(join(root, 'gitleaks.toml'), GITLEAKS_CONFIG, { mode: 0o600 })
      await writeFile(join(root, 'empty', '.gitleaksignore'), '', { mode: 0o600 })
      const auth = await this.auth(source.repo, 'read')
      const cloned = await this.command(
        workspace,
        [
          'clone',
          '--no-checkout',
          '--no-local',
          '--no-hardlinks',
          '--no-recurse-submodules',
          '--no-tags',
          `--template=${join(root, 'empty')}`,
          '--',
          url,
          workspace.repo,
        ],
        undefined,
        undefined,
        auth,
        root,
      )
      if (cloned.code !== 0) throw failed()
      const actual = this.sha(
        (await this.git(workspace, ['rev-parse', '--verify', `${source.expectedBaseSha}^{commit}`]))
          .stdout,
      )
      if (actual !== source.expectedBaseSha)
        throw conflict('Repository base does not match the expected commit')
      return workspace
    } catch (error) {
      await this.dispose(workspace)
      if (isDomainError(error)) throw error
      throw failed()
    }
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
      credentials = await this.provider.issueCredentials(ref, access, CREDENTIAL_TTL_SECONDS)
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
    return {
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
    return runProcess(this.options.gitBinary ?? 'git', [...options, ...args], {
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

  private sha(output: Uint8Array): string {
    const value = text(output).trim()
    if (!publicationShaSchema.safeParse(value).success) throw failed()
    return value
  }

  private async tree(workspace: Workspace, sha: string): Promise<Map<string, Entry>> {
    const output = await this.git(workspace, ['ls-tree', '-rz', '--full-tree', sha])
    const entries = this.entries(output.stdout, /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/)
    await this.sizes(workspace, entries)
    return entries
  }

  private async index(workspace: Workspace): Promise<Map<string, Entry>> {
    return this.entries(
      (await this.git(workspace, ['ls-files', '--stage', '-z'])).stdout,
      /^(100644|100755) ([a-f0-9]{40}) 0\t([^\0]+)$/,
    )
  }

  private entries(bytes: Uint8Array, format: RegExp): Map<string, Entry> {
    const raw = text(bytes)
    if (raw && !raw.endsWith('\0')) throw failed()
    const entries = new Map<string, Entry>()
    for (const row of raw ? raw.slice(0, -1).split('\0') : []) {
      const match = format.exec(row)
      if (!match)
        throw forbidden('Repository contains a link, submodule or unsupported index entry')
      const mode = match[1]!
      const oid = match[2]!
      const path = match[3]!
      assertPublicationPath(path)
      if (entries.has(path) || entries.size >= publicationLimits.files)
        throw badRequest('Repository file count exceeds its limit')
      entries.set(path, { path, mode, oid })
    }
    return entries
  }

  private async sizes(
    workspace: Workspace,
    entries: Map<string, Entry>,
  ): Promise<Map<string, number>> {
    if (!entries.size) return new Map()
    const request = [...entries.values()].map((entry) => entry.oid).join('\n') + '\n'
    const output = await this.git(
      workspace,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      Buffer.from(request),
    )
    const rows = text(output.stdout).trimEnd().split('\n')
    if (rows.length !== entries.size) throw failed()
    const sizes = new Map<string, number>()
    let total = 0
    for (const [index, entry] of [...entries.values()].entries()) {
      const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(rows[index]!)
      const size = Number(match?.[2])
      if (
        !match ||
        match[1] !== entry.oid ||
        !Number.isSafeInteger(size) ||
        size > publicationLimits.fileBytes
      )
        throw badRequest('Repository blob exceeds its limit')
      total += size
      if (total > publicationLimits.treeBytes)
        throw badRequest('Repository tree exceeds its size limit')
      sizes.set(entry.path, size)
    }
    return sizes
  }

  private checkNumstat(output: Uint8Array, protectedPaths: readonly string[]): void {
    const raw = text(output)
    if (raw && !raw.endsWith('\0')) throw badRequest('Invalid patch statistics')
    const paths = new Set<string>()
    for (const row of raw ? raw.slice(0, -1).split('\0') : []) {
      const match = /^(?:[0-9]+|-)\t(?:[0-9]+|-)\t(.+)$/.exec(row)
      if (!match) throw badRequest('Unsupported or ambiguous patch paths')
      if (paths.has(match[1]!) || paths.size >= publicationLimits.files)
        throw badRequest('Publication has repeated paths or too many changes')
      paths.add(match[1]!)
      assertPublicationChange(
        { path: match[1]!, oldMode: '100644', newMode: '100644', sizeBytes: 0 },
        protectedPaths,
      )
    }
  }

  private async checkPostimages(workspace: Workspace, patch: Uint8Array): Promise<void> {
    // Git can take a binary postimage straight from its object store instead of inflating
    // the supplied payload. Bound historical blobs too, before native apply allocates them.
    // Keep duplicate OIDs: several distinct paths can each allocate the same object.
    const oids: string[] = []
    for (const line of Buffer.from(patch).toString('latin1').split('\n')) {
      if (!line.startsWith('index ')) continue
      const match = /^index [a-f0-9]{4,40}\.\.([a-f0-9]{4,40})(?: [0-7]{6})?$/.exec(line)
      if (!match) throw badRequest('Invalid publication object header')
      if (match[1]!.length === 40 && !/^0+$/.test(match[1]!)) oids.push(match[1]!)
    }
    if (!oids.length) return
    if (oids.length > publicationLimits.files)
      throw badRequest('Publication changes too many files')
    const result = await this.git(
      workspace,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      Buffer.from(oids.join('\n') + '\n'),
    )
    const rows = text(result.stdout).trimEnd().split('\n')
    if (rows.length !== oids.length) throw failed()
    let total = 0
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] === `${oids[i]} missing`) continue
      const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(rows[i]!)
      const size = Number(match?.[2])
      if (
        !match ||
        match[1] !== oids[i] ||
        !Number.isSafeInteger(size) ||
        size > publicationLimits.fileBytes
      )
        throw badRequest('Publication historical blob exceeds its limit')
      total += size
      if (total > publicationLimits.treeBytes)
        throw badRequest('Publication historical blobs exceed the tree limit')
    }
  }

  private async validateIndex(
    workspace: Workspace,
    base: Map<string, Entry>,
    candidate: Map<string, Entry>,
    metadata: PublicationMetadata,
  ): Promise<void> {
    // Ask Git for the resulting raw delta as well, never trust patch header declarations alone.
    const raw = await this.git(workspace, [
      'diff',
      '--cached',
      '--raw',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      metadata.expectedBaseSha,
      '--',
    ])
    if (raw.stdout.byteLength > publicationLimits.patchBytes)
      throw badRequest('Publication changes too many files')
    const sizes = await this.sizes(workspace, candidate)
    const paths = new Set([...base.keys(), ...candidate.keys()])
    for (const path of paths) {
      const before = base.get(path)
      const after = candidate.get(path)
      if (before?.oid === after?.oid && before?.mode === after?.mode) continue
      assertPublicationChange(
        {
          path,
          oldMode: before?.mode ?? '000000',
          newMode: after?.mode ?? '000000',
          sizeBytes: sizes.get(path) ?? 0,
        },
        metadata.protectedPaths,
      )
      if (after) {
        const blob = (
          await this.git(
            workspace,
            ['cat-file', 'blob', after.oid],
            undefined,
            publicationLimits.fileBytes,
          )
        ).stdout
        const scan = await runProcess(
          this.options.gitleaksBinary ?? 'gitleaks',
          [
            'stdin',
            '--config',
            join(workspace.root, 'gitleaks.toml'),
            '--gitleaks-ignore-path',
            join(workspace.root, 'empty'),
            '--ignore-gitleaks-allow',
            '--redact=100',
            '--no-banner',
            '--no-color',
            '--log-level=error',
          ],
          {
            cwd: workspace.root,
            env: this.environment(workspace),
            input: blob,
            maxBytes: 64 * 1024,
          },
        )
        if (scan.code === 1) throw forbidden('Publication contains a possible secret')
        if (scan.code !== 0) throw failed()
      }
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
    const existing = (
      await this.git(workspace, ['ls-remote', '--refs', workspace.url, ref], undefined, 1024, auth)
    ).stdout
    const remote = text(existing).trim()
    const match = remote ? /^([a-f0-9]{40})\t([^\n]+)$/.exec(remote) : null
    if (remote && (!match || match[2] !== ref)) throw failed()
    const expected = match?.[1] ?? ''
    if (
      expected !== headSha &&
      expected !== metadata.expectedBaseSha &&
      !(expected === '' && metadata.turn === 1)
    )
      throw conflict('Task branch changed before publication')
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

  private async dispose(workspace: Workspace): Promise<void> {
    await rm(workspace.root, { recursive: true, force: true })
  }

  private async sandboxExec(sandbox: Sandbox, argv: string[], input?: Uint8Array): Promise<void> {
    const controller = new AbortController()
    let handle: Awaited<ReturnType<Sandbox['exec']>> | undefined
    const run = async () => {
      handle = await sandbox.exec({
        argv,
        env: {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdin: input
          ? (async function* () {
              yield input
            })()
          : undefined,
        timeoutMs: publicationLimits.commandMs,
        signal: controller.signal,
      })
      if (controller.signal.aborted) {
        void handle.kill('SIGKILL').catch(() => {})
        throw failed()
      }
      const consume = (async () => {
        let size = 0
        for await (const chunk of handle!.output()) {
          size += chunk.data.byteLength
          if (size > 64 * 1024) throw failed()
        }
      })()
      const [exit] = await Promise.all([handle.wait(), consume])
      if (exit.reason !== 'exited' || exit.code !== 0) throw failed()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(failed())
          }, publicationLimits.commandMs)
        }),
      ])
    } catch {
      controller.abort()
      if (handle) void handle.kill('SIGKILL').catch(() => {})
      throw failed()
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
