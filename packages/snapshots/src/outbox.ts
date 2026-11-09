import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createZstdDecompress } from 'node:zlib'

import {
  badRequest,
  outboxFileNameSchema,
  outboxLimits,
  publicationTooLarge,
  snapshotHasCredential,
  snapshotLimits,
} from '@repo/domain'
import { extract } from 'tar-stream'

import { credentialScan, keepLimit, UstarFraming, VALIDATION_TIMEOUT_MS } from './ustar-framing.ts'

// The files the agent left for the client in SANDBOX_OUT (docs/plan/66-chat-visuals.md, В8–В9):
// regular files right in the folder, as one ustar archive in zstd. The archive is never a part of
// the snapshot; the sandbox side takes it with the capture of a completed turn and core reads it
// again before any file reaches the artifacts bucket.

export interface OutboxEntry {
  name: string
  sizeBytes: number
}

export interface OutboxFile extends OutboxEntry {
  bytes: Buffer
}

export const invalidOutbox = () => badRequest('Invalid outbox archive')
export const outboxTooLarge = () => publicationTooLarge('Agent files exceed their limits')

/**
 * Reads an outbox archive from start to end and returns its files in archive order, or throws:
 * a size above the limits of the plan (`outboxTooLarge`), a folder, link or special file, a
 * setuid bit, a name with a folder or one that does not fit, two files of one name
 * (`invalidOutbox`), or one of `refused` — the turn's credentials, the spellings of the client's
 * variables — in a name or a body (`snapshotHasCredential`). `onFile` gets each checked file in
 * full before the next is read; nothing is given for a file whose check failed.
 */
export async function readOutboxArchive(
  bytes: Uint8Array,
  options: {
    refused?: readonly string[]
    onFile?: (file: OutboxFile) => Promise<void>
  } = {},
): Promise<OutboxEntry[]> {
  if (!(bytes instanceof Uint8Array)) throw invalidOutbox()
  if (bytes.byteLength > outboxLimits.archiveBytes) throw outboxTooLarge()
  // A private copy: the caller cannot swap bytes during an await.
  const owned = Buffer.from(bytes)
  const refused = (options.refused ?? [])
    .filter((value) => value.length > 0)
    .map((value) => Buffer.from(value, 'utf8'))
  const entries: OutboxEntry[] = []
  const names = new Set<string>()
  let fileError: { error: unknown } | undefined
  const parser = extract()
  parser.on('entry', (header, stream, next) => {
    stream.on('error', () => {})
    try {
      if (header.type !== 'file' || (header.linkname ?? '') !== '') throw invalidOutbox()
      const name = header.name
      const size = header.size ?? 0
      if (!outboxFileNameSchema.safeParse(name).success || names.has(name)) throw invalidOutbox()
      if (((header.mode ?? 0) & 0o7000) !== 0 || !Number.isSafeInteger(size) || size < 0)
        throw invalidOutbox()
      if (entries.length >= outboxLimits.files || size > outboxLimits.fileBytes)
        throw outboxTooLarge()
      names.add(name)
      const scan = credentialScan(refused)
      let exposed = refused.length > 0 && credentialScan(refused)(Buffer.from(name, 'utf8'))
      const chunks: Buffer[] = []
      let length = 0
      stream.on('data', (chunk: unknown) => {
        if (!(chunk instanceof Uint8Array)) {
          parser.destroy(invalidOutbox())
          return
        }
        length += chunk.byteLength
        if (refused.length > 0 && !exposed) exposed = scan(chunk)
        if (options.onFile) chunks.push(Buffer.from(chunk))
      })
      stream.on('end', () => {
        if (exposed) return next(snapshotHasCredential())
        if (length !== size) return next(invalidOutbox())
        entries.push({ name, sizeBytes: size })
        if (!options.onFile) return next()
        options.onFile({ name, sizeBytes: size, bytes: Buffer.concat(chunks, length) }).then(
          () => next(),
          (error: unknown) => {
            fileError = { error }
            next(error instanceof Error ? error : invalidOutbox())
          },
        )
      })
      stream.resume()
    } catch (error) {
      next(error instanceof Error ? error : invalidOutbox())
    }
  })
  try {
    await pipeline(
      Readable.from([owned]),
      createZstdDecompress({
        params: {
          [constants.ZSTD_d_windowLogMax]: Math.ceil(Math.log2(snapshotLimits.expandedBytes)),
        },
      }),
      new UstarFraming(outboxTooLarge),
      parser,
      { signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS) },
    )
  } catch (error) {
    // An error of `onFile` is the caller's: it keeps its own kind.
    if (fileError) throw fileError.error
    throw keepLimit(error)
  }
  return entries
}
