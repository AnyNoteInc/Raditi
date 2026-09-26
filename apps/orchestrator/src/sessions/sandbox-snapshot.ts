import { Buffer } from 'node:buffer'

import {
  badRequest,
  SANDBOX_WORKDIR,
  sessionStateSchema,
  snapshotLimits,
  type ExecHandle,
  type ExecSpec,
  type Sandbox,
  type SessionState,
} from '@repo/domain'

import {
  snapshotEntryPath,
  validateSnapshotArchives,
  type SnapshotArchives,
} from './archive-validation.ts'

export { validateSnapshotArchives, type SnapshotArchives } from './archive-validation.ts'

const EXEC_TIMEOUT_MS = 60_000
const STDERR_BYTES = 64 * 1024
const MAX_EXEC_CHUNKS = 100_000
const LIST_BYTES = snapshotLimits.entries * (snapshotLimits.path + 1)
const commandFailed = () => badRequest('Snapshot sandbox command failed or exceeded its limits')

async function* input(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  if (bytes.byteLength > 0) yield bytes
}

const nulList = (paths: string[]): Uint8Array =>
  Buffer.from(paths.length === 0 ? '' : `${paths.join('\0')}\0`, 'utf8')

/**
 * P1 byte transport only. P2 must stop all agent processes before capture, and restore into a
 * fresh, quiescent sandbox before writing turn credentials or starting the next agent.
 * Docker lifecycle, cloning headSha and applying/publishing patch.diff belong to P2.
 */
export class SandboxSnapshotTransport {
  readonly #timeoutMs: number

