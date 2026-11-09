import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createZstdDecompress, zstdCompressSync } from 'node:zlib'

import {
  badRequest,
  publicationTooLarge,
  sessionRelativePathSchema,
  snapshotHasCredential,
  snapshotTooLarge,
  sessionStateSchema,
  snapshotLimits,
  snapshotPartNames,
  type SessionState,
  type SnapshotPartName,
} from '@repo/domain'
import { extract, type Header } from 'tar-stream'

import {
  credentialScan,
  keepLimit,
  UstarFraming,
  VALIDATION_TIMEOUT_MS,
  type TooLarge,
} from './ustar-framing.ts'

/** The parts of the snapshot of a turn with a repository. */
export interface SnapshotArchives {
  home: Uint8Array
  untracked: Uint8Array
  patch: Uint8Array
}

/**
 * The one part of the snapshot of a turn without a repository (docs/plan/57-browser-tasks.md,
 * Б4): the agent's session. Its working directory is never read or kept.
 */
export interface HomeOnlyArchives {
  home: Uint8Array
  untracked?: undefined
  patch?: undefined
}

/** Either kind: all three parts, or `home` alone. */
export type TurnArchives = SnapshotArchives | HomeOnlyArchives

const homeOnlyNames: readonly SnapshotPartName[] = Object.freeze(['home'] as const)

/**
 * Which parts `archives` hold, as snapshotPartNamesOf() names them for a manifest: all three, or
 * `home` alone. A patch without its new files, or the reverse, is refused.
 */
export function archivedPartNames(
  archives: Partial<SnapshotArchives>,
): readonly SnapshotPartName[] {
  const untracked = archives.untracked !== undefined
  if (untracked !== (archives.patch !== undefined))
    throw badRequest('Snapshot archives must hold both repository parts or neither')
  return untracked ? snapshotPartNames : homeOnlyNames
}

/**
 * An untracked part that holds no file: two zero blocks of ustar in zstd. The candidate core
 * builds carries it (GitWorkspaceService.preparePublication); kept here so that a host without
 * the platform's code makes the same bytes.
 */
export const emptyUntrackedArchive = (): Uint8Array => zstdCompressSync(Buffer.alloc(1024))

const invalidArchive = () => badRequest('Invalid snapshot archive')
/** The agent's session state is its own; untracked files and the patch are its changes. */
const tooLargeFor = (name: SnapshotPartName): TooLarge =>
  name === 'home'
    ? () => snapshotTooLarge('Snapshot session archive exceeds its limits')
    : () => publicationTooLarge(`Snapshot ${name} part exceeds its limits`)

/** Never normalize away a traversal or an absolute path from an untrusted archive. */
export function snapshotEntryPath(name: string, directory = false): string {
  const path = directory && name.endsWith('/') ? name.slice(0, -1) : name
  if (
    !sessionRelativePathSchema.safeParse(path).success ||
    Buffer.byteLength(path, 'utf8') > snapshotLimits.path ||
    path.includes('\ufffd') ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw invalidArchive()
  }
  return path
}

const inside = (path: string, parent: string): boolean =>
  path === parent || path.startsWith(`${parent}/`)

function assertHomePath(path: string, directory: boolean, state: SessionState): void {
  const included = state.include.some(
    (parent) => inside(path, parent) || (directory && parent.startsWith(`${path}/`)),
  )
  if (!included || state.exclude.some((excluded) => inside(path, excluded))) {
    throw invalidArchive()
  }
}

function assertHeader(
  header: Header,
  paths: Map<string, boolean>,
  parentPaths: Set<string>,
  state?: SessionState,
): void {
  const directory = header.type === 'directory'
  if ((!directory && header.type !== 'file') || (header.linkname ?? '') !== '')
    throw invalidArchive()
  const path = snapshotEntryPath(header.name, directory)
  const size = header.size ?? 0
  if (
    paths.has(path) ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > snapshotLimits.fileBytes ||
    (directory && size !== 0) ||
    ((header.mode ?? 0) & 0o7000) !== 0
  ) {
    throw invalidArchive()
  }
  const segments = path.split('/')
  for (let i = 1; i < segments.length; i += 1) {
    const parent = segments.slice(0, i).join('/')
    if (paths.get(parent) === false) throw invalidArchive()
    parentPaths.add(parent)
  }
  // A later file cannot replace a parent directory that an earlier entry needed.
  if (!directory && parentPaths.has(path)) throw invalidArchive()
  if (state) assertHomePath(path, directory, state)
  paths.set(path, directory)
}

