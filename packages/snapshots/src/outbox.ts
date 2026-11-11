import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { constants, createZstdDecompress, zstdCompress } from 'node:zlib'

import {
  badRequest,
  OUTBOX_MANIFEST_BYTES,
  OUTBOX_MANIFEST_ENTRY,
  outboxLimits,
  outboxManifestSchema,
  publicationTooLarge,
  snapshotHasCredential,
  snapshotLimits,
  type OutboxManifest,
} from '@repo/domain'
import { extract, pack } from 'tar-stream'

import { credentialScan, keepLimit, UstarFraming, VALIDATION_TIMEOUT_MS } from './ustar-framing.ts'

// The files the agent left for the client in SANDBOX_OUT (docs/plan/66-chat-visuals.md, В8–В9):
// regular files right in the folder, as one ustar archive in zstd. The archive is never a part of
// the snapshot; the sandbox side takes it with the capture of a completed turn and core reads it
// again before any file reaches the artifacts bucket.
//
// The names of the files are not in the ustar headers, which hold a hundred bytes — fifty Russian
// letters. The first entry is a manifest (`OUTBOX_MANIFEST_ENTRY`) that lists the names the client
// gets, and the files follow as `0`, `1`, … in that order. The manifest also says what was left
// out, so that a file that never came is not silent: see `outboxManifestSchema`.

export interface OutboxEntry {
  name: string
  sizeBytes: number
}

export interface OutboxFile extends OutboxEntry {
  bytes: Buffer
}

export const invalidOutbox = () => badRequest('Invalid outbox archive')
export const outboxTooLarge = () => publicationTooLarge('Agent files exceed their limits')

/** What an outbox archive holds: its files in order, and what it says was left out. */
export interface OutboxContents {
  entries: OutboxEntry[]
  /** Entries of the folder that were left: a folder, a link, a name that cannot reach the client. */
  skipped: number
  /** The files were taken out whole (too many, too large, a secret): there are none. */
  refused: boolean
}

const zstd = promisify(zstdCompress)

/**
 * An outbox archive made here, not in the sandbox: the notice that files were left out — `skipped`
 * entries, or `refused` whole — and, for tests, files as the sandbox would give them. The names
 * are the manifest's, the entries are numbered.
 */
export async function packOutbox(
  files: readonly { name: string; bytes: Uint8Array | string }[] = [],
  notice: { skipped?: number; refused?: boolean } = {},
): Promise<Uint8Array> {
  const manifest: OutboxManifest = {
    v: 1,
    names: files.map(({ name }) => name),
    skipped: notice.skipped ?? 0,
    refused: notice.refused ?? false,
  }
  const writer = pack()
  writer.entry({ name: OUTBOX_MANIFEST_ENTRY, mode: 0o644 }, JSON.stringify(manifest))
  files.forEach(({ bytes }, index) => {
    writer.entry({ name: String(index), mode: 0o644 }, Buffer.from(bytes))
  })
  writer.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of writer) chunks.push(Buffer.from(chunk as Uint8Array))
  return zstd(Buffer.concat(chunks))
}

/**
 * Reads an outbox archive from start to end and returns its files in archive order with what it
 * says was left out, or throws: a size above the limits of the plan (`outboxTooLarge`), no manifest
 * first, a folder, link or special file, a setuid bit, an entry that the manifest does not number,
 * a file the manifest names and the archive lacks (`invalidOutbox`), or one of `refused` — the
 * turn's credentials, the spellings of the client's variables — in a name or a body
 * (`snapshotHasCredential`). `onFile` gets each checked file in full before the next is read;
 * nothing is given for a file whose check failed.
 */
export async function readOutboxArchive(
  bytes: Uint8Array,
  options: {
    refused?: readonly string[]
    onFile?: (file: OutboxFile) => Promise<void>
  } = {},
): Promise<OutboxContents> {
  if (!(bytes instanceof Uint8Array)) throw invalidOutbox()
  if (bytes.byteLength > outboxLimits.archiveBytes) throw outboxTooLarge()
  // A private copy: the caller cannot swap bytes during an await.
  const owned = Buffer.from(bytes)
  const refused = (options.refused ?? [])
    .filter((value) => value.length > 0)
    .map((value) => Buffer.from(value, 'utf8'))
  const entries: OutboxEntry[] = []
  let manifest: OutboxManifest | undefined
  let seen = 0
  let fileError: { error: unknown } | undefined
  const parser = extract()
  const regular = (header: { type?: string; linkname?: string | null; mode?: number }) =>
    header.type === 'file' && (header.linkname ?? '') === '' && ((header.mode ?? 0) & 0o7000) === 0
  parser.on('entry', (header, stream, next) => {
    stream.on('error', () => {})
    try {
      const size = header.size ?? 0
      if (!regular(header) || !Number.isSafeInteger(size) || size < 0) throw invalidOutbox()
      const index = seen
      seen += 1
      const isManifest = index === 0
      // The manifest comes first and by its own name; the files are numbered after it.
      if (isManifest ? header.name !== OUTBOX_MANIFEST_ENTRY : !manifest) throw invalidOutbox()
      if (isManifest && size > OUTBOX_MANIFEST_BYTES) throw invalidOutbox()
      const fileIndex = index - 1
      if (!isManifest) {
        if (header.name !== String(fileIndex) || fileIndex >= manifest!.names.length)
          throw invalidOutbox()
        if (entries.length >= outboxLimits.files || size > outboxLimits.fileBytes)
          throw outboxTooLarge()
      }
      const name = isManifest ? undefined : manifest!.names[fileIndex]!
      const scan = credentialScan(refused)
      let exposed = name !== undefined && refused.length > 0 && scan(Buffer.from(name, 'utf8'))
      const bodyScan = credentialScan(refused)
      const chunks: Buffer[] = []
      let length = 0
      stream.on('data', (chunk: unknown) => {
        if (!(chunk instanceof Uint8Array)) {
          parser.destroy(invalidOutbox())
          return
        }
        length += chunk.byteLength
        if (refused.length > 0 && !exposed) exposed = bodyScan(chunk)
        if (isManifest || options.onFile) chunks.push(Buffer.from(chunk))
      })
      stream.on('end', () => {
        if (exposed) return next(snapshotHasCredential())
        if (length !== size) return next(invalidOutbox())
        if (isManifest) {
          try {
            const body = Buffer.concat(chunks, length)
            const parsed = outboxManifestSchema.parse(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
            )
            // The names are read raw too: JSON spells a quote or a backslash with an escape.
            if (
              refused.length > 0 &&
              parsed.names.some((each) => credentialScan(refused)(Buffer.from(each, 'utf8')))
            )
              return next(snapshotHasCredential())
            manifest = parsed
          } catch {
            return next(invalidOutbox())
          }
          return next()
        }
        entries.push({ name: name!, sizeBytes: size })
        if (!options.onFile) return next()
        options.onFile({ name: name!, sizeBytes: size, bytes: Buffer.concat(chunks, length) }).then(
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
  if (!manifest || entries.length !== manifest.names.length) throw invalidOutbox()
  return { entries, skipped: manifest.skipped, refused: manifest.refused }
}