  constructor(options: { timeoutMs?: number } = {}) {
    const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > EXEC_TIMEOUT_MS) {
      throw badRequest('Invalid snapshot command timeout')
    }
    this.#timeoutMs = timeoutMs
  }

  async capture(sandbox: Sandbox, state: SessionState, baseSha: string): Promise<SnapshotArchives> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha))
      throw badRequest('Snapshot capture requires the trusted base commit')
    const homeState = this.#state(state)
    const paths: string[] = []
    const checkedAncestors = new Set<string>()
    await this.#checkNoSymlinkAncestors(sandbox, homeState.root, checkedAncestors)
    for (const path of homeState.include) {
      if (homeState.include.some((parent) => parent !== path && path.startsWith(`${parent}/`)))
        continue
      const exists = await this.#exec(sandbox, ['test', '-e', `${homeState.root}/${path}`], 0, {
        allowedCodes: [0, 1],
      })
      if (exists.code === 0) {
        // tar does not follow a final symlink, but it would traverse a symlink parent of a
        // literal file in --files-from. Reject those before the archive command sees it.
        await this.#checkNoSymlinkAncestors(sandbox, `${homeState.root}/${path}`, checkedAncestors)
        paths.push(path)
      }
    }
    const home = await this.#archive(sandbox, homeState.root, paths, homeState.exclude)
    await this.#checkDestination(sandbox, SANDBOX_WORKDIR)
    const untrackedList = await this.#exec(
      sandbox,
      ['git', '-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'],
      LIST_BYTES,
      { cwd: SANDBOX_WORKDIR },
    )
    let names: string[]
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(untrackedList.bytes)
      if (text !== '' && !text.endsWith('\0')) throw commandFailed()
      names = text === '' ? [] : text.slice(0, -1).split('\0')
      if (names.length > snapshotLimits.entries || new Set(names).size !== names.length) {
        throw commandFailed()
      }
      names.forEach((name) => snapshotEntryPath(name))
    } catch {
      throw commandFailed()
    }
    const untracked = await this.#archive(sandbox, SANDBOX_WORKDIR, names, [], true)
    const patch = await this.#exec(
      sandbox,
      [
        'git',
        '--no-replace-objects',
        '-c',
        'core.fsmonitor=false',
        'diff',
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        baseSha,
        '--',
      ],
      snapshotLimits.patchBytes,
      { cwd: SANDBOX_WORKDIR },
    )
    const parts = { home, untracked, patch: patch.bytes }
    await validateSnapshotArchives(homeState, parts)
    return parts
  }

  async restore(sandbox: Sandbox, state: SessionState, parts: SnapshotArchives): Promise<void> {
    const homeState = this.#state(state)
    // Own the checked bytes across awaits; a caller cannot swap data after validation.
    for (const name of ['home', 'untracked', 'patch'] as const) {
      const limit = name === 'patch' ? snapshotLimits.patchBytes : snapshotLimits.archiveBytes
      if (!(parts[name] instanceof Uint8Array) || parts[name].byteLength > limit)
        throw commandFailed()
    }
    const checked = {
      home: Buffer.from(parts.home),
      untracked: Buffer.from(parts.untracked),
      patch: Buffer.from(parts.patch),
    }
    await validateSnapshotArchives(homeState, checked)
    // Existing symlink ancestors are dangerous even when every archive entry is a regular file.
    await this.#checkDestination(sandbox, homeState.root)
    await this.#checkDestination(sandbox, SANDBOX_WORKDIR)
    for (const [root, archive] of [
      [homeState.root, checked.home],
      [SANDBOX_WORKDIR, checked.untracked],
    ] as const) {
      await this.#exec(sandbox, ['mkdir', '--parents', '--', root], 0)
      await this.#exec(
        sandbox,
        [
          'tar',
          '--extract',
          '--zstd',
          '--file=-',
          `--directory=${root}`,
          '--no-same-owner',
          '--no-same-permissions',
          '--keep-old-files',
        ],
        0,
        { stdin: input(archive) },
      )
    }
  }

  #state(state: SessionState): SessionState {
    const parsed = sessionStateSchema.safeParse(state)
    if (!parsed.success) throw badRequest('Invalid snapshot session state')
    return parsed.data
  }

  async #archive(
    sandbox: Sandbox,
    root: string,
    paths: string[],
    excludes: string[],
    noRecursion = false,
  ): Promise<Uint8Array> {
    const argv = [
      'tar',
      '--create',
      '--zstd',
      '--format=ustar',
      '--file=-',
      `--directory=${root}`,
      '--null',
      '--verbatim-files-from',
      '--no-wildcards',
      '--anchored',
      ...excludes.map((path) => `--exclude=${path}`),
      ...(noRecursion ? ['--no-recursion'] : []),
      '--files-from=-',
    ]
    return (
      await this.#exec(sandbox, argv, snapshotLimits.archiveBytes, { stdin: input(nulList(paths)) })
    ).bytes
  }

  async #checkDestination(sandbox: Sandbox, root: string): Promise<void> {
    await this.#checkNoSymlinkAncestors(sandbox, root)
    const exists = await this.#exec(sandbox, ['test', '-e', root], 0, { allowedCodes: [0, 1] })
    if (exists.code === 0) {
      const links = await this.#exec(
        sandbox,
        ['find', '-P', root, '-type', 'l', '-print', '-quit'],
        snapshotLimits.path + 1,
      )
      if (links.bytes.byteLength > 0) throw commandFailed()
    }
  }

  async #checkNoSymlinkAncestors(
    sandbox: Sandbox,
    root: string,
    checked = new Set<string>(),
  ): Promise<void> {
    const segments = root.slice(1).split('/')
    for (let i = 1; i <= segments.length; i += 1) {
      const path = `/${segments.slice(0, i).join('/')}`
      if (checked.has(path)) continue
      const link = await this.#exec(sandbox, ['test', '-L', path], 0, { allowedCodes: [0, 1] })
      if (link.code === 0) throw commandFailed()
      checked.add(path)
    }
  }

  async #exec(
    sandbox: Sandbox,
    argv: string[],
    maxBytes: number,
    options: Pick<ExecSpec, 'cwd' | 'stdin'> & { allowedCodes?: number[] } = {},
  ): Promise<{ bytes: Uint8Array; code: number }> {
    const controller = new AbortController()
    let handle: ExecHandle | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(commandFailed())
      }, this.#timeoutMs)
    })
    const run = async () => {
      handle = await sandbox.exec({
        argv,
        cwd: options.cwd,
        stdin: options.stdin,
        timeoutMs: this.#timeoutMs,
        signal: controller.signal,
      })
      if (controller.signal.aborted) {
        void handle.kill('SIGKILL').catch(() => {})
        throw commandFailed()
      }
      const current = handle
      const consume = async () => {
        const chunks: Buffer[] = []
        const offsets = { stdout: 0, stderr: 0 }
        let count = 0
        for await (const chunk of current.output()) {
          if (
            ++count > MAX_EXEC_CHUNKS ||
            (chunk.stream !== 'stdout' && chunk.stream !== 'stderr') ||
            !(chunk.data instanceof Uint8Array) ||
            chunk.data.byteLength === 0 ||
            chunk.offset !== offsets[chunk.stream]
          )
            throw commandFailed()
          offsets[chunk.stream] += chunk.data.byteLength
          if (offsets[chunk.stream] > (chunk.stream === 'stdout' ? maxBytes : STDERR_BYTES)) {
            throw commandFailed()
          }
          if (chunk.stream === 'stdout') chunks.push(Buffer.from(chunk.data))
        }
        return Buffer.concat(chunks, offsets.stdout)
      }
      const [bytes, exit] = await Promise.all([consume(), current.wait()])
      if (
        exit.reason !== 'exited' ||
        exit.code === null ||
        !(options.allowedCodes ?? [0]).includes(exit.code)
      ) {
        throw commandFailed()
      }
      return { bytes, code: exit.code }
    }
    try {
      return await Promise.race([run(), timeout])
    } catch {
      controller.abort()
      if (handle) void handle.kill('SIGKILL').catch(() => {})
      throw commandFailed()
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
