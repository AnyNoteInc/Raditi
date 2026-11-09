import { Buffer } from 'node:buffer'
import { Transform, type TransformCallback } from 'node:stream'

import { badRequest, isSnapshotCredential, isTooLarge, snapshotLimits } from '@repo/domain'

// The plain-ustar framing and the credential scan every archive of a turn passes: the snapshot
// parts (archive-validation.ts) and the agent's files for the client (outbox.ts). Internal to
// the package: not exported from its index.

const BLOCK_BYTES = 512
export const VALIDATION_TIMEOUT_MS = 60_000
const USTAR_MAGIC_VERSION = Buffer.from('ustar\0' + '00', 'latin1')

const invalidArchive = () => badRequest('Invalid snapshot archive')
export type TooLarge = () => Error
/** A size limit keeps its 413 and a found credential its own error; the rest is one format error. */
export const keepLimit = (error: unknown): Error =>
  isTooLarge(error) || isSnapshotCredential(error) ? error : invalidArchive()

/**
 * Finds any of the turn's exact credentials in a stream of chunks, including one split between
 * two chunks of the same file. The error never carries the value.
 */
export function credentialScan(credentials: readonly Buffer[]): (chunk: Uint8Array) => boolean {
  const keep = Math.max(0, ...credentials.map((value) => value.byteLength - 1))
  let tail: Buffer = Buffer.alloc(0)
  return (chunk) => {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const joined = tail.byteLength > 0 ? Buffer.concat([tail, bytes]) : bytes
    tail = joined.subarray(Math.max(0, joined.byteLength - keep))
    return credentials.some((value) => joined.includes(value))
  }
}

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

/**
 * Restrict the wire format before tar-stream interprets it. GNU tar and tar-stream do not
 * interpret every PAX/global/long-name extension identically. P1 accepts plain USTAR only;
 * the capture command requests that format explicitly. No archive bytes are extracted here.
 */
export class UstarFraming extends Transform {
  readonly #tooLarge: TooLarge

  constructor(tooLarge: TooLarge) {
    super()
    this.#tooLarge = tooLarge
  }

  readonly #header = Buffer.alloc(BLOCK_BYTES)
  #headerBytes = 0
  #remaining = 0
  #total = 0
  #entries = 0
  #zeroBlocks = 0

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.#total += chunk.byteLength
      if (this.#total > snapshotLimits.expandedBytes) throw this.#tooLarge()
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
    } catch (error) {
      callback(keepLimit(error))
    }
  }

  #checkHeader(): void {
    if (this.#header.every((byte) => byte === 0)) {
      this.#zeroBlocks += 1
      return
    }
    if (this.#zeroBlocks > 0) throw invalidArchive()
    if (++this.#entries > snapshotLimits.entries) throw this.#tooLarge()
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
    if (mode > 0o777 || (type === 53 && size !== 0)) throw invalidArchive()
    if (size > snapshotLimits.fileBytes) throw this.#tooLarge()
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
