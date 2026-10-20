import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'

import {
  addOnlyPathSchema,
  badRequest,
  publicationTooLarge,
  SANDBOX_WORKDIR,
  sandboxCommandFailed,
  snapshotLimits,
  turnOutputRejected,
  type Sandbox,
  type TurnWorkingTree,
} from '@repo/domain'
import { extract } from 'tar-stream'

import { execBounded } from '@repo/snapshots'

// The agent's working tree of a running turn for its preview (docs/plan/53-chat-preview-release.md,
// Р23): what changed against the commit the sandbox got, new files and the paths an earlier export
// of the turn wrote, as `untracked.tar.zst` is made — by commands inside the sandbox, through exec,
// without stopping the agent. Core checks everything again: the archive as an untracked part, each
// path as a candidate's (previews/preview-sync.ts).

const LIST_BYTES = snapshotLimits.entries * (snapshotLimits.path + 1)
const failed = () => sandboxCommandFailed('Working tree export failed or exceeded its limits')
const tooLarge = () => publicationTooLarge('The agent changes exceed the limits of a preview sync')
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const STATUS = /^[AMDT]$/

/**
 * Git as capture runs it: no fsmonitor, no external diff or text conversion of the agent's — and
 * no optional lock (the agent works on). `git diff` refreshes the index it reads whatever the
 * locks say (git 2.39 of the sandbox image), so the export reads a copy of the agent's index:
 * a rewrite of `.git/index` under `index.lock` would fail the agent's own git meanwhile.
 */
const git = (...args: string[]) => [
  'git',
  '--no-pager',
  '--no-optional-locks',
  '--no-replace-objects',
  '--literal-pathspecs',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
  ...args,
]

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  if (bytes.byteLength > 0) yield bytes
}

const nulList = (paths: readonly string[]): Uint8Array =>
  Buffer.from(paths.length === 0 ? '' : `${paths.join('\0')}\0`, 'utf8')

function nulNames(bytes: Uint8Array): string[] {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw failed()
  }
  if (text !== '' && !text.endsWith('\0')) throw failed()
  return text === '' ? [] : text.slice(0, -1).split('\0')
}

/** The names of a tar.zst: what of the asked paths the archive holds. */
async function archivedNames(archive: Uint8Array): Promise<Set<string>> {
  const names = new Set<string>()
  const parser = extract()
  parser.on('entry', (header, stream, next) => {
    names.add(header.name.replace(/\/$/, ''))
    stream.on('end', () => next())
    stream.resume()
  })
  try {
    await pipeline(Readable.from([archive]), createZstdDecompress(), parser, {
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    // A link or another entry the parser takes as it is: the caller's validation refuses it.
    throw turnOutputRejected('Working tree export archive is invalid')
  }
  return names
}

export interface WorkingTreeExportInput {
  baseSha: string
  addOnlyPaths?: readonly string[]
  alsoPaths?: readonly string[]
}

/**
 * Exports the working tree of `sandbox` against `baseSha`. Links and other entries that are not
 * regular files end up in the archive as they are: the validation of core refuses the export.
 */
export async function exportSandboxWorkingTree(
  sandbox: Sandbox,
  input: WorkingTreeExportInput,
): Promise<TurnWorkingTree> {
  const addOnly = input.addOnlyPaths ?? []
  const also = input.alsoPaths ?? []
  if (!SHA.test(input.baseSha)) throw badRequest('A working tree export needs the trusted base')
  if (addOnly.length > 8 || !addOnly.every((path) => addOnlyPathSchema.safeParse(path).success))
    throw badRequest('Invalid add-only paths of a working tree export')
  if (also.length > snapshotLimits.entries) throw tooLarge()
  const run = (argv: string[], maxStdout: number, stdin?: Uint8Array) =>
    execBounded(sandbox, argv, {
      cwd: SANDBOX_WORKDIR,
      maxStdout,
      failure: failed,
      tooLarge,
      ...(stdin ? { stdin: once(stdin) } : {}),
    })

  // Tracked files against the base, with what the agent staged or committed itself — read
  // through a copy of the index in the sandbox's /tmp, which git may refresh as it likes.
  const index = `/tmp/.raditi-export-index-${randomBytes(8).toString('hex')}`
  let listed: Uint8Array
  await run(['cp', '--', '.git/index', index], 0)
  try {
    listed = (
      await run(
        [
          'env',
          `GIT_INDEX_FILE=${index}`,
          ...git(
            'diff',
            '--name-status',
            '-z',
            '--no-renames',
            '--no-ext-diff',
            input.baseSha,
            '--',
          ),
        ],
        LIST_BYTES,
      )
    ).stdout
  } finally {
    await run(['rm', '-f', '--', index], 0).catch(() => {})
  }
  const status = nulNames(listed)
  if (status.length % 2 !== 0) throw failed()
  const written = new Set<string>()
  const deleted = new Set<string>()
  for (let i = 0; i < status.length; i += 2) {
    const code = status[i]!
    const path = status[i + 1]!
    if (!STATUS.test(code) || !path) throw failed()
    if (code === 'D') deleted.add(path)
    else written.add(path)
  }
  // A file the agent took out of the index and kept is untracked now: written, not deleted.
  const untracked = (argv: string[]) => async () => {
    for (const path of nulNames((await run(argv, LIST_BYTES)).stdout)) {
      deleted.delete(path)
      written.add(path)
    }
  }
  await untracked(git('ls-files', '--others', '--exclude-standard', '-z'))()
  if (addOnly.length) await untracked(git('ls-files', '--others', '-z', '--', ...addOnly))()
  for (const path of also) if (!deleted.has(path)) written.add(path)
  if (written.size + deleted.size > snapshotLimits.entries) throw tooLarge()

  const names = [...written].sort()
  const archive = (
    await run(
      [
        'tar',
        '--create',
        '--zstd',
        '--format=ustar',
        '--file=-',
        `--directory=${SANDBOX_WORKDIR}`,
        '--null',
        '--verbatim-files-from',
        '--no-wildcards',
        '--anchored',
        '--no-recursion',
        // An earlier path the agent removed since is not an error: it is a deletion.
        '--ignore-failed-read',
        '--files-from=-',
      ],
      snapshotLimits.archiveBytes,
      nulList(names),
    )
  ).stdout
  const present = await archivedNames(archive)
  for (const path of names) if (!present.has(path)) deleted.add(path)
  return { archive, deletes: [...deleted].sort() }
}
