import { Buffer } from 'node:buffer'

import {
  badRequest,
  envValueForms,
  isSnapshotCredential,
  isTooLarge,
  OUTBOX_MANIFEST_ENTRY,
  outboxFileNameSchema,
  outboxLimits,
  type OutboxManifest,
  SANDBOX_OUT,
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
import { validateSnapshotArchives, type HomeOnlyArchives } from './archive-validation.ts'
import { outboxTooLarge, packOutbox, readOutboxArchive } from './outbox.ts'

export type { HomeOnlyArchives, SnapshotArchives, TurnArchives } from './archive-validation.ts'

const commandFailed = () =>
  sandboxCommandFailed('Snapshot sandbox command failed or exceeded its limits')
const LIST_BYTES = snapshotLimits.entries * (snapshotLimits.path + 1)
const homeTooLarge = () => snapshotTooLarge('Agent session state exceeds the snapshot limits')

/** The records of a NUL-terminated list; a last one without its NUL is dropped. */
function splitNul(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < bytes.length; i += 1)
    if (bytes[i] === 0) {
      records.push(bytes.subarray(start, i))
      start = i + 1
    }
  return records
}

/** A record as UTF-8 text, or null when it is not. */
function decodeName(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

async function* input(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  if (bytes.byteLength > 0) yield bytes
}

/**
 * What the capture of the outbox took: the archive, how many files, how many it left. The archive
 * also says it left some (its manifest), and is made for that alone when no file is left to take.
 */
export interface OutboxCapture {
  archive?: Uint8Array
  files: number
  /** Entries that are not regular files, or whose name cannot reach the client as it is. */
  skipped: number
}

/** Where the numbered links of the outbox are made: next to SANDBOX_OUT, on the same tmpfs. */
const OUTBOX_STAGE_PARENT = SANDBOX_OUT.slice(0, SANDBOX_OUT.lastIndexOf('/'))
const OUTBOX_STAGE = new RegExp(`^${OUTBOX_STAGE_PARENT}/\\.outbox\\.[A-Za-z0-9]{8}\\n$`)

const nulList = (paths: string[]): Uint8Array =>
  Buffer.from(paths.length === 0 ? '' : `${paths.join('\0')}\0`, 'utf8')

/**
 * The byte transport of a turn's session. The agent's processes are stopped before capture, and
 * restore goes into a fresh, quiescent sandbox before turn credentials or the next agent.
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
   * The agent's session — the home archive alone: no git command runs and the working directory
   * is not read (a turn has no repository, docs/plan/83-remove-projects.md). `credentials` are
   * the turn's own (turnCredentials): an archive that contains one is refused before anything is
   * saved (snapshotHasCredential), and so is one that holds a value of the client's variables of
   * the turn (`envValues`, plan 53, Р13) in any spelling the driver masks.
   */
  async capture(
    sandbox: Sandbox,
    state: SessionState,
    credentials: readonly string[] = [],
    envValues: readonly string[] = [],
  ): Promise<HomeOnlyArchives> {
    const homeState = this.#state(state)
    const home = await this.#home(sandbox, homeState)
    return this.#validated(homeState, { home }, credentials, envValues)
  }

  /**
   * The files the agent left for the client (docs/plan/66-chat-visuals.md, В8–В9): the regular
   * files right in SANDBOX_OUT, never one in a folder below it, as one ustar archive in zstd with
   * plain modes. A ustar header holds a name of a hundred bytes, which a Russian file name
   * outgrows, so the files are archived under their numbers and the manifest — the first entry,
   * written by the host — holds the names (`outboxManifestSchema`). An entry that is no regular
   * file, or whose name cannot reach the client as it is, is left and counted, and the manifest
   * says so: the archive is then made for that alone when nothing else is left to take. More
   * than ten files, a file above 20 MiB or an archive above 16 MiB is refused (outboxTooLarge),
   * and so is the archive that holds one of the turn's credentials or a spelling of a value of
   * the client's variables (snapshotHasCredential): the caller drops the outbox, never the turn.
   * The agent's processes are stopped before this runs.
   */
  async captureOutbox(
    sandbox: Sandbox,
    credentials: readonly string[] = [],
    envValues: readonly string[] = [],
  ): Promise<OutboxCapture> {
    await this.#checkNoSymlinkAncestors(sandbox, SANDBOX_OUT)
    const exists = await this.#exec(sandbox, ['test', '-d', SANDBOX_OUT], 0, {
      allowedCodes: [0, 1],
    })
    if (exists.code !== 0) return { files: 0, skipped: 0 }
    const list = await this.#exec(
      sandbox,
      ['find', '-P', SANDBOX_OUT, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y %s %f\\0'],
      LIST_BYTES,
      { tooLarge: outboxTooLarge },
    )
    const names: string[] = []
    let skipped = 0
    for (const record of list.stdout.length ? splitNul(list.stdout) : []) {
      const match = /^(\S) (\d+) ([\s\S]+)$/u.exec(decodeName(record) ?? '')
      if (!match || match[1] !== 'f' || !outboxFileNameSchema.safeParse(match[3]).success) {
        skipped += 1
        continue
      }
      if (Number(match[2]) > outboxLimits.fileBytes) throw outboxTooLarge()
      names.push(match[3]!)
    }
    if (names.length > outboxLimits.files) throw outboxTooLarge()
    if (names.length === 0)
      return skipped === 0
        ? { files: 0, skipped }
        : { archive: await packOutbox([], { skipped }), files: 0, skipped }
    const manifest: OutboxManifest = { v: 1, names, skipped, refused: false }
    const stage = await this.#stageOutbox(sandbox, manifest)
    let archive: Uint8Array
    try {
      archive = (
        await this.#exec(
          sandbox,
          [
            'tar',
            '--create',
            '--zstd',
            '--format=ustar',
            // Two names of one file in the folder (`ln a b`) are two files, not a link entry,
            // which the framing refuses: the whole outbox would be lost.
            '--hard-dereference',
            '--file=-',
            `--directory=${stage}`,
            '--null',
            '--verbatim-files-from',
            '--no-recursion',
            '--mode=u=rw,go=r',
            '--files-from=-',
          ],
          outboxLimits.archiveBytes,
          {
            stdin: input(
              nulList([OUTBOX_MANIFEST_ENTRY, ...names.map((_, index) => String(index))]),
            ),
            tooLarge: outboxTooLarge,
          },
        )
      ).stdout
    } finally {
      // Only links in a folder of ours: the files stay where the agent left them, and a sandbox
      // that cannot remove them is reset after the turn all the same.
      await this.#exec(sandbox, ['rm', '--recursive', '--force', '--', stage], 0).catch(() => {})
    }
    const contents = await readOutboxArchive(archive, {
      refused: [...credentials, ...envValueForms(envValues)],
    })
    return { archive, files: contents.entries.length, skipped }
  }

  /**
   * A folder next to SANDBOX_OUT with a hard link to each file under its number and the manifest
   * as a file: what the archive is made of, so that its names are numbers and no argument of any
   * command is a pattern. The folder is made by `mktemp`, a name the agent cannot have taken.
   */
  async #stageOutbox(sandbox: Sandbox, manifest: OutboxManifest): Promise<string> {
    const made = await this.#exec(
      sandbox,
      ['mktemp', '--directory', `--tmpdir=${OUTBOX_STAGE_PARENT}`, '.outbox.XXXXXXXX'],
      128,
    )
    const stage = Buffer.from(made.stdout).toString('utf8')
    if (!OUTBOX_STAGE.test(stage)) throw commandFailed()
    const folder = stage.slice(0, -1)
    try {
      for (const [index, name] of manifest.names.entries())
        await this.#exec(
          sandbox,
          ['ln', '--no-target-directory', '--', `${SANDBOX_OUT}/${name}`, `${folder}/${index}`],
          0,
        )
      await this.#exec(sandbox, ['dd', `of=${folder}/${OUTBOX_MANIFEST_ENTRY}`, 'status=none'], 0, {
        stdin: input(Buffer.from(JSON.stringify(manifest), 'utf8')),
      })
    } catch (error) {
      await this.#exec(sandbox, ['rm', '--recursive', '--force', '--', folder], 0).catch(() => {})
      throw error
    }
    return folder
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

  async #validated<P extends HomeOnlyArchives>(
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

  /**
   * The session of turn n−1 into a fresh, quiescent sandbox. Nothing of the working directory is
   * restored: it is only made, and must be empty — whatever is there was not the turn's.
   */
  async restore(sandbox: Sandbox, state: SessionState, parts: { home: Uint8Array }): Promise<void> {
    const homeState = this.#state(state)
    // Only the owned, checked copy reaches the sandbox.
    const checked = await validateSnapshotArchives(homeState, { home: parts.home })
    // Existing symlink ancestors are dangerous even when every archive entry is a regular file.
    await this.#checkDestination(sandbox, homeState.root)
    await this.#checkDestination(sandbox, SANDBOX_WORKDIR)
    await this.#exec(sandbox, ['mkdir', '--parents', '--', SANDBOX_WORKDIR], 0)
    const entries = await this.#exec(
      sandbox,
      ['find', '-P', SANDBOX_WORKDIR, '-mindepth', '1', '-print', '-quit'],
      snapshotLimits.path + 1,
    )
    if (entries.stdout.byteLength > 0) throw commandFailed()
    await this.#exec(sandbox, ['mkdir', '--parents', '--', homeState.root], 0)
    await this.#exec(
      sandbox,
      [
        'tar',
        '--extract',
        '--zstd',
        '--file=-',
        `--directory=${homeState.root}`,
        '--no-same-owner',
        '--no-same-permissions',
        '--keep-old-files',
      ],
      0,
      { stdin: input(checked.home) },
    )
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