async function validateArchive(
  bytes: Uint8Array,
  tooLarge: TooLarge,
  credentials: readonly Buffer[],
  state?: SessionState,
): Promise<void> {
  const parser = extract()
  const paths = new Map<string, boolean>()
  const parentPaths = new Set<string>()
  parser.on('entry', (header, stream, next) => {
    // Rejecting a header also destroys its Source stream; attach before validation so that
    // this expected failure is reported only by pipeline(), never as an uncaught exception.
    stream.on('error', () => {})
    try {
      assertHeader(header, paths, parentPaths, state)
      let exposed = false
      if (credentials.length > 0) {
        exposed = credentialScan(credentials)(Buffer.from(header.name))
        const scan = credentialScan(credentials)
        stream.on('data', (chunk: unknown) => {
          if (!(chunk instanceof Uint8Array)) parser.destroy(invalidArchive())
          else if (!exposed) exposed = scan(chunk)
        })
      }
      // tar-stream also checks checksums and the exact body length; drain without retaining it.
      stream.on('end', () => next(exposed ? snapshotHasCredential() : undefined))
      stream.resume()
    } catch {
      next(invalidArchive())
    }
  })
  try {
    await pipeline(
      Readable.from([bytes]),
      createZstdDecompress({
        params: {
          [constants.ZSTD_d_windowLogMax]: Math.ceil(Math.log2(snapshotLimits.expandedBytes)),
        },
      }),
      new UstarFraming(tooLarge),
      parser,
      { signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS) },
    )
  } catch (error) {
    throw keepLimit(error)
  }
}

/** The stored size limit of a part: its 413 when `sizeBytes` exceeds it. */
export function assertSnapshotPartSize(name: SnapshotPartName, sizeBytes: number): void {
  const limit = name === 'patch' ? snapshotLimits.patchBytes : snapshotLimits.archiveBytes
  if (sizeBytes > limit) throw tooLargeFor(name)()
}

/** A private copy: a caller cannot swap bytes during an await after they were checked. */
function ownedPart(name: SnapshotPartName, bytes: unknown): Buffer {
  if (!(bytes instanceof Uint8Array)) throw invalidArchive()
  assertSnapshotPartSize(name, bytes.byteLength)
  return Buffer.from(bytes)
}

/**
 * Check every archive completely before the caller starts any restore or commits a manifest:
 * all three parts, or `home` alone for a turn without a repository (archivedPartNames).
 * Callers must use only the returned copies, never their own input buffers. With the turn's
 * `credentials` (capture), a part that contains one verbatim — a file name or content in an
 * archive, or the patch text — is refused as snapshotHasCredential(). Binary changes to tracked
 * files are compressed inside the patch: the trusted candidate repeats this exact match over
 * every changed file in full (GitWorkspaceService.preparePublication). `homeRefused` — the
 * spellings of the values of the client's variables (envValueForms; plan 53, Р13) — refuses the
 * home archive alone the same way: the driver masked them in the session it keeps, and one left
 * there would reach the agent of every later turn. A change of the site that holds one is the
 * publication's to refuse (envValueInChange).
 */
export async function validateSnapshotArchives<P extends TurnArchives>(
  state: SessionState,
  parts: P,
  credentials: readonly string[] = [],
  homeRefused: readonly string[] = [],
): Promise<P> {
  if (parts === null || typeof parts !== 'object') throw invalidArchive()
  return validateParts(
    state,
    parts,
    archivedPartNames(parts),
    credentials,
    homeRefused,
  ) as Promise<P>
}

/** The same checks for only the given parts, such as the home part a sandbox sealed. */
export async function validateSnapshotParts<P extends Partial<SnapshotArchives>>(
  state: SessionState,
  parts: P,
  credentials: readonly string[] = [],
): Promise<P> {
  const names = snapshotPartNames.filter((name) => Object.hasOwn(parts, name))
  return validateParts(state, parts, names, credentials) as Promise<P>
}

async function validateParts(
  state: SessionState,
  parts: Partial<SnapshotArchives>,
  names: readonly SnapshotPartName[],
  credentials: readonly string[],
  homeRefused: readonly string[] = [],
): Promise<Partial<SnapshotArchives>> {
  const parsed = sessionStateSchema.safeParse(state)
  if (!parsed.success) throw badRequest('Invalid snapshot session state')
  const owned: Partial<SnapshotArchives> = {}
  for (const name of names) owned[name] = ownedPart(name, parts?.[name])
  const bytes = (values: readonly string[]) =>
    values.filter((value) => value.length > 0).map((value) => Buffer.from(value, 'utf8'))
  const known = bytes(credentials)
  // Sequential decoding bounds memory: compressed parts are staged, expanded tar data is not.
  if (owned.home)
    await validateArchive(
      owned.home,
      tooLargeFor('home'),
      [...known, ...bytes(homeRefused)],
      parsed.data,
    )
  if (owned.untracked) await validateArchive(owned.untracked, tooLargeFor('untracked'), known)
  if (owned.patch && credentialScan(known)(owned.patch)) throw snapshotHasCredential()
  return owned
}

/** The untracked part alone (trusted publication), with the same framing and limits. */
export async function validateUntrackedArchive(bytes: Uint8Array): Promise<Uint8Array> {
  const owned = ownedPart('untracked', bytes)
  await validateArchive(owned, tooLargeFor('untracked'), [])
  return owned
}
