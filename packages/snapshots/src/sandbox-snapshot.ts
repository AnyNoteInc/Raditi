import { Buffer } from 'node:buffer'

import {
  addOnlyPathSchema,
  badRequest,
  envValueForms,
  isSnapshotCredential,
  isTooLarge,
  publicationTooLarge,
  SANDBOX_WORKDIR,
  sandboxCommandFailed,
  sessionStateSchema,
  snapshotLimits,
  snapshotTooLarge,
  turnOutputRejected,
  type ExecSpec,
  type Sandbox,
  type SessionState,
} from '@repo/domain'

import { execBounded, SANDBOX_EXEC_TIMEOUT_MS } from './exec.ts'
import {
  snapshotEntryPath,
  validateSnapshotArchives,
  type TurnArchives,
} from './archive-validation.ts'

export type { HomeOnlyArchives, SnapshotArchives, TurnArchives } from './archive-validation.ts'

const LIST_BYTES = snapshotLimits.entries * (snapshotLimits.path + 1)
const commandFailed = () =>
  sandboxCommandFailed('Snapshot sandbox command failed or exceeded its limits')
// The agent's session state versus its changes to the site: both 413s, told apart for the client.
const homeTooLarge = () => snapshotTooLarge('Agent session state exceeds the snapshot limits')
const changesTooLarge = () => publicationTooLarge('Agent changes exceed the snapshot limits')

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
    const timeoutMs = options.timeoutMs ?? SANDBOX_EXEC_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SANDBOX_EXEC_TIMEOUT_MS) {
      throw badRequest('Invalid snapshot command timeout')
    }
    this.#timeoutMs = timeoutMs
  }

  /**
   * `credentials` are the turn's own (turnCredentials): an archive or patch that contains one
   * is refused before anything is saved or published (snapshotHasCredential). New files below
   * `addOnlyPaths` (plan 53, Р12) are taken even when an ignore file of the site hides them:
   * the media the agent adds there are part of its change, never in its working set. A home
   * archive that holds a value of the client's variables of the turn (`envValues`, Р13) in any
   * spelling the driver masks is refused the same way. Without `baseSha` — a turn without a
   * repository (docs/plan/57-browser-tasks.md, Б4) — only the home archive is taken: no git
   * command runs and the working directory is not read.
   */
  async capture(
    sandbox: Sandbox,
    state: SessionState,
    baseSha: string | undefined,
    credentials: readonly string[] = [],
    addOnlyPaths: readonly string[] = [],
    envValues: readonly string[] = [],
  ): Promise<TurnArchives> {
    if (baseSha !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha))
      throw badRequest('Snapshot capture requires the trusted base commit')
    if (baseSha === undefined && addOnlyPaths.length > 0)
      throw badRequest('Add-only paths need the base commit of a capture')
    if (
      addOnlyPaths.length > 8 ||
      !addOnlyPaths.every((p) => addOnlyPathSchema.safeParse(p).success)
    )
      throw badRequest('Invalid add-only paths of a capture')
    const homeState = this.#state(state)
    const home = await this.#home(sandbox, homeState)
    if (baseSha === undefined) return this.#validated(homeState, { home }, credentials, envValues)
    await this.#checkDestination(sandbox, SANDBOX_WORKDIR)
    const names = await this.#untracked(sandbox, [
      'git',
      '-c',
      'core.fsmonitor=false',
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ])
    if (addOnlyPaths.length) {
      const seen = new Set(names)
      const media = await this.#untracked(sandbox, [
        'git',
        '--literal-pathspecs',
        '-c',
        'core.fsmonitor=false',
        'ls-files',
        '--others',
        '-z',
        '--',
        ...addOnlyPaths,
      ])
      for (const name of media) if (!seen.has(name)) names.push(name)
    }
    if (names.length > snapshotLimits.entries) throw changesTooLarge()
    const untracked = await this.#archive(sandbox, SANDBOX_WORKDIR, names, [], {
      noRecursion: true,
      tooLarge: changesTooLarge,
    })
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
      { cwd: SANDBOX_WORKDIR, tooLarge: changesTooLarge },
    )
    return this.#validated(
      homeState,
      { home, untracked, patch: patch.stdout },
      credentials,
      envValues,
    )
  }

  /** The agent's session: the includes that exist, without a symlink on the way to any. */
  async #home(sandbox: Sandbox, homeState: SessionState): Promise<Uint8Array> {
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
    return this.#archive(sandbox, homeState.root, paths, homeState.exclude, {
      tooLarge: homeTooLarge,
    })
  }

  async #validated<P extends TurnArchives>(
    homeState: SessionState,
    parts: P,
    credentials: readonly string[],
    envValues: readonly string[],
  ): Promise<P> {
    try {
      return await validateSnapshotArchives(homeState, parts, credentials, envValueForms(envValues))
    } catch (error) {
      if (isTooLarge(error) || isSnapshotCredential(error)) throw error
      // A link, special file or setuid bit in the agent's files: its output, not client input.
      throw turnOutputRejected('Captured snapshot archive is invalid')
    }
  }

  /** The NUL list of untracked files one `ls-files` prints, each a checked entry path. */
  async #untracked(sandbox: Sandbox, argv: string[]): Promise<string[]> {
    const list = await this.#exec(sandbox, argv, LIST_BYTES, {
      cwd: SANDBOX_WORKDIR,
      tooLarge: changesTooLarge,
    })
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(list.stdout)
      if (text !== '' && !text.endsWith('\0')) throw commandFailed()
      const names = text === '' ? [] : text.slice(0, -1).split('\0')
      if (new Set(names).size !== names.length) throw commandFailed()
      names.forEach((name) => snapshotEntryPath(name))
      return names
    } catch {
      throw commandFailed()
    }
  }

  /**
   * The parts of turn n−1 into a fresh, quiescent sandbox. A snapshot without a repository
   * (Б4) restores its session alone: the working directory is only made, and must be empty.
   */
  async restore(sandbox: Sandbox, state: SessionState, parts: TurnArchives): Promise<void> {
    const homeState = this.#state(state)
    // Only the owned, checked copies reach the sandbox.
    const checked: TurnArchives = await validateSnapshotArchives(homeState, parts)
    // Existing symlink ancestors are dangerous even when every archive entry is a regular file.
    await this.#checkDestination(sandbox, homeState.root)
    await this.#checkDestination(sandbox, SANDBOX_WORKDIR)
    const writes: Array<readonly [string, Uint8Array]> = [[homeState.root, checked.home]]
    if (checked.untracked !== undefined) writes.push([SANDBOX_WORKDIR, checked.untracked])
    else {
      await this.#exec(sandbox, ['mkdir', '--parents', '--', SANDBOX_WORKDIR], 0)
      // Nothing of the working directory is restored: whatever is there was not the turn's.
      const entries = await this.#exec(
        sandbox,
        ['find', '-P', SANDBOX_WORKDIR, '-mindepth', '1', '-print', '-quit'],
        snapshotLimits.path + 1,
      )
      if (entries.stdout.byteLength > 0) throw commandFailed()
    }
    for (const [root, archive] of writes) {
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
    { noRecursion = false, tooLarge }: { noRecursion?: boolean; tooLarge: () => Error },
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
      await this.#exec(sandbox, argv, snapshotLimits.archiveBytes, {
        stdin: input(nulList(paths)),
        tooLarge,
      })
    ).stdout
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
      if (links.stdout.byteLength > 0) throw commandFailed()
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

  #exec(
    sandbox: Sandbox,
    argv: string[],
    maxStdout: number,
    options: Pick<ExecSpec, 'cwd' | 'stdin'> & {
      allowedCodes?: number[]
      tooLarge?: () => Error
    } = {},
  ) {
    return execBounded(sandbox, argv, {
      ...options,
      maxStdout,
      timeoutMs: this.#timeoutMs,
      failure: commandFailed,
    })
  }
}
