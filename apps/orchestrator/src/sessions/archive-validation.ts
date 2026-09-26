import { Buffer } from 'node:buffer'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createZstdDecompress } from 'node:zlib'

import {
  badRequest,
  sessionRelativePathSchema,
  sessionStateSchema,
  snapshotLimits,
  type SessionState,
} from '@repo/domain'
import { extract, type Header } from 'tar-stream'

export interface SnapshotArchives {
  home: Uint8Array
  untracked: Uint8Array
  patch: Uint8Array
}

const BLOCK_BYTES = 512
const VALIDATION_TIMEOUT_MS = 60_000
const USTAR_MAGIC_VERSION = Buffer.from('ustar\0' + '00', 'latin1')

const invalidArchive = () => badRequest('Invalid or oversized snapshot archive')

/** No parseInt prefixes, base-256, high-bit aliases, embedded NULs or hidden suffixes. */
function octalField(header: Buffer, offset: number, length: number, empty = false): number {
  // ascii decoding masks bit 7 and would turn malicious bytes such as 0xb0 into '0'.
  const encoded = header.toString('latin1', offset, offset + length)
  if (empty && /^[\0 ]+$/.test(encoded)) return 0
  if (!/^ *[0-7]+[\0 ]*$/.test(encoded)) throw invalidArchive()
  const value = Number.parseInt(encoded, 8)
  if (!Number.isSafeInteger(value)) throw invalidArchive()
  return value
}

function assertStringField(header: Buffer, offset: number, size: number): void {
  const field = header.subarray(offset, offset + size)
  const zero = field.indexOf(0)
  if (zero !== -1 && field.subarray(zero).some((byte) => byte !== 0)) throw invalidArchive()
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(zero === -1 ? field : field.subarray(0, zero))
  } catch {
    throw invalidArchive()
  }
}

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

/**
 * Restrict the wire format before tar-stream interprets it. GNU tar and tar-stream do not
 * interpret every PAX/global/long-name extension identically. P1 accepts plain USTAR only;
 * the capture command requests that format explicitly. No archive bytes are extracted here.
 */
class UstarFraming extends Transform {
  readonly #header = Buffer.alloc(BLOCK_BYTES)
  #headerBytes = 0
  #remaining = 0
  #total = 0
  #entries = 0
  #zeroBlocks = 0

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.#total += chunk.byteLength
      if (this.#total > snapshotLimits.expandedBytes) throw invalidArchive()
      let offset = 0
      while (offset < chunk.byteLength) {
        if (this.#remaining > 0) {
          const skip = Math.min(this.#remaining, chunk.byteLength - offset)
          this.#remaining -= skip
          offset += skip
          continue
        }
        const length = Math.min(BLOCK_BYTES - this.#headerBytes, chunk.byteLength - offset)
        chunk.copy(this.#header, this.#headerBytes, offset, offset + length)
        offset += length
        this.#headerBytes += length
        if (this.#headerBytes === BLOCK_BYTES) {
          this.#checkHeader()
          this.#headerBytes = 0
        }
      }
      callback(null, chunk)
    } catch {
      callback(invalidArchive())
    }
  }

  #checkHeader(): void {
    if (this.#header.every((byte) => byte === 0)) {
      this.#zeroBlocks += 1
      return
    }
    if (this.#zeroBlocks > 0 || ++this.#entries > snapshotLimits.entries) throw invalidArchive()
    if (!this.#header.subarray(257, 265).equals(USTAR_MAGIC_VERSION)) throw invalidArchive()
    assertStringField(this.#header, 0, 100)
    assertStringField(this.#header, 345, 155)
    const type = this.#header[156]
    if (type !== 0 && type !== 48 && type !== 53) throw invalidArchive()
    // Validate every raw numeric field before tar-stream's permissive parseInt decoding.
    // Malformed metadata can make GNU tar create files and only then fail extraction.
    const mode = octalField(this.#header, 100, 8)
    octalField(this.#header, 108, 8) // uid
    octalField(this.#header, 116, 8) // gid
    const size = octalField(this.#header, 124, 12)
    octalField(this.#header, 136, 12) // mtime
    octalField(this.#header, 148, 8) // checksum; tar-stream also verifies its value
    octalField(this.#header, 329, 8, true) // unused device numbers may be blank in USTAR
    octalField(this.#header, 337, 8, true)
    if (mode > 0o777 || size > snapshotLimits.fileBytes || (type === 53 && size !== 0)) {
      throw invalidArchive()
    }
    this.#remaining = Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES
  }

  override _flush(callback: TransformCallback): void {
    callback(
      this.#headerBytes !== 0 || this.#remaining !== 0 || this.#zeroBlocks < 2
        ? invalidArchive()
        : null,
    )
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

async function validateArchive(bytes: Uint8Array, state?: SessionState): Promise<void> {
  const parser = extract()
  const paths = new Map<string, boolean>()
  const parentPaths = new Set<string>()
  parser.on('entry', (header, stream, next) => {
    // Rejecting a header also destroys its Source stream; attach before validation so that
    // this expected failure is reported only by pipeline(), never as an uncaught exception.
    stream.on('error', () => {})
    try {
      assertHeader(header, paths, parentPaths, state)
      // tar-stream also checks checksums and the exact body length; drain without retaining it.
      stream.on('end', () => next())
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
      new UstarFraming(),
      parser,
      { signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS) },
    )
  } catch {
    throw invalidArchive()
  }
}

/** Check both archives completely before the caller starts any restore or commits a manifest. */
export async function validateSnapshotArchives(
  state: SessionState,
  parts: SnapshotArchives,
): Promise<void> {
  const parsed = sessionStateSchema.safeParse(state)
  if (!parsed.success) throw badRequest('Invalid snapshot session state')
  for (const name of ['home', 'untracked', 'patch'] as const) {
    const bytes = parts[name]
    const limit = name === 'patch' ? snapshotLimits.patchBytes : snapshotLimits.archiveBytes
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > limit) throw invalidArchive()
  }
  // Sequential decoding bounds memory: compressed parts are staged, expanded tar data is not.
  await validateArchive(parts.home, parsed.data)
  await validateArchive(parts.untracked)
}
